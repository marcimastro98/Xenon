// SDK widget sandbox diagnostics (js/sdk-diagnostics.js): the static scan of a
// package's own files and the validation of the probe's run-time `blocked`
// reports, which together tell a widget's author what the sandbox refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const D = require('../js/sdk-diagnostics.js');
const here = path.dirname(fileURLToPath(import.meta.url));

const kinds = (issues) => issues.map((i) => i.kind);

test('scan: a normal web page names every sandbox problem at once', () => {
  const html = `<!doctype html><html><head>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://fonts.example.com/a.css">
  </head><body>
    <button onclick="go()">Go</button>
    <img src="https://img.example.com/logo.png">
    <iframe src="https://example.com"></iframe>
    <script>
      const teams = JSON.parse(localStorage.getItem('t'));
      fetch('https://api.example.com/x');
    </script>
  </body></html>`;
  const out = D.scanWidgetSource([{ path: 'index.html', text: html }]);
  assert.deepEqual(kinds(out), ['remote_script', 'inline_script', 'inline_handler', 'network', 'storage', 'remote_style', 'remote_asset', 'frame']);
  assert.equal(out[0].host, 'cdn.tailwindcss.com');
  assert.equal(out[0].file, 'index.html');
  assert.equal(out.find((i) => i.kind === 'remote_style').host, 'fonts.example.com');
});

test('scan: a correct package is clean', () => {
  const files = [
    { path: 'index.html', text: '<!doctype html><link rel="stylesheet" href="widget.css"><script src="widget.js" defer></script><img src="icon.png"><a href="#x">x</a>' },
    { path: 'widget.css', text: 'body{background:url(bg.png)} .a{background:url("data:image/png;base64,AA")}' },
    { path: 'widget.js', text: "parent.postMessage({ xenonSdk: 1, type: 'fetch', id: 1, url: 'https://api.example.com/v1' }, '*');\nxenon.fetch('https://a.b');\nconst s = store.get('k');" },
  ];
  assert.deepEqual(D.scanWidgetSource(files), []);
});

test('scan: comments and non-executable script blocks are not issues', () => {
  const js = '// we never call fetch() or localStorage here\n/* eval( is banned */\nconst u = "https://x.y//z";';
  assert.deepEqual(D.scanWidgetSource([{ path: 'a.js', text: js }]), []);
  const html = '<!-- <script src="https://cdn.x/y.js"></script> --><script type="application/json">{"a":1}</script>';
  assert.deepEqual(D.scanWidgetSource([{ path: 'index.html', text: html }]), []);
});

test('scan: JS network, storage and eval patterns', () => {
  const at = (text) => kinds(D.scanWidgetSource([{ path: 'w.js', text }]));
  assert.deepEqual(at('window.fetch(u)'), ['network']);
  assert.deepEqual(at('const x = new XMLHttpRequest()'), ['network']);
  assert.deepEqual(at('new WebSocket("wss://a")'), ['network']);
  assert.deepEqual(at('const c = document.cookie'), ['storage']);
  assert.deepEqual(at('indexedDB.open("a")'), ['storage']);
  assert.deepEqual(at('const f = new Function("return 1")'), ['eval']);
  assert.deepEqual(at('api.fetch(u); obj.eval(x)'), []);
});

test('scan: CSS @import and remote url() are told apart', () => {
  const out = D.scanWidgetSource([{ path: 's.css', text: '@import url("https://fonts.g.com/css");\n.a{background:url(https://img.x.com/a.png)}' }]);
  assert.deepEqual(out.map((i) => [i.kind, i.host]), [['remote_style', 'fonts.g.com'], ['remote_asset', 'img.x.com']]);
});

test('scan: javascript: links count as inline handlers', () => {
  assert.deepEqual(kinds(D.scanWidgetSource([{ path: 'i.html', text: '<a href="javascript:void(0)">x</a>' }])), ['inline_handler']);
});

test('scan: output is deduped and capped', () => {
  const files = Array.from({ length: 40 }, (_, n) => ({ path: `p${n}.js`, text: 'fetch(1); fetch(2)' }));
  const out = D.scanWidgetSource(files);
  assert.equal(out.length, D.ISSUES_MAX);
  assert.equal(new Set(out.map((i) => i.file)).size, out.length);
});

