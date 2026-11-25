# Fuzz stage: protocol invariants, Unicode identifiers, cross-session checks (internal)

Upgrade #9 of the tool-qa loop (`LOOP-TOOLING-UPGRADES.md`, item 9). This is the design and the first slice. The stage
is code in this repository (`corpus/fuzz/`), runs inside the live-probe lane, and is **off by default**.

## Where it runs

**Inside live-probe, after the oracle stage, once per stdio target. Not its own lane.** The driver's probe option
(`corpus/live-probe-driver.mjs`, `fuzzProbe`) wraps the oracle stage's probe: when the target's first probe got a tool
list, the stage runs read-only sessions on the same `docker run` of the target, then hands the driver its probe back.

Why not a lane of its own:

- The cost of a subject is its install (npm with scripts, PyPI, OCI pulls up to 2 GB) and the sandbox, not the
  protocol calls. A fuzz session is a container start (about 1 to 3 s under gVisor) and a few dozen small requests. A
  second lane would pay the install, the conformance job, the guard (`setup_minutes: 8`) and the exposure of running
  third-party code a second time to buy about 20 s of protocol work.
- The 60 s window fits: the stage gets `FUZZ_BUDGET_MS = 60 s` and a per-target allowance of `FUZZ_ALLOWANCE_S = 60`
  added to the target's limit only while the stage is on. It never runs past the target's limit less the driver's 75 s
  reserve (the oracle stage's rule), is skipped with `time_budget` when under 20 s are left, and a stage error never
  reaches the driver. A typical run is 2 sessions, 100 to 500 ms of protocol time plus two container starts.
- Findings stay tied to the same install, version, config state and sandbox evidence as the grade they belong to.

A separate lane (cf. `scan-deep`, disabled) is right for phase 2, where generated call sequences against our own
fixture servers need minutes and no third-party install. Third-party targets stay read-only either way.

Cost of adding it: `versions.probe` in tool-qa `pump/workflows.json` gets a `fuzz` entry when it is switched on, which
makes every subject due again once (the run_key includes versions). Do not add the entry before the switch.

## What is sent

Only `initialize`, `notifications/initialized`, `ping`, `tools/list`, `prompts/list`, `resources/list` and
`resources/templates/list`, with a cursor where a list is paginated. `Session.request` refuses every other method
(`corpus/fuzz/session.mjs`, `READ_ONLY_METHODS`): no `tools/call`, `prompts/get` or `resources/read`. A request the
server makes of us gets "method not found". Cursors the server never issued are the only invented input.

## Sessions

Round 1 is two fresh server containers (`variantCommand`, the oracle stage's: same image, mounts, env, network and
limits; one alive at a time, removed after use, trace summarised):

- **A**: initialize; every list (tools; prompts and resources/templates when declared) twice; then the first cursor
  again (spent), then two cursors nobody issued (`isokron-fuzz-invalid-cursor`, and one with a bidi override, NUL and a
  non-BMP character).
- **B**: initialize; every list once; then A's first cursor (issued in another session).

Round 2 runs only when round 1 has a finding that could be the server's fault (FZ-CAT-1 `content_unstable`, FZ-PAG-1
`duplicate_item`); observations need no second round.

## Invariants

Per list ("primitive"): `tools`, `prompts`, `resources`, `templates`. Verdicts: `pass`, `fail`, `warn`, `observation`,
`na`, `inconclusive`. Item identity: tools and prompts by `name`; resources and templates by `uri` (a resource's `name`
is display text and repeats). Item equality: SHA-256 of the item's canonical JSON (sorted keys). "Attribution" is the
most a finding can be: **subject** (the server is blamed), **observation** (recorded, never blamed), **tool** (our
side or unconfirmed).

