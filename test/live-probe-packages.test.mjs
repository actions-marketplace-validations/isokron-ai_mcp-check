// The live-probe lane's package types beyond npm, PyPI and OCI images (corpus/live-probe.mjs, corpus/LIVE-PROBE.md
// "Package types"): how a subject's crate is resolved into a sandbox launch, how long it may build and where it runs in
// the shard, and whose fault a failed install is. The sandbox's side (images, hardening, the proxy's allowlist, the
// entry helpers) is tested in isokron-ai/mcp-surface-corpus (test/package-kinds.test.mjs, R-SBX-35 to R-SBX-43). Each
// protection has a mutation check: with it taken out of a copy of the module, the fixture that pins it gets through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as LP from '../corpus/live-probe.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const NODE24 = 'docker.io/library/node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';

function res(status, body) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : null) }, arrayBuffer: async () => buf };
}
/** The official registry, answering searches from a list of servers; nothing else is reachable. */
function registry(servers) {
  return async (url) => {
    const u = new URL(url);
    if (u.hostname !== 'registry.modelcontextprotocol.io') throw new Error('unexpected fetch ' + url);
    const q = (u.searchParams.get('search') || '').toLowerCase();
    return res(200, { servers: servers.filter((s) => s.name.toLowerCase().includes(q) || (s.packages || []).some((p) => String(p.identifier).toLowerCase().includes(q))).map((server) => ({ server })) });
  };
}
const server = (name, repo, packages) => ({ name, version: '1.0.0', repository: { url: 'https://github.com/' + repo, source: 'github' }, packages });
const crate = (identifier, extra = {}) => ({ registryType: 'cargo', identifier, version: '0.4.1', transport: { type: 'stdio' }, ...extra });
const items = (subjects) => JSON.stringify(subjects.map((subject, i) => ({ subject, run_key: String(i + 1).repeat(64).slice(0, 64), fence: i + 1 })));

/** A copy of corpus/live-probe.mjs with one protection taken out, beside the original so its imports resolve. */
async function mutant(from, to) {
  const src = readFileSync(join(root, 'corpus', 'live-probe.mjs'), 'utf8');
  assert.ok(src.includes(from), 'the mutation text is in corpus/live-probe.mjs: ' + from.slice(0, 80));
  const file = join(root, 'corpus', '.mutant-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.mjs');
  writeFileSync(file, src.replace(from, to));
  try { return await import(pathToFileURL(file).href); } finally { rmSync(file, { force: true }); }
}

// ------------------------------------------------------------------ crates

test('R-LP-54: a crate resolves to a sandbox build of exactly that crate (checked name, exact version or latest), after npm, PyPI and images; never a crate named like an option', async () => {
  const f = registry([
    server('io.github.acme/rusty', 'acme/rusty', [crate('rusty-mcp')]),
    server('io.github.acme/both', 'acme/both', [crate('both-mcp'), { registryType: 'npm', identifier: 'both-mcp', version: '1.0.0', transport: { type: 'stdio' } }]),
    server('io.github.acme/evil', 'acme/evil', [crate('--git=https://evil.example/x')]),
    server('io.github.acme/ranged', 'acme/ranged', [crate('ranged', { version: '^1.2' })]),
    server('io.github.acme/private', 'acme/private', [crate('private', { registryBaseUrl: 'https://crates.acme.example' })]),
  ]);
  const r = (s) => LP.resolveSubject({ subject: s, repo: s }, { fetch: f });
  const rusty = await r('acme/rusty');
  assert.equal(rusty.status, 'runnable');
  assert.deepEqual(rusty.launch, { kind: 'cargo', crate: 'rusty-mcp', version: '0.4.1' });
  assert.equal(rusty.choice.purl, 'pkg:cargo/rusty-mcp@0.4.1');
  assert.equal((await r('acme/both')).launch.kind, 'npm', 'an installed package before a build');
  assert.equal((await r('acme/evil')).detail, 'launch_invalid');
  assert.equal((await r('acme/ranged')).launch.version, 'latest', 'a range is not passed to cargo; the latest release is built');
  assert.equal((await r('acme/private')).detail, 'private_registry');
  // The seed list alone (no registry entry): the seed's crate, latest.
  const seedOnly = await LP.resolveSubject({ subject: 'acme/seeded', repo: 'acme/seeded' }, { fetch: registry([]), seed: new Map([['acme/seeded', [{ registry: 'cargo', identifier: 'seeded' }]]]) });
  assert.deepEqual([seedOnly.status, seedOnly.launch, seedOnly.choice.verified_by], ['runnable', { kind: 'cargo', crate: 'seeded', version: 'latest' }, 'seed']);
  // A registry entry that names the repository but is not the owner's: crates.io has no signed provenance we check, so it is not the subject's.
  const other = await LP.resolveSubject({ subject: 'acme/claimed', repo: 'acme/claimed' }, { fetch: registry([server('io.github.mallory/claimed', 'acme/claimed', [crate('x')])]) });
  assert.equal(other.detail, 'unverified_registry_entry');
});

