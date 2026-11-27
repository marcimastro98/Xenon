// Themes, backgrounds and the other share codes through xenon-mcp (server/mcp/mcp-dev-looks.js): the real checks
// Bit's create_preset runs, the code handed only to the dashboard that opens it, and the dashboard's picture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../mcp/mcp-dev-tools.js');
const { KINDS, CODE_SHOWN_MAX } = require('../mcp/mcp-dev-looks.js');
const { aiPresetDeps } = require('../grid/ai-preset-deps.js');
const PresetShare = require('../js/presets/preset-share.js');

const BG = { name: 'Slow tide', fps: 30, code: 'function draw(ctx, t, w, h) { ctx.fillStyle = "#05060a"; ctx.fillRect(0, 0, w, h); }' };
const THEME = { appearance: 'dark', autoPalette: false, accent: '#8b6cff', background: '#0b0a12', text: '#ecebf5' };

function deps(answerTo = () => null) {
  const asked = [];
  return {
    asked,
    d: {
      presetDeps: aiPresetDeps,
      ask: async (kind, args, timeoutMs, payload) => { asked.push({ kind, args, timeoutMs, payload }); return answerTo(kind); },
      captureRect: async (where) => ({ ok: true, data: 'JPEG', width: where.rect.width, height: where.rect.height }),
    },
  };
}

test('preset_reference: the kinds the tools make, then one kind\'s rules', async () => {
  const { d } = deps();
  const all = await T.runOp('preset_reference', {}, d);
  assert.deepEqual(Object.keys(all.kinds), KINDS);
  assert.ok(!('widget' in all.kinds) && !('sounds' in all.kinds), 'widgets have their own tools, sounds cannot be written');
  assert.doesNotMatch(all.note, /create_preset/, 'names the MCP tools, not Bit\'s');
  const bg = await T.runOp('preset_reference', { kind: 'bg' }, d);
  assert.equal(bg.ok, true);
  assert.ok(bg.fields.code && bg.example.code);
  assert.equal((await T.runOp('preset_reference', { kind: 'widget' }, d)).error, 'unknown_kind');
});

test('check_preset: a background passes, the code decodes as Xenon\'s import reads it', async () => {
  const { d, asked } = deps();
  const r = await T.runOp('check_preset', { kind: 'bg', data: BG }, d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.report, { dropped: 0, changed: 0 });
  const back = PresetShare.decodePreset(r.code);
  assert.equal(back.kind, 'bg');
  assert.equal(back.name, 'Slow tide');
  assert.equal(back.data.code, BG.code);
  assert.equal(asked.length, 0, 'a check never reaches the dashboard');
});

test('check_preset: data may come as JSON text; broken data and kinds are refused', async () => {
  const { d } = deps();
  assert.equal((await T.runOp('check_preset', { kind: 'theme', data: JSON.stringify(THEME) }, d)).ok, true);
  assert.equal((await T.runOp('check_preset', { kind: 'theme', data: '{nope' }, d)).error, 'bad_json');
  assert.equal((await T.runOp('check_preset', { kind: 'theme', data: [1] }, d)).error, 'bad_data');
  assert.equal((await T.runOp('check_preset', { kind: 'sounds', data: {} }, d)).error, 'unknown_kind');
  const broken = await T.runOp('check_preset', { kind: 'bg', data: { name: 'x', code: 'no draw here' } }, d);
  assert.equal(broken.ok, false);
  assert.ok(broken.hint, 'says what to fix');
});

test('check_preset: a theme carries its background; a code too long to show is left out', async () => {
  const { d } = deps();
  const r = await T.runOp('check_preset', { kind: 'theme', data: { ...THEME, bgCustom: BG } }, d);
  assert.equal(r.ok, true);
  assert.equal(PresetShare.decodePreset(r.code).data.bgCustom.code, BG.code);
  const pad = '// ' + 'x'.repeat(59000) + '\n';
  const big = { ...BG, code: pad + BG.code, assets: { a: 'data:image/png;base64,' + 'A'.repeat(300000) } };
  const long = await T.runOp('check_preset', { kind: 'bg', data: big }, d);
  assert.equal(long.ok, true, long.hint);
  assert.equal(long.code, undefined);
  assert.match(long.codeNote, /import_preset/);
  assert.ok(CODE_SHOWN_MAX < 300000);
});

test('import_preset: the code goes as the question\'s payload, never in its broadcast args', async () => {
  const { d, asked } = deps((kind) => (kind === 'import' ? { placed: true } : null));
  const r = await T.runOp('import_preset', { kind: 'bg', data: BG }, d);
  assert.equal(r.ok, true);
  assert.match(r.note, /confirms/);
  const [q] = asked;
  assert.equal(q.kind, 'import');
  assert.equal(PresetShare.decodePreset(q.payload.code).kind, 'bg');
  assert.ok(!JSON.stringify(q.args).includes(q.payload.code), 'the broadcast carries no code');
});

test('import_preset: no dashboard on screen says so; a failing check opens nothing', async () => {
  const { d, asked } = deps();
  const r = await T.runOp('import_preset', { kind: 'bg', data: BG }, d);
  assert.equal(r.error, 'no_dashboard');
  assert.match(r.hint, /check_preset/);
  await T.runOp('import_preset', { kind: 'bg', data: { code: '' } }, d);
  assert.equal(asked.length, 1, 'only the good code asked the dashboard');
});

test('dashboard_shot: the whole window, with its scale, or why not', async () => {
  const where = { found: true, rect: { left: 0, top: 0, width: 1280, height: 720, screenX: 0, screenY: 0 }, dpr: 2 };
  let got = null;
  const on = deps((kind) => (kind === 'screen' ? where : null));
  on.d.captureRect = async (w) => { got = w; return { ok: true, data: 'JPEG', width: 2560, height: 1440 }; };
  const r = await T.runOp('dashboard_shot', {}, on.d);
  assert.deepEqual(r.image, { mimeType: 'image/jpeg', data: 'JPEG' });
  assert.equal(got.dpr, 2, 'the capture gets the scale, not just the box');
  assert.equal((await T.runOp('dashboard_shot', {}, deps().d)).error, 'no_dashboard');
  assert.equal((await T.runOp('dashboard_shot', {}, deps(() => ({ found: false })).d)).error, 'not_on_screen');
});
