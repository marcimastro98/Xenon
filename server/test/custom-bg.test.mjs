import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  buildSrcdoc, encodeForJsString, sanitizeBgAssets, sanitizeBgFps,
  CODE_MAX, ASSET_MAX_COUNT, ASSET_MAX_CHARS, ASSETS_TOTAL_MAX,
  FPS_MIN, FPS_MAX, FPS_DEFAULT,
} = require('../js/custom-bg.js');

// The code-defined animated background runs UNTRUSTED user JS inside a sandboxed
// iframe. These guard both the SECURITY properties of the srcdoc AND — crucially —
// that the embedded snippet ROUND-TRIPS back to valid, identical source (an earlier
// entity-escaped version compiled to garbage, so every background rendered blank).

// Pull the embedded `var __src=...` string literal back out and evaluate it the
// way the browser's JS parser would, to prove it equals the original code.
function decodeEmbedded(html) {
  const marker = 'var __src=';
  const start = html.indexOf(marker) + marker.length;
  // The literal ends where the assets literal begins. lastIndexOf: the code
  // under test may itself contain the marker text, but the REAL one always
  // comes after the whole code literal.
  const end = html.lastIndexOf(',__assetsJson=');
  const literal = html.slice(start, end);
  // eslint-disable-next-line no-eval
  return (0, eval)(literal);
}

// Same round-trip for the bundled assets payload: literal → JSON → object.
// The assets literal ends where the fps literal begins.
function decodeEmbeddedAssets(html) {
  const marker = ',__assetsJson=';
  const start = html.lastIndexOf(marker) + marker.length;
  const end = html.indexOf(',__fps=', start);
  const literal = html.slice(start, end);
  // eslint-disable-next-line no-eval
  return JSON.parse((0, eval)(literal));
}

// A tiny but well-formed data URI (1×1 transparent PNG).
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('embedded code round-trips back to the exact original source', () => {
  const code = 'const n = 5;\nfunction draw(ctx, t, w, h) {\n  for (let i = 0; i < n; i++) if (i > 0 && t < 9) ctx.fillRect(i, 0, 1, 1);\n}';
  const decoded = decodeEmbedded(buildSrcdoc(code));
  assert.equal(decoded, code, 'the snippet the frame compiles is byte-identical to what the user wrote');
  // And it must actually compile + expose a draw function (the real failure mode).
  const factory = new Function('canvas', 'ctx', decoded + '\n;return (typeof draw==="function")?draw:null;');
  assert.equal(typeof factory({}, {}), 'function', 'draw compiles and is returned');
});

test('every template-style snippet using < and > compiles to a draw function', () => {
  // These are the shapes the built-in gallery ships; a broken encoding turned all
  // of them into null (blank background).
  const snippets = [
    'function draw(ctx,t,w,h){for(let x=0;x<w;x+=8)ctx.fillRect(x,0,1,h);}',
    'let a=[];for(let i=0;i<10;i++)a.push(i);function draw(ctx,t,w,h){if(a.length>0)ctx.clearRect(0,0,w,h);}',
  ];
  for (const s of snippets) {
    const decoded = decodeEmbedded(buildSrcdoc(s));
    assert.equal(decoded, s);
    const factory = new Function('canvas', 'ctx', decoded + '\n;return (typeof draw==="function")?draw:null;');
    assert.equal(typeof factory({}, {}), 'function');
  }
});

test('a literal </script> in the snippet cannot break out of the script element', () => {
  const html = buildSrcdoc('function draw(){}</script><script>window.__pwn=1</script>');
  // No raw closing/opening tag from the payload may appear in the HTML source.
  assert.ok(!html.includes('</script><script>window.__pwn'), 'no raw injected tag pair');
  assert.ok(!html.includes('<script>window.__pwn'), 'no raw injected script open');
  // Yet it still decodes back to the original text the user typed.
  assert.equal(decodeEmbedded(html), 'function draw(){}</script><script>window.__pwn=1</script>');
});

test('encodeForJsString escapes < > (so </script> can never form)', () => {
  const enc = encodeForJsString('a < b > c </script>');
  assert.ok(!enc.includes('<'), 'no raw < survives');
  assert.ok(!enc.includes('>'), 'no raw > survives');
  assert.ok(enc.includes('\\u003c') && enc.includes('\\u003e'), 'angle brackets became \\uXXXX');
});

test('buildSrcdoc always carries the sandbox CSP kill-switch', () => {
  const html = buildSrcdoc('function draw(ctx,t,w,h){}');
  assert.ok(html.includes("connect-src 'none'"), 'no network from the frame');
  assert.ok(html.includes("default-src 'none'"), 'nothing loads by default');
  assert.ok(html.includes("base-uri 'none'"), 'base-uri locked');
});

test('buildSrcdoc caps the embedded code at CODE_MAX', () => {
  const huge = 'x'.repeat(CODE_MAX + 5000);
  assert.equal(decodeEmbedded(buildSrcdoc(huge)).length, CODE_MAX, 'embedded code capped exactly at CODE_MAX');
});

test('buildSrcdoc tolerates empty / non-string code', () => {
  assert.equal(decodeEmbedded(buildSrcdoc('')), '');
  assert.equal(decodeEmbedded(buildSrcdoc(null)), '');
  assert.equal(decodeEmbedded(buildSrcdoc(undefined)), '');
});

