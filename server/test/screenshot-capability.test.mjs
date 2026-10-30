// capabilities/screenshot.js: the Deck key and the voice for a screenshot.
// Pinned here: the engine gets the planned path and the result never carries
// it, a failed capture records nothing and tells no dashboard, "show" with no
// screenshot says so, and without the engine the AI is not offered the tool.
// An area pick waits for the user, copies, and a cancel is not an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const shot = require('../capabilities/screenshot.js');
const { createCapabilities, aiFunctions } = require('../capabilities/index.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

const FILE = 'C:\\Users\\u\\Pictures\\Xenon\\Desktop\\Desktop 2026-10-26 21-05-09.png';

function deps({ reply = { ok: true, width: 1920, height: 1080, hdr: false }, last = null, game = '' } = {}) {
  const log = { requests: [], opts: [], added: [], saved: [], revealed: [], dirs: [] };
  const store = {
    plan: async ({ kind, game: g, root }) => { log.plan = { kind, game: g }; log.root = root; return { id: 'aaaaaaaaaaaaaaaa', dir: path.dirname(FILE), file: FILE, name: path.basename(FILE) }; },
    add: (e) => { log.added.push(e); return { id: e.id, kind: e.kind, name: path.basename(e.file), game: e.game, width: e.width, height: e.height, hdr: e.hdr }; },
    last: async () => last,
  };
  const capture = {
    host: { available: () => true, request: async (cmd, body, opts) => { log.requests.push({ cmd, body }); log.opts.push(opts); return typeof reply === 'function' ? reply() : reply; } },
    store: () => store,
    game: () => game,
    mkdir: async (d) => { log.dirs.push(d); },
    reveal: (f) => log.revealed.push(f),
    onSaved: (e) => log.saved.push(e),
    hint: async () => 'Drag to pick an area',
  };
  return { d: { capture }, log };
}

test('a screenshot of the screen: planned path to the engine, name and size back, no path', async () => {
  const { d, log } = deps({ game: 'game.exe' });
  const r = await shot.run(d, {});
  assert.deepEqual(log.plan, { kind: 'screenshot', game: 'game.exe' });
  assert.deepEqual(log.dirs, [path.dirname(FILE)]);
  assert.deepEqual(log.requests, [{ cmd: 'screenshot', body: { target: 'screen', path: FILE } }]);
  assert.deepEqual(r, { ok: true, id: 'aaaaaaaaaaaaaaaa', name: path.basename(FILE), game: 'game.exe', width: 1920, height: 1080, hdr: false, copied: false });
  assert.deepEqual(log.opts, [undefined], 'the normal 15 s timeout');
  assert.ok(!JSON.stringify(r).includes('Users'), 'no path in the result');
  assert.equal(log.saved.length, 1, 'dashboards told once');
  assert.ok(!JSON.stringify(log.saved).includes('Users'), 'no path on the wire');
});

test('the chosen folder is the root; a vanished one falls back and says so, never naming it', async () => {
  const chosen = deps();
  chosen.d.capture.shotFolder = async () => ({ dir: 'E:\\Shots' });
  const r = await shot.run(chosen.d, {});
  assert.equal(chosen.log.root, 'E:\\Shots');
  assert.equal(r.folderMissing, undefined);

  const gone = deps();
  gone.d.capture.shotFolder = async () => ({ dir: '', missing: true });
  const g = await shot.run(gone.d, {});
  assert.equal(gone.log.root, undefined, 'the standard Pictures/Xenon');
  assert.equal(g.folderMissing, true);
  assert.equal(gone.log.saved[0].folderMissing, true);

  const broken = deps();
  broken.d.capture.shotFolder = async () => { throw new Error('io'); };
  assert.equal((await shot.run(broken.d, {})).ok, true, 'a failing folder check never blocks the screenshot');
  assert.equal(broken.log.root, undefined);
});

test('"window" and "region" are passed through; anything else is the screen', async () => {
  for (const [target, want] of [['window', 'window'], ['region', 'region'], ['screen', 'screen'], ['../x', 'screen']]) {
    const { d, log } = deps();
    await shot.run(d, { target });
    assert.equal(log.requests[0].body.target, want);
  }
});

test('an area: the hint and copy go to the engine, it may wait for the user, the toast knows it was copied', async () => {
  const { d, log } = deps({ reply: { ok: true, width: 301, height: 151, hdr: true, copied: true } });
  const r = await shot.run(d, { target: 'region' });
  assert.deepEqual(log.requests, [{ cmd: 'screenshot', body: { target: 'region', path: FILE, copy: true, hint: 'Drag to pick an area' } }]);
  assert.deepEqual(log.opts, [{ timeoutMs: shot.REGION_TIMEOUT_MS }]);
  assert.ok(shot.REGION_TIMEOUT_MS > 120000, 'longer than the engine\'s own 2 minutes');
  assert.equal(r.copied, true);
  assert.equal(log.saved[0].copied, true);
});

test('an area cancelled with Esc is done, not failed: nothing recorded, no toast', async () => {
  const { d, log } = deps({ reply: { ok: true, cancelled: true } });
  assert.deepEqual(await shot.run(d, { target: 'region' }), { ok: true, cancelled: true });
  assert.equal(log.added.length, 0);
  assert.equal(log.saved.length, 0);
});

test('a hint that cannot be read leaves the picker without it', async () => {
  const { d, log } = deps();
  d.capture.hint = async () => { throw new Error('i18n.js missing'); };
  assert.equal((await shot.run(d, { target: 'region' })).ok, true);
  assert.equal(log.requests[0].body.hint, '');
});

test('while an area is being picked, another press is answered at once and the engine is not asked', async () => {
  let release;
  const waiting = new Promise((r) => { release = r; });
  const { d, log } = deps({ reply: () => waiting });
  const first = shot.run(d, { target: 'region' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await shot.run(d, { target: 'region' }), { ok: true, picking: true });
  assert.deepEqual(await shot.run(d, { target: 'screen' }), { ok: true, picking: true });
  assert.equal(log.requests.length, 1);
  release({ ok: true, cancelled: true });
  assert.deepEqual(await first, { ok: true, cancelled: true });
  assert.equal((await shot.run(d, { target: 'screen' })).picking, undefined, 'free again afterwards');
  assert.equal(log.requests.length, 2);
});

test('a failed capture records nothing and keeps only the codes the user can act on', async () => {
  for (const [error, want] of [['no_window', 'no_window'], ['unsupported', 'unsupported'], ['timeout', 'failed'], ['capture_failed', 'failed'], [undefined, 'failed']]) {
    const { d, log } = deps({ reply: { ok: false, error } });
    assert.deepEqual(await shot.run(d, {}), { ok: false, error: want });
    assert.equal(log.added.length, 0);
    assert.equal(log.saved.length, 0);
  }
});

test('a folder that cannot be made is a write failure, and the engine is not asked', async () => {
  const { d, log } = deps();
  d.capture.mkdir = async () => { throw new Error('EACCES'); };
  assert.deepEqual(await shot.run(d, {}), { ok: false, error: 'write_failed' });
  assert.equal(log.requests.length, 0);
});

test('"show" opens the last screenshot, or says there is none', async () => {
  const none = deps();
  assert.deepEqual(await shot.run(none.d, { mode: 'reveal' }), { ok: false, error: 'no_file' });
  assert.equal(none.log.revealed.length, 0);
  const one = deps({ last: { file: FILE, name: 'a.png' } });
  assert.deepEqual(await shot.run(one.d, { mode: 'reveal' }), { ok: true, shown: true, name: 'a.png' });
  assert.deepEqual(one.log.revealed, [FILE]);
});

test('without the engine nothing runs and the AI is not offered take_screenshot', async () => {
  const { d } = deps();
  d.capture.host.available = () => false;
  const runner = createCapabilities(d);
  assert.equal(runner.probes().capture, false);
  assert.deepEqual(await runner.run({ type: 'screenshot' }), { ok: false, error: 'unavailable' });
  assert.ok(!aiFunctions(runner.probes()).some(f => f.name === 'take_screenshot'));
  const on = createCapabilities(deps().d);
  assert.ok(aiFunctions(on.probes()).some(f => f.name === 'take_screenshot'));
});

test('the catalog marks it sensitive, in the capture group, with a Deck label in every language', () => {
  const c = CAPABILITIES.find(x => x.type === 'screenshot');
  assert.equal(c.capability.risk, 'sensitive');
  assert.equal(c.group, 'capture');
  const i18n = readFileSync(path.join(HERE, '..', 'js', 'i18n.js'), 'utf8');
  for (const k of ['deck_act_screenshot', 'deck_cat_capture', 'deck_param_target', 'deck_opt_take', 'deck_opt_screen', 'deck_opt_window', 'deck_opt_region', 'shot_saved', 'shot_copied', 'shot_show', 'shot_pick_hint']) {
    assert.equal(i18n.match(new RegExp(`\\b${k}:`, 'g')).length, 11, k);
  }
  assert.match(readFileSync(path.join(HERE, '..', 'js', 'deck-editor.js'), 'utf8'), /group: 'capture', labelKey: 'deck_cat_capture'/);
});

test('a widget reaches it only through the capture category, and only to take one', () => {
  const sdk = require('../sdk-widgets.js');
  const cats = Object.entries(sdk.SDK_ACTION_CATEGORIES).filter(([, types]) => types.includes('screenshot')).map(([c]) => c);
  assert.deepEqual(cats, ['capture']);
  assert.deepEqual([...sdk.SDK_ACTION_LIMITS.screenshot.mode], ['take']);
});

test('server.js wires the engine, the index under DATA_DIR, the SSE without a path and the shutdown', () => {
  const src = readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
  assert.match(src, /const CAPTURE_EXE = path\.join\(__dirname, 'capture', process\.platform === 'win32' \? 'xenon-capture\.exe' : 'xenon-capture'\);/);
  assert.match(src, /file: path\.join\(DATA_DIR, 'captures\.json'\)/);
  assert.match(src, /onSaved: \(e\) => broadcastSSE\('capture', \{\s+kind: e\.kind, id: e\.id, name: e\.name, game: e\.game, copied: e\.copied === true,\s+\.\.\.\(e\.folderMissing === true \? \{ folderMissing: true \} : \{\}\),\s+(?:\/\/[^\n]*\s+)?(?:\.\.\.\(Number\.isInteger\(e\.covered\) && e\.covered > 0 \? \{ covered: e\.covered \} : \{\}\),\s+(?:\/\/[^\n]*\s+)?)?\.\.\.\(e\.kind === 'screenshot' && layersHost\.available\(\) \? \{ pinnable: true \} : \{\}\),\s+\}\)/);
  assert.match(src, /shotFolder: \(\) => _captureFolder\.resolve\(captureOptions\(\)\.shotFolder\)/);
  assert.match(src, /hint: \(\) => LayerI18n\.text\('shot_pick_hint', _serverHubSettings && _serverHubSettings\.language\)/);
  // The engine stops after a recording is finished, then the index is written.
  assert.match(src, /\.then\(\(\) => _captureHost\.stop\(\)\)\n\s+\.then\(\(\) => _captures\.flush\(\)\);/);
});
