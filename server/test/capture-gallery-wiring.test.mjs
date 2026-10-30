// How the gallery is reached. Pinned here: index.html loads the model before
// the viewer and the viewer before the gallery (each reads the one before at
// load time), all after the toast's script; the Settings card opens it; the
// dashboard refreshes an open gallery on 'capture' and 'captures' and opens
// it on 'gallery_open' only on the PC (never on a paired phone); the Deck key
// opens it on the screen it was pressed on with 'all' as no filter; the
// Deck editor has an icon for it; the server tells screens about a delete or
// a trim, and wires the voice to 'gallery_open'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

test('index.html: the stylesheet, the scripts in order, the Settings card', () => {
  const html = read('index.html');
  assert.ok(html.includes('href="components/CaptureGallery/CaptureGallery.css"'));
  const at = f => html.indexOf(`<script src="js/${f}"></script>`);
  const order = ['capture-toast.js', 'capture-gallery-model.js', 'capture-gallery-viewer.js', 'capture-gallery.js'].map(at);
  assert.ok(order.every(i => i > 0), 'every script is loaded');
  assert.deepEqual(order, order.slice().sort((a, b) => a - b), 'in this order');
  const card = html.slice(html.indexOf('id="settings-capture-gallery"'), html.indexOf('id="settings-capture-shots"'));
  assert.match(card, /data-i18n="capg_title"/);
  assert.match(card, /onclick="CaptureGallery\.open\(\)"/);
});

test('main.js: capture and captures refresh it, gallery_open opens it on the PC only', () => {
  const main = read('js/main.js');
  const block = name => {
    const i = main.indexOf(`es.addEventListener('${name}'`);
    assert.ok(i > 0, name);
    return main.slice(i, main.indexOf('\n    });', i));
  };
  assert.match(block('capture'), /CaptureGallery\.changed\(\)/);
  assert.match(block('captures'), /CaptureGallery\.changed\(\)/);
  const open = block('gallery_open');
  assert.match(open, /window\.__xenonRemote\) return/);
  assert.match(open, /CaptureGallery\.open\(\{ filter: d\.filter, id: d\.id \}\)/);
});

test('deck.js opens it locally; deck-editor.js has its icon', () => {
  const deck = read('js/deck.js');
  const i = deck.indexOf("action.type === 'gallery'");
  assert.ok(i > 0);
  assert.match(deck.slice(i, i + 200), /filter: action\.filter === 'all' \? '' : action\.filter/);
  assert.match(read('js/deck-editor.js'), /\n\s+gallery: _ai\(/);
});

test('server.js: delete and trim tell the screens; the voice opens it through gallery_open', () => {
  const server = read('server.js');
  assert.match(server, /reqPath === '\/captures\/delete' \|\| reqPath === '\/captures\/trim'\)\) broadcastSSE\('captures'/);
  assert.match(server, /openGallery: \(o\) => broadcastSSE\('gallery_open', o\)/);
});

// Found by the 390 / 1440 probe: a long game name widened the select past the
// dialog, "Try again" was 33 px tall, and the arrows stayed over the video
// while trimming (where the arrow keys move the handles).
test('CaptureGallery.css and the viewer: narrow select, 44 px retry, no arrows while trimming', () => {
  const css = read('components/CaptureGallery/CaptureGallery.css');
  const narrow = css.slice(css.indexOf('@media (max-width: 560px)'));
  assert.match(narrow, /\.capg-game-select \{[^}]*width: 100%;[^}]*max-width: 100%;/);
  assert.match(css, /\.capg-game-select \{[^}]*min-width: 0;/);
  assert.match(css, /\.capg-status-act \.ui-btn \{ min-height: 44px; \}/);
  assert.match(css, /\.capg-nav:disabled, \.capg-viewer\.is-trimming \.capg-nav \{ visibility: hidden; \}/);
  const viewer = read('js/capture-gallery-viewer.js');
  assert.match(viewer, /actions\.classList\.add\('is-trim'\);\n\s+root\.classList\.add\('is-trimming'\);/);
  assert.match(viewer, /actions\.classList\.remove\('is-trim'\);\n\s+root\.classList\.remove\('is-trimming'\);/);
});

