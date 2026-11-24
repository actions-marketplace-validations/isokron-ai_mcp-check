#!/usr/bin/env bash
# The sandbox part of a live-probe shard (corpus/LIVE-PROBE.md), run by .github/workflows/live-probe.yml and
# live-probe-selftest.yml after `corpus/live-probe.mjs plan`:
#
#   corpus/live-probe-sandbox.sh <work> <mcp-surface-corpus checkout> <deadline, epoch seconds>
#
#   1. gVisor (runsc) installed and registered exactly as the sandbox pins it, then the host firewall (net-guard.sh);
#   2. the sandbox self test (bin/sandbox-selftest.mjs, eleven escape attempts) and its telemetry check
#      (scripts/check-selftest.mjs), before any target. If the check fails, nothing else runs.
#      TODO: call mcp-surface-corpus's reusable sandbox-conformance.yml instead, once it is merged there.
#   3. the controls (our own server from npm, and the forgery server) through the sandbox driver;
#   4. the subjects through the sandbox driver, stopped at the deadline (the items left report a retryable skip);
#   5. a last sweep of every container, network and volume of the runs, and a check that none is left, so no
#      target process exists when the upload steps start.
#
# Every target runs in the driver's containers (bin/run-shard.mjs: gVisor, user 65534, no capabilities, read-only
# root, internal networks, an environment of names the harness sets); nothing of a target runs in this shell. The
# driver prints only "run finished, exit N" lines; everything else goes to files under <work>. GH_TOKEN (the job's
# read-only token) is read by the driver's own fetch of repository facts and never reaches a container.
#
# Writes <work>/sandbox.json with every exit status. Exits 1 when the sandbox could not be set up or did not pass its
# self test (then no target ran), else 0: a subject's failure never fails the job, `bundle` reads what happened.
set -uo pipefail
work="${1:?work folder}"
msc="$(cd "${2:?mcp-surface-corpus checkout}" && pwd)"
deadline="${3:?deadline}"
[[ "$deadline" =~ ^[0-9]{10}$ ]] || { echo "deadline must be epoch seconds"; exit 2; }
mkdir -p "$work"
umask 077

install_rc=-1; guard_rc=-1; selftest_rc=-1; check_rc=-1; controls_rc=-1; subjects_rc=-1; swept=false
left_labelled=-1; left_containers=-1; left_volumes=-1; uid_procs=-1; runsc_procs=-1
gvisor=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).release || ""))' "$msc/gvisor.json" 2>/dev/null || true)
msc_commit=$(git -C "$msc" rev-parse HEAD 2>/dev/null || true)

write_state() {
  node -e '
    const [file, ...v] = process.argv.slice(1);
    const n = (x) => (/^-?[0-9]{1,4}$/.test(x) ? Number(x) : null);
    const s = { install_rc: n(v[0]), guard_rc: n(v[1]), selftest_rc: n(v[2]), selftest_check_rc: n(v[3]), controls_rc: n(v[4]), subjects_rc: n(v[5]), swept: v[6] === "true", msc_commit: /^[0-9a-f]{40}$/.test(v[7]) ? v[7] : null, gvisor_release: v[8] || null, worker_kit_ref: /^[0-9a-f]{40}$/.test(v[9]) ? v[9] : null, left: { labelled: n(v[10]), containers: n(v[11]), volumes: n(v[12]), uid_65534_processes: n(v[13]), runsc_processes: n(v[14]) }, finished_at: new Date().toISOString() };
    require("fs").writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
  ' "$work/sandbox.json" "$install_rc" "$guard_rc" "$selftest_rc" "$check_rc" "$controls_rc" "$subjects_rc" "$swept" "$msc_commit" "$gvisor" "${WORKER_KIT_REF:-}" \
    "$left_labelled" "$left_containers" "$left_volumes" "$uid_procs" "$runsc_procs"
}

sweep() {
  local ids
  ids=$(docker ps -aq --filter label=isokron.surface.run); [ -z "$ids" ] || docker rm -f -v $ids
  ids=$(docker network ls -q --filter label=isokron.surface.run); [ -z "$ids" ] || docker network rm $ids
  ids=$(docker volume ls -q --filter label=isokron.surface.run); [ -z "$ids" ] || docker volume rm -f $ids
}

