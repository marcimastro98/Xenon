// Pictures attached in the chat go inside what the assistant creates: the
// "attached:N" it writes becomes the picture, in every slot that takes one, and
// a ref with no picture is refused before anything is built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadServerSettingsSlice, serverDashboardWidgets } from './server-settings-slice.mjs';

const require = createRequire(import.meta.url);
const A = require('../ai-attached-pictures.js');
const P = require('../ai-presets.js');
const PresetShare = require('../js/preset-share.js');

const deps = { normalizeSettings: loadServerSettingsSlice(), dashboardWidgets: serverDashboardWidgets(), sdkEnabled: true, appVersion: '9.9.9' };
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const GIF_B64 = 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
const PNG = 'data:image/png;base64,' + PNG_B64;
const GIF = 'data:image/gif;base64,' + GIF_B64;

function create(kind, data, pictures) {
  return P.runCreatePreset({ kind, name: 'Mine', data: JSON.stringify(data) }, deps, pictures);
}
const decoded = (out) => PresetShare.decodePreset(out.code).data;

test('only real pictures of a kind the app shows are kept, in their places', () => {
  assert.deepEqual(A.picturesFrom('nope'), []);
  const got = A.picturesFrom([PNG, 'data:image/svg+xml;base64,PHN2Zy8+', 42, 'data:image/png;base64,' + 'A'.repeat(A.PICTURE_MAX_CHARS), GIF, PNG]);
  assert.deepEqual(got, [PNG, null, null, null]);
  assert.equal(A.picturesFrom(['data:image/png;base64,abc"onerror=x']).at(0), null);
});

test('the model is told which pictures it can use, and nothing without any', () => {
  assert.equal(A.picturesNote([]), '');
  assert.equal(A.picturesNote([null]), '');
  const note = A.picturesNote([PNG, null, GIF]);
  assert.match(note, /2 picture\(s\)/);
  assert.match(note, /"attached:1", "attached:3"/);
  assert.doesNotMatch(note, /attached:2/);
});

test('refs become pictures anywhere in the data, files become their bytes', () => {
  const res = A.resolvePictures({ a: 'attached:1', list: [{ deep: { x: 'attached:2' } }], keep: 'attached', files: [
    { path: 'img/logo.png', data: 'attached:1' }, { path: 'anim.gif', content: 'attached:2' }, { path: 'index.html', content: 'attached:1 is text here' },
  ] }, [PNG, GIF]);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.wrongType, []);
  assert.equal(res.value.a, PNG);
  assert.equal(res.value.list[0].deep.x, GIF);
  assert.equal(res.value.keep, 'attached');
  assert.deepEqual(res.value.files[0], { path: 'img/logo.png', data: PNG_B64 });
  assert.deepEqual(res.value.files[1], { path: 'anim.gif', data: GIF_B64 });
  assert.equal(res.value.files[2].content, 'attached:1 is text here');
});

test('a ref with no picture, or a file named for another kind, is refused with a hint', () => {
  const missing = A.resolvePictures({ a: 'attached:3', b: 'attached:1' }, [PNG, null]);
  assert.deepEqual(missing.missing, ['attached:3']);
  assert.equal(A.pictureProblem(missing).error, 'no_picture');
  const wrong = A.resolvePictures([{ path: 'logo.png', data: 'attached:1' }], [GIF]);
  assert.equal(A.pictureProblem(wrong).error, 'picture_type');
  assert.match(A.pictureProblem(wrong).hint, /\.gif/);
  assert.equal(A.pictureProblem(A.resolvePictures({ a: 1 }, [])), null);
});

test('an animated background carries the picture as an asset', () => {
  const out = create('bg', { name: 'Photo', code: 'function draw(ctx, t, w, h, assets) { ctx.drawImage(assets.photo, 0, 0, w, h); }', assets: { photo: 'attached:1' } }, [GIF]);
  assert.equal(out.fnResult.ok, true, JSON.stringify(out.fnResult));
  assert.equal(decoded(out).assets.photo, GIF);
  assert.equal(out.clientActions[0].action, 'marketplace_open_import');
});

