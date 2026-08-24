// How the Windows setup decides the dashboard libraries are present.
//
// It used to ask the filesystem: `Test-Path node_modules\ws`. A folder is not a
// module. An npm install interrupted part-way — a closed window, a dropped
// connection, an antivirus holding a file mid-write — leaves the directory
// behind with nothing usable inside it, and the two answers then disagree
// forever: Test-Path says present, `require('ws')` says MODULE_NOT_FOUND.
//
// That disagreement is the whole bug reported on Discord. The setup reported
// "dependencies already installed" and skipped the repair; its final summary
// said every component was OK; the retry pass saw nothing to retry; and the
// engine died on `require('ws')` at every launch, which the app could only
// show as "Xenon isn't finished installing" with a button leading back to the
// same skip. The user's own run named the module: Cannot find module 'ws'.
//
// So all three sites ask node instead. PowerShell cannot run here, but the part
// that has to be RIGHT is the probe — and the probe is JavaScript, so it is
// lifted out of the script and run against real fixtures, both ways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PS1 = readFileSync(new URL('../install.ps1', import.meta.url), 'utf8');
const LOCK = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));

/** The probe exactly as install.ps1 builds it, with $dep filled in. */
function probeFor(dep) {
  const m = PS1.match(/\$probe = "([^"]+)"/);
  assert.ok(m, 'install.ps1 must still build the probe as a $probe string');
  const js = m[1].replace('$dep', dep);
  assert.ok(!js.includes('$'), `the probe must be fully substituted, got: ${js}`);
  return js;
}

/** Runs the real probe from `cwd`, returning its exit code the way the setup reads it. */
function runProbe(dep, cwd) {
  return spawnSync(process.execPath, ['-e', probeFor(dep)], { cwd, encoding: 'utf8' }).status;
}

function withTempRoot(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'xenon-deps-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A module that actually loads. */
function installReal(root, name) {
  const dir = path.join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
  writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};');
}

// ── The exact failure that was reported ──────────────────────────────────────

test('a folder left behind by a half-finished install is not counted as present', () => {
  withTempRoot((root) => {
    // Precisely what the old check passed on, and what the user had.
    mkdirSync(path.join(root, 'node_modules', 'ws'), { recursive: true });
    assert.notEqual(runProbe('ws', root), 0, 'an empty module folder must read as missing');
  });
});

test('a dependency that is genuinely absent reads as missing', () => {
  withTempRoot((root) => {
    assert.notEqual(runProbe('ws', root), 0);
  });
});

// The other direction matters just as much: a probe that always answered
// "missing" would re-run npm install on every setup, forever.
test('a dependency that really loads reads as present', () => {
  withTempRoot((root) => {
    for (const dep of ['ws', 'koffi', 'msedge-tts']) installReal(root, dep);
    for (const dep of ['ws', 'koffi', 'msedge-tts']) {
      assert.equal(runProbe(dep, root), 0, `${dep} should resolve`);
    }
  });
});

test('a package.json pointing at a file that is not there reads as missing', () => {
  withTempRoot((root) => {
    // npm writes the manifest before the files it names — an install killed in
    // that window leaves exactly this.
    const dir = path.join(root, 'node_modules', 'ws');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ws', main: 'index.js' }));
    assert.notEqual(runProbe('ws', root), 0);
  });
});

// The setup runs the probe with -WorkingDirectory $root, and node resolves an
// `-e` script against the working directory. If that ever stopped being true
// the check would answer about the wrong folder.
test('the probe answers about the folder it is run from', () => {
  withTempRoot((root) => {
    installReal(root, 'ws');
    assert.equal(runProbe('ws', root), 0);
    const elsewhere = path.join(root, 'elsewhere');
    mkdirSync(elsewhere);
    // A nested folder still sees the parent's node_modules — that is node's own
    // upward search, and the server relies on it too (server/ has no
    // node_modules of its own).
    assert.equal(runProbe('ws', elsewhere), 0, 'node searches upward');
  });
});

// ── The script itself ────────────────────────────────────────────────────────

