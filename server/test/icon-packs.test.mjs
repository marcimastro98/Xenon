import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const ip = require('../icon-packs.js');
const ps = require('../js/preset-share.js');
const ci = require('../js/content-installs.js');

// ---------------------------------------------------------------------------
// svgProblem — the fail-closed acceptance gate for pack SVGs. One accepted
// shape, many named rejections. The client builder duplicates this check
// (iconSvgProblem in preset-share.js); the matrix below asserts the two copies
// agree on every case, so a drift between them fails CI instead of shipping.
// ---------------------------------------------------------------------------

const CLEAN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const CASES = [
  [CLEAN, ''],
  ['<?xml version="1.0"?>\n' + CLEAN, ''],
  ['<svg viewBox="0 0 4 4"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="4" height="4"/></svg>', ''],
  ['<svg viewBox="0 0 4 4"><use href="#part"/><path id="part" d="M0 0h4v4z"/></svg>', ''],
  ['', 'empty'],
  ['just text', 'not_svg'],
  ['<svg><script>alert(1)</script></svg>', 'script'],
  ['<!DOCTYPE svg><svg/>', 'doctype'],
  ['<svg><!ENTITY x "y"></svg>', 'doctype'],
  ['<svg onload="alert(1)"/>', 'event_handler'],
  ['<svg><a href="javascript:alert(1)">x</a></svg>', 'event_handler_or_js'],
  ['<svg><foreignObject><body/></foreignObject></svg>', 'foreign_object'],
  ['<svg><image href="https://x.example/a.png"/></svg>', 'embedded_content'],
  ['<svg><iframe src="x"/></svg>', 'embedded_content'],
  ['<svg><use href="https://evil.example/#p"/></svg>', 'external_href'],
  ['<svg><use xlink:href="file:///etc/passwd"/></svg>', 'external_href'],
  ['<svg><rect style="fill:url(https://x/f.svg#a)"/></svg>', 'external_url'],
  ['<svg><a href="data:text/html,hi">x</a></svg>', 'data_text_uri'],
  // A payload "hidden" in a comment still trips the raw-text scan.
  ['<svg><!-- <script>alert(1)</script> --></svg>', 'script'],
  // Slash-separated event handler (no whitespace before `on`).
  ['<svg><animate/onbegin="alert(1)" dur="1s"/></svg>', 'event_handler'],
  ['<svg><circle/onload=alert(1)/></svg>', 'event_handler'],
  // CSS @import pulls an external stylesheet.
  ['<svg><style>@import "https://evil.example/x.css";</style></svg>', 'css_import'],
  // SMIL animating an href to an external target.
  ['<svg><set attributeName="href" to="https://evil.example/x"/></svg>', 'animated_href'],
  ['<svg><animate attributeName="xlink:href" values="https://evil.example/x"/></svg>', 'animated_href'],
];

test('svgProblem accepts clean icons and rejects active/external content', () => {
  for (const [svg, expected] of CASES) {
    const got = ip.svgProblem(svg);
    if (expected === '') assert.equal(got, '', 'accepted: ' + svg.slice(0, 60));
    else assert.notEqual(got, '', 'rejected: ' + svg.slice(0, 60));
  }
});

test('client iconSvgProblem agrees with the server verdict on every case', () => {
  for (const [svg] of CASES) {
    const server = ip.svgProblem(svg);
    const client = ps.iconSvgProblem(svg);
    assert.equal(!!server, !!client, 'verdict drift on: ' + svg.slice(0, 60));
    assert.equal(server, client, 'reason drift on: ' + svg.slice(0, 60));
  }
});

// ---------------------------------------------------------------------------
// validateIconPack — payload boundary (ids, caps, magic bytes, all-or-nothing)
// ---------------------------------------------------------------------------

const b64 = (s) => Buffer.from(s).toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const okPayload = (over = {}) => Object.assign({
  manifest: { id: 'neon-arcade', name: 'Neon Arcade', author: 'Marci', version: '1.0.0' },
  icons: [
    { id: 'play', label: 'Play', type: 'svg', data: b64(CLEAN) },
    { id: 'stop_1', type: 'png', data: PNG.toString('base64') },
  ],
}, over);

test('validateIconPack accepts a clean pack and derives labels', () => {
  const v = ip.validateIconPack(okPayload());
  assert.equal(v.ok, true);
  assert.equal(v.manifest.id, 'neon-arcade');
  assert.equal(v.icons.length, 2);
  assert.equal(v.icons[1].label, 'stop_1'); // label falls back to the id
});

