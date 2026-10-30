// A package can carry the wallpaper picture (it used to stay behind silently, and
// a Store listing showed a background its package did not contain). These pin
// the untrusted-payload check, the round trip through a code, and the
// redistribution marker both settings sanitizers keep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { wallpaperPayload, WALLPAPER_EMBED_MAX, encodePreset, decodePreset } = require('../js/preset-share.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const SVG = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');

test('a wallpaper payload is accepted only as a known picture type', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    assert.deepEqual(wallpaperPayload({ type, data: PNG, name: ' Frieren.png ' }),
      { type, ext: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[type], name: 'Frieren.png', data: PNG });
  }
  assert.equal(wallpaperPayload({ type: 'video/webm', data: PNG }), null);
  assert.equal(wallpaperPayload({ type: 'text/html', data: PNG }), null);
  assert.equal(wallpaperPayload({ type: 'image/png', data: '<script>' }), null);
  assert.equal(wallpaperPayload({ type: 'image/png', data: '' }), null);
  assert.equal(wallpaperPayload({ type: 'image/png', data: 'A'.repeat(Math.ceil(WALLPAPER_EMBED_MAX / 3) * 4 + 4) }), null);
  assert.equal(wallpaperPayload('image/png'), null);
  assert.equal(wallpaperPayload(null), null);
});

test('a pasted SVG wallpaper travels as its data: URI, nothing else', () => {
  assert.deepEqual(wallpaperPayload({ type: 'image/svg+xml', url: SVG }), { type: 'image/svg+xml', name: '', url: SVG });
  assert.equal(wallpaperPayload({ type: 'image/svg+xml', url: 'https://example.com/a.svg' }), null);
  assert.equal(wallpaperPayload({ type: 'image/svg+xml', url: 'data:text/html;base64,PGI+' }), null);
  assert.equal(wallpaperPayload({ type: 'image/svg+xml', url: SVG + 'A'.repeat(512 * 1024) }), null);
});

test('the wallpaper survives the code round trip inside a bundle', () => {
  const data = { theme: { accent: '#00f8ff' }, wallpaper: { type: 'image/png', name: 'bg.png', data: PNG } };
  const env = decodePreset(encodePreset('bundle', 'Frieren Essentials', data, { appVersion: '4.12.0' }));
  assert.deepEqual(wallpaperPayload(env.data.wallpaper), { type: 'image/png', ext: 'png', name: 'bg.png', data: PNG });
});

// Both sanitizers keep `imported` + a valid installId, and nothing else new.
function loadSanitizer(file, fnName, extra) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const start = src.indexOf('function ' + fnName + '(');
  const end = src.indexOf('\n}\n', start) + 2;
  const ctx = vm.createContext(Object.assign({
    BG_SVG_DATA_RE: /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/,
    BG_SVG_MAX_CHARS: 512 * 1024,
  }, extra));
  vm.runInContext(src.slice(start, end), ctx);
  return ctx[fnName];
}
const INSTALLS = { INSTALL_ID_RE: /^xi_[a-z0-9]{8,32}$/ };
for (const [file, fnName, extra] of [
  ['server/js/settings.js', 'sanitizeBackgroundMedia', { ContentInstalls: INSTALLS }],
  ['server/server.js', 'sanitizeSettingsBackgroundMedia', { contentInstalls: INSTALLS }],
]) {
  test(`${fnName} keeps the imported marker and its receipt id`, () => {
    const clean = loadSanitizer(file, fnName, extra);
    const base = { url: '/uploads/background-1-ab.webp', name: 'bg', type: 'image/webp', version: '1' };
    assert.deepEqual({ ...clean({ ...base, imported: true, installId: 'xi_abcdef12' }) },
      { ...base, imported: true, installId: 'xi_abcdef12' });
    assert.deepEqual({ ...clean({ ...base, imported: true, installId: '../etc' }) }, { ...base, imported: true });
    assert.deepEqual({ ...clean({ ...base, imported: 'yes', installId: 'xi_abcdef12' }) }, base);
    assert.deepEqual({ ...clean({ url: SVG, imported: true }) }, { url: SVG, name: 'svg', type: 'image/svg+xml', version: '', imported: true });
    assert.equal(clean({ ...base, url: '/uploads/../x.webp', imported: true }), null);
  });
}

test('the package picker offers the wallpaper and the import tracks it for removal', () => {
  const SRC = readFileSync(join(ROOT, 'server', 'js', 'preset-share.js'), 'utf8');
  assert.match(SRC, /wallRow = checkRow\(tr\('preset_bundle_wallpaper'/);
  assert.match(SRC, /wallpaper: !!\(wallRow && picked\(wallRow\)\)/);
  assert.match(SRC, /if \(data\.wallpaper\) out\.wallpaper = await applyWallpaper\(data\.wallpaper, tx\)/);
  assert.match(SRC, /imported: true, installId: tx \? tx\.id : undefined/);
  assert.match(SRC, /backgroundMedia: wallOwned \? null : HS\(\)\.backgroundMedia/);
  // A refused wallpaper must never wipe the user's current one.
  const apply = SRC.slice(SRC.indexOf('async function applyWallpaper'));
  assert.ok(apply.indexOf('if (!next.backgroundMedia) return false') < apply.indexOf('hubSettings = next'));
});