// Item 24: a screenshot is pinned from the viewer by its id, only on the PC
// where the shell draws layers; deleting it takes its pins away.
test('the viewer pins a picture by id where the server says it can; delete unpins', () => {
  const gallery = read('js/capture-gallery.js');
  assert.match(gallery, /g\.pinnable = r\.pinnable === true;/);
  assert.match(gallery, /pinnable: g\.pinnable === true && !window\.__xenonRemote,/);
  const viewer = read('js/capture-gallery-viewer.js');
  // A GIF is neither a video nor a picture the server pins or edits.
  assert.match(viewer, /if \(o\.pinnable && e\.kind === 'screenshot'\) actions\.appendChild\(btn\(tr\('shot_pin', 'Pin'\), '', pin\)\);/);
  assert.match(viewer, /if \(e\.kind === 'screenshot'\) actions\.appendChild\(btn\(tr\('capg_edit', 'Edit'\), '', edit\)\);/);
  assert.equal(require('../js/capture-gallery-model.js').errorText('not_picture')[0], 'deck_err_not_a_picture');
  assert.match(viewer, /post\(o\.url, '\/actions\/run', \{ type: 'screenPin', id: current\(\)\.id \}\)/);
  const server = read('server.js');
  assert.match(server, /pinnable: layersHost\.available\(\),/);
  assert.match(server, /LayersModel\.unpinCapture\(cur, id\)/);
});

// The macOS engine trims and copies but makes no shareable copies and finds no
// private data, and a Linux one may lack the tools to trim or copy: the server says what this engine can do, the viewer shows only
// that, and a reply without `can` (an older server) keeps every button.
test('the viewer shows Trim, Copy, Export, Transcript and "Find private data" only where the engine has them', () => {
  const server = read('server.js');
  assert.match(server, /can: \{\n\s+trim: _captureHost\.has\('trim'\),\n\s+copy: _captureHost\.has\('copy_files'\),\n\s+export: _captureHost\.has\('export'\),\n\s+cover: _captureHost\.has\('cover'\),\n\s+speech: _captureHost\.has\('speech'\),\n\s+\},/);
  const gallery = read('js/capture-gallery.js');
  assert.match(gallery, /g\.can = engineCan\(r\.can\);/);
  assert.match(gallery, /export: o\.export !== false, cover: o\.cover !== false, speech: o\.speech !== false,\n\s+trim: o\.trim !== false, copy: o\.copy !== false,/);
  assert.match(gallery, /can: g\.can,/);
  const viewer = read('js/capture-gallery-viewer.js');
  assert.match(viewer, /const can = o\.can \|\| \{ export: true, cover: true, speech: true, trim: true, copy: true \};/);
  // Linux without ffmpeg cannot trim, and without wl-copy or xclip cannot copy.
  assert.match(viewer, /if \(can\.trim\) actions\.appendChild\(btn\(tr\('capg_trim', 'Trim'\)/);
  assert.match(viewer, /if \(can\.copy\) actions\.appendChild\(btn\(tr\('capg_copy', 'Copy'\)/);
  assert.match(viewer, /if \(can\.export\) actions\.appendChild\(btn\(tr\('capg_exp_button', 'Export'\), '', startExport\)\);/);
  assert.match(viewer, /if \(can\.speech \|\| e\.transcript\) actions\.appendChild\(wordsButton\(\)\);/);
  assert.match(viewer, /canFind: can\.cover,/);
  const annotate = read('js/capture-annotate.js');
  assert.match(annotate, /if \(o\.canFind !== false\) lower\.append\(find\);/);
});