test('a Deck key wears the picture as its icon and behind its label', () => {
  const out = create('deck', { name: 'Pics', cols: 2, rows: 1, root: { pages: [{ keys: [
    { kind: 'action', title: 'Me', icon: { type: 'image', value: 'attached:1' }, bgImage: { value: 'attached:2', dim: 20 }, triggers: { tap: { type: 'media', cmd: 'next' } } },
  ] }] } }, [PNG, GIF]);
  assert.equal(out.fnResult.ok, true, JSON.stringify(out.fnResult));
  const key = decoded(out).root.pages[0].keys[0];
  assert.equal(key.icon.type, 'image');
  assert.equal(key.icon.value, PNG);
  assert.equal(key.bgImage.value, GIF);
});

test('a native Ambient scene uses the picture as its backdrop', () => {
  const out = create('ambient-layout', { scene: { name: 'Mine', bg: { type: 'image', url: 'attached:1' }, components: [{ type: 'clock', x: 30, y: 30, w: 40, h: 25 }] } }, [PNG]);
  assert.equal(out.fnResult.ok, true, JSON.stringify(out.fnResult));
  assert.equal(decoded(out).scene.bg.url, PNG);
});

test('a widget package carries the picture as a file of its own', () => {
  const files = [
    { path: 'manifest.json', content: JSON.stringify({ api: 1, name: 'Logo', streams: [] }) },
    { path: 'index.html', content: '<!doctype html><img src="logo.gif" alt="">' },
    { path: 'logo.gif', data: 'attached:1' },
  ];
  const out = create('widget', { id: 'my-logo', name: 'Logo', files }, [GIF]);
  assert.equal(out.fnResult.ok, true, JSON.stringify(out.fnResult));
  const file = decoded(out).payload.files.find((f) => f.path === 'logo.gif');
  assert.equal(file.data, GIF_B64);
});

test('nothing is built or opened when the data names a picture that is not there', () => {
  const out = create('bg', { code: 'function draw(ctx){}', assets: { photo: 'attached:2' } }, [PNG]);
  assert.equal(out.fnResult.ok, false);
  assert.equal(out.fnResult.error, 'no_picture');
  assert.deepEqual(out.clientActions, []);
});

test('create_widget places the pictures before it builds the files, and every chat turn hands them over', () => {
  const S = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const at = S.indexOf("if (fnName === 'create_widget') {");
  const body = S.slice(at, S.indexOf("} else if (fnName === 'my_widgets')", at));
  assert.ok(body.indexOf('aiPictures.resolvePictures(') < body.indexOf('externalizeInlineScripts('));
  assert.match(body, /if \(problem\) \{\s*r = problem;/);
  assert.match(S, /aiPresets\.runCreatePreset\(fnArgs, aiPresetDeps\(\), pictures\)/);
  // Each provider's tool runner in the chat route gets this message's pictures.
  const route = S.slice(S.indexOf('const _aiPictures = aiPictures.picturesFrom(aiBody.pictures);'));
  const runners = route.split('latestExplicitlyWantsScreen: _latestExplicitlyWantsScreen,').length - 1;
  assert.ok(runners >= 5);
  assert.equal(route.split('pictures: _aiPictures').length - 1, runners);
});

test('the chat sends one picture per attached image, in order, leaving out documents and screen mode', async () => {
  const C = require('../js/ai-pictures.js');
  const big = { mimeType: 'image/png', data: 'A'.repeat(C.AI_PICTURE_MAX_CHARS) };
  const got = await C.aiPicturesForSend([
    { mimeType: 'application/pdf', data: 'JVBERi0=' },
    { mimeType: 'image/png', data: PNG_B64 },
    { mimeType: 'image/jpeg', data: '/9j/', fromScreenMode: true },
    big,
    { mimeType: 'image/gif', data: GIF_B64 },
  ]);
  // Without a canvas (node) a picture too big to send as it is cannot be made smaller.
  assert.deepEqual(got, [PNG, null, null, GIF]);
});
