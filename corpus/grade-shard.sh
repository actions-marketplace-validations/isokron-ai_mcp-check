#!/usr/bin/env bash
# Grades this shard's recorded tool lists with corpus/grade.mjs, inside a container: the runner's
# digest-pinned runtime image (runner/corpus/images.json), no network, read-only root, every capability
# dropped, run as the runner's own non-root user. The run folder and this checkout are mounted
# read-only; the dataset comes back on stdout and is written by the host into the run folder, which
# the next step encrypts. Nothing of it is printed.
set -euo pipefail
c="$RUNNER_TEMP/corpus"
img=$(node -e 'const j = require(process.argv[1]); process.stdout.write(String(j.runtime || ""))' "$PWD/runner/corpus/images.json")
[[ "$img" =~ ^[a-z0-9./_-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]] || { echo "harness error: the runtime image is not digest-pinned"; exit 1; }
d="$c/out/_mcp-check"
mkdir -p "$d"
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" --memory 2g --memory-swap 2g --pids-limit 256 --cpus 2 \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --mount "type=bind,src=$c/out,dst=/in,readonly" \
  --mount "type=bind,src=$GITHUB_WORKSPACE,dst=/pkg,readonly" \
  --env "MCP_CHECK_GRADED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --workdir /pkg \
  "$img" node /pkg/corpus/grade.mjs /in >"$d/dataset.jsonl.tmp" 2>"$d/grade-stderr.log"
mv "$d/dataset.jsonl.tmp" "$d/dataset.jsonl"
echo "graded"
