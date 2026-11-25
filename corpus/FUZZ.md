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

A fail or warn from FZ-CAT-* and FZ-PAG-* is repeated by round 2 (a fresh A and B) before the server is blamed.

## Invariants

Per list ("primitive"): `tools`, `prompts`, `resources`, `templates`. Verdicts: `pass`, `fail`, `warn`, `na`,
`inconclusive`. Item identity: `name` (resources: `uri` when there is no name). Item equality: SHA-256 of the item's
canonical JSON (sorted keys), so key order never counts.

| ID | Rule | Pass | Warn | Fail | Not applicable / inconclusive |
|---|---|---|---|---|---|
| FZ-CAT-1 | Listing twice in one session gives the same catalog | ordered item hashes equal | same items, other order (`order_unstable`) | other items or definitions (`content_unstable`; counts of added, removed, changed) | `na`: method not found; the server sent `notifications/<x>/list_changed` during either listing (`list_changed_announced`). `inconclusive`: a listing did not reach its end (`incomplete_traversal`) |
| FZ-CAT-2 | Listing in two sessions gives the same catalog | as CAT-1, A's first listing against B's | `session_order_unstable` | `session_content_unstable` | as CAT-1 |
| FZ-PAG-1 | Following `nextCursor` to the end yields each item once | every `name` once over all pages | | a name on two pages or twice (`duplicate_item`) | `na`: one page only. `inconclusive`: no end reached (page cap 50, item cap 5000, repeated cursor, timeout, error) |
| FZ-PAG-2 | A cursor used a second time: error, or the page it first gave | JSON-RPC error (`rejected`), or equal item hashes (`same_page`) | | a different page (`spent_cursor_other_page`) | `na`: no cursor issued |
| FZ-PAG-3 | A cursor the server never issued: JSON-RPC error | error (`rejected`) for both invented cursors | answered with the first page again (`cursor_ignored`; the spec asks for -32602) | answered with anything else (`invented_cursor_accepted`) | `na`: not paginated |
| FZ-PAG-4 | A cursor issued in session A, used in B: error, or the page A got | as PAG-2 (a stateless offset cursor is allowed to work) | | a different page, for example the list restarted (`foreign_cursor_other_page`) | `na`: no cursor issued |
| FZ-UNI-1 | No invisible, control, format, private-use, unassigned or ill-formed code point in an identifier (tools, prompts, resources, templates: `name`; resources: `uri`) | none | U+FFFD only | `invisible_or_control` (Cc, Cf, Cs, Co, Cn, Zl, Zp, Zs other than U+0020, default-ignorable, variation selectors, tag characters); `ill_formed` (a lone surrogate); `invalid_utf8` (a line of the server's output that is not UTF-8) | `na`: nothing listed |
| FZ-UNI-2 | No two identifiers of one list are equal after removing ignorable characters, NFKC and folding Cyrillic and Greek look-alikes to Latin | all distinct | equal only after case folding (`collision_case`) | `collision` | |
| FZ-UNI-3 | Identifiers are in NFC | all NFC | `not_nfc` | | |
| FZ-UNI-4 | No Latin word mixes in Cyrillic, Greek, Armenian, Cherokee or Coptic letters | none | `mixed_script` | | |

The static engine already grades one tool list's invisible characters and look-alikes (`sec-zero-width`,
`sec-homoglyph`, `spec-name-charset`). FZ-UNI adds what a single-list grade cannot: prompts, resources and templates,
collisions between two identifiers (the shadowing case), NFC, lone surrogates and invalid UTF-8 read with a strict
decoder, and the same finding recorded with the invariants.

## Who is at fault

Same rule as the skips (`LIVE-PROBE.md`): a server is recorded as at fault (`subject`) only with evidence our own
environment cannot explain. `corpus/fuzz/judge.mjs` `attribute`:

- **`subject`** for a `fail` or `warn` that (a) was computed from complete listings (no page cap, timeout, closed
  pipe, byte or line cap of ours, no error in the middle) and (b) for CAT-* and PAG-*, **showed again in round 2** with
  the same invariant and kind, on fresh containers. Unicode findings are deterministic bytes the server sent, read with
  a strict decoder through no relay: one sighting is enough.
- **`tool`** (verdict `inconclusive`, kind `unconfirmed_<kind>`, `first_seen` kept) for a failure that did not repeat
  (a flaky server and our environment look the same), or that had no time for a second round (`confirmation:
  not_run`).
- **`tool`** (verdict `inconclusive`) for every limit or session problem of ours: `initialize_failed`,
  `incomplete_traversal`, `session_limited`, `malformed_answer`.
- A server that announces a change (`list_changed`) is `na` for the catalog invariants, never a failure.
- Phase 2 adds a control gate: the known-answer control (s901, our own server) runs the same stage; if it does not pass
  every invariant, the shard's fuzz results are all `tool`.

Fuzz results never turn a graded item into a skip and never change its grade: they are findings next to it.

## Output

`<out>/<target>/fuzz.json` (format `isokron-live-probe-fuzz/1`): the rounds with each session's record (health, lists,
probes; server names appear here), the attributed results, the reproducers. The bundle step copies it to
`raw/fuzz.json` (subject text allowed there) and writes `results/live-probe.json` `fuzz`: stage status, counts, and
each result as `{ id, primitive, verdict, kind, fault, reproduced, evidence }` where evidence is counts, hashes and
code points only (`safeEvidence`). A shard where the plan did not switch the stage on has no `fuzz` key and no change in
its bundles.

Observation fields (mcp-results `fields/registry.yaml`): existing, `list_determinism` (boolean, planned): true when
FZ-CAT-1 and FZ-CAT-2 pass for tools. Proposed additions: `fuzz_stage` (object), `invariant_results` (array),
`unicode_identifier_findings` (array). Written only while `EMIT_FUZZ_FIELDS` is `true` (default `false`), which needs the
registry change merged and tool-qa's ingest pinned to it. Until then everything is in `results/` and `raw/`.

## Reproducers, and how one becomes a regression test

Every `subject` result carries a reproducer in `fuzz.json` (`reproducers[]`, format `isokron-fuzz-reproducer/1`): only
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
   `versions.tool.mcp-check`.
4. When the registry has the fields and ingest is pinned to it: set `EMIT_FUZZ_FIELDS = true`.