test('validateIconPack rejects bad ids, dup ids and bad types', () => {
  assert.equal(ip.validateIconPack(okPayload({ manifest: { id: '../up', name: 'x' } })).error, 'bad_pack_id');
  assert.equal(ip.validateIconPack(okPayload({ manifest: { id: 'UPPER', name: 'x' } })).error, 'bad_pack_id');
  const dup = okPayload();
  dup.icons[1] = Object.assign({}, dup.icons[0]);
  assert.equal(ip.validateIconPack(dup).error, 'duplicate_icon_id');
  const badIcon = okPayload();
  badIcon.icons[0].id = 'has.dot';
  assert.equal(ip.validateIconPack(badIcon).error, 'bad_icon_id');
  const badType = okPayload();
  badType.icons[0].type = 'gif';
  assert.equal(ip.validateIconPack(badType).error, 'bad_icon_type');
});

test('validateIconPack enforces the caps and rejects the WHOLE pack on one bad icon', () => {
  const many = okPayload();
  many.icons = Array.from({ length: 121 }, (_, i) => ({ id: 'i' + i, type: 'svg', data: b64(CLEAN) }));
  assert.equal(ip.validateIconPack(many).error, 'too_many_icons');
  const fat = okPayload();
  fat.icons[0].data = Buffer.alloc(ip.ICON_MAX_BYTES + 1, 65).toString('base64');
  assert.equal(ip.validateIconPack(fat).error, 'icon_too_large');
  const evil = okPayload();
  evil.icons.push({ id: 'bad', type: 'svg', data: b64('<svg onload="x"/>') });
  const v = ip.validateIconPack(evil);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'svg_rejected');
  assert.equal(v.icon, 'bad');
});

test('validateIconPack rejects a PNG without the PNG magic', () => {
  const fake = okPayload();
  fake.icons[1] = { id: 'fake', type: 'png', data: b64('MZ not a png at all') };
  assert.equal(ip.validateIconPack(fake).error, 'png_rejected');
});

// ---------------------------------------------------------------------------
// createIconPacks — filesystem store (install / list / resolve / remove)
// ---------------------------------------------------------------------------

test('install → list → resolve → remove round-trip; traversal never resolves', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xenon-iconpacks-'));
  try {
    const store = ip.createIconPacks({ dir });
    const r = await store.install(okPayload());
    assert.deepEqual(r, { ok: true, id: 'neon-arcade', count: 2 });

    const packs = await store.list();
    assert.equal(packs.length, 1);
    assert.equal(packs[0].id, 'neon-arcade');
    assert.deepEqual(packs[0].icons.map((i) => i.file).sort(), ['play.svg', 'stop_1.png']);

    const hit = store.resolve('neon-arcade', 'play.svg');
    assert.ok(hit && hit.mime === 'image/svg+xml');
    assert.ok(fs.existsSync(hit.abs));

    // Traversal / off-charset requests never resolve.
    assert.equal(store.resolve('..', 'play.svg'), null);
    assert.equal(store.resolve('neon-arcade', '../manifest.json'), null);
    assert.equal(store.resolve('neon-arcade', 'play.svg/..'), null);
    assert.equal(store.resolve('neon-arcade', 'manifest.json'), null);

    // Reinstall under the same id replaces the folder wholesale.
    const v2 = okPayload();
    v2.icons = [{ id: 'only', type: 'svg', data: b64(CLEAN) }];
    assert.equal((await store.install(v2)).count, 1);
    const after = await store.list();
    assert.deepEqual(after[0].icons.map((i) => i.file), ['only.svg']);

    assert.equal(await store.remove('neon-arcade'), true);
    assert.equal((await store.list()).length, 0);
    assert.equal(await store.remove('../oops'), false);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Receipt integration — iconPackIds ride contentInstalls like widgetIds do
// ---------------------------------------------------------------------------

test('content-install receipts normalize and count iconPackIds', () => {
  const [record] = ci.normalizeContentInstalls([{
    id: 'xi_m5abc123deadbeef',
    name: 'Neon icons',
    kind: 'icons',
    installedAt: 1,
    source: 'catalog',
    resources: { iconPackIds: ['neon-arcade', 'neon-arcade', 'BAD ID', '../up'] },
  }]);
  assert.equal(record.kind, 'icons');
  assert.deepEqual(record.resources.iconPackIds, ['neon-arcade']);
  assert.equal(ci.resourceCount({ iconPackIds: ['a-pack'] }), 1);
});

test('preset envelope round-trips the icons kind', () => {
  const data = okPayload();
  const code = ps.encodePreset('icons', 'Neon Arcade', data, {});
  const env = ps.decodePreset(code);
  assert.ok(env);
  assert.equal(env.kind, 'icons');
  assert.equal(env.name, 'Neon Arcade');
  assert.equal(env.data.manifest.id, 'neon-arcade');
  assert.equal(env.data.icons.length, 2);
});

test('iconIdFromFilename derives valid ids', () => {
  assert.equal(ps.iconIdFromFilename('Play Button.svg'), 'play-button');
  assert.equal(ps.iconIdFromFilename('ICON__2 (final).png'), 'icon-2-final');
  assert.equal(ps.iconIdFromFilename('---.svg'), '');
});
