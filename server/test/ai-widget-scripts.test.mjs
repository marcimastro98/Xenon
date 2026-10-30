// A widget the assistant writes with its code inside index.html would install
// and then show an empty tile (the sandbox CSP runs script files only): the
// inline scripts move to files of their own before install and before encoding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadServerSettingsSlice, serverDashboardWidgets } from './server-settings-slice.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { externalizeInlineScripts } = require('../ai-widget-scripts.js');
const P = require('../ai-presets.js');
const PresetShare = require('../js/preset-share.js');
const SdkWidgets = require('../sdk-widgets.js');

const MANIFEST = { path: 'manifest.json', content: JSON.stringify({ api: 1, name: 'Clock', streams: [], actions: [] }) };
const page = (body) => ({ path: 'index.html', content: '<!doctype html><html><body><div id="t"></div>' + body + '</body></html>' });
const byPath = (files, p) => files.find((f) => f.path === p);

test('an inline script becomes a file and the tag points at it', () => {
  const { files, moved } = externalizeInlineScripts([MANIFEST, page('<script>\n  tick();\n</script>')]);
  assert.equal(moved, 1);
  assert.equal(byPath(files, 'index.html').content.includes('<script src="index-script.js"></script>'), true);
  assert.equal(byPath(files, 'index.html').content.includes('tick();'), false);
  assert.equal(byPath(files, 'index-script.js').content, 'tick();\n');
  assert.deepEqual(byPath(files, 'manifest.json'), MANIFEST);
});

test('several scripts keep their order, attributes and a free name each', () => {
  const html = page('<script>a();</script><script type="module">b();</script>');
  const { files, moved } = externalizeInlineScripts([MANIFEST, html, { path: 'index-script.js', content: 'mine();' }]);
  assert.equal(moved, 2);
  const out = byPath(files, 'index.html').content;
  assert.ok(out.indexOf('src="index-script-2.js"') < out.indexOf('type="module" src="index-script-3.js"'));
  assert.equal(byPath(files, 'index-script.js').content, 'mine();');
  assert.equal(byPath(files, 'index-script-2.js').content, 'a();\n');
  assert.equal(byPath(files, 'index-script-3.js').content, 'b();\n');
});

test('a page in a folder gets its script beside it', () => {
  const { files } = externalizeInlineScripts([MANIFEST, { path: 'ui/panel.html', content: '<script>p();</script>' }]);
  assert.equal(byPath(files, 'ui/panel.html').content, '<script src="panel-script.js"></script>');
  assert.equal(byPath(files, 'ui/panel-script.js').content, 'p();\n');
});

test('script files, data blocks, empty tags, non-HTML and base64 files are left alone', () => {
  const html = page('<script src="w.js"></script><script type="application/json">{"a":1}</script><script> </script>');
  const js = { path: 'w.js', content: '<script>not html</script>' };
  const png = { path: 'a.png', data: 'iVBORw0KGgo=' };
  const { files, moved } = externalizeInlineScripts([MANIFEST, html, js, png]);
  assert.equal(moved, 0);
  assert.deepEqual(files, [MANIFEST, html, js, png]);
});

test('at the 40-file cap nothing is moved', () => {
  const filler = Array.from({ length: 38 }, (_, i) => ({ path: 'f' + i + '.js', content: '1' }));
  const html = page('<script>a();</script>');
  const { files, moved } = externalizeInlineScripts([MANIFEST, html, ...filler]);
  assert.equal(moved, 0);
  assert.equal(files.length, 40);
  assert.equal(byPath(files, 'index.html'), html);
});

test('a share code with an inline script carries the script as a file and says so', () => {
  const deps = { normalizeSettings: loadServerSettingsSlice(), dashboardWidgets: serverDashboardWidgets(), sdkEnabled: true, appVersion: '9.9.9' };
  const r = P.buildPreset('widget', 'Clock', { id: 'clock-test', files: [MANIFEST, page('<script>tick();</script>')] }, deps);
  assert.ok(r.code, JSON.stringify(r.report));
  const widget = PresetShare.decodePreset(r.code).data;
  assert.equal(SdkWidgets.validateWidgetPayload(widget.payload).ok, true);
  const text = (p) => Buffer.from(byPath(widget.payload.files, p).data, 'base64').toString('utf8');
  assert.equal(text('index.html').includes('<script src="index-script.js"></script>'), true);
  assert.equal(text('index-script.js'), 'tick();\n');
  assert.equal(r.report.entries.some((e) => e.issue === 'moved'), true);
});

test('create_widget moves inline scripts before the install', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
  const at = src.indexOf("if (fnName === 'create_widget')");
  const body = src.slice(at, src.indexOf('installWidgetPayload(payload', at));
  assert.match(body, /externalizeInlineScripts\(/);
});

test('a widget create_widget installs gets the same critique as a widget share code', () => {
  const deps = { normalizeSettings: loadServerSettingsSlice(), dashboardWidgets: serverDashboardWidgets(), sdkEnabled: true, appVersion: '9.9.9' };
  const loop = { path: 'w.js', content: 'function f() { requestAnimationFrame(f); } f();' };
  const out = P.critiqueWidget('loop-test', [MANIFEST, page('<script src="w.js"></script>'), loop], deps);
  assert.ok(out && typeof out.code === 'string');
  assert.ok(out.critique.fix >= 1);
  assert.ok(out.critique.findings.some((f) => /hidden/.test(f.problem)));
  assert.equal(P.critiqueWidget('Bad Id!', [MANIFEST], deps), null);
});

test('create_widget hands its critique, and the design check on credits, to the model', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
  const at = src.indexOf("if (fnName === 'create_widget')");
  const body = src.slice(at, src.indexOf("} else if (fnName === 'preset_reference')", at));
  // The whole package as installed (an edit sends only the files it changes).
  assert.match(body, /aiPresets\.critiqueWidget\(r\.id, whole && whole\.ok \? whole\.files : files, aiPresetDeps\(\)\)/);
  assert.match(body, /provider === 'xenon'\s*\n?\s*\? addConsiderations\(checked\.critique, await aiXenon\.designAdvice\(DATA_DIR, checked\.code\)\)/);
  assert.match(body, /call create_widget again with the same id/);
});
