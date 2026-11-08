import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hiddenCategories, navState, leavesActive } = require('../js/sheet-usage.js');
const SheetChat = require('../js/sheet-chat.js');

const onScreen = (...tiles) => ({
  usageMode: 'widgets',
  layers: { widgets: tiles.map((widget) => ({ kind: 'tile', widget })) },
});

test('with a dashboard nothing is shortened', () => {
  for (const settings of [null, {}, { usageMode: '' }, { usageMode: 'dashboard' }, { usageMode: 'both' }]) {
    assert.deepEqual(hiddenCategories(settings), [], JSON.stringify(settings));
  }
});

test('with no dashboard its own settings go, and a tile keeps its settings only once on the screen', () => {
  const none = hiddenCategories({ usageMode: 'widgets' });
  for (const cat of ['island', 'background', 'display', 'secondscreen', 'weather', 'streaming']) {
    assert.ok(none.includes(cat), cat);
  }
  assert.ok(!none.includes('appearance'));
  assert.ok(!none.includes('general'));
  assert.ok(!hiddenCategories(onScreen('weather')).includes('weather'));
  assert.ok(!hiddenCategories(onScreen('twitch')).includes('streaming'), 'any tile of the group keeps it');
  assert.ok(hiddenCategories(onScreen('weather')).includes('streaming'));
});

test('a Store widget on the screen brings no tile settings back', () => {
  const settings = { usageMode: 'widgets', layers: { widgets: [{ kind: 'sdk', widget: 'weather' }, null] } };
  assert.ok(hiddenCategories(settings).includes('weather'));
});

test('a group label goes with its last row, and stays while one row is left', () => {
  const rows = [{ label: true }, { cat: 'a' }, { cat: 'b' }, { label: true }, { cat: 'c' }, { label: true }];
  assert.deepEqual(navState(rows, ['c']), [false, false, false, true, true, true]);
  assert.deepEqual(navState(rows, ['a']), [false, true, false, false, false, true]);
  assert.deepEqual(navState(rows, ['a', 'b']), [true, true, true, false, false, true]);
});

// The menu's All capture options opened Settings on Capture, then General: Capture's
// row waits for the server before it shows, and a row not shown read as one hidden.
test('Settings stays on the page it opened unless this list hides it', () => {
  const rows = [{ label: true }, { cat: 'general' }, { cat: 'capture', active: true }, { cat: 'island' }];
  assert.equal(leavesActive(rows, navState(rows, [])), false, 'nothing hidden: it stays');
  assert.equal(leavesActive(rows, navState(rows, ['island'])), false, 'another page hidden: it stays');
  assert.equal(leavesActive(rows, navState(rows, ['capture'])), true, 'its own page hidden: it goes');
  assert.equal(leavesActive(rows.map((r) => ({ ...r, active: false })), [false, false, true, false]), false, 'no page open');
});

test('the chat keeps only words, and a broken store is a new chat', () => {
  const history = [
    { role: 'user', parts: [{ text: 'ciao' }] },
    { role: 'model', parts: [{ functionCall: { name: 'x' } }] },
    { role: 'tool', parts: [{ text: 'no' }] },
    { role: 'model', parts: [{ text: 'eccomi' }] },
  ];
  assert.deepEqual(SheetChat.keep(history, 'prima').history.map((t) => t.parts[0].text), ['ciao', 'eccomi']);
  assert.equal(SheetChat.keep(history, 'prima').summary, 'prima');
  assert.deepEqual(SheetChat.parse('{broken'), { history: [], summary: '' });
  assert.deepEqual(SheetChat.parse('null'), { history: [], summary: '' });
  const long = Array.from({ length: 90 }, (_, i) => ({ role: 'user', parts: [{ text: String(i) }] }));
  const kept = SheetChat.keep(long).history;
  assert.equal(kept.length, 40);
  assert.equal(kept.at(-1).parts[0].text, '89');
});

test('the bubbles show what was said, not the record of actions or the placeholders', () => {
  const history = [
    { role: 'user', parts: [{ text: '[richiesta vocale]' }] },
    { role: 'model', parts: [{ text: '[Xenon record: tools you ran in this reply: x ok]\n\nFatto.' }] },
  ];
  assert.deepEqual(SheetChat.bubbles(history), [{ role: 'assistant', text: 'Fatto.' }]);
});
