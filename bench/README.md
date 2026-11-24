# mcp-check adversarial benchmark

mcp-check says it is hard to fool. This folder is how that claim is measured, and how a release is stopped when it
stops being true.

- **Cases** (`cases/<language>/<name>/`): small synthetic MCP servers written by hand for this benchmark, one idiom
  each. No third-party code is copied. Languages: TypeScript, JavaScript, Python, Go, Rust, committed lists (tools.json,
  MCPB manifests), and servers in languages the reader does not read yet (C#, Java, Kotlin, Ruby, PHP, Swift).
- **Truth** (`truth/<language>/<name>.json`): what the server really lists, kept outside the case folder so the reader
  never sees it. See [Truth files](#truth-files).
- **Scoring** (`run.mjs`): every case is read exactly as a user reads it (`mcp-check --repo-dir <case> --format json`,
  every section) and compared with its truth. Per check and per language: true and false positives, false negatives,
  precision and recall with Wilson 95% intervals; per language: how often the reader abstained or found nothing.
  Output: JSON and Markdown ([`SCORE.md`](SCORE.md) is the committed copy of the current score). Checks are listed
  in three groups: measured against hand-written labels; inferred labels only (drafted from the engine's output, so
  they show self-consistency, not correctness); and checks with no positive case.
- **Gate** (`gate.mjs`): compares a fresh score with [`baseline.json`](baseline.json). It fails on:
  - any new miss or false alarm in any case (each disagreement has a stable key, `check|fn-or-fp|subject`, stored per
    case in the baseline), so one case getting worse is never hidden by another getting better;
  - for any check, overall or in one language: false negatives rising, true positives falling, recall falling below
    the baseline interval, any false-positive rise for `sec-*`, `reader-tools` and `security-cap`, and precision
    falling below the baseline interval for the other checks;
  - fewer cases, or a case set (every case and truth file) whose hash is not the baseline's;
  - a faulty-oracle case not caught with the disagreement its truth names;
  - a score better than the baseline ("rebaseline: improvements not locked in"), so a gain cannot be lost later.
  The mutant pass decides kills with the same rule.
- **Faulty-oracle cases** (`cases/faulty-oracle/`): cases whose label is wrong on purpose. Each truth names the
  disagreement the wrong label must cause (`expected_disagreement`); if the scorer does not report exactly that one,
  the run fails. This proves the scorer is reading mcp-check's output, not echoing
  the labels.
- **Mutants** (`mutate.mjs`): small bugs put into a temp copy of mcp-check's reader and check code, and small edits
  to the cases, to see whether the benchmark notices. [`MUTANTS.md`](MUTANTS.md) is the committed result, with
  every surviving mutant listed as a test gap.
- **Known gaps**: cases that reproduce something mcp-check cannot see yet are scored like any other case and listed
  in the score's "Known gaps" section, never counted as passes. The first is the shape of CVE-2025-6514
  (`cases/real-world/cve-2025-6514-shape`).

Nothing here runs a server or touches the network: `--repo-dir` reads files only.

## Running it

```bash
npm ci
node bench/run.mjs                          # the score as Markdown on stdout
node bench/gate.mjs                         # the gate against baseline.json
node bench/mutate.mjs --jobs 4              # the full mutant pass (about 210 mutants; about two minutes)
node bench/mutate.mjs --sample 40           # a fixed subset of the source mutants
node bench/run.mjs --root <other build>     # score another mcp-check build (a release candidate)
node bench/run.mjs --cases <folder>         # another case set laid out as cases/ and truth/
```

CI runs the gate on every pull request and push to `main` (the `bench` job of `ci.yml`), and the full mutant pass
when `src/`, `engine/` or `bench/` changed (the `mutants` job of `ci.yml`; skipped with a notice otherwise). Both are
required by `ci-ok`. `bench-mutants.yml` runs the mutant pass weekly as well.

## When the gate fails

A failure names the check, the language and the numbers. The score's "Every disagreement" section names the cases.

- A reader or check change made something worse: fix the change.
- A change is intended (a reader fix, a new case the reader misses today, a corrected label): rebaseline in the same
  pull request and say why in it:

  ```bash
  node bench/run.mjs --rebaseline     # writes bench/baseline.json and bench/SCORE.md
  ```

  The baseline diff is the record of what was accepted, and a reviewer reads it like code: every key that appears in
  `disagreement_keys` is a new miss being accepted. An improvement fails the gate too until it is rebaselined
  ("rebaseline: improvements not locked in"), so a reader fix that lands (C# support, for example) locks its gain in.
- When the mutant pass fails, a mutant that the benchmark used to kill now survives (`mutants/expected.json`): a case
  or a label stopped catching that bug. After adding cases, `node bench/mutate.mjs --write-expected` rewrites the
  list; never remove an id by hand to make a run pass.

## Truth files

```json
{
  "id": "python/poison-docstring",
  "language": "python",
  "idioms": ["adversarial", "decorator"],
  "about": "one line on what the case tests",
  "outcome": "tools",
  "tools": ["send_mail", "list_inbox", "count_unread"],
  "optional_tools": [],
  "findings": { "sec-instruction-phrases": { "send_mail": "blocking", "list_inbox": "blocking" } },
  "server_findings": { "spec-name-unique": "attention" },
  "details": { "send_mail": { "description": "…", "params": ["body", "subject", "to"], "required": ["body", "subject", "to"], "annotations": {} } },
  "unreadable": { "render_chart": ["description", "inputSchema", "annotations"] }
}
```

- `outcome`: `tools` (a list to grade), `multiple` (several servers: refuse rather than merge), `names` (names only:
  refuse), `incomplete`, `none` (no tool exists in the source), `unsupported`.
- `tools`: every tool the server lists by default. `optional_tools`: tools registered under a condition (an environment
  variable, a flag); listing them or not is both right, but the reader must mark them conditional.
- `findings`: per check, the tools it must flag, optionally with the severity. Every check in the core list
  (`lib/cases.mjs`) is scored on every case, and its truth is "no tool" unless the case says otherwise, so every
  clean case is a labelled negative. `server_findings`: the same for checks of the whole list.
- `exhaustive: true`: every check is labelled; anything else raised on the case's tools is a false positive.
  `not_scored` leaves out checks whose answer depends on the exact JSON an SDK serialises.
- `details`: what the reader must make of each tool. `unreadable`: parts that are built at run time, which the reader
  must mark as unreadable (and skip their checks) rather than grade as empty.
- `faulty_oracle`: this case's label is wrong on purpose; the text says what is wrong. `expected_disagreement`: the
  one disagreement key the wrong label must cause.
- `known_gap` and `reproduces`: a capability mcp-check lacks; check IDs starting `gap-` name a check that does not
  exist yet.
- `truth_level`: `inferred` where labels were drafted with the engine's output and then checked by hand against
  `RUBRIC.md` and the case source; otherwise the labels were written by hand from the source.

## Release

Before a release, the maintainers also run a private blind holdout of more cases in the same format, which is never
committed here (`holdout-hashes.json` holds only the sha256 of its files, and the test suite refuses any public case
or truth file that matches one), against the release candidate (`node bench/run.mjs --root <candidate> --cases <holdout>`), in addition
to this gate and the real-repository QA.
