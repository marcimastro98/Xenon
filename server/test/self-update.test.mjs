import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSelfUpdate, buildZipUrl, pickSingleDir } = require('../self-update.js');

const ROOT = 'C:\\X';
const DATA = 'C:\\X\\server\\data';

function makeFs({ git = false, applier = true, app = false, marker = null } = {}) {
  return {
    existsSync: (p) => {
      const s = String(p);
      if (s.endsWith('.git')) return git;
      if (s.endsWith('update-apply.ps1')) return applier;
      if (s.includes('\\app\\server') && s.endsWith('server.js')) return app;
      return false;
    },
    readFileSync: (p) => {
      if (String(p).endsWith('staged.json')) {
        if (!marker) throw new Error('no marker');
        return JSON.stringify(marker);
      }
      throw new Error('unexpected read ' + p);
    },
  };
}

function make(opts) {
  const calls = [];
  const spawn = (file, args) => { calls.push({ file, args }); return { unref() {} }; };
  const su = createSelfUpdate({ root: ROOT, dataDir: DATA, fsImpl: makeFs(opts), spawn });
  return { su, calls };
}

test('buildZipUrl targets the tag source archive', () => {
  assert.equal(buildZipUrl('a/b', 'v3.3.0'), 'https://github.com/a/b/archive/refs/tags/v3.3.0.zip');
});

test('pickSingleDir returns the lone wrapper folder, else null', () => {
  const dir = (name) => ({ name, isDirectory: () => true });
  const file = (name) => ({ name, isDirectory: () => false });
  assert.equal(pickSingleDir([dir('Xenon-3.3.0'), file('readme')]), 'Xenon-3.3.0');
  assert.equal(pickSingleDir([dir('a'), dir('b')]), null);
  assert.equal(pickSingleDir([file('x')]), null);
});

test('supported(): false on a git checkout', () => {
  const { su } = make({ git: true });
  assert.equal(su.supported(), false);
});

test('supported(): false when the applier script is missing', () => {
  const { su } = make({ applier: false });
  assert.equal(su.supported(), false);
});

test('supported(): true on a normal install with the applier present', () => {
  const { su } = make({ git: false, applier: true });
  assert.equal(su.supported(), true);
});

test('staged(): version only when both marker and staged build exist', () => {
  assert.deepEqual(make({ app: true, marker: { version: '3.3.0' } }).su.staged(), { version: '3.3.0' });
  assert.equal(make({ app: false, marker: { version: '3.3.0' } }).su.staged(), null, 'no app tree → not staged');
  assert.equal(make({ app: true, marker: null }).su.staged(), null, 'no marker → not staged');
});

test('apply(): refuses when unsupported or nothing staged, launches the applier when ready', () => {
  assert.deepEqual(make({ git: true }).su.apply(), { ok: false, error: 'unsupported' });
  assert.deepEqual(make({ applier: true, app: false }).su.apply(), { ok: false, error: 'not_staged' });

  const ready = make({ applier: true, app: true, marker: { version: '3.3.0' } });
  assert.deepEqual(ready.su.apply(), { ok: true, started: true });
  assert.equal(ready.calls.length, 1, 'spawns once');
  const c = ready.calls[0];
  assert.equal(c.file, 'powershell');
  assert.ok(c.args.join(' ').includes('Start-Process powershell -Verb RunAs'), 'launches elevated');
  assert.ok(c.args.join(' ').includes('update-apply.ps1'), 'runs the applier script');
});