// ── Bundled image assets ──────────────────────────────────────────────────────

test('valid assets round-trip into the srcdoc; omitted assets embed as {}', () => {
  const html = buildSrcdoc('function draw(){}', { city: PNG_1PX });
  assert.deepEqual(decodeEmbeddedAssets(html), { city: PNG_1PX });
  assert.deepEqual(decodeEmbeddedAssets(buildSrcdoc('function draw(){}')), {});
});

test('sanitizeBgAssets drops everything that is not a well-formed data:image URI', () => {
  const clean = sanitizeBgAssets({
    ok: PNG_1PX,
    'bad key!': PNG_1PX,                                   // key outside [a-z][a-z0-9_]
    Upper: PNG_1PX,                                        // must start lowercase
    remote: 'https://imgur.com/x.png',                     // remote loads stay impossible
    script: 'data:text/html;base64,PHNjcmlwdD4=',          // wrong MIME
    svg: 'data:image/svg+xml;base64,PHN2Zz4=',             // svg can carry script — excluded
    notb64: 'data:image/png;base64,%%%%',                  // not base64
    nostring: 42,
  });
  assert.deepEqual(Object.keys(clean), ['ok']);
});

test('sanitizeBgAssets enforces the count and size ceilings', () => {
  const many = {};
  for (let i = 0; i < ASSET_MAX_COUNT + 4; i++) many['img_' + i] = PNG_1PX;
  assert.equal(Object.keys(sanitizeBgAssets(many)).length, ASSET_MAX_COUNT);

  const hugeOne = 'data:image/png;base64,' + 'A'.repeat(ASSET_MAX_CHARS);
  assert.deepEqual(sanitizeBgAssets({ big: hugeOne }), {}, 'per-asset cap');

  const chunk = 'data:image/png;base64,' + 'A'.repeat(Math.ceil(ASSETS_TOTAL_MAX / 2));
  const total = sanitizeBgAssets({ a: chunk, b: chunk, c: chunk });
  assert.ok(Object.keys(total).length < 3, 'total cap drops the overflowing entry');
});

test('a malicious asset value cannot break out of the script element', () => {
  // The value fails the data-URI allowlist outright, but even the JSON wrapper
  // of a VALID set must never contain a raw angle bracket.
  const html = buildSrcdoc('function draw(){}', { ok: PNG_1PX });
  const markerStart = html.indexOf(',__assetsJson=');
  const markerEnd = html.indexOf(';(function(){', markerStart);
  const literal = html.slice(markerStart, markerEnd);
  assert.ok(!literal.includes('<') && !literal.includes('>'), 'no raw <> in the assets literal');
});

test('assets are handed to the draw contract (factory param + 5th argument)', () => {
  const html = buildSrcdoc('function draw(ctx,t,w,h,assets){}', { sprite: PNG_1PX });
  assert.ok(html.includes('new Function("canvas","ctx","assets"'), 'setup scope receives assets');
  assert.ok(html.includes('draw(ctx,el,innerWidth,innerHeight,assets)'), 'draw receives assets');
});

// ── Frame-rate cap ────────────────────────────────────────────────────────────

test('sanitizeBgFps clamps to the 10–60 range and defaults to 30', () => {
  assert.equal(sanitizeBgFps(undefined), FPS_DEFAULT);
  assert.equal(sanitizeBgFps(null), FPS_DEFAULT);
  assert.equal(sanitizeBgFps('nope'), FPS_DEFAULT);
  assert.equal(sanitizeBgFps(NaN), FPS_DEFAULT);
  assert.equal(sanitizeBgFps(1), FPS_MIN);
  assert.equal(sanitizeBgFps(1000), FPS_MAX);
  assert.equal(sanitizeBgFps(24.4), 24, 'rounded to an integer');
  assert.equal(sanitizeBgFps('45'), 45, 'numeric strings accepted');
});

test('buildSrcdoc embeds the sanitized fps as a numeric literal (default when omitted)', () => {
  assert.ok(buildSrcdoc('function draw(){}').includes(',__fps=' + FPS_DEFAULT + ';'), 'omitted → default');
  assert.ok(buildSrcdoc('function draw(){}', null, 15).includes(',__fps=15;'), 'explicit value embedded');
  assert.ok(buildSrcdoc('function draw(){}', null, 9999).includes(',__fps=' + FPS_MAX + ';'), 'out-of-range clamped');
  assert.ok(buildSrcdoc('function draw(){}', null, '<img onerror=x>').includes(',__fps=' + FPS_DEFAULT + ';'),
    'a non-numeric value can never inject markup — it collapses to the default number');
});

test('the frame loop throttles paints to the embedded fps', () => {
  const html = buildSrcdoc('function draw(){}', null, 20);
  assert.ok(html.includes('step=1000/__fps'), 'paint interval derived from the cap');
  assert.ok(html.includes('if(t-last<step-1){raf=requestAnimationFrame(frame);return;}'),
    'early rAF ticks are skipped without painting');
  // Elapsed time stays on the real clock — skipping frames must not slow motion.
  assert.ok(html.includes('var el=(t-start)/1000'), 'elapsed seconds follow the rAF timestamp');
});