test('scan: the bundled examples and the client helper raise nothing', () => {
  const root = path.join(here, '..', 'sdk-example');
  const files = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (/\.(html?|m?js|css)$/.test(e.name)) files.push({ path: rel, text: fs.readFileSync(path.join(dir, e.name), 'utf8') });
    }
  };
  walk(root, '');
  assert.ok(files.some((f) => f.path === 'xenon-client.js'));
  assert.deepEqual(D.scanWidgetSource(files), []);
});

test('blocked report: CSP directives map to issue kinds', () => {
  const out = D.validateBlockedReport({ items: [
    { directive: 'script-src-elem', blocked: 'cdn.tailwindcss.com' },
    { directive: 'script-src-elem', blocked: 'inline' },
    { directive: 'script-src-attr', blocked: 'inline' },
    { directive: 'script-src', blocked: 'eval' },
    { directive: 'connect-src', blocked: 'site.api.espn.com' },
    { directive: 'img-src', blocked: 'a.espncdn.com' },
    { directive: 'worker-src', blocked: '' },
    { directive: 'frame-src', blocked: 'example.com' },
  ] });
  assert.deepEqual(kinds(out), ['remote_script', 'inline_script', 'inline_handler', 'eval', 'network', 'remote_asset', 'other', 'frame']);
  assert.equal(out[0].host, 'cdn.tailwindcss.com');
  assert.equal(out[1].host, undefined);
});

test('blocked report: malformed or oversized reports are dropped whole', () => {
  assert.equal(D.validateBlockedReport(null), null);
  assert.equal(D.validateBlockedReport({ items: [] }), null);
  assert.equal(D.validateBlockedReport({ items: 'x' }), null);
  assert.equal(D.validateBlockedReport({ items: Array(D.REPORT_ITEMS_MAX + 1).fill({ directive: 'img-src', blocked: 'a.b' }) }), null);
  assert.equal(D.validateBlockedReport({ items: [{ directive: 'img-src', blocked: 'https://a.b/path?token=1' }] }), null);
  assert.equal(D.validateBlockedReport({ items: [{ directive: '<b>x</b>', blocked: '' }] }), null);
  assert.equal(D.validateBlockedReport({ items: [{ directive: 'img-src', blocked: 42 }] }), null);
});

test('mergeIssues keeps order, drops duplicates and unknown kinds', () => {
  const a = [{ kind: 'network', host: 'a.com' }];
  const out = D.mergeIssues(a, [{ kind: 'network', host: 'a.com' }, { kind: 'bogus' }, { kind: 'storage' }], 5);
  assert.deepEqual(out, [{ kind: 'network', host: 'a.com' }, { kind: 'storage' }]);
  assert.notEqual(out, a);
});

test('error reports: validated, cleaned, and merged by kind and message', () => {
  assert.equal(D.validateErrorReport(null), null);
  assert.equal(D.validateErrorReport({ items: [] }), null);
  assert.equal(D.validateErrorReport({ items: [{ kind: 'nope', message: 'x' }] }), null);
  assert.equal(D.validateErrorReport({ items: new Array(D.REPORT_ITEMS_MAX + 1).fill({ kind: 'error', message: 'x' }) }), null);
  const got = D.validateErrorReport({ items: [{ kind: 'console', message: 'a\u0000b' + 'z'.repeat(400), count: 3 }, { kind: 'rejection', message: 'r', count: -2 }] });
  assert.equal(got[0].message.length, 300);
  assert.ok(!got[0].message.includes('\u0000'));
  assert.equal(got[0].count, 3);
  assert.equal(got[1].count, 1);
  const merged = D.mergeErrors([{ kind: 'console', message: 'm', count: 2 }], [{ kind: 'console', message: 'm', count: 3 }, { kind: 'error', message: 'Script error.', count: 1 }]);
  assert.deepEqual(merged, [{ kind: 'console', message: 'm', count: 5 }, { kind: 'error', message: 'Script error.', count: 1 }]);
  const many = Array.from({ length: 30 }, (_, i) => ({ kind: 'error', message: 'e' + i, count: 1 }));
  const kept = D.mergeErrors([], many);
  assert.equal(kept.length, 20);
  assert.equal(kept.at(-1).message, 'e29', 'the newest are kept');
});
