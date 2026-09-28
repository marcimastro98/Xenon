// A package import installs widgets but grants nothing. Until the grant prompt is
// both REACHABLE and VISIBLE, an installed widget is an installed dead widget —
// the reported symptom being "the permissions dialog sometimes doesn't appear",
// because the one prompt that did fire opened underneath the import modal.
//
// Three things have to hold, and each has bitten:
//   1. the prompt renders above the dialog that triggered it;
//   2. the import asks AFTER its own modal is gone;
//   3. several widgets are asked one at a time (the dialog supersedes itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CW = readFileSync(join(ROOT, 'server', 'js', 'custom-widget.js'), 'utf8');
const SHARE = readFileSync(join(ROOT, 'server', 'js', 'preset-share.js'), 'utf8');
const CSS = readFileSync(join(ROOT, 'server', 'components', 'CustomWidget', 'CustomWidget.css'), 'utf8');

function zIndexOf(css, selector) {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, selector + ' not found in CustomWidget.css');
  const m = css.slice(at, at + 260).match(/z-index:\s*(\d+)/);
  assert.ok(m, 'no z-index on ' + selector);
  return Number(m[1]);
}

// The import/share modals live at 2000 (SettingsModal.css .preset-modal-overlay).
const PRESET_MODAL_Z = 2000;

test('every host-drawn decision outranks the modal that can trigger it', () => {
  for (const sel of ['.cw-perm-backdrop', '.cw-clip-backdrop', '.cw-ext-backdrop']) {
    assert.ok(
      zIndexOf(CSS, sel) > PRESET_MODAL_Z,
      sel + ' must sit above the preset modal or the prompt is invisible',
    );
  }
});

test('the import asks for grants only after its own modal is closed', () => {
  const handler = SHARE.slice(SHARE.indexOf("runTrackedInstall('bundle'"));
  const close = handler.indexOf('close();');
  const ask = handler.indexOf('requestGrants(');
  assert.ok(ask > 0, 'the bundle import never asks for the widgets it installed');
  assert.ok(close > 0 && close < ask, 'grants must be requested after close(), not while the modal is up');
});

test('applyBundle reports which packages it installed', () => {
  // Counters alone cannot drive a prompt — the caller needs the ids.
  assert.match(SHARE, /widgets: \{ installed: 0, failed: 0, ids: \[\] \}/);
  assert.match(SHARE, /out\.widgets\.ids\.push\(wid\)/);
});

/** Load the queue with the dialog replaced by a stub that records and can answer. */
function loadQueue() {
  const start = CW.indexOf('function requestGrants');
  const end = CW.indexOf('function requestGrant(');
  assert.ok(start > 0 && end > start, 'requestGrants not found');

  const opened = [];
  const granted = new Set();
  const context = vm.createContext({
    opened, granted,
    packageById: (id) => ({ id, name: id }),
    packageGranted: (pkg) => granted.has(pkg.id),
    // Records the prompt and hands back its close callback, so the test drives
    // the user's answers explicitly instead of guessing at timing.
    openPermDialog: (pkg, _instId, _onAllow, onClose) => { opened.push({ id: pkg.id, onClose }); },
  });
  vm.runInContext(CW.slice(start, end), context);
  return { opened, granted, requestGrants: context.requestGrants };
}

test('several widgets are asked one at a time, in order', () => {
  const q = loadQueue();
  q.requestGrants(['a', 'b', 'c']);
  assert.deepEqual(q.opened.map((o) => o.id), ['a']);
  q.opened[0].onClose();
  assert.deepEqual(q.opened.map((o) => o.id), ['a', 'b']);
  q.opened[1].onClose();
  assert.deepEqual(q.opened.map((o) => o.id), ['a', 'b', 'c']);
});

// Declining one widget is a normal answer, not a reason to silently skip the rest.
test('a cancelled prompt still advances the queue', () => {
  const q = loadQueue();
  q.requestGrants(['a', 'b']);
  q.opened[0].onClose();   // cancel === close; the queue must not stall
  assert.deepEqual(q.opened.map((o) => o.id), ['a', 'b']);
});