# The driver, with its public lines only; its exit status is returned.
drive() {
  local list="$1" out="$2" limit="$3"
  mkdir -p "$out/_shard"
  timeout --kill-after=30 "$limit" node "$msc/bin/run-shard.mjs" --targets "$list" --out "$out" --lane ci \
    2>>"$out/_shard/driver-stderr.log" | grep --line-buffered -E '^run finished, exit [0-9]+$'
  return "${PIPESTATUS[0]}"
}

# 1. gVisor first: registering runsc restarts the Docker daemon; then the firewall. The logs stay ours (not root's).
# shellcheck disable=SC2024
sudo "$msc/scripts/install-runsc.sh" "$(command -v node)" >"$work/install-runsc.log" 2>&1; install_rc=$?
# shellcheck disable=SC2024
if [ "$install_rc" -eq 0 ]; then sudo "$msc/scripts/net-guard.sh" >"$work/net-guard.log" 2>&1; guard_rc=$?; fi
if [ "$install_rc" -ne 0 ] || [ "$guard_rc" -ne 0 ]; then
  echo "::error title=live-probe::the sandbox could not be set up (gVisor $install_rc, firewall $guard_rc); no target ran"
  tail -n 20 "$work/install-runsc.log" "$work/net-guard.log" 2>/dev/null
  write_state; exit 1
fi

# 2. The self test, then its telemetry check, which alone decides.
(cd "$msc" && node bin/sandbox-selftest.mjs --out "$work/selftest" --lane ci) >"$work/selftest.log" 2>&1; selftest_rc=$?
node "$msc/scripts/check-selftest.mjs" "$work/selftest/telemetry.jsonl" >"$work/selftest-check.txt" 2>&1; check_rc=$?
cat "$work/selftest-check.txt"
if [ "$check_rc" -ne 0 ]; then
  echo "::error title=live-probe::the sandbox self test failed (harness $selftest_rc, check $check_rc); no target ran"
  sweep >/dev/null 2>&1 || true
  write_state; exit 1
fi

export SURFACE_PROBE_MS="${SURFACE_PROBE_MS:-45000}"
# 3. The controls.
echo "controls:"
drive "$work/targets-controls.json" "$work/driver-controls" 900; controls_rc=$?
sweep >>"$work/sweep.log" 2>&1 || true

# 4. The subjects, until the deadline.
runnable=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).targets.length))' "$work/targets-subjects.json")
if [ "$runnable" -gt 0 ]; then
  left=$(( deadline - $(date +%s) ))
  if [ "$left" -gt 60 ]; then
    echo "subjects ($runnable, at most ${left}s):"
    drive "$work/targets-subjects.json" "$work/driver-subjects" "$left"; subjects_rc=$?
  else
    echo "::warning title=live-probe::no time left for the subjects"; subjects_rc=124
  fi
else
  subjects_rc=0
fi

# 5. Nothing of a target may outlive this step: no container or volume at all (labelled or not), no labelled
#    network, no host process running as the sandbox user (65534), and no runsc or containerd-shim-runsc process.
#    A process that got out some other way (another user, another name) is not seen here: corpus/LIVE-PROBE.md.
sweep >>"$work/sweep.log" 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pgrep -f 'runsc|containerd-shim-runsc' >/dev/null || break
  sleep 1
done
left_labelled=$(( $(docker ps -aq --filter label=isokron.surface.run | wc -l) + $(docker network ls -q --filter label=isokron.surface.run | wc -l) ))
left_containers=$(docker ps -aq | wc -l)
left_volumes=$(docker volume ls -q | wc -l)
uid_procs=$(pgrep -u 65534 | wc -l)
runsc_procs=$(pgrep -f 'runsc|containerd-shim-runsc' | wc -l)
if [ $(( left_labelled + left_containers + left_volumes + uid_procs + runsc_procs )) -eq 0 ]; then swept=true
else
  echo "::error title=live-probe::the sandbox is not gone: $left_labelled labelled, $left_containers containers, $left_volumes volumes, $uid_procs processes of uid 65534, $runsc_procs runsc processes"
  ps -eo pid,user,comm 2>/dev/null | awk '$2 == "nobody" || $2 == "65534" || $3 ~ /runsc|containerd-shim/' >>"$work/sweep.log" || true
fi
write_state
echo "sandbox: self test $check_rc, controls $controls_rc, subjects $subjects_rc, swept $swept"
exit 0