| ID | Rule | Finding | Attribution and why |
|---|---|---|---|
| FZ-CAT-1 | Listing twice in one session gives the same catalog | `content_unstable` (other items or definitions); `order_unstable` (same items, other order) | `content_unstable`: **subject**, only if the server declared no `listChanged` for that list, announced no change, and the second round on fresh containers shows it again; otherwise **tool** (`unconfirmed_content_unstable`). `order_unstable`: **observation** (the specification does not order a list). Declared `listChanged` or an announcement: `na` |
| FZ-CAT-2 | Listing in two sessions gives the same catalog | `session_content_unstable`, `session_order_unstable` | **observation** always: a catalog may depend on time, configuration or state, and the specification does not require two sessions to agree. `na` when `listChanged` is declared |
| FZ-PAG-1 | Following `nextCursor` to the end yields each item once | `duplicate_item` | **subject** when it repeats in round 2 (a client following the cursors gets one item twice; the item's identity is the tool or prompt name, the resource uri); else **tool**. `na` for one page; `inconclusive` (**tool**) with no end (page cap 50, item cap 5000, repeated cursor, timeout, error) |
| FZ-PAG-2 | A cursor used a second time: an error, or the page it first gave | `spent_cursor_other_page` | **observation**. Reuse is not specified; "stable cursors" is a SHOULD (below) |
| FZ-PAG-3 | A cursor the server never issued gets an error | `cursor_ignored` (the first page again), `invented_cursor_accepted` (another page) | **observation**. Invalid cursors SHOULD get -32602 and be handled gracefully (below); returning the first page is a graceful handling the text allows |
| FZ-PAG-4 | A cursor issued in session A, used in B: an error, or the page A got | `foreign_cursor_other_page` | **observation**. The specification forbids the client to do this ("Don't persist cursors across sessions"); it says nothing of the server's answer, so a server that restarts the list is conformant. The probe is ours |
| FZ-UNI-1 | No invisible or control code point, lone surrogate or invalid UTF-8 in an identifier | `invisible_or_control`, `ill_formed`, `invalid_utf8` (clear cases); `unusual_code_point` | **subject** only for a clear case in a **tool name**: control characters, bidi controls, zero-width U+200B and U+2060..2064, U+FEFF, U+180E, a lone surrogate, a stdout line that is not UTF-8, a ZWJ whose neighbours are both ASCII ("a, ZWJ, b"), VS15/VS16 after something that is not a pictograph, emoji modifier or keycap base, and tag characters outside a subdivision-flag sequence (U+1F3F4, tag letters, cancel tag U+E007F). Emoji sequences (skin tones, family, flags, keycaps), ZWJ in Indic and other non-Latin text, Co (icon fonts), Cn, other format characters, soft hyphen and anything in a prompt, resource or uri: **observation** or not judged |
| FZ-UNI-2 | No two identifiers of one list are equal after removing ignorable characters, NFKC and folding Cyrillic and Greek look-alikes | `collision`, `collision_case` | **observation**. Names (tools, prompts) and uris (resources, templates); display names are not compared |
| FZ-UNI-3 | Tool and prompt names are in NFC | `not_nfc` | **observation** |
| FZ-UNI-4 | No word of a tool or prompt name mixes Latin with Cyrillic, Greek, Armenian, Cherokee or Coptic letters | `mixed_script` (per word: "Report Отчёт" is two words, each in one script) | **observation** |

Emoji names are ordinary: a ZWJ between pictographs and VS16 after a pictograph or a keycap base pass. The static
engine already grades one tool list's invisible characters and look-alikes (`sec-zero-width`, `sec-homoglyph`,
`spec-name-charset`); FZ-UNI adds prompts, resources and templates, collisions between two identifiers, NFC, lone
surrogates and invalid UTF-8 read with a strict decoder.

## Who is at fault

Same rule as the skips (`LIVE-PROBE.md`): a server is recorded as at fault (`subject`) only with evidence our own
environment cannot explain **and** a specification text or a clear defect in its bytes behind it. Only FZ-CAT-1
`content_unstable`, FZ-PAG-1 `duplicate_item` and the clear cases of FZ-UNI-1 can be `subject`
(`SUBJECT_CAPABLE` in `corpus/fuzz/judge.mjs`); every other finding is an observation, in the record and the results,
with `fault: null`. The first two need the second round (`attribute`):

- not reproduced in round 2, or no time for one: verdict `inconclusive`, kind `unconfirmed_<kind>`, fault `tool`;
- every limit or session problem of ours (`initialize_failed`, `incomplete_traversal`, `session_limited`,
  `malformed_answer`): `inconclusive`, fault `tool`;
- a server that declared `listChanged` for the list, or announced a change, is `na` for the catalog invariants.

What the 2025-11-25 specification says (pagination page, "Implementation Guidelines" and "Error Handling"), verbatim:

> Servers SHOULD: Provide stable cursors; Handle invalid cursors gracefully
>
> Clients MUST treat cursors as opaque tokens: ... Don't persist cursors across sessions
>
> Invalid cursors SHOULD result in an error with code -32602 (Invalid params).

and, on the page size, "clients MUST NOT assume a fixed page size". Nothing says what a server does with a cursor used
twice, and the "MUST" about sessions binds the client, which is why FZ-PAG-4 is an observation. Whether a server
answers an invented cursor with an error or with its first page is a choice between two SHOULDs; we record it.

Phase 2 adds a control gate: the known-answer control (s901, our own server) runs the same stage; if it does not pass
every invariant, the shard's fuzz results are all `tool`.

Fuzz results never turn a graded item into a skip and never change its grade: they are findings next to it.

## Time

