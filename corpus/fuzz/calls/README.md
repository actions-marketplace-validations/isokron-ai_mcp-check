# tools/call fuzz stage (fixtures only)

Loop item B1 (owner decision 27 Nov 2026). Sends `tools/call` with inputs generated from each tool's `inputSchema`
and checks protocol invariants. **It runs only against our own fixtures** (`fixtures.json`): seeded protocol-fault
servers (`fixtures/seeded-server.mjs`) and the tiny-tracker builds of isokron-ai/mcp-write-safety (the correct build
and every seeded defect build). `tools/call` can have side effects, so a third-party server is never run here, and
the read-only list/schema fuzz stage of live-probe (`../session.mjs`, `READ_ONLY_METHODS`) is unchanged.

- `fixtures.mjs`: the only way to start a server. It takes an id from `fixtures.json`, never a command.
- `gen.mjs`: inputs per tool: `valid`, `boundary`, `invalid` (one violation each), `oversize` (1 MiB).
- `invariants.mjs`: LIFE-1 no crash, LIFE-2 no hang, ERR-1 JSON-RPC error shape and id, ERR-2 unknown tool is an
  error, OUT-1 structuredContent satisfies outputSchema, ISERR-1 `isError` boolean with content, ISERR-2 invalid input
  gets an error, RES-1 success has `content`. A schema we cannot read is `inconclusive`, never a finding.
- `matrix.mjs`: runs every fixture and compares with its known answer (`expect`). Controls: `known_good` (no finding a
  fixture does not expect) and `known_bad` (every known fault found). Every miss is a defect of our stage or fixture.
- `.github/workflows/fuzz-calls.yml`: the T0 worker tool-qa's `t0-fuzz` lane dispatches (sealed bundle).

Run locally: `TINY_TRACKER_DIR=<built examples/tiny-tracker> node corpus/fuzz/calls/matrix.mjs --out /tmp/out`.
