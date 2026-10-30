// The assistant changes the user's own widgets later (ai-my-widgets.js and the
// create_widget / my_widgets tools in server.js).
//
// The rules these tests hold:
//  - only the user's own widgets are listed, read or changed; a Store or shared
//    widget is never read and never overwritten, even by id;
//  - a read hands back whole files, never a cut one an edit would lose the rest of;
//  - an edit sends only what it changes: the other files, images and fonts stay;
//  - the critique checks the whole package as installed, not just the edit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const W = require('../ai-my-widgets.js');
const S = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');

test('the list holds the user\'s own widgets only', () => {
  const own = new Set(['capodanno', 'cpu-ring']);
  const list = W.listOwn([
    { id: 'capodanno', name: 'Capodanno', version: '1.0.1', size: 'wide', description: 'Countdown' },
    { id: 'cpu-ring', name: 'CPU', version: '1.0.0' },
    { id: 'wall-plate', name: 'Wall Plate', version: '1.0.2' },
    { id: 'cpu-ring-trial', name: 'Trial', trial: true },
    { id: 'night-scene', name: 'Scene', surface: 'ambient' },
  ], (id) => own.has(id) || id === 'cpu-ring-trial' || id === 'night-scene');
  assert.deepEqual(list.map((w) => w.id), ['capodanno', 'cpu-ring']);
  assert.deepEqual(list[0], { id: 'capodanno', name: 'Capodanno', version: '1.0.1', size: 'wide', description: 'Countdown' });
  assert.equal(list[1].size, null);
});

test('a read gives text files whole and assets by name, never a cut file', () => {
  const out = W.readOwn({ id: 'capodanno', files: [
    { path: 'manifest.json', data: b64('{"api":1}') },
    { path: 'index.html', data: b64('<div>è</div>') },
    { path: 'img/flap.png', data: Buffer.alloc(300).toString('base64') },
  ] });
  assert.equal(out.ok, true);
  assert.deepEqual(out.files, [{ path: 'manifest.json', content: '{"api":1}' }, { path: 'index.html', content: '<div>è</div>' }]);
  assert.deepEqual(out.assets, [{ path: 'img/flap.png', bytes: 300 }]);
  const big = W.readOwn({ id: 'x', files: [{ path: 'app.js', data: b64('a'.repeat(W.MAX_READ_CHARS + 1)) }] });
  assert.deepEqual(big, { ok: false, error: 'too_large' });
});

test('an edit keeps what it does not send and drops what it removes', () => {
  const current = { id: 'capodanno', files: [
    { path: 'manifest.json', data: 'M1' }, { path: 'index.html', data: 'H1' },
    { path: 'old.js', data: 'O1' }, { path: 'img/flap.png', data: 'P1' },
  ] };
  const merged = W.mergeEdit(current, [{ path: 'index.html', data: 'H2' }, { path: 'new.js', data: 'N2' }], ['old.js']);
  assert.deepEqual(merged, [
    { path: 'manifest.json', data: 'M1' }, { path: 'index.html', data: 'H2' },
    { path: 'img/flap.png', data: 'P1' }, { path: 'new.js', data: 'N2' },
  ]);
  assert.deepEqual(W.mergeEdit(null, [{ path: 'a', data: 'x' }]), [{ path: 'a', data: 'x' }]);
});

test('create_widget changes an installed id only when it is the user\'s own work', () => {
  const at = S.indexOf("if (fnName === 'create_widget') {");
  const body = S.slice(at, S.indexOf("} else if (fnName === 'my_widgets')", at));
  const guard = body.indexOf('if (editing && !widgetExportable(id))');
  const install = body.indexOf("installWidgetPayload({ id, files: all }, 'creator')");
  assert.ok(guard > 0 && install > guard, 'the ownership check comes before the install');
  assert.match(body, /const editing = !!current \|\| trialVault\.has\(id\);/, 'a trial package counts as installed, and is not own');
  assert.match(body, /if \(current\) all = aiMyWidgets\.mergeEdit\(current, changed, fnArgs\.remove\);/);
  assert.match(body, /aiPresets\.critiqueWidget\(r\.id, whole && whole\.ok \? whole\.files : files,/, 'the critique sees the whole package');
  assert.match(body, /error: 'not_yours', hint:/);
});

test('my_widgets reads nothing that is not the user\'s, and is declared for the model', () => {
  const at = S.indexOf("} else if (fnName === 'my_widgets') {");
  const body = S.slice(at, S.indexOf("} else if (fnName === 'preset_reference')", at));
  assert.ok(body.indexOf('!widgetExportable(id)') < body.indexOf('readPackagePayload'), 'ownership before any read');
  assert.match(body, /aiMyWidgets\.listOwn\(\(await refreshSdkScan\(\)\)\.packages, widgetExportable\)/);
  assert.match(S, /\{ name: 'my_widgets', description: 'Read-only: the widgets the user owns/);
  assert.match(S, /remove: \{ type: 'ARRAY', description: 'When changing an existing widget/);
  assert.match(S, /To CHANGE a widget the user already has[^']*call my_widgets/);
});