test('R-LP-54 mutation check: without the crate name check an option-like crate name reaches the sandbox', async () => {
  const f = registry([server('io.github.acme/evil', 'acme/evil', [crate('--git=https://evil.example/x')])]);
  const M = await mutant("    if (!CRATE_NAME.test(id)) return { detail: 'launch_invalid' };\n    const v = version", '    const v = version');
  assert.equal((await M.resolveSubject({ subject: 'acme/evil', repo: 'acme/evil' }, { fetch: f })).launch.crate, '--git=https://evil.example/x');
});

test('R-LP-55: a crate builds after the other subjects, in a list of its own, with the build cap on top of its share; the others share a budget that leaves room for it', async () => {
  const servers = [server('io.github.a/one', 'a/one', [{ registryType: 'npm', identifier: 'one', version: '1.0.0', transport: { type: 'stdio' } }]), server('io.github.a/two', 'a/two', [crate('two')])];
  const inputs = LP.parseInputs({ shardId: 's', attemptId: 'a1', items: items(['a/one', 'a/two']) });
  const plan = await LP.planShard({ inputs, fetch: registry(servers) });
  const [one, two] = plan.items;
  assert.equal(plan.subject_timeout_s, LP.subjectTimeout(1, LP.BUILD_RESERVE_S));
  assert.equal(one.target.timeout_s, plan.subject_timeout_s + LP.ORACLE_ALLOWANCE_S);
  assert.equal(two.target.timeout_s, Math.min(1800, plan.subject_timeout_s + LP.ORACLE_ALLOWANCE_S + LP.BUILD_ALLOWANCE_S));
  assert.ok(two.target.timeout_s >= 15 * 60 + LP.SUBJECT_TIMEOUT_MIN_S, 'room for the whole 15-minute build and a probe');
  const lists = LP.targetLists(plan, { node24Image: NODE24 });
  assert.deepEqual(lists.subjects.targets.map((t) => t.id), ['s001']);
  assert.deepEqual(lists.builds.targets.map((t) => t.id), ['s002']);
  assert.ok(LP.subjectTimeout(9, LP.BUILD_RESERVE_S) < LP.subjectTimeout(9), 'a shard with a crate leaves time for it');
  // The sandbox script runs the builds after the subjects and before the images, and records builds_rc.
  const sh = readFileSync(join(root, 'corpus', 'live-probe-sandbox.sh'), 'utf8');
  const at = (s) => { const i = sh.indexOf(s); assert.ok(i > 0, s); return i; };
  assert.ok(at('drive "$work/targets-subjects.json"') < at('drive "$work/targets-builds.json" "$work/driver-builds"') && at('drive "$work/targets-builds.json"') < at('drive "$work/oci/$id.json"'));
  assert.match(sh, /builds_rc: n\(v\[16\]\)/);
});

