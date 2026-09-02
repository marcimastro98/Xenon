import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// A Steam tile that launches the game you click needs one thing Xenon already
// had internally: launchSteamGame. Exposing it is a new action category rather
// than a widening of `url`, and that distinction is the whole point of these
// tests — `url` is http(s) links, and letting it carry protocol handlers would
// hand every widget already granted it the ability to invoke any registered
// scheme on the machine, retroactively and with no new prompt.

test('the steam category exposes exactly one action, and it is the existing one', () => {
  const sdk = require('../sdk-widgets.js');
  const cats = sdk.SDK_ACTION_CATEGORIES;
  assert.deepEqual([...cats.steam], ['launchSteamGame']);
});

test('url still means http(s) links, and never a protocol handler', () => {
  const sdk = require('../sdk-widgets.js');
  assert.deepEqual([...sdk.SDK_ACTION_CATEGORIES.url], ['openUrl']);
  assert.ok(!sdk.SDK_ACTION_CATEGORIES.url.includes('launchSteamGame'),
    'a widget granted `url` must not gain game launching without being asked again');
});

test('the AppID is a number before it is ever a URL', () => {
  // steam://rungameid/<id> is built by interpolation, so the validation in front
  // of it is what stands between a widget and an arbitrary protocol string.
  const registry = read('server/actions/registry.js');
  assert.match(registry, /function isSteamAppId[\s\S]{0,120}\/\^\\d\{1,12\}\$\//,
    'the AppID check must stay digits-only — it is what makes the interpolation safe');
  const start = registry.indexOf("case 'launchSteamGame'");
  // Comments stripped first: the one above this case explains the launcher by
  // name, which would otherwise make the order look wrong when it is right.
  const body = registry.slice(start, registry.indexOf('case ', start + 10))
    .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  assert.ok(body.indexOf('isSteamAppId') < body.indexOf('openExternal'),
    'the id must be validated before it reaches the shell launcher');
});

test('every mirror of the category list carries it', () => {
  // Five places have to agree or the grant is silently unusable: the server
  // allowlist, the bridge that dispatches, the settings list the permission
  // dialog is built from, the docs, and the label the user actually reads.
  assert.match(read('server/sdk-widgets.js'), /steam: Object\.freeze\(\['launchSteamGame'\]\)/);
  assert.match(read('server/js/custom-widget.js'), /steam: \['launchSteamGame'\]/);
  assert.match(read('server/js/settings.js'), /'spotify', 'steam'|'steam', 'obs'/);
  assert.match(read('docs/WIDGET_SDK.md'), /\| `steam` \| `\{ type: 'launchSteamGame', gameId \}`/);
  assert.match(read('server/js/custom-widget.js'), /steam: \['cw_act_steam', 'Launch a Steam game'\]/);
});

test('the permission line is translated in every language the app ships', () => {
  const I18N = read('server/js/i18n.js');
  const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];
  const found = new Set();
  let current = null;
  for (const line of I18N.split('\n')) {
    const ns = line.match(/^ {2}([a-z]{2}): \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
    if (ns) current = ns[1];
    const t = line.trimStart();
    if (t.startsWith('cw_act_steam:') || t.startsWith('"cw_act_steam":')) found.add(current);
  }
  const missing = LANGS.filter((l) => !found.has(l));
  assert.equal(missing.length, 0, `cw_act_steam missing in: ${missing.join(', ')}`);
});
