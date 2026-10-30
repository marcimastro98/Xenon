// A Deck AI or mixer key pressed in the Virtual Deck window or on a widget layer
// did nothing: those pages have no AI chat, and a layer window is cut to its tiles.
// Pinned here: the key hands the step to the server, a dashboard (or the screen's
// Bit) claims it, nobody = no_dashboard, only those two kinds pass, and the route
// is guarded like the shortcut claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDeckShortcutRunner } = require('../deck-shortcut-runner.js');
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

function runner(claimer) {
  const sent = [];
  const r = createDeckShortcutRunner({
    readConfigs: async () => [], steps: () => [], run: async () => ({ ok: true }), claimMs: 60,
    broadcast: (event, data) => { sent.push({ event, data }); if (claimer && event === 'deck_shortcut') setTimeout(() => r.claim(data.nonce), 5); },
  });
  return { r, sent };
}

test('an AI step is claimed by a dashboard', async () => {
  const { r, sent } = runner(true);
  const res = await r.handOff({ type: 'ai', mode: 'prompt', prompt: 'hi' });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(sent[0].data.action, { type: 'ai', mode: 'prompt', prompt: 'hi' });
  r.stop();
});

test('nobody claims = no_dashboard; other kinds are refused without a broadcast', async () => {
  const { r, sent } = runner(false);
  assert.deepEqual(await r.handOff({ type: 'appMixer' }), { ok: false, error: 'no_dashboard' });
  assert.equal(sent.length, 1);
  assert.equal((await r.handOff({ type: 'openApp', path: 'x' })).error, 'unknown_action');
  assert.equal((await r.handOff(null)).error, 'unknown_action');
  assert.equal(sent.length, 1);
  r.stop();
});

test('the route validates, and is CSRF-guarded and denied to paired devices', () => {
  const src = read('server.js');
  assert.match(src, /'\/deck\/client-step',\n/);
  assert.match(src, /reqPath === '\/deck\/client-step'[\s\S]{0,500}handOff\(require\('\.\/js\/deck-actions\.js'\)\.validateAction\(/);
  const ra = read('remote-access.js');
  assert.equal((ra.match(/'\/deck\/client-step'/g) || []).length, 2);
});

// The Virtual Deck window opened its mixer empty ("no app is playing audio")
// because the row builder lives in volume.js, and a failing key only flashed red
// because toast.js was missing: both load there before deck.js.
test('the Deck window has the mixer rows and the error toast', () => {
  const html = read('deck-popup.html');
  const deck = html.indexOf('<script src="js/deck.js">');
  for (const f of ['js/toast.js', 'js/volume.js']) {
    const at = html.indexOf(`<script src="${f}">`);
    assert.ok(at > 0 && at < deck, `${f} before deck.js`);
  }
  for (const css of ['components/AudioSection/AudioSection.css', 'components/Toast/Toast.css']) {
    assert.ok(html.includes(`<link rel="stylesheet" href="${css}">`), css);
  }
});

test('deck.js hands off only where the step cannot run', () => {
  const deck = read('js/deck.js');
  assert.match(deck, /if \(handsOff\(action\)\) return handOffStep\(action\);\n\s+if \(runClientAction\(action\)\)/);
  assert.match(deck, /action\.type === 'ai'\) return !\(window\.startVoiceSession \|\| window\.openMediaChat \|\| window\.openAiPanel \|\| window\.aiAsk\)/);
  assert.match(deck, /action\.type === 'appMixer' && typeof isLayerPage === 'function' && isLayerPage\(\)/);
});
