import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// `lang` was in `init` from the start, which is enough for a widget that renders
// once and not enough for the ones people keep on screen. A widget open while
// its owner switched the dashboard to another language kept the code it was
// handed at mount, so it stayed in the old one until something reloaded it —
// and nothing said so, which is the worst version of the bug: an author reads
// `lang` in init, does the right thing with it, and is still wrong.
//
// Found while a widget author was showing off a Steam tile written in French,
// which Xenon would have shown in French to a German user with no way for him
// to know why.

test('a language change is pushed to open widgets, like a theme change is', () => {
  const bridge = read('server/js/custom-widget.js');
  assert.match(bridge, /function refreshLang\(\)/);
  assert.match(bridge, /post\(entry, \{ type: 'lang', lang: code \}\)/);
  assert.match(bridge, /refreshTheme, refreshLang,/, 'it has to be reachable from outside the bridge');
});

test('setLang actually calls it, and cannot break the language switch if it fails', () => {
  const i18n = read('server/js/i18n.js');
  const start = i18n.indexOf('function setLang(l)');
  const body = i18n.slice(start, i18n.indexOf('\n}', start));
  assert.match(body, /window\.CustomWidget\.refreshLang\(\)/, 'the push must happen on a real change');
  // Guarded: a bridge that is not up yet must not take the language switch down
  // with it — switching language is the user's action, not the widget's.
  const call = body.indexOf('refreshLang()');
  assert.ok(body.lastIndexOf('try {', call) > body.lastIndexOf('applyTranslations()', call) - 200,
    'the call has to be inside a try');
  assert.ok(body.indexOf('applyTranslations()') < call,
    'the dashboard re-renders first; a widget is told after');
});

test('the SDK guide tells widget authors to handle it', () => {
  const doc = read('docs/WIDGET_SDK.md');
  assert.match(doc, /### 3d\. `lang` — host → widget/);
  assert.match(doc, /\{ xenonSdk: 1, type: 'lang', lang: 'de' \}/);
  assert.match(doc, /only at mount/, 'the doc should say what changed, so an existing widget knows to update');
});
