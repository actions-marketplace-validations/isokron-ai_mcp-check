# Loop worker: live-probe (internal)

`.github/workflows/live-probe.yml` is the live-probe lane of IsoKron's testing loop
([isokron-ai/tool-qa](https://github.com/isokron-ai/tool-qa)). For each subject it installs the server from its
published package, starts it in a sandbox, asks for its tool list, and grades that list with this repository's
engine, exactly as `mcp-check -- <server>` grades a live list. No tool is ever called.

## Inputs

The tool-qa pump dispatches the workflow with the three inputs every worker takes (tool-qa `docs/INTERFACES.md`,
"Worker dispatch"):

| Input | Format |
|---|---|
| `shard_id` | 1 to 128 letters, digits, `.`, `_`, `-` |
| `attempt_id` | the same |
| `items` | one line of JSON: 1 to 10 `{"subject": "owner/name", "run_key": "<64 hex>", "fence": <n>}` |

Each input is checked as a whole string before anything runs; `corpus/live-probe.mjs` then checks the items in full.
The run is named `shard <shard_id>`.

## What happens

1. **Kill switch** (job `guard`). Nothing runs unless the repository variable `LOOP_ENABLED` is exactly `true`,
   `LOOP_PAUSE_UNTIL` (optional) has passed, and `LANE_LIVE_PROBE_ENABLED` is unset or `true`
   (`corpus/loop-guard.mjs`). Off ends the run with a notice, never a failure.
2. **Install method** (`corpus/live-probe.mjs plan`). For each subject: the official MCP Registry entries whose
   repository is the subject, or whose packages are the seed list's packages for it (tool-qa
   `history/seed-v1.json`, at the worker-kit commit), latest versions only. The first package that can run here
   wins: packages named in the seed list first, then stdio before streamable HTTP, then npm, PyPI, OCI. An OCI tag is
   pinned to its digest through the registry's own anonymous token service. Arguments and env come from the entry's
   declared values and defaults; a required env value is a dummy, never a credential. Building from source is the
   build-probe lane's work, not this one.
3. **Sandbox** (`corpus/live-probe-sandbox.sh`), the one in
   [isokron-ai/mcp-surface-corpus](https://github.com/isokron-ai/mcp-surface-corpus) at `SURFACE_CORPUS_REF`, used as
   it is: gVisor (`runsc`) with syscall tracing, user 65534, no capabilities, a read-only root, an install network
   whose only way out is an allowlist proxy to the package registry, a run network with no way out, a DNS logger
   that answers every name with itself, and the host firewall. Before any target the sandbox self test runs its
   eleven escape attempts and its telemetry check must pass; if not, nothing else runs. Then the controls, then the
   subjects, each with its own time limit, all stopped at minute 36 of the job. Last, every container, network and
   volume is removed and checked gone, before any upload step starts.
4. **Grade and bundle** (`corpus/live-probe.mjs bundle`). The controls are checked first; then each item's bundle is
   written, and tool-qa's worker-kit (pinned to `WORKER_KIT_REF`) seals and uploads it as
   `result-<attempt_id>-<i>.tar.age`. Every item gets a bundle.

## Bundle

| Path | Holds |
|---|---|
| `results/live-probe.json` | Status (`graded` or `skipped`), our detail code, the tool-qa skip reason; the install method; the live grade (tool count, catalog hash, era, per-section grades, scores and caps, check counts, findings by check id and tool position); the comparison with the list read from source when the sandbox read one (counts, letters, checks that differ); timings; the sandbox's exit statuses. |
| `observations/live.ndjson` | Field records from the mcp-results field registry (below). |
| `controls/` | The three control outputs (below). |
| `raw/` | Captured target bytes, each file at most 6 MiB (a cut is recorded in `raw_truncated`): `tools-list.json` (the tools/list answers), `probe-bare.json` and `probe-env.json` (each probe whole, with its JSON-RPC transcript), `record.json` (the sandbox's record), `registry.json`, `static.json`, `analysis.json`, `steps.txt` (install and run log), `telemetry.jsonl` (the sandbox telemetry of this subject and of the run: settings, containers, syscall trace summaries, DNS queries, connections, egress, firewall drops), `report.json` (findings with tool names and messages), `static-compare.json`, `resolution.json`. |
| `logs/live-probe.log` | One line: the item's outcome. |

Subject text (tool names and descriptions, server info, package names, host names a server looked up) is kept under
`raw/`. Outside it, a subject's string appears only when a strict pattern shows it is plain and holds no word ingest
reads as an attempt identity; otherwise only its hash.

Field records (all `stage: live`): `subject_id`, `registry_name`, `registry_version`, `registry_package_register_type`,
`registry_package_identifier`, `registry_package_version`, `registry_package_transport`,
`registry_package_runtime_hint`, `package_purl`, `oci_digest`, `transports_offered`, `commit_sha`, `commit_date`,
`protocol_era`, `protocol_negotiated`, `client_version`, `server_info`, `capabilities_flags`,
`capabilities_jcs_sha256`, `instructions_len_chars`, `instructions_sha256`, `startup_ms`, `latency_cold_ms`,
`startup_without_config`, `config_state`, `catalog_per_config_state` (tool count and catalog hash with no env and with
dummy env), `stdout_noise_lines`, `stderr_counts`, `list_changed_notifications`, `pagination_behaviour`,
`install_phase_behaviour`, `network_event`, `static_vs_live_agreement`, `observation_coverage`, `step_telemetry`,
`sandbox_tier`, `runner_env`, `our_tool_versions`, and for a skip `error_taxonomy_code`.

## Skips

A subject that cannot be installed, started or listed is a skip, never a failed job:

| Detail | Skip reason | Retryable |
|---|---|---|
| `bad_subject`, `no_package`, `unsupported_package` (cargo, NuGet, MCPB only), `private_registry`, `launch_invalid` | `no_runnable_artifact` | no |
| `remote_only` | `remote_only` | no |
| `unsupported_transport` (SSE, or HTTP with no fixed local port) | `unsupported_transport` | no |
| `image_unavailable`, `install_failed`, `install_timeout` | `install_failed_registry` | no |
| `needs_credentials` (the registry entry declares a required env var, and no list with dummy values) | `start_requires_credentials` | no |
| `start_failed`, `start_timeout`, `list_failed` | `timeout_start` | no |
| `list_rejected` (the engine refused the list) | `no_runnable_artifact` | no |
| `rate_limited` | `rate_limited` | yes |
| `upstream_error`, `harness_error`, `shard_deadline` | `upstream_unavailable` | yes |
| `sandbox_evidence_missing` (no syscall trace or firewall log for it) | `trace_unavailable` | yes |

## Controls

Every bundle carries all three; if any one does not give its expected outcome the bundle step stops and nothing is
uploaded.

| Kind | Expected | What it is |
|---|---|---|
| `known_good` | `match` | Our own server, `@isokron/mcp-check@1.3.1`, installed from npm and started in the sandbox like a subject. Its live list must have the tool count, catalog hash, grades and checks in `corpus/fixtures/live-probe/known-answer.json`, which `node corpus/live-probe.mjs known-answer` computes from the saved capture `test/fixtures/live-probe/known-answer-tools.json` (the tests check they agree). |
| `forgery` | `contained` | `corpus/fixtures/live-probe/forgery-server.js`, run in the sandbox's pinned node image with a fresh marker. Every text it returns (tool names, descriptions, server info, capabilities, errors) poses as a result of another attempt. It goes through the same grading and field code as a subject; the marker must come back in `raw/` and nothing outside `raw/` may hold the marker, an identity key or an envelope. |
| `malicious` | `blocked` | The sandbox self test of this run: every escape attempt blocked and logged, and its telemetry check passed. |

## Proof on GitHub

`live-probe.yml` runs only on dispatch from `main`. `.github/workflows/live-probe-selftest.yml` runs the same steps on
every pull request that touches the lane, on a fixture shard of our own repositories
(`corpus/fixtures/live-probe/selftest-shard.json`: one that is graded, one whose server installs but cannot start, one with no
package), builds each bundle with the worker-kit in dry-run mode, and judges it with tool-qa's own ingest code at
`WORKER_KIT_REF`: the manifest schema, identity and file checks, identity claims outside `raw/`, the controls, the
field registry and the secret scan, plus each item's expected outcome.