test('already-granted packages are never asked about', () => {
  const q = loadQueue();
  q.granted.add('b');
  q.requestGrants(['a', 'b', 'c']);
  q.opened[0].onClose();
  assert.deepEqual(q.opened.map((o) => o.id), ['a', 'c']);
});

// Approving one package can install another's dependency, so membership is
// re-checked at dequeue time rather than only when the queue was built.
test('a package granted while the queue is running is skipped', () => {
  const q = loadQueue();
  q.requestGrants(['a', 'b']);
  q.granted.add('b');
  q.opened[0].onClose();
  assert.deepEqual(q.opened.map((o) => o.id), ['a']);
});

test('an empty or all-granted list opens nothing', () => {
  const q = loadQueue();
  q.requestGrants([]);
  q.granted.add('x');
  q.requestGrants(['x']);
  assert.deepEqual(q.opened, []);
});

test('closePermDialog runs the dialog onClose on every close path', () => {
  const fn = CW.slice(CW.indexOf('function closePermDialog'), CW.indexOf('// ── Clipboard copy confirmation'));
  assert.match(fn, /_onClose/);
  // Cleared before firing: a callback that re-opens must not re-enter this one.
  assert.ok(fn.indexOf('bd._onClose = null') < fn.indexOf('after()'), 'clear the handle before running it');
  assert.match(fn, /try \{ after\(\); \} catch/);
});

test('requestGrants is exported on the CustomWidget surface', () => {
  assert.match(CW, /packageGranted, requestGrant, requestGrants,/);
});

// placePackage (the "+" panel, Installed → Add to page, the after-install
// prompt) creates a tile, then asks. The dialog runs onClose on EVERY path and,
// on Allow, runs it before onAllow — so the tile's fate must be decided from
// the saved assignment, never from a flag onAllow sets. Deciding from a flag
// removed the tile the user had just approved, on every first placement.
function loadPlace() {
  const start = CW.indexOf('function placePackage');
  const end = CW.indexOf('// The two ways a Store widget lands');
  assert.ok(start > 0 && end > start, 'placePackage not found');
  const state = { enabled: true, assign: {}, grants: {} };
  const dialogs = [];
  const context = vm.createContext({
    state, dialogs,
    sdk: () => state,
    persist: (patch) => Object.assign(state, patch),
    packageById: (id) => ({ id, name: id, surface: 'tile' }),
    packageGranted: (pkg) => !!state.grants[pkg.id],
    openPermDialog: (pkg, instId, onAllow, onClose) => dialogs.push({ pkg, instId, onAllow, onClose }),
  });
  vm.runInContext(CW.slice(start, end), context);
  return { state, dialogs, placePackage: context.placePackage };
}

test('Allow keeps the new tile; Cancel takes it away', () => {
  const p = loadPlace();
  const dropped = [];
  p.placePackage('river', () => 'custom~a1', (id) => dropped.push(id));
  // What the Allow button does, in its real order: save, close, then onAllow.
  p.state.assign = { 'custom~a1': 'river' };
  p.state.grants = { river: {} };
  p.dialogs[0].onClose();
  if (p.dialogs[0].onAllow) p.dialogs[0].onAllow();
  assert.deepEqual(dropped, [], 'an approved tile stays');

  p.placePackage('keyring', () => 'custom~b2', (id) => dropped.push(id));
  p.dialogs[1].onClose();   // Cancel: nothing was assigned
  assert.deepEqual(dropped, ['custom~b2'], 'a declined tile is removed');
});

test('an already approved package is placed without asking', () => {
  const p = loadPlace();
  p.state.grants = { river: {} };
  p.placePackage('river', () => 'custom~c3', () => { throw new Error('must not drop'); });
  assert.equal(p.dialogs.length, 0);
  assert.equal(p.state.assign['custom~c3'], 'river');
});
