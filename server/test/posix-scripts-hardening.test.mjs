import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Pins the shell-script hardening: the updater never deletes outside the
// install, the uninstaller never rm -rf's / or $HOME, server/data is created
// owner-only, and the macOS installer only unpacks release archives that match
// the signed SHA256SUMS. The functions are lifted out of the real scripts and
// run in isolation, so what is tested is the shipped text.

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(serverDir, rel), 'utf8');
const posix = { skip: process.platform === 'win32' };

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-sh-'));
}

// Extract a bash function body by name (from "name() {" to the first line that
// is exactly "}").
function bashFunction(src, name) {
  const start = src.indexOf(`${name}() {`);
  assert.ok(start >= 0, `${name} not found`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 3);
}

test('update-apply.sh: manifest entries that escape the install are never candidates', posix, () => {
  const src = read('update-apply.sh');
  const m = src.match(/why="\$\("\$NODE_BIN" -e '([\s\S]*?)' "\$MANIFEST_PATH"/);
  assert.ok(m, 'node filter found');
  const dir = scratch();
  try {
    const root = path.join(dir, 'root');
    fs.mkdirSync(path.join(root, 'server', 'real'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'outside'));
    fs.symlinkSync(path.join(dir, 'outside'), path.join(root, 'server', 'shared'));
    const manifest = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({
      version: '5.0.0',
      files: ['server/real/old.js', '../evil', 'server/../../evil', '/etc/passwd', 'a/./b', 'a//b',
        'a\\..\\b', 'server/shared/victim.js', 'kept.js', ''],
    }));
    const staged = path.join(dir, 'staged.txt');
    fs.writeFileSync(staged, 'kept.js\n');
    const out = path.join(dir, 'out.txt');
    execFileSync(process.execPath, ['-e', m[1], manifest, staged, 'v5.0.0', out, root]);
    assert.deepEqual(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean), ['server/real/old.js']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('uninstall.sh: refuses to remove /, $HOME, an empty path or a non-Xenon folder', posix, () => {
  const fn = bashFunction(read('uninstall.sh'), 'root_dir_is_removable');
  const dir = scratch();
  try {
    const home = path.join(dir, 'home', 'me');
    const xenon = path.join(dir, 'Xenon');
    const other = path.join(dir, 'other');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(xenon, 'server'), { recursive: true });
    fs.writeFileSync(path.join(xenon, 'package.json'), '{\n  "name": "xenon-edge-widget",\n  "version": "5.0.0"\n}\n');
    fs.writeFileSync(path.join(xenon, 'server', 'server.js'), '');
    fs.mkdirSync(path.join(other, 'server'), { recursive: true });
    fs.writeFileSync(path.join(other, 'package.json'), '{"name":"something-else"}');
    fs.writeFileSync(path.join(other, 'server', 'server.js'), '');
    const check = (target) => spawnSync('bash', ['-c', `${fn}\nroot_dir_is_removable "$1"`, 'x', target],
      { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    for (const bad of ['', '/', home, path.dirname(home), other, path.join(dir, 'missing')]) {
      const r = check(bad);
      assert.notEqual(r.status, 0, `must refuse ${JSON.stringify(bad)}`);
      assert.ok(r.stdout.trim().length > 0, 'says why');
    }
    assert.equal(check(xenon).status, 0, 'a real Xenon install is removable');
    // Through a symlink to / it is still /.
    fs.symlinkSync('/', path.join(dir, 'rootlink'));
    assert.notEqual(check(path.join(dir, 'rootlink')).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('uninstall.sh: the detached deleter itself refuses / and an empty target', () => {
  const src = read('uninstall.sh');
  assert.match(src, /case "\$target" in ''\|\/\|\/\/\*\) rm -f "\$self"; exit 1 ;; esac/);
});

test('install.sh and the app bootstrap create server/data owner-only', () => {
  assert.match(read('install.sh'), /mkdir -p "\$DATA_DIR"\n[\s\S]{0,400}\nchmod 700 "\$DATA_DIR"/);
  const boot = fs.readFileSync(path.join(serverDir, '..', 'apps', 'native', 'src-tauri', 'posix', 'xenon-bootstrap.sh'), 'utf8');
  assert.match(boot, /mkdir -p "\$INSTALL_ROOT\/server\/data"\n[\s\S]{0,400}chmod 700 "\$INSTALL_ROOT\/server\/data"/);
});

test('install.sh: macOS archives come only from the signed-manifest verifier', () => {
  const src = read('install.sh');
  for (const asset of ['MediaRemoteAdapter-macos.tar.gz', 'xenon-helper-macos.tar.gz']) {
    assert.ok(src.includes(`fetch_verified_asset '${asset}'`), asset);
    assert.ok(!src.includes(`releases/latest/download/${asset}`), `${asset} is no longer fetched unverified`);
  }
  assert.ok(src.includes('"$SERVER_DIR/release-asset-cli.js"'));
});

test('install.sh fetch_verified_asset: keeps a matching file, refuses a mismatch or a failure', posix, () => {
  const fn = bashFunction(read('install.sh'), 'fetch_verified_asset');
  const dir = scratch();
  try {
    const fakeServer = path.join(dir, 'server');
    const dest = path.join(dir, 'dest');
    fs.mkdirSync(fakeServer);
    fs.mkdirSync(dest);
    const body = 'archive bytes';
    const good = crypto.createHash('sha256').update(body).digest('hex');
    // A stand-in CLI: writes the file and reports the hash it was told to.
    fs.writeFileSync(path.join(fakeServer, 'release-asset-cli.js'), `
      const fs = require('fs'), path = require('path');
      const [asset, destDir] = process.argv.slice(2);
      const mode = process.env.FAKE_MODE;
      if (mode === 'fail') { console.log(JSON.stringify({ ok: false, error: 'no_entry' })); process.exit(1); }
      const p = path.join(destDir, asset);
      fs.writeFileSync(p, ${JSON.stringify(body)});
      const sha = mode === 'lie' ? '0'.repeat(64) : ${JSON.stringify(good)};
      console.log(JSON.stringify({ ok: true, path: p, sha256: sha }));
    `);
    const run = (mode) => spawnSync('bash', ['-c',
      `have() { command -v "$1" >/dev/null 2>&1; }\n${fn}\nfetch_verified_asset "$1" "$2"`, 'x', 'a.tar.gz', dest],
    { env: { ...process.env, NODE_BIN: process.execPath, SERVER_DIR: fakeServer, FAKE_MODE: mode }, encoding: 'utf8' });
    const ok = run('ok');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), path.join(dest, 'a.tar.gz'));
    const lie = run('lie');
    assert.notEqual(lie.status, 0);
    assert.equal(lie.stdout.trim(), '');
    assert.equal(fs.existsSync(path.join(dest, 'a.tar.gz')), false, 'a file that does not re-hash is deleted');
    const failed = run('fail');
    assert.notEqual(failed.status, 0);
    assert.equal(failed.stdout.trim(), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
