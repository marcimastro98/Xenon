import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const assets = require('../asset-version.js');
const SERVER = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const SCREEN_BIT = fs.readFileSync(new URL('../js/screen-bit.js', import.meta.url), 'utf8');

function site(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-assets-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const tagFor = (root, rel, version = '5.0.0') => encodeURIComponent(
  assets.tagOf(fs.statSync(path.join(root, rel)), version),
);

test('every local script and stylesheet gets the version of its file', async () => {
  const root = site({ 'js/a.js': 'a', 'styles/b.css': 'b', 'components/C/c.css': 'c', 'shared/d.js': 'd', 'vendor/e.js': 'e' });
  try {
    const html = [
      '<script src="js/a.js"></script>',
      '<script defer data-x="1" src="/js/a.js"></script>',
      '<link rel="stylesheet" href="styles/b.css">',
      '<link href="components/C/c.css" rel="stylesheet">',
      '<script src="shared/d.js"></script>',
      '<script src="vendor/e.js"></script>',
    ].join('\n');
    const out = await assets.stamp(html, root, '5.0.0');
    assert.ok(out.includes(`src="js/a.js?v=${tagFor(root, 'js/a.js')}"`));
    assert.ok(out.includes(`src="/js/a.js?v=${tagFor(root, 'js/a.js')}"`), 'a rooted URL is the same file');
    assert.ok(out.includes(`href="styles/b.css?v=${tagFor(root, 'styles/b.css')}"`));
    assert.ok(out.includes(`href="components/C/c.css?v=${tagFor(root, 'components/C/c.css')}" rel="stylesheet"`));
    assert.ok(out.includes(`src="shared/d.js?v=${tagFor(root, 'shared/d.js')}"`));
    assert.ok(out.includes(`src="vendor/e.js?v=${tagFor(root, 'vendor/e.js')}"`));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('what is not a local asset stays exactly as written', async () => {
  const root = site({ 'js/a.js': 'a', 'secret.js': 's' });
  try {
    const html = [
      '<script src="js/missing.js"></script>',
      '<script src="https://example.com/js/a.js"></script>',
      '<script src="//example.com/js/a.js"></script>',
      '<script src="layer-i18n.js"></script>',
      '<script src="js/../secret.js"></script>',
      '<script src="js/a.js?x=1"></script>',
      '<link rel="preload" as="image" href="public/a.svg">',
      '<link rel="stylesheet" href="https://fonts.example.com/styles/a.css">',
      '<a href="js/a.js">link</a>',
      '<img src="js/a.js">',
      '<script>const s = "<notascript>";</script>',
    ].join('\n');
    assert.equal(await assets.stamp(html, root, '5.0.0'), html);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a page with no assets costs nothing and survives empty input', async () => {
  assert.equal(await assets.stamp('', os.tmpdir(), '5.0.0'), '');
  assert.equal(await assets.stamp('<p>hi</p>', os.tmpdir(), '5.0.0'), '<p>hi</p>');
});

test('the version moves with the size, the date and the app', () => {
  const stat = { size: 1200, mtimeMs: 1762500000123.5 };
  const base = assets.tagOf(stat, '5.0.0');
  assert.notEqual(assets.tagOf({ ...stat, size: 1201 }, '5.0.0'), base);
  assert.notEqual(assets.tagOf({ ...stat, mtimeMs: 1762500000124 }, '5.0.0'), base);
  assert.notEqual(assets.tagOf(stat, '5.0.1'), base, 'an update that restores size and date still moves it');
  assert.equal(assets.tagOf(stat, '5.0.0'), base);
  assert.match(base, /^[A-Za-z0-9.-]+$/, 'nothing in it needs escaping');
});

test('only the version on disk right now may stay in the cache', () => {
  const stat = { size: 10, mtimeMs: 1000 };
  const now = assets.tagOf(stat, '5.0.0');
  assert.match(assets.cacheControl(now, stat, '5.0.0'), /immutable/);
  assert.match(assets.cacheControl(now, stat, '5.0.0'), /^private/, 'paired devices fetch these with their cookie');
  assert.equal(assets.cacheControl(null, stat, '5.0.0'), 'no-cache', 'no version asked: as before');
  assert.equal(assets.cacheControl('', stat, '5.0.0'), 'no-cache');
  assert.equal(assets.cacheControl(now, { ...stat, mtimeMs: 2000 }, '5.0.0'), 'no-cache', 'a page from before an edit');
  assert.equal(assets.cacheControl(now, stat, '5.0.1'), 'no-cache', 'a page from before an update');
});

test('a changed file gets a new URL at the next page load', async () => {
  const root = site({ 'js/a.js': 'one' });
  try {
    const page = '<script src="js/a.js"></script>';
    const before = await assets.stamp(page, root, '5.0.0');
    fs.writeFileSync(path.join(root, 'js/a.js'), 'three');
    assert.notEqual(await assets.stamp(page, root, '5.0.0'), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('every dashboard page goes out through sendPage, and the file handler obeys', () => {
  for (const route of ['/shell-driver', '/sdk-service', '/screen-alerts', '/scene', '/draw', '/menu', '/deck-popup', '/spotlight']) {
    const at = SERVER.indexOf(`reqPath === '${route}' && req.method === 'GET'`);
    assert.ok(at > 0, route);
    const body = SERVER.slice(at, SERVER.indexOf('} else if (', at + 10));
    assert.match(body, /await sendPage\(/, route);
    assert.doesNotMatch(body, /res\.end\(/, `${route} answers past sendPage`);
  }
  assert.match(SERVER, /await sendPage\(LayerPage\.compose\(lite, tiles, dashboard\)\)/);
  assert.match(SERVER, /await sendPage\(html\);\s*\n\s*\n\s*\} else if \(reqPath === '\/pair'/, 'the dashboard itself');

  const handler = SERVER.slice(SERVER.indexOf("} else if (ext === '.css' || ext === '.js') {"));
  assert.match(handler.slice(0, 900), /assetVersion\.cacheControl\(urlObj\.searchParams\.get\('v'\), stat, APP_VERSION\)/);
  assert.doesNotMatch(handler.slice(0, 900), /'Cache-Control': 'no-cache'/, 'one answer for 200 and 304');
});

test('a script listed by the page counts as in the page, version or not', () => {
  assert.match(SCREEN_BIT, /script\[src="' \+ src \+ '"\], script\[src\^="' \+ src \+ '\?"\]/);
});
