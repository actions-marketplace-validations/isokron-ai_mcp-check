#!/usr/bin/env bash
# Runs one shard of the surface-only corpus with the runner checked out in ./runner (isokron-ai/mcp-writecheck-action).
# The runner's driver prints only its label and "run finished, exit N" lines, and only the latter pass the
# filter below into the log; everything else goes to
# files in $RUNNER_TEMP/corpus/out, which is encrypted before upload. With --surface-only the driver
# installs and starts each target in its sandbox and sends initialize and tools/list only: no manifest,
# no mcp-writecheck step, no tool call (corpus/README.md, "The runner hook").
# Its exit status goes to the step output rc; the step itself always succeeds so the results are still
# encrypted and uploaded.
set -uo pipefail
c="$RUNNER_TEMP/corpus"
mkdir -p "$c/out/_shard"
node runner/corpus/run-shard.mjs --surface-only --targets "$c/targets.json" --consume-targets \
  --out "$c/out" --work "$c/work" --lane ci --shard "${SHARD:?}" --shards "${CORPUS_SHARDS:?}" ${CORPUS_ONLY:+--only "$CORPUS_ONLY"} \
  2>>"$c/out/_shard/driver-stderr.log" \
  | grep --line-buffered -E '^run finished, exit [0-9]+$' | tee "$c/public.txt"
rc=${PIPESTATUS[0]}
rm -f "$c/targets.json"
# Last sweep, in case the driver itself died (the same labels the runner's own shard script sweeps).
{
  ids=$(docker ps -aq --filter label=isokron.corpus.run)
  [ -z "$ids" ] || docker rm -f -v $ids
  ids=$(docker network ls -q --filter label=isokron.corpus.run)
  [ -z "$ids" ] || docker network rm $ids
  ids=$(docker volume ls -q --filter label=isokron.corpus.run)
  [ -z "$ids" ] || docker volume rm -f $ids
} >>"$c/out/_shard/driver-stderr.log" 2>&1 || true
for p in /proc/[0-9]*; do
  if { tr '\0' '\n' < "$p/environ"; } 2>/dev/null | grep -qx 'CORPUS_SANDBOX=1'; then kill -KILL "${p#/proc/}" 2>/dev/null || true; fi
done
[[ "$rc" =~ ^[0-9]{1,3}$ ]] || rc=125
echo "rc=$rc" >> "$GITHUB_OUTPUT"
exit 0
