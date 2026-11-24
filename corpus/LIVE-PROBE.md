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
   wins: packages named in the seed list first, then stdio before streamable HTTP, then npm, PyPI, OCI. Arguments and
   env come from the entry's declared values and defaults; a required env value is a dummy, never a credential.
   Building from source is the build-probe lane's work, not this one.
   - **Whose entry it is.** Anyone can publish a registry entry whose repository URL names someone else's repository,
     and the package behind it too, so what a package says about itself (npm `repository`, PyPI `project_urls`)
     proves nothing. An entry counts as the subject's only when one of these holds, and `results/live-probe.json`
     records which (`install.matched_by`, `install.verified_by`):
     - `seed`: it carries a package of the seed list;
     - `namespace`: its name is in the owner's namespace, `io.github.<owner>/...`, which the registry verifies;
     - `ghcr_owner`: the image is under `ghcr.io/<owner>/`;
     - `npm_provenance`: the npm registry serves a build provenance attestation for that exact version (SLSA v1 in
       a Sigstore bundle, `dist.attestations`) whose statement names the package, version and the tarball's own
       sha512 (`dist.integrity`), and whose signed workflow repository is the subject;
     - `pypi_provenance`: PyPI's integrity API serves a PEP 740 attestation for a file of that release, from a
       GitHub Trusted Publisher whose repository is the subject, naming the file and its sha256.

     For both provenance kinds the lane itself checks the signature: the leaf certificate chains to Sigstore's
     public Fulcio authority (pinned in `corpus/fixtures/live-probe/sigstore-fulcio.json`), was issued to GitHub
     Actions (OIDC issuer extension) for the subject's repository (Source Repository URI extension and the SAN), and
     the DSSE signature over the statement verifies with it. The extensions are read from the certificate's own
     `tbsCertificate.extensions` (a certificate that is not well-formed DER, or names an extension twice, is
     refused). A package signed by a shared reusable workflow has that workflow in its SAN, not the subject: it is
     accepted only when the Source Repository URI is still the subject, the Build Signer URI (extension 9) is the SAN
     and is a release tag of a workflow on this allowlist (`TRUSTED_REUSABLE_SIGNERS`):
     - `https://github.com/slsa-framework/slsa-github-generator/.github/workflows/` (the SLSA GitHub generator)

     `results/live-probe.json` says which (`install.provenance_signer`: `repository_workflow` or
     `trusted_reusable_workflow`). The install is pinned to the version whose provenance was checked (the attested
     document's own version), so a `latest` that moves in between cannot swap the package. Not checked here: the transparency log (Rekor) entry,
     that the signing time fell inside the certificate's ten-minute validity, and the freshness of the pinned root
     (no TUF update); the registry checked the first two when it accepted the attestation. Anything else is
     skipped as `unverified_registry_entry`, with the reason in `results/live-probe.json` (`unverified`).
   - **OCI images** come only from docker.io, ghcr.io, quay.io, public.ecr.aws, mcr.microsoft.com and
     registry.gitlab.com, and their token services only from those hosts (auth.docker.io and gitlab.com included);
     never an IP literal. The tag is pinned to its digest, and the linux/amd64 image's manifest is read: one whose
     config and layers add up to more than 2 GB is not pulled (`image_too_large`). Those are compressed bytes, so
     OCI subjects run one at a time after the others, each only when the Docker disk has about four times its
     declared size free, and its image is removed after it; when there is not enough, that subject and every later
     one are a retryable skip (`disk_low`).
   - **npm install scripts run**, inside the sandbox's install container: gVisor with syscall tracing, egress only
     through the allowlist proxy to the npm registry. What they did is in the bundle (the install container's trace
     summary and every proxy request in `raw/telemetry.jsonl`, the counts in `install_phase_behaviour`). A native
     module is built from source in the sandbox's build image (below, "Native modules").
3. **Sandbox** (`corpus/live-probe-sandbox.sh`), the one in
   [isokron-ai/mcp-surface-corpus](https://github.com/isokron-ai/mcp-surface-corpus) at `SURFACE_CORPUS_REF`, used as
   it is: gVisor (`runsc`) with syscall tracing, user 65534, no capabilities, a read-only root, an install network
   whose only way out is an allowlist proxy to the package registry, a run network with no way out, a DNS logger
   that answers every name with itself, and the host firewall. Before any target, at that same commit:
   - its reusable `sandbox-conformance.yml` runs as the job `sandbox`, on a runner of its own; the probe job starts
     only when its verdict is `pass`;
   - in the probe job, on the runner that will run the targets, its `sandbox-guard` action installs gVisor and the
     firewall and runs the eleven escape attempts of the self test, and fails the job unless the telemetry
     recomputes a pass; the sandbox script then runs no target unless that guard passed from the same commit as
     the checkout, and checks the telemetry once more itself.

   Then the controls, then the subjects, each with its own time limit, all stopped at minute 34 of the job. Last,
   every container, network and volume is removed, and the upload steps start only when there is no container or
   volume left at all (labelled or not), no labelled network, no host process running as the sandbox user (uid
   65534), and no `runsc` or `containerd-shim-runsc` process.
4. **Grade and bundle** (`corpus/live-probe.mjs bundle`). The controls are checked first; then each item's bundle is
   written, and tool-qa's worker-kit (pinned to `WORKER_KIT_REF`) seals and uploads it as
   `result-<attempt_id>-<i>.tar.age`. Every item gets a bundle.

## Oracles

After the driver's own probe of a target, the oracle stage (`corpus/live-probe-driver.mjs`, which runs the sandbox's
`bin/run-shard.mjs` unchanged and adds the stage through its probe option; `corpus/oracles/`) asks independent
oracles the same questions, on the same `docker run` of the target (same image, mounts, env, network, limits): each
server process is a sandbox container with a name and cidfile of its own, one at a time, removed after use, its
syscall trace summarised and removed. Nothing of a target runs on the runner. No tool is ever called.

1. **SDK clients**, each the official SDK used the way its documentation shows, pinned (`corpus/oracles/pins.json`):
   TypeScript 1.x (`@modelcontextprotocol/sdk` 1.32.2) and 2.x (`@modelcontextprotocol/client` 2.4.0), Python
   (`mcp` 2.3.0) and Go (`github.com/modelcontextprotocol/go-sdk` v1.8.0). Each connects with its own default
   negotiation (the Python and Go clients try `server/discover` first) and lists every page of tools/list.
2. **The official conformance suite** (`@modelcontextprotocol/conformance` 0.2.0-alpha.12, built from git commit
   f44482b, pinned by npm integrity), against both frozen requirement sets it ships: 2025-11-25 (the stateful wire)
   and 2026-07-28 (stateless). The stage refuses to run when the installed sets do not hash as pinned. Of each set's
   server scenarios only the read-only ones run, each on its own revision's wire: `server-initialize`, `ping`,
   `tools-list`, `prompts-list`, `resources-list` (2025-11-25) and `tools-list`, `prompts-list`, `resources-list`
   (2026-07-28). Every other scenario of the set is recorded as not run, with why: `calls_tool`, `gets_prompt`,
   `reads_resource`, `subscribes`, `changes_server_state`, `needs_fixture_server` or `transport_only`.

   The suite speaks Streamable HTTP only, so a stdio server is reached through our bridge
   (`corpus/oracles/bridge.mjs`, on 127.0.0.1 at a port the system picks): each POSTed message becomes one line on
   the server's stdin and the server's answer line is the response body, byte for byte, so the suite's wire-schema
   checks see the server's own bytes. Each scenario gets fresh server processes. Following the design's bridge
   discipline, the results are payload-level only: transport scenarios are not run, and a check about the bridge
   itself (the session id) is `bridge_excluded`, never scored against the server. The bridge's byte-level transcript
   is kept in `raw/oracles.json`.

The stage runs at most once in full per target, after the first probe that got a tool list, and at most once with the
clients only, after the first probe that got none (a client that lists where our probe did not is the lead for a
reader bug). It never runs past the target's time limit less 75 s (kept for the driver's second probe and its
analysis), at most 150 s; each target's limit grows by 150 s for it (`ORACLE_ALLOWANCE_S`). Streamable HTTP targets
are probed inside the sandbox by a helper container, so the stage does not run for them (`oracle_stage.why`:
`http_transport`). The stage runs inside the driver's probe call: `step_telemetry` gives `oracle_ms` and `probe_ms`
without it (R-ORC-02), but the driver's own container record of that probe (in `raw/telemetry.jsonl`) spans both.

