# Corpus: grading the tool lists of public MCP servers (internal)

`.github/workflows/corpus.yml` grades the `tools/list` of pinned third-party open-source MCP servers.
It records the tool list only: each server is installed and started in a sandbox, sent `initialize`
and `tools/list`, and stopped. No tool is ever called.

The result is a dataset for IsoKron's own use: calibrating the checks against real servers and
measuring how the rubric lands. It is not a findings channel. **No grade of a named server is
published from this workflow or its dataset** until the public pages that such a publication needs
are live: a methodology page, a page explaining how a maintainer disputes or corrects a grade, and a
re-check path. Until then the dataset stays encrypted, and anything published from it is aggregate
only (for example, "N% of the servers graded have no `title` on any tool").

## How it works

The workflow does not have a sandbox of its own. It runs the corpus driver of
[isokron-ai/mcp-writecheck-action](https://github.com/isokron-ai/mcp-writecheck-action/tree/main/corpus)
at a commit on that repository's `main`, and reuses all of it as it stands:

| From the runner (`runner/corpus/`) | Used for |
|---|---|
| `targets.json.age` | The target list (format `isokron-corpus-targets/2`), encrypted. Decrypted at run time with the `CORPUS_TARGETS_KEY` secret by `decrypt-targets.sh`; the driver deletes the clear text before any target runs. This repository holds no copy and never names a target, only IDs such as `t13`. |
| `images.json` | The digest-pinned container images. The grader container uses its `runtime` image too. |
| `run-shard.mjs` and `sandbox/` | Install, backends, set-up and the server, in containers as user 10001 with every capability dropped, a read-only root, and an internal network after install. `sandbox/surface.mjs` sends `initialize` and `tools/list` and writes `surface.json`. |
| `net-guard.sh`, `install-age.sh`, `check-batch.sh` | The network guard, the pinned `age`, and the batch-input check (`t<NN>` IDs, at most 40, up to 16 shards). |
| `encrypt-results.sh`, `recipients.txt`, `summary.sh` | Everything the job wrote is encrypted to IsoKron's archive key before upload; the summary prints only the label and `run finished, exit N` lines. |

What this repository adds:

| File | What it does |
|---|---|
| `corpus/run-surface-shard.sh` | Runs the driver with `--surface-only` for one shard, then sweeps leftover containers, networks and volumes. |
| `corpus/grade-shard.sh` | Runs `corpus/grade.mjs` in the runner's digest-pinned runtime image with `--network none`, a read-only root, no capabilities, the run folder and this checkout mounted read-only. The dataset comes back on stdout into the run folder, before the encrypt step. |
| `corpus/grade.mjs` | One JSON line per target (format `isokron-mcp-check-corpus/1`); also `summarize` for aggregates. |

## The runner hook (`--surface-only`)

The workflow stops before anything is decrypted unless the checked-out driver accepts
`--surface-only`. That flag is a change to make in isokron-ai/mcp-writecheck-action; until it is on
that repository's `main`, set no `RUNNER_REF` and the workflow refuses to start. The change:

1. `run-shard.mjs` accepts `--surface-only`. With it, `--cli` and `--cli-commit` are optional; the
   driver still builds the tools volume it mounts read-only at `SANDBOX_TOOLS`, from `corpus/sandbox/`
   alone (no mcp-writecheck build), and records `cli: null` with a reason.
2. Per target, steps 1 to 5b run as today (artifact check, volumes and networks, install, backends,
   set-up, the surface probe). Steps 6 and 7 (manifests, `init`, `plan`, `catalog`, `full`) and the
   backend and target snapshots do not run; a target's `full` block is ignored, not refused.
3. Status: exit 0 when `meta.surface` is recorded; 124 on a time limit; 125 when the probe gave no
   `tools/list` answer or on any harness error, as today. `meta.json` and `shard.json` record
   `mode: "surface-only"`.
4. The runner's own tests cover: no CLI step and no `writecheck.yaml` in surface-only mode, the probe
   still runs inside the sandbox with the same isolation, and a target with `full.plan_hash` makes no
   write.

Nothing else changes: the list format, the images, the isolation, the encryption and the public log
stay as the runner's `corpus/README.md` describes them. Once merged, put that commit's SHA in
`RUNNER_REF` in `corpus.yml` (or pass it as `runner-ref` per dispatch).

## Grading earlier runs without starting anything

The runner's own corpus runs already record `surface.json` for every target, in their encrypted
bundles. On IsoKron's machine, with the archive key:

```sh
age -d -i ~/path/to/archive-key.txt corpus-shard-3.tgz.age | tar -xz -C shard-3
node corpus/grade.mjs shard-3 > shard-3.jsonl        # one line per target
cat shard-*.jsonl > dataset.jsonl
node corpus/grade.mjs summarize dataset.jsonl       # grade distribution, checks by number of targets
```

## Dataset record (`isokron-mcp-check-corpus/1`)

| Field | Meaning |
|---|---|
| `target` | The target ID from the list (`t13`). Never a name. |
| `graded_at`, `engine_version`, `rubric_version`, `spec_version`, `sources_read` | When and with what it was graded. Grades from different rubric versions are not comparable. |
| `surface` | `captured_at` from `surface.json`; `sha256_jcs`, `protocol_version`, `tools_pages` from the runner's `meta.json`. |
| `server_info` | `name` and `version` from the server's `initialize` answer (kept only inside the encrypted bundle). |
| `tool_count`, `catalog_hash`, `era` | As in a report. |
| `sections` | Per section: `grade`, `score`, `ready`, `counts`, `caps`. |
| `check_counts`, `findings` | Each check ID with its number of findings; each finding's `id`, `severity`, `tool`, `path`. |
| `error` | `{ code, message }` when the target could not be graded (`no_surface`, `too_large`, `too_deep`, `too_many_tools`, `not_json`, ...), with every other field null. |

## Owner set-up

1. Land the runner hook (above) in isokron-ai/mcp-writecheck-action and set `RUNNER_REF`.
2. In this repository: environment `corpus`, deployment branches limited to `main`, secret
   `CORPUS_TARGETS_KEY` (the same age identity the runner's corpus uses).
3. Dispatch from `main` with a short `only` list first.
