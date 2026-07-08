import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildSrcdoc, encodeForJsString, CODE_MAX } = require('../js/custom-bg.js');

// The code-defined animated background runs UNTRUSTED user JS inside a sandboxed
// iframe. These guard both the SECURITY properties of the srcdoc AND — crucially —
// that the embedded snippet ROUND-TRIPS back to valid, identical source (an earlier
// entity-escaped version compiled to garbage, so every background rendered blank).

// Pull the embedded `var __src=...;` string literal back out and evaluate it the
// way the browser's JS parser would, to prove it equals the original code.
function decodeEmbedded(html) {
  const marker = 'var __src=';
  const start = html.indexOf(marker) + marker.length;
  // The literal ends at the ';' that precedes the bootstrap IIFE.
  const end = html.indexOf(';(function(){', start);
  const literal = html.slice(start, end);
  // eslint-disable-next-line no-eval
  return (0, eval)(literal);
}

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