**Install** (`corpus/oracles/install.mjs`, a step before the sandbox guard and before any target): `npm ci
--ignore-scripts` from `corpus/oracles/package-lock.json`, `pip install --require-hashes --only-binary=:all:
--no-deps` from `requirements.txt`, `go build -mod=readonly` from `go/go.mod` and `go.sum`, into the runner's temp
folder. Every download goes through the sandbox's own allowlist proxy (`sandbox/egress-proxy.mjs`, on 127.0.0.1) to
registry.npmjs.org, pypi.org, files.pythonhosted.org, proxy.golang.org, sum.golang.org and storage.googleapis.com (the
Go module proxy redirects module zips there; go.sum decides what is accepted); `clients.json` records what installed
and the proxy's requests. A client that does not install is `unavailable` (our fault, never the server's); with
nothing installed the stage is off and each item says `not_installed`. The clients and the suite run with PATH, a
home of their own and the Docker variables only: no token.

**Judging** (`corpus/oracles/judge.mjs`, in the bundle step): each client's tools are hashed with this repository's
engine exactly as our reader's list is, and by tool names alone. Each conformance check is `pass`, `fail`, `warning`,
`info`, `skipped`, `bridge_excluded`, `not_applicable` (a list method the server never declared answered "method not
found") or `expected_fail` (listed in the subject's baseline). Disagreements carry the design's classes: D6
`live_client` (one oracle lists and another does not, or the tool names differ), D4 `schema_mismatch` (same names,
other definitions), D12 crash/timeout, D7 `lint_vs_conformance` (the suite's tool-name check against our engine's
`spec-name-charset` / `spec-name-length`). They are leads for triage, never a verdict.

**Baselines** (`corpus/fixtures/live-probe/oracle-baseline.json`): the expected oracle results of our own servers, the
known-answer control and the T0 subjects of the self test (mcp-check, kronicle-lite, sea-lite): each client's
outcome and negotiated protocol (and, for the pinned version, its catalog hash), the scenarios run per revision, the
expected failures and the expected disagreements (none). Any other failure, a baselined failure that passes (stale),
or a disagreement not listed fails the self test. In every bundle of a baselined subject, `results/live-probe.json`
`oracles.baseline_problems` lists the differences.

## Bundle

| Path | Holds |
|---|---|
| `results/live-probe.json` | Status (`graded` or `skipped`), our detail code, the tool-qa skip reason; the install method; the live grade (tool count, catalog hash, era, per-section grades, scores and caps, check counts, findings by check id and tool position); the comparison with the list read from source when the sandbox read one (counts, letters, checks that differ); timings; the sandbox's exit statuses. |
| `observations/live.ndjson` | Field records from the mcp-results field registry (below). |
| `controls/` | The three control outputs (below). |
| `raw/` | Captured target bytes, each file at most 6 MiB (a cut is recorded in `raw_truncated`): `tools-list.json` (the tools/list answers), `probe-bare.json` and `probe-env.json` (each probe whole, with its JSON-RPC transcript), `record.json` (the sandbox's record), `registry.json`, `static.json`, `analysis.json`, `steps.txt` (install and run log), `telemetry.jsonl` (the sandbox telemetry of this subject and of the run: settings, containers, syscall trace summaries, DNS queries, connections, egress, firewall drops), `report.json` (findings with tool names and messages), `static-compare.json`, `resolution.json`, `oracles.json` (the oracle stage's record: each client's output, each scenario's checks, the bridge's transcript and counts, the sessions' trace summaries). |
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
`sandbox_tier`, `runner_env`, `our_tool_versions`, and for a skip `error_taxonomy_code`. The oracle stage adds
`oracle_stage`, `sdk_client_results`, `conformance_suite`, `conformance_summary`, `conformance_checks` and
`oracle_disagreements` (`EMIT_ORACLE_FIELDS`; tool-qa's ingest pins a registry with them). The meta file's `oracles`
lists the suite and each SDK client that ran, with its version.

## Skips

A subject that cannot be installed, started or listed is a skip, never a failed job:

| Detail | Skip reason | Retryable |
|---|---|---|
| `bad_subject`, `no_package`, `unsupported_package` (cargo, NuGet, MCPB only), `private_registry`, `launch_invalid`, `unverified_registry_entry` | `no_runnable_artifact` | no |
| `oci_host_not_allowed`, `image_too_large` | `policy_excluded` | no |
| `remote_only` | `remote_only` | no |
| `unsupported_transport` (SSE, or HTTP with no fixed local port) | `unsupported_transport` | no |
| `image_unavailable`, `install_failed`, `install_timeout` | `install_failed_registry` | no |
| `needs_credentials` (the registry entry declares a required env var, and no list with dummy values) | `start_requires_credentials` | no |
| `start_failed`, `start_timeout`, `list_failed` | `timeout_start` | no |
| `list_rejected` (the engine refused the list) | `no_runnable_artifact` | no |
| `rate_limited` | `rate_limited` | yes |
| `upstream_error`, `harness_error`, `shard_deadline`, `disk_low` | `upstream_unavailable` | yes |
| `sandbox_evidence_missing` (no syscall trace or firewall log for it) | `trace_unavailable` | yes |

## Controls

Every bundle carries all of them (four when the oracle stage is installed, else three); if any one does not give its
expected outcome the bundle step stops and nothing is uploaded.

| Kind | Expected | What it is |
|---|---|---|
| `known_good` | `match` | Our own server, `@isokron/mcp-check@1.3.1`, installed from npm and started in the sandbox like a subject. Its live list must have the tool count, catalog hash, grades and checks in `corpus/fixtures/live-probe/known-answer.json`, which `node corpus/live-probe.mjs known-answer` computes from the saved capture `test/fixtures/live-probe/known-answer-tools.json` (the tests check they agree). |
| `known_good` | `match` | The oracle stage on the same server (`controls/oracle-known-answer.json`): every SDK client that installed, and the conformance suite, give the answers in `corpus/fixtures/live-probe/oracle-baseline.json` (`controls.known_good`). Present only when the oracles were installed. |
| `forgery` | `contained` | `corpus/fixtures/live-probe/forgery-server.js`, run in the sandbox's pinned node image with a fresh marker. Every text it returns (tool names, descriptions, server info, capabilities, errors) poses as a result of another attempt. It goes through the same grading and field code as a subject; the marker must come back in `raw/` and nothing outside `raw/` may hold the marker, an identity key or an envelope. |
| `malicious` | `blocked` | The sandbox self test of this run: every escape attempt blocked and logged, and its telemetry check passed. |

## Proof on GitHub

`live-probe.yml` runs only on dispatch from `main`. `.github/workflows/live-probe-selftest.yml` runs the same steps on
every pull request that touches the lane, on a fixture shard of our own repositories
(`corpus/fixtures/live-probe/selftest-shard.json`: our T0 servers mcp-check, kronicle-lite and sea-lite, each with its oracle baseline, and one with no
package), builds each bundle with the worker-kit in dry-run mode, and judges it with tool-qa's own ingest code at
`WORKER_KIT_REF`: the manifest schema, identity and file checks, identity claims outside `raw/`, the controls, the
field registry and the secret scan, plus each item's expected outcome.

## Residual risk

The upload steps run in the same job as the sandbox, after it. The checks before them see containers, volumes,
labelled networks, processes of uid 65534 and runsc processes. A target that escaped gVisor (a gVisor bug, then a host
kernel bug) and ran on the host under another user or another name would not be seen, and could reach the job's
artifact upload token in the steps after it. The runner is discarded after the job and holds no secret; ingest's
identity, file and claim checks still apply to anything uploaded.

## Native modules

An npm subject installs with its install scripts on. Since mcp-surface-corpus 73a2669 (`SURFACE_CORPUS_REF`), such an
install runs in the full Debian image of the same Node release as the run image (`node24-build`: compilers, make,
python3 and the Node headers), with `npm_config_nodedir=/usr/local` and `npm_config_build_from_source=true`, so a
native module (better-sqlite3 in kronicle-lite, for example) builds from source against those headers; the server then
runs in the slim image as before. The install network still reaches only the npm registry: prebuilt binaries are not
fetched.