test('R-LP-55 mutation check: without the build list a crate would run among the subjects on a subject\'s time limit', async () => {
  const servers = [server('io.github.a/two', 'a/two', [crate('two')])];
  const inputs = LP.parseInputs({ shardId: 's', attemptId: 'a1', items: items(['a/two']) });
  const M = await mutant("export const isBuild = (launch) => !!(launch && launch.kind === 'cargo');", 'export const isBuild = () => false;');
  const plan = await M.planShard({ inputs, fetch: registry(servers) });
  const lists = M.targetLists(plan, { node24Image: NODE24 });
  assert.deepEqual([lists.subjects.targets.length, lists.builds.targets.length], [1, 0]);
  assert.ok(plan.items[0].target.timeout_s < 15 * 60, 'no room for the build');
});

const cargoRec = (steps, o = {}) => ({ install: { kind: 'cargo', ok: false, steps, egress_refused: 0, ...o }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 60000 }, timed_out: false });
const LAUNCH = { kind: 'cargo', crate: 'rusty-mcp', version: 'latest' };
const fd = (rec, stepsLog, owned = true) => LP.failureDetail(rec, null, null, { stepsLog, launch: LAUNCH, argsUnfilled: 0, owned });

test('R-LP-56: a crate\'s failed install is the crate\'s only on cargo\'s own word before anything compiled, with no trouble reaching crates.io, and only when its registry entry is the subject\'s own; what our entry helper cannot find and everything else is ours', () => {
  const install = (exit = 101) => [{ name: 'install', exit, timed_out: false }];
  assert.equal(fd(cargoRec(install()), '    Updating crates.io index\nerror: could not find `rusty-mcp` in registry `crates-io` with version `*`\n'), 'install_failed');
  assert.equal(fd(cargoRec(install()), 'error: could not find `rusty_mcp` in registry `crates-io`\n'), 'install_failed', 'cargo treats - and _ alike');
  assert.equal(fd(cargoRec(install()), 'error: there is nothing to install in `rusty-mcp v0.4.1`, because it has no binaries\n`cargo install` is only for installing programs, and can\'t be used with libraries.\n'), 'package_not_runnable');
  // Another crate's name: not this crate's word.
  assert.equal(fd(cargoRec(install()), 'error: could not find `serde-evil` in registry `crates-io`\n'), 'install_build_failed');
  // After a Compiling line a build script may print anything: never the crate's absence.
  assert.equal(fd(cargoRec(install()), '   Compiling evil-build v0.1.0\nerror: could not find `rusty-mcp` in registry `crates-io`\n'), 'install_build_failed');
  // Trouble reaching crates.io: our side.
  assert.equal(fd(cargoRec(install()), 'warning: spurious network error (2 tries remaining): [7] Couldn\'t connect to server\nerror: could not find `rusty-mcp` in registry `crates-io`\n'), 'install_build_failed');
  assert.equal(fd(cargoRec(install(), { egress_refused: 1 }), 'error: could not find `rusty-mcp` in registry `crates-io`\n'), 'install_blocked');
  assert.equal(fd(cargoRec(install(137)), ''), 'install_resource_limit');
  assert.equal(fd(cargoRec([{ name: 'install', exit: null, timed_out: true }]), ''), 'install_timeout');
  assert.equal(fd(cargoRec(install()), 'error: linker `cc` not found\n'), 'install_build_failed');
  // The entry helper (mcp-surface-corpus sandbox/cargo-entry.mjs) runs after a successful install: what it cannot find is a
  // limit of its own checks (its name pattern, its regular-file test), never the crate's; several is ours too (no guess).
  const entry = (error) => [{ name: 'install', exit: 0 }, { name: 'entry', exit: 1, result: { error } }];
  for (const e of ['no_binary', 'not_installed', null]) assert.equal(fd(cargoRec(entry(e)), ''), 'entry_unresolved', String(e));
  assert.equal(fd(cargoRec(entry('several_binaries')), ''), 'entry_ambiguous');
  assert.equal(fd(cargoRec([{ name: 'install', exit: 0 }, { name: 'entry', exit: 1 }]), ''), 'entry_unresolved');
  // cargo's own word about a crate whose registry entry is not the subject's own (seed-only, seed-matched, repository-only): ours.
  assert.equal(fd(cargoRec(install()), 'error: could not find `rusty-mcp` in registry `crates-io`\n', false), 'package_error_unowned');
  assert.equal(fd(cargoRec(install()), 'error: there is nothing to install in `rusty-mcp v0.4.1`, because it has no binaries\n', false), 'package_error_unowned');
  assert.equal(LP.ownedEntry({ matched_by: 'repository+namespace+seed' }), true);
  for (const m of ['seed', 'seed-only', 'repository', 'repository+seed', null]) assert.equal(LP.ownedEntry({ matched_by: m }), false, String(m));
  assert.deepEqual(LP.DETAILS.entry_unresolved, ['install_failed_registry', false, 'install', 'tool']);
  assert.deepEqual(LP.DETAILS.package_error_unowned, ['install_failed_registry', false, 'install', 'tool']);
  // npm's and pip's package-error words in a crate's log are not evidence about the crate.
  assert.equal(fd(cargoRec(install()), '   Compiling x\nnpm ERR! code E404\nNo matching distribution found for x\n'), 'install_build_failed');
  for (const d of ['package_not_runnable', 'entry_ambiguous']) assert.ok(LP.DETAILS[d], d);
  assert.deepEqual(LP.DETAILS.package_not_runnable, ['install_failed_registry', false, 'install', 'subject']);
  assert.deepEqual(LP.DETAILS.entry_ambiguous, ['install_failed_registry', false, 'install', 'tool']);
});