// Three sites asked the same wrong question: the pre-install skip, the
// post-install verification, and Get-ComponentStatus — which drives BOTH the
// "everything is installed" summary and the automatic retry pass. Leaving any
// one of them on a path check would keep the loop alive through that site.
test('no dependency check asks the filesystem any more', () => {
  assert.doesNotMatch(
    PS1,
    /Test-Path \(Join-Path \$root "node_modules/,
    'a folder-existence check on node_modules is what this fix removed',
  );
  const uses = PS1.match(/Get-UnloadableNodeDeps/g) || [];
  // One definition plus the three call sites.
  assert.ok(uses.length >= 4, `expected the resolver check at every site, found ${uses.length}`);
});

test('the component summary and the retry pass read the same answer', () => {
  const status = PS1.slice(PS1.indexOf('function Get-ComponentStatus'), PS1.indexOf('function Invoke-ComponentRetryPass'));
  assert.match(status, /'Dashboard libraries'\s*=\s*\(\(Get-UnloadableNodeDeps/);
});

// Without node there is no answer, and "no answer" must mean install rather
// than skip — skipping on a question you could not ask is how this started.
test('an unanswerable probe reports everything missing, not everything fine', () => {
  const fn = PS1.slice(PS1.indexOf('function Get-UnloadableNodeDeps'), PS1.indexOf('function Install-NpmDependenciesIfNeeded'));
  assert.match(fn, /if \(-not \$NodePath\) \{ return @\(\$requiredNodeDeps\) \}/);
  // …and a probe that throws counts against the module too.
  assert.match(fn, /catch \{[\s\S]*\$missing \+= \$dep/);
});

// ── Why the install may skip lifecycle scripts ───────────────────────────────
//
// The install that broke never finished because of a dependency that refuses to
// be installed by npm: msedge-tts declares `preinstall: npx only-allow pnpm`, a
// guard whose purpose is to fail unless the caller is pnpm. On the reporter's PC
// %APPDATA%\npm did not exist, so npx itself died with ENOENT, the preinstall
// failed, npm aborted the tree, and node_modules was left half-written.
//
// So the setup installs with --ignore-scripts. These pin the two facts that make
// that safe, against the lockfile, so a dependency bump that changed either one
// fails here instead of on a user's machine.

test('the setup installs without running dependency lifecycle scripts', () => {
  const installs = PS1.match(/-ArgumentList[^\n]*'install'[^\n]*/g) || [];
  assert.ok(installs.length >= 2, 'both npm invocations must be covered');
  for (const line of installs) {
    assert.match(line, /'--ignore-scripts'/, `npm invocation without the flag: ${line.trim()}`);
  }
});

// The load-bearing one. koffi is native, so if its binary arrived from a BUILD
// step, skipping scripts would leave the RGB bridge dead — silently, and only on
// the user's machine. It does not: npm ships one prebuilt package per platform,
// selected by `os`, and none of them has an install script of its own. koffi's
// own install script is the fallback for a platform with no prebuilt package.
test("koffi's native binary arrives as a package, not as a build step", () => {
  const prebuilts = Object.entries(LOCK.packages)
    .filter(([name]) => name.includes('@koromix/koffi-'));
  assert.ok(prebuilts.length > 0, 'koffi must still ship per-platform prebuilt packages');

  const windows = prebuilts.filter(([, meta]) => (meta.os || []).includes('win32'));
  assert.ok(windows.length > 0, 'the platform Xenon installs on must have a prebuilt package');

  for (const [name, meta] of prebuilts) {
    assert.ok(!meta.hasInstallScript, `${name} must not need a script to install`);
    assert.equal(meta.optional, true, `${name} is selected by platform, so it must be optional`);
  }
});

// ws must stay script-free, and the two that do declare scripts must stay the
// two we have reasoned about. A NEW dependency with an install script would need
// its own judgement before --ignore-scripts could be assumed harmless for it.
test('only the packages we have reasoned about declare install scripts', () => {
  const withScripts = Object.entries(LOCK.packages)
    .filter(([, meta]) => meta.hasInstallScript)
    .map(([name]) => name.replace(/^node_modules\//, ''));
  // '' is the root project — that entry IS our own postinstall, the one
  // Restore-SharedFolderLinks now runs by hand. koffi's is the no-prebuilt
  // fallback and msedge-tts's is the pnpm guard; both are covered above. A NEW
  // name here is a dependency whose install script nobody has judged yet, and
  // --ignore-scripts must not be assumed harmless for it until someone has.
  assert.deepEqual(withScripts.sort(), ['', 'koffi', 'msedge-tts']);
});

// --ignore-scripts skips OUR postinstall too, and that one is required: it makes
// the server\shared junction the dashboard serves /shared/src/*.js through.
test('the setup runs our own postinstall explicitly', () => {
  assert.match(PS1, /function Restore-SharedFolderLinks/);
  assert.match(PS1, /tools\\link-shared\.mjs/, 'it must call the same script package.json does');
  const fn = PS1.slice(PS1.indexOf('function Install-NpmDependenciesIfNeeded'));
  const calls = fn.match(/Restore-SharedFolderLinks/g) || [];
  assert.ok(calls.length >= 2, 'both the skip path and the success path must link');
});

// package.json is what defines the step; if the postinstall is ever renamed or
// dropped, the explicit call above is pointing at nothing.
test('the explicit call and package.json name the same script', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.postinstall, /link-shared\.mjs/);
});
