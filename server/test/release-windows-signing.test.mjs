// The Windows half of a release is signed inside ONE SimplySign session, on a
// GitHub-hosted runner by default or on the signing PC. A slip here either
// ships unsigned binaries, leaks the one-time-code seed to build steps, or
// logs the maintainer's own session out: these pin each of those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RELEASE = readFileSync(fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const jobs = RELEASE.split(/\n  (?=[a-z-]+:\n)/);
const job = (name) => jobs.find((j) => j.startsWith(`${name}:\n`)) || '';
const steps = (text) => text.split(/\n      - name: /).slice(1).map((s) => ({ name: s.slice(0, s.indexOf('\n')), body: s }));
const stepAt = (list, name) => list.findIndex((s) => s.name.startsWith(name));

test('the gate picks the signer: input, then repo variable, then hosted, nothing else', () => {
  const gate = job('gate');
  assert.match(gate, /signer: \$\{\{ steps\.check\.outputs\.signer \}\}/);
  assert.match(gate, /SIGNER_INPUT: \$\{\{ inputs\.signer \}\}/);
  assert.match(gate, /SIGNER_VAR: \$\{\{ vars\.WINDOWS_SIGNER \}\}/);
  assert.match(gate, /signer="\$\{SIGNER_VAR:-hosted\}"/);
  assert.match(gate, /hosted\|home\) [^\n]*\n\s+\*\) [^\n]*exit 1/);
  assert.match(RELEASE, /signer:\n\s+description: [^\n]+\n\s+type: choice\n\s+options: \[default, hosted, home\]\n\s+default: default/);
});

test('native runs where the session is: hosted in windows-signing, home on the signing PC', () => {
  const native = job('native');
  assert.match(native, /runs-on: \$\{\{ needs\.gate\.outputs\.signer == 'home' && fromJSON\('\["self-hosted", "windows", "xenon-signing"\]'\) \|\| 'windows-latest' \}\}/);
  assert.match(native, /environment: \$\{\{ needs\.gate\.outputs\.signer == 'home' && 'release-signing' \|\| 'windows-signing' \}\}/);
  assert.match(native, /XENON_SIGNER: \$\{\{ needs\.gate\.outputs\.signer \}\}/);
});

test('the session opens after the long compile and closes after the last signature, hosted only', () => {
  const list = steps(job('native'));
  const engine = stepAt(list, 'Build the engine the installer carries');
  const compile = stepAt(list, 'Compile the native app ahead of signing');
  const open = stepAt(list, 'Open a SimplySign session');
  const decide = stepAt(list, 'Decide whether this build is Authenticode-signed');
  const build = stepAt(list, 'Build the native app');
  const verify = stepAt(list, 'Verify the installer is signed');
  const close = stepAt(list, 'Close the SimplySign session');
  assert.ok(engine >= 0 && engine < compile && compile < open && open < decide && decide < build && build < verify && verify < close,
    'engine, compile, open, decide, signed build, verify, close');
  assert.match(list[compile].body, /npm run build -- --no-bundle --config \$engineConf/);
  assert.match(list[open].body, /if: env\.XENON_SIGNER == 'hosted'\n/);
  assert.match(list[open].body, /session\.ps1" -Action Connect/);
  // Unsigned (no thumbprint) builds never log in.
  assert.match(list[open].body, /IsNullOrWhiteSpace\(\$env:IN_THUMBPRINT\)[\s\S]*exit 0[\s\S]*-Action Connect/);
  // Closed even when a step failed, and never on the signing PC: that session is the maintainer's.
  assert.match(list[close].body, /if: always\(\) && env\.XENON_SIGNER == 'hosted'\n/);
  assert.match(list[close].body, /session\.ps1" -Action Disconnect/);
});

test('the one-time-code seed reaches only the step that logs in', () => {
  const holders = jobs.filter((j) => j.includes('CERTUM_OTPAUTH_URI: ${{ secrets.'));
  assert.equal(holders.length, 1);
  const list = steps(job('native'));
  const withSeed = list.filter((s) => s.body.includes('secrets.CERTUM_OTPAUTH_URI'));
  assert.deepEqual(withSeed.map((s) => s.name), ['Open a SimplySign session (hosted signer)']);
});

test('the helper and the engine are built without secrets and signed by native under the same names', () => {
  for (const name of ['helper', 'capture']) {
    const text = job(name);
    assert.match(text, /runs-on: windows-latest/, name);
    assert.doesNotMatch(text, /secrets\./, `${name} holds no secret`);
  }
  const native = job('native');
  assert.match(native, /needs: \[gate, helper, capture\]/);
  for (const [name, path] of [['xenon-helper', 'win-tools/helper/xenon-helper.exe'], ['xenon-capture', 'win-tools/capture/xenon-capture.exe']]) {
    assert.match(native, new RegExp(`name: ${name}\\n\\s+path: ${path.replace(/[./]/g, '\\$&')}\\n\\s+overwrite: true`), name);
  }
});

test('a dry run builds and signs the Windows half from its own commit and publishes nothing', () => {
  assert.match(RELEASE, /dry_run:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: false/);
  for (const name of ['helper', 'capture', 'native']) {
    assert.match(job(name), /ref: \$\{\{ inputs\.dry_run && github\.sha \|\| inputs\.tag \|\|/, name);
  }
  for (const name of ['native-macos', 'native-linux', 'publish']) {
    assert.match(job(name), /if: needs\.gate\.outputs\.proceed == 'true' && !inputs\.dry_run/, name);
  }
});
