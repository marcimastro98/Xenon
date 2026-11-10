// The menu's window showing one screen alone (showSheet, takeAsk), and how a
// function in the menu finds the Deck key that already does it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createScreenMenu } = require('../screen-menu.js');
const Functions = require('../menu-functions.js');
const DeckShortcuts = require('../js/deck-shortcuts.js');
const DeckModel = require('../js/deck-model.js');

const menu = (shell = true) => {
  const pushes = [];
  return { pushes, m: createScreenMenu({ host: { menus: () => shell }, broadcast: (s) => pushes.push(s) }) };
};

test('a sheet opens alone in the menu window and leaves with it', () => {
  const { m, pushes } = menu();
  assert.equal(m.showSheet({ open: 'store' }), 'screen');
  assert.equal(pushes.at(-1).open, true);
  assert.equal(pushes.at(-1).sheet.open, 'store');
  m.close();
  assert.equal(pushes.at(-1).open, false);
  assert.equal(pushes.at(-1).sheet, undefined);
});

test('no shell, or a screen a sheet cannot show: the caller opens the dashboard', () => {
  assert.equal(menu(false).m.showSheet({ open: 'store' }), 'closed');
  assert.equal(menu().m.showSheet({ open: 'update' }), 'closed');
  assert.equal(menu().m.showSheet({ open: 'nothing' }), 'closed');
  assert.equal(menu().m.showSheet(null), 'closed');
});

test('a question for the chat is handed over once, and only to the chat', () => {
  const { m, pushes } = menu();
  m.showSheet({ open: 'chat' }, '  what is my GPU doing?  ');
  assert.ok(!JSON.stringify(pushes).includes('GPU'), 'the question never rides the broadcast');
  assert.equal(m.takeAsk(), 'what is my GPU doing?');
  assert.equal(m.takeAsk(), '');
  m.showSheet({ open: 'store' }, 'not for the store');
  assert.equal(m.takeAsk(), '');
});

test('a long question is cut, a question that is not text is dropped', () => {
  const { m } = menu();
  m.showSheet({ open: 'chat' }, 'x'.repeat(5000));
  assert.equal(m.takeAsk().length, 2000);
  m.showSheet({ open: 'chat' }, { text: 'no' });
  assert.equal(m.takeAsk(), '');
});

const fn = (id) => Functions.functionById(id);

test('a screenshot key with no target counts as the screenshot of the menu', () => {
  assert.ok(Functions.matches(fn('shot'), { type: 'screenshot' }));
  assert.ok(Functions.matches(fn('shot'), { type: 'screenshot', target: 'screen' }));
  assert.ok(!Functions.matches(fn('shot'), { type: 'screenshot', target: 'window' }));
  assert.ok(!Functions.matches(fn('shot'), { type: 'screenshot', mode: 'reveal' }), 'showing the file is another key');
  assert.ok(!Functions.matches(fn('shot'), null));
});

test('the key the menu made wins over one that only does the same', () => {
  const made = { keyId: Functions.KEY_PREFIX + 'shot', does: { type: 'screenshot' } };
  const other = { keyId: 'k1', does: { type: 'screenshot' } };
  assert.equal(Functions.keyFor([other, made], fn('shot')), made);
  assert.equal(Functions.keyFor([other], fn('shot')), other);
  assert.equal(Functions.keyFor([], fn('shot')), null);
  assert.equal(Functions.keyFor(null, fn('shot')), null);
});

const shot = { action: { type: 'screenshot', target: 'window' } };
const deckWith = (steps) => ({
  main: { profiles: [{ id: 'p', root: { pages: [{ keys: [{ id: 'k1', kind: 'action', shortcut: 'ctrl+shift+f3', triggers: { tap: { steps } } }] }] } }] },
});

test('only a one-step key says what it does', () => {
  const does = (steps) => DeckShortcuts.collectShortcuts(deckWith(steps)).list[0].does;
  const one = does([shot]);
  assert.equal(one.type, 'screenshot');
  assert.equal(one.target, 'window');
  assert.equal(does([shot, shot]), null, 'a macro of two steps is not one function');
});

test('findTopKey finds a key and says nothing about a missing one', () => {
  const config = DeckModel.normalizeDeckConfig({});
  const page = config.profiles[0].root.pages[0];
  page.keys[2] = { id: 'k_found', kind: 'action', title: 'Shot', actions: [{ type: 'screenshot' }] };
  const hit = DeckModel.findTopKey(config, 'k_found');
  assert.equal(hit.slot, 2);
  assert.deepEqual(hit.nav, { profileId: config.profiles[0].id, path: [], pageIndex: 0 });
  assert.equal(DeckModel.findTopKey(config, 'k_missing'), null);
});