The stage's own budget is 60 s (`FUZZ_BUDGET_MS`); a typical run is 2 sessions of 100 to 500 ms of protocol time plus
two container starts (a few seconds), and a failing run adds two sessions. `probe_ms` in the timing record no longer
includes it (`fuzz_ms` is its own key). The self test measures it: a stage over `FUZZ_STAGE_MAX_MS` (60 s) fails the
self test (`fuzz_over_budget`).

What this does to the lane's arithmetic, none of which this change alters: `SUBJECT_BUDGET_S` (26 min for subjects) and
the 34-minute job stop stay; each target's limit grows by 60 s only while the stage is on, so the job stop is what
bounds a shard (items left report a retryable `shard_deadline`). The worst case is 60 s for each of 10 subjects, 10
minutes a shard; the typical case is well under one. tool-qa's lease is `1.5 x (setup_minutes + shard_size x
minutes_per_subject) + 10`: with `setup_minutes` 8, `minutes_per_subject` 2 and shard 10 that is 52 minutes. At
switch-on tool-qa should set `minutes_per_subject` to 3 (the worst case, lease 67 minutes) and leave `setup_minutes`;
this change does not touch tool-qa. The job stop at minute 34 holds either way, so a longer lease only waits for a run
that has already ended.

## Output

`<out>/<target>/fuzz.json` (format `isokron-live-probe-fuzz/1`): the rounds with each session's record (health, lists,
probes; server names appear here), the attributed results, the reproducers. Server cursors are hashes (`cur-<16 hex>`);
the initialize answer is a hash plus `declares`, `list_changed` and the protocol version, never its instructions or server
info. The record is capped at 3 MiB (`capRecord`: reproducers first, then item lists), well under the bundle's 6 MiB
cut. The bundle step copies it to
`raw/fuzz.json` (subject text allowed there) and writes `results/live-probe.json` `fuzz`: stage status, counts, and
each result as `{ id, primitive, verdict, kind, fault, reproduced, evidence }` where evidence is counts, hashes and
code points only (`safeEvidence`); `observation` is a verdict of its own. A shard where the plan did not switch the stage on has no `fuzz` key and no change in
its bundles.

Observation fields (mcp-results `fields/registry.yaml`): existing, `list_determinism` (boolean, planned): true when
FZ-CAT-1 and FZ-CAT-2 pass for tools. Proposed additions: `fuzz_stage` (object), `invariant_results` (array),
`unicode_identifier_findings` (array). Written only while `EMIT_FUZZ_FIELDS` is `true` (default `false`), which needs the
registry change merged and tool-qa's ingest pinned to it. Until then everything is in `results/` and `raw/`.

## Reproducers, and how one becomes a regression test

Every `subject` or observation result carries a reproducer in `fuzz.json` (`reproducers[]`, format `isokron-fuzz-reproducer/1`): only
the requests and answers that show it (initialize, the traversal or probe involved, in the order asked), the expected
verdict and kind, and `order`, which session of the spec each server start plays. It is narrowed by construction (one
invariant, one list, the sessions involved); shrinking items inside a list is phase 2.

1. Take the reproducer from the bundle's `raw/fuzz.json`.
2. Save it as `test/fixtures/fuzz/<R-FZ-NN>.json`. Third-party names may stay (names are public by policy) except for
   security-class findings, which go to Joshua first.
3. Add a test `R-FZ-NN: <what it was>` to `test/fuzz.test.mjs` using `replayCase(JSON.parse(file))` (exported by
   `test/fuzz.test.mjs`): it starts `corpus/fuzz/replay-server.mjs` for every session of the spec, runs the stage, and
   asserts the same invariant and kind (see `R-FZ-12`). It must fail with the invariant muted (`setMutation`), which is the mutation check.
4. Add the row to `REGRESSIONS.md` (ID `R-FZ-NN`, next free number) with the test and the fix commit.

## Not in this slice (phase 2)

- Cross-session leaks: data of session A visible in session B. Needs state-changing calls, so it runs only against our
  own fixture servers (`tools/call` allowed there, never on third-party servers).
- Generated call sequences and metamorphic checks over them (repeat, reorder, interleave sessions) on fixture servers.
- The control gate above; item-level shrinking of reproducers; 2026-07-28 stateless era (`server/discover`); streamable
  HTTP targets (probed by a helper container, not through the probe option).
- OAuth checks: most cannot run offline and stay out of this lane.

## Switching it on

1. Merge this change and the mcp-results registry entries (optional: results are in `results/` and `raw/` without them).
2. Repository variable `LANE_LIVE_PROBE_FUZZ=on` in isokron-ai/mcp-check. Off by unsetting it.
3. In tool-qa `pump/workflows.json`, `live-probe.versions.probe`: add `"fuzz": "<mcp-check commit>"`, bump
   `versions.tool.mcp-check`; set `minutes_per_subject` to 3 (see "Time").
4. When the registry has the fields and ingest is pinned to it: set `EMIT_FUZZ_FIELDS = true`.
