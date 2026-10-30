// Deck key shortcuts by voice: "put Ctrl+Shift+F9 on my Music key", through
// the capability registry, the same way the Deck editor sets them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync as readFileSyncRaw } from 'node:fs';
const readFileSync = (p) => readFileSyncRaw(p, 'utf8').replace(/\r\n/g, '\n');

const require = createRequire(import.meta.url);
const { validateAction } = require('../js/deck-actions.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const SERVER = readFileSync(new URL('../server.js', import.meta.url));

const key = (id, title, extra) => Object.assign({ id, kind: 'action', title, action: { type: 'openUrl', url: 'https://x.test/' + id } }, extra);
const deckConfigs = () => ({
  'deck-a': { profiles: [{ name: 'Main', root: { pages: [{ keys: [
    key('k1', 'Music'),
    key('k2', 'Mute', { shortcut: 'ctrl+shift+f8' }),
    key('k3', 'Music Pause'),
    { kind: 'folder', folder: { pages: [{ keys: [key('k4', 'Lights')] }] } },
  ] }] } }] },
  'deck-b': { profiles: [{ name: 'Games', root: { pages: [{ keys: [key('k5', 'Lights')] }] } }] },
});

// A fake store with the server's contract: edit a copy, write only what changed.
function fakeDeck(opts = {}) {
  const state = { configs: deckConfigs(), writes: [] };
  const deck = {
    update: async (edit) => {
      const copy = JSON.parse(JSON.stringify(state.configs));
      const out = edit(copy) || {};
      for (const id of out.changed || []) { state.configs[id] = copy[id]; state.writes.push(id); }
      return out.result;
    },
    status: () => opts.status || [],
    takenByOthers: () => opts.taken || [],
  };
  return { state, caps: createCapabilities({ deck, shortcutsAvailable: () => true }) };
}
const keyIn = (configs, instance, id) => {
  let hit = null;
  const walk = (pages) => pages.forEach((p) => p.keys.forEach((k) => { if (k.id === id) hit = k; if (k.kind === 'folder') walk(k.folder.pages); }));
  configs[instance].profiles.forEach((p) => walk(p.root.pages));
  return hit;
};

test('"put ctrl shift F9 on my Music key" sets it on that key only', async () => {
  const { state, caps } = fakeDeck();
  const action = aiAction('set_key_shortcut', { key: 'music', shortcut: 'Ctrl+Shift+F9', junk: 1 });
  assert.deepEqual(action, { type: 'deckShortcut', key: 'music', shortcut: 'Ctrl+Shift+F9' });
  const r = await caps.run(validateAction(action));
  assert.equal(r.ok, true);
  assert.equal(r.key, 'Music (Main)');
  assert.equal(keyIn(state.configs, 'deck-a', 'k1').shortcut, 'ctrl+shift+f9');
  assert.equal(keyIn(state.configs, 'deck-a', 'k3').shortcut, undefined, 'the exact title wins over "Music Pause"');
  assert.deepEqual(state.writes, ['deck-a']);
});

test('"remove the shortcut from Mute" takes it away; doing it twice writes once', async () => {
  const { state, caps } = fakeDeck();
  assert.deepEqual(await caps.run({ type: 'deckShortcut', key: 'Mute', shortcut: '' }), { ok: true, key: 'Mute (Main)', shortcut: '' });
  assert.equal('shortcut' in keyIn(state.configs, 'deck-a', 'k2'), false);
  assert.equal((await caps.run({ type: 'deckShortcut', key: 'Mute', shortcut: 'off' })).ok, true);
  assert.deepEqual(state.writes, ['deck-a']);
});

test('a key inside a folder is found, and a title on two Decks asks which one', async () => {
  const { state, caps } = fakeDeck();
  const r = await caps.run({ type: 'deckShortcut', key: 'Lights', shortcut: 'ctrl+shift+f10' });
  assert.equal(r.error, 'ambiguous');
  assert.deepEqual(r.choices, ['Lights (Main)', 'Lights (Games)']);
  assert.deepEqual(state.writes, []);
  const none = await caps.run({ type: 'deckShortcut', key: 'Kettle', shortcut: 'ctrl+shift+f10' });
  assert.equal(none.error, 'no_key');
  assert.ok(none.choices.includes('Music (Main)'));
});

test('the Xenon menu names the key by id: a repeated title is no problem, and the AI cannot pass an id', async () => {
  const { state, caps } = fakeDeck();
  const r = await caps.run(validateAction({ type: 'deckShortcut', keyId: 'k5', shortcut: 'ctrl+shift+f10' }));
  assert.equal(r.ok, true);
  assert.equal(r.key, 'Lights (Games)');
  assert.equal(keyIn(state.configs, 'deck-b', 'k5').shortcut, 'ctrl+shift+f10');
  assert.equal(keyIn(state.configs, 'deck-a', 'k4').shortcut, undefined);
  assert.equal((await caps.run({ type: 'deckShortcut', keyId: 'gone', shortcut: 'ctrl+shift+f11' })).error, 'no_key');
  assert.equal('keyId' in aiAction('set_key_shortcut', { key: 'Lights', keyId: 'k5', shortcut: 'ctrl+shift+f10' }), false);
});

test('bad, reserved and taken combinations are refused with the reason and nothing is written', async () => {
  const { state, caps } = fakeDeck({ taken: ['ctrl+shift+f1'] });
  assert.equal((await caps.run({ type: 'deckShortcut', key: 'Music', shortcut: 'q' })).error, 'bad_shortcut');
  const reserved = await caps.run({ type: 'deckShortcut', key: 'Music', shortcut: 'ctrl+alt+delete' });
  assert.ok(['reserved', 'bad_shortcut'].includes(reserved.error));
  const sys = await caps.run({ type: 'deckShortcut', key: 'Music', shortcut: 'win+l' });
  assert.ok(['reserved', 'bad_shortcut'].includes(sys.error));
  assert.deepEqual(await caps.run({ type: 'deckShortcut', key: 'Music', shortcut: 'ctrl+shift+f1' }), { ok: false, error: 'in_use', by: 'page or search shortcut' });
  assert.deepEqual(await caps.run({ type: 'deckShortcut', key: 'Music', shortcut: 'ctrl+shift+f8' }), { ok: false, error: 'in_use', by: 'Mute' });
  assert.deepEqual(state.writes, []);
});

test('"which shortcuts do I have?" reads the live verdicts', async () => {
  const { caps } = fakeDeck({ status: [{ keyId: 'k2', combo: 'ctrl+shift+f8', title: 'Mute', state: 'listening' }] });
  const r = await caps.run({ type: 'deckShortcutList' });
  assert.equal(r.ok, true);
  assert.equal(r.shortcuts.length, 1);
  assert.equal(r.shortcuts[0].key, 'Mute');
  assert.equal(r.shortcuts[0].state, 'listening');
  assert.ok(r.shortcuts[0].shortcut.length > 0);
});

test('without the Helper (or GNOME) neither tool is offered nor run', async () => {
  const caps = createCapabilities({ deck: { update: async () => ({}) }, shortcutsAvailable: () => false });
  assert.equal(caps.probes().shortcuts, false);
  const names = aiFunctions(caps.probes()).map((f) => f.name);
  assert.ok(!names.includes('set_key_shortcut') && !names.includes('list_key_shortcuts'));
  assert.equal((await caps.run({ type: 'deckShortcut', key: 'Music', shortcut: 'ctrl+shift+f9' })).ok, false);
  const on = aiFunctions({ shortcuts: true }).map((f) => f.name);
  assert.ok(on.includes('set_key_shortcut') && on.includes('list_key_shortcuts'));
});

test('server.js serializes every Deck write and writes the AI edit as set ops', () => {
  assert.match(SERVER, /function withDeckWrite\(fn\) \{/);
  assert.match(SERVER, /await withDeckWrite\(async \(\) => \{\n {8}const current = await readDeckStore\(\);/);
  assert.match(SERVER, /function updateDeckConfigs\(edit\) \{\n {2}return withDeckWrite\(/);
  assert.match(SERVER, /\.map\(\(id\) => \(\{ t: 'set', id, config: configs\[id\] \}\)\)/);
  assert.match(SERVER, /update: \(edit\) => updateDeckConfigs\(edit\)/);
});
