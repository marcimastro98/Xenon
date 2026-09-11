import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// A widget can WATCH the named values local scripts set with POST /state/set
// (the `scriptStates` stream) and can never SET one. Both halves are promises
// the guide makes, so both are pinned here — the SDK surface is mirrored across
// five files and a guide promise nothing enforces is a promise that goes stale.

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const DOC = readFileSync(join(__dirname, '..', '..', 'docs', 'WIDGET_SDK.md'), 'utf8');

test('scriptStates is a declarable stream in every mirror of the SDK surface', () => {
  const sdk = require('../sdk-widgets.js');
  assert.ok(sdk.SDK_STREAMS.includes('scriptStates'), 'sdk-widgets.js: not in SDK_STREAMS');
  // The grant-side copy: a stream missing here is filtered out of every saved
  // grant, so the package is granted it and never receives a byte.
  assert.match(read('js', 'settings.js'), /const SDK_WIDGET_STREAMS = Object\.freeze\(\[[^\]]*'scriptStates'/);
  // The permission label the user actually reads before approving.
  assert.match(read('js', 'custom-widget.js'), /scriptStates: \['cw_stream_scriptstates',/);
  // And the auto-generated capability table in the guide.
  assert.match(DOC, /\*\*Data streams\*\* \(`streams`\):[^\n]*`scriptStates`/);
});

test('a manifest asking for scriptStates keeps it through validation', () => {
  const sdk = require('../sdk-widgets.js');
  assert.ok(sdk.SDK_STREAMS.includes('scriptStates'));
  // The picker's category map decides where such a package is filed; a stream
  // in no category leaves the package uncategorised in the palette.
  assert.match(read('js', 'custom-widget.js'), /id: 'system'[^\n]*streams: \[[^\]]*'scriptStates'\]/);
});

test('its permission label is translated in every language the app ships', () => {
  const src = read('js', 'i18n.js');
  const n = (src.match(/["']?cw_stream_scriptstates["']?\s*:/g) || []).length;
  assert.equal(n, 11, `cw_stream_scriptstates is defined ${n} times, expected 11`);
});

test('the dashboard forwards script_states to granted widgets', () => {
  const main = read('js', 'main.js');
  const handler = main.slice(main.indexOf("addEventListener('script_states'"), main.indexOf("addEventListener('ha_states'"));
  assert.ok(handler.includes("CustomWidget.onData('scriptStates'"), 'main.js must fan the SSE event out to the bridge');
  // Same event feeds the deck — one listener, both consumers.
  assert.ok(handler.includes('Deck.refreshStates'), 'the deck must keep its half of this listener');
});

test('the initial SSE dump sends script_states even when nothing is set', () => {
  // The guide promises an empty map rather than silence, so a widget can tell
  // "nothing is set" from "not told yet" on a cold start. The relayed SDK
  // states above it are guarded on a non-empty map; this one must not be.
  const src = read('server.js');
  const line = src.split('\n').find(l => l.includes('event: script_states'));
  assert.ok(line, 'no initial script_states dump');
  assert.ok(!line.includes('Object.keys(_scriptStates.states).length'), 'the dump must not be gated on a non-empty map');
  assert.match(DOC, /empty map included/);
});

test('no bridge path lets a widget WRITE a script state', () => {
  // /state/set stays CSRF-sensitive (a sandboxed iframe's opaque origin reads as
  // cross-site), and the bridge must never proxy it on a widget's behalf: that
  // store is shared and unnamespaced, so one package could overwrite another's
  // name — or the user's own script's.
  assert.match(read('server.js'), /const isSdkSensitive =[^\n]*'\/state\/set'/);
  const bridge = read('js', 'custom-widget.js');
  assert.ok(!bridge.includes('/state/set'), 'custom-widget.js must not call /state/set');
  assert.ok(!/type === 'scriptState'/.test(bridge), 'no bridge message may set a script state');
  assert.match(DOC, /Read-only, by design/);
});

test('the guide documents the stream and points writers at deck.states', () => {
  const sec = DOC.slice(DOC.indexOf('### 3d-ter.'), DOC.indexOf('### 3e.'));
  assert.ok(sec.length > 400, 'the scriptStates section is missing or empty');
  assert.match(sec, /stream === 'scriptStates'/);
  assert.match(sec, /deck\.states/);
});