test('R-LP-56 mutation check: without the Compiling guard, the network guard, the same-crate check or the ownership gate, a crate is blamed for what it did not say', async () => {
  for (const [from, to, log] of [
    ["  if (/^\\s*Compiling /m.test(t) || CARGO_NOT_THE_CRATE.test(t)) return null;", '  if (CARGO_NOT_THE_CRATE.test(t)) return null;', '   Compiling evil-build v0.1.0\nerror: could not find `rusty-mcp` in registry `crates-io`\n'],
    ["  if (/^\\s*Compiling /m.test(t) || CARGO_NOT_THE_CRATE.test(t)) return null;", "  if (/^\\s*Compiling /m.test(t)) return null;", 'warning: spurious network error (2 tries remaining)\nerror: could not find `rusty-mcp` in registry `crates-io`\n'],
    ['  if (missing && same(missing[1])) return \'install_failed\';', "  if (missing) return 'install_failed';", 'error: could not find `serde-evil` in registry `crates-io`\n'],
  ]) {
    assert.equal(fd(cargoRec([{ name: 'install', exit: 101 }]), log), 'install_build_failed');
    const M = await mutant(from, to);
    assert.equal(M.failureDetail(cargoRec([{ name: 'install', exit: 101 }]), null, null, { stepsLog: log, launch: LAUNCH, argsUnfilled: 0, owned: true }), 'install_failed', 'without the guard: ' + from.slice(0, 50));
  }
  // Without the ownership gate a seed-only crate's absence would be the subject's.
  const log = 'error: could not find `rusty-mcp` in registry `crates-io`\n';
  assert.equal(fd(cargoRec([{ name: 'install', exit: 101 }]), log, false), 'package_error_unowned');
  const M = await mutant("      return ev ? (owned ? ev : 'package_error_unowned') : 'install_build_failed';", "      return ev || 'install_build_failed';");
  assert.equal(M.failureDetail(cargoRec([{ name: 'install', exit: 101 }]), null, null, { stepsLog: log, launch: LAUNCH, argsUnfilled: 0, owned: false }), 'install_failed');
});
