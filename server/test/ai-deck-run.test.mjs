// Bit presses a Deck action (run_deck_action, server/ai-deck-run.js): the same
// validator as a key, risky types wait on a confirmation card, and the card
// only ever sends back a nonce for an action the server stored itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { appStringsSource } from './i18n-source.mjs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const run = require('../ai-deck-run.js');
const { ACTION_CATALOG } = require('../js/deck-actions.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('safe actions run, risky ones wait on the card, sounds play in the page', () => {
  assert.equal(run.plan({ type: 'vmBusMute', bus: '0', mode: 'toggle' }).mode, 'run');
  assert.deepEqual(run.plan({ type: 'vmBusMute', bus: '0', mode: 'toggle', extra: 'x' }).action, { type: 'vmBusMute', bus: '0', mode: 'toggle' }, 'only the params the spec allows');
  for (const type of ['runScript', 'typeText', 'hotkey', 'phoneCall', 'lockWorkstation', 'webhook', 'twitchChat', 'obsStream', 'haLock', 'haCallService', 'sdkHandler']) {
    assert.equal(run.plan({ type }).mode, 'confirm', type);
  }
  assert.equal(run.plan({ type: 'playSound', file: 'packs/a1/x.mp3' }).mode, 'client');
  assert.equal(run.plan({ type: 'appMixer' }).mode, 'client');
});

test('a program started through the Deck always waits on the card', () => {
  const shell = run.plan({ type: 'openApp', path: 'C:/Windows/System32/cmd.exe', args: '/c calc' });
  assert.equal(shell.mode, 'confirm');
  assert.deepEqual(run.describe(shell.action).map((r) => r.name), ['path', 'args'], 'the card shows what would run');
  assert.equal(run.plan({ type: 'openApp', path: 'C:/Users/x/Downloads/setup.exe' }).mode, 'confirm');
  assert.equal(run.plan({ type: 'openStoreApp', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', name: 'Calculator' }).mode, 'confirm');
});

test('what a tool returns is data, and the prompt says so', () => {
  assert.match(engineSource(), /aiDeckRun.TOOL_TEXT_NOTE +/);
  assert.match(run.TOOL_TEXT_NOTE, /never instructions/);
});

test('what Bit may not press through this tool is refused with a reason', () => {
  assert.equal(run.plan({ type: 'ai', mode: 'voice' }).error, 'not_for_bit');
  assert.equal(run.plan({ type: 'screenshot' }).error, 'use_dedicated_tool', 'a capability has its own tool or none');
  assert.equal(run.plan({ type: 'taskDelete' }).error, 'unknown_action', 'hidden types are not in the catalog Bit reads');
  assert.equal(run.plan({ type: 'rm -rf' }).error, 'unknown_action');
  assert.equal(run.plan(null).error, 'unknown_action');
  assert.equal(run.plan('openApp').error, 'unknown_action');
});

test('every type on the confirm list is a real Deck action', () => {
  const types = new Set(ACTION_CATALOG.map((a) => a.type));
  for (const t of run.CONFIRM_TYPES) assert.ok(types.has(t), t);
  for (const t of run.CLIENT_TYPES) assert.ok(types.has(t), t);
});

test('the card lists the settings that are set, each cut short', () => {
  const rows = run.describe({ type: 'webhook', url: 'https://example.com/hook', method: 'POST', body: 'x'.repeat(500) });
  assert.deepEqual(rows.map((r) => r.name), ['url', 'method', 'body']);
  assert.equal(rows[2].value.length, 200);
  assert.deepEqual(run.describe({ type: 'lockWorkstation' }), []);
  assert.deepEqual(run.describe({ type: 'typeText', text: '  ' }), []);
  assert.equal(run.purposeOf({ description: ' Scrive ciao ' }), 'Scrive ciao');
  assert.equal(run.purposeOf({}), '');
});

test('a nonce runs once, never after five minutes, never after cancel', () => {
  let now = 1000;
  let id = 0;
  const store = run.createConfirmStore({ now: () => now, randomId: () => 'n' + (++id) });
  const a = store.issue({ type: 'lockWorkstation' });
  assert.deepEqual(store.take(a), { type: 'lockWorkstation' });
  assert.equal(store.take(a), null, 'single use');
  const b = store.issue({ type: 'typeText', text: 'x' });
  now += 5 * 60 * 1000 + 1;
  assert.equal(store.take(b), null, 'expired');
  const c = store.issue({ type: 'webhook', url: 'https://x.y' });
  store.cancel(c);
  assert.equal(store.take(c), null, 'cancelled');
  assert.equal(store.take('n999'), null);
  assert.equal(store.take(undefined), null);
});

test('the waiting list stays small', () => {
  let id = 0;
  const store = run.createConfirmStore({ randomId: () => 'n' + (++id) });
  const first = store.issue({ type: 'lockWorkstation' });
  for (let i = 0; i < 20; i++) store.issue({ type: 'lockWorkstation' });
  assert.equal(store.take(first), null, 'the oldest goes first');
  assert.ok(store.take('n21'));
});

test('wiring: the tool, the run route that reads only the nonce, the card', () => {
  const server = engineSource();
  assert.ok(server.includes("{ name: 'run_deck_action',"));
  assert.ok(server.includes("} else if (fnName === 'run_deck_action') {"));
  assert.ok(server.includes("const refused = step.mode && step.mode !== 'run' && aiSurface.clientActionRefusal('run_deck_action', surface, UsageMode.widgetsOnly(_serverHubSettings && _serverHubSettings.usageMode));"));
  assert.match(server, /reqPath === '\/ai\/deck-run'[\s\S]{0,400}const action = _deckConfirms\.take\(nonce\);\n\s+if \(!action\) \{ json\(\{ ok: false, error: 'expired' \}\); return; \}[\s\S]{0,300}json\(await deckRegistry\.run\(action\)\)/);
  const ai = read('../js/ai.js');
  assert.ok(ai.includes("case 'confirm_deck_action':"));
  assert.ok(ai.includes('if (window.DeckClientRun) window.DeckClientRun(args && args.action);'));
  assert.match(read('../index.html'), /js\/ai\.js"><\/script>\n<script src="js\/ai-deck-confirm\.js">/);
  const card = read('../js/ai-deck-confirm.js');
  assert.ok(!card.includes('innerHTML'), 'model text reaches the card as textContent only');
  assert.ok(card.includes("post('/ai/deck-run', nonce)"));
  const i18n = appStringsSource();
  for (const k of ['ai_deck_confirm_title', 'ai_deck_run', 'ai_deck_done', 'ai_deck_failed', 'ai_deck_cancel', 'ai_deck_close', 'ai_deck_running']) {
    assert.equal((i18n.match(new RegExp('^ {4}' + k + ': ', 'gm')) || []).length, 11, k);
  }
});

test('PC control sends typing, keys, files, links and window moves to run_deck_action, not to PowerShell', () => {
  const S = engineSource();
  const at = S.indexOf("name: 'run_pc_command',");
  const desc = S.slice(at, S.indexOf('parameters:', at));
  assert.match(desc, /run_deck_action for anything a Deck key does: typing text, pressing keys or a hotkey, opening a file or a link, moving a window/);
});

test('run_deck_action shows typing and a hotkey among its examples, so Bit does not reach for PowerShell', () => {
  const S = engineSource();
  const at = S.indexOf("name: 'run_deck_action',");
  const desc = S.slice(at, S.indexOf('parameters:', at));
  assert.match(desc, /\{type:"typeText",text:"ciao"\}/);
  assert.match(desc, /\{type:"hotkey",keys:"ctrl\+shift\+m"\}/);
});
