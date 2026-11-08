// The Deck's four windows (key editor, Deck appearance, Smart Profiles, mixer) are sheets like
// every other window. What has to stay true, on their real code where a rig can reach it:
//  1. Smart Profiles opens once, closes on Esc and gives the focus back.
//  2. A press beside it closes only what has nothing to lose.
//  3. What is being typed survives the list of apps arriving.
//  4. A combination being recorded keeps every key; the window gets them back afterwards.
//  5. The main key comes last, Save as preset is a tool, promos wait for all four.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom, windowKeys, settle } from './mini-dom.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function between(src, from, to) {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `${from} … ${to} not found`);
  return src.slice(start, end);
}

function pressKeys(keys, seen = {}) {
  return (key, extra = {}) => keys.slice().forEach((fn) => fn({
    key,
    shiftKey: false,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() { seen.swallowed = true; },
    ...extra,
  }));
}

function smartProfiles({ rules = [], windows = [] } = {}) {
  const { document } = makeDom();
  const window = {
    DeckIcons: { CLOSE_MARK: '<svg></svg>' },
    DeckModel: { cloneConfig: (c) => JSON.parse(JSON.stringify(c)), normalizeDeckConfig: (c) => c },
    initCustomSelect: (sel) => dropdowns.push(sel),
  };
  const dropdowns = [];
  const saved = [];
  const keys = windowKeys(window);
  vm.runInNewContext(read('../js/dialog-focus.js'), { window, document });
  let appsArrive = () => assert.fail('the list of apps was never asked for');
  const box = {
    window,
    document,
    el(tag, cls, text) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    },
    tr: (_key, fallback) => fallback,
    getConfig: () => ({
      profiles: [{ name: 'Main' }, { name: 'Game' }],
      autoSwitch: { enabled: false, revert: 'default', rules },
    }),
    saveConfig: (_id, config) => saved.push(config),
    deckBase: () => '',
    fetch: () => new Promise((resolve) => {
      appsArrive = () => resolve({ json: async () => ({ windows }) });
    }),
    render() {},
  };
  const src = read('../js/deck.js');
  vm.runInNewContext(`${between(src, 'function switchRow(', 'function openDeckStyleModal(')}
    ${between(src, 'let closeAutoSwitch = null;', '// ── Smart Profiles: foreground-app')}
    this.open = openAutoSwitchDialog;`, box);
  const trigger = document.createElement('button');
  document.body.append(trigger);
  trigger.focus();
  const one = (selector) => document.querySelector(selector);
  return {
    document,
    keys,
    trigger,
    dropdowns,
    saved,
    one,
    open: () => box.open({}, 'deck'),
    press: pressKeys(keys),
    arrive: () => appsArrive(),
    addRule: () => one('.deck-asw .deck-ed-addstep').click(),
    field: () => one('.deck-asw-rule').children[0],
    type(input, text) {
      input.value = text;
      input._handlers.input.forEach((fn) => fn({ target: input }));
    },
  };
}

test('Smart Profiles opens once: a second press does not stack a second window', () => {
  const r = smartProfiles();
  r.open();
  r.open();
  assert.equal(r.document.querySelectorAll('.deck-asw').length, 1);
  assert.equal(r.keys.length, 1, 'and one hold on the keyboard');
});

test('Esc closes Smart Profiles and the focus goes back to what opened it', () => {
  const r = smartProfiles();
  r.open();
  r.press('Escape');
  assert.equal(r.one('.deck-asw'), null);
  assert.equal(r.keys.length, 0);
  assert.equal(r.document.activeElement, r.trigger);
});

test('a press beside an untouched window closes it', () => {
  const r = smartProfiles();
  r.open();
  r.one('.deck-asw-backdrop').click();
  assert.equal(r.one('.deck-asw'), null);
});

test('a press beside a window with a change in it is a slip: nothing is lost', () => {
  const r = smartProfiles();
  r.open();
  r.addRule();
  r.one('.deck-asw-backdrop').click();
  assert.ok(r.one('.deck-asw'));
  r.press('Escape');
  assert.equal(r.one('.deck-asw'), null, 'Esc is a decision, and it still closes');
});

test('what is being typed survives the list of apps arriving', async () => {
  const r = smartProfiles({ windows: [{ app: 'OBS64.exe' }, { app: 'obs64' }, { app: '' }] });
  r.open();
  r.addRule();
  const field = r.field();
  r.type(field, 'ob');
  r.arrive();
  await settle();
  assert.equal(r.field(), field, 'the same field, with the caret still in it');
  assert.equal(field.value, 'ob');
  const apps = r.one('#deck-asw-apps').children.map((option) => option.value);
  assert.deepEqual(apps, ['obs64'], 'one suggestion per app, no .exe, no blanks');
});

test('rules use the shared dropdown, and it floats above the list', () => {
  const r = smartProfiles({ rules: [{ exe: 'obs64', profile: 'Game' }] });
  r.open();
  assert.equal(r.dropdowns.length, 2, 'the fallback and the rule');
  r.dropdowns.forEach((sel) => assert.equal(sel.getAttribute('data-cs-fixed'), ''));
});

test('a saved rule is what was typed, written the way the app names it', () => {
  const r = smartProfiles();
  r.open();
  r.one('.deck-asw .deck-ed-switchrow').click();
  r.addRule();
  r.type(r.field(), ' OBS64.EXE ');
  r.one('.deck-asw .deck-ed-btn.primary').click();
  assert.equal(JSON.stringify(r.saved[0].autoSwitch),
    JSON.stringify({ enabled: true, revert: 'default', rules: [{ exe: 'obs64', profile: 'Main' }] }));
  assert.equal(r.one('.deck-asw'), null);
});

function recorder() {
  const { document } = makeDom();
  const window = {
    DeckIcons: { CLOSE_MARK: '' },
    DeckShortcuts: {
      normalizeShortcut: (combo) => combo || '',
      formatShortcut: (combo) => combo,
      reservedBy: () => null,
      comboFromKeyEvent: (e) => e.combo || '',
    },
  };
  const keys = windowKeys(window);
  vm.runInNewContext(read('../js/dialog-focus.js'), { window, document });
  vm.runInNewContext(read('../js/deck-editor-shortcut.js'), {
    window,
    document,
    navigator: { platform: 'Win32', userAgent: '' },
    fetch: async () => ({ ok: false }),
  });
  const root = document.createElement('div');
  const first = root.appendChild(document.createElement('button'));
  const last = root.appendChild(document.createElement('button'));
  document.body.append(root);
  let closes = 0;
  let card = null;
  window.DialogFocus.hold(root, {
    start: first,
    onEsc() { closes += 1; },
    leavesKeys: () => card.recording(),
  });
  card = window.DeckEditorShortcut.buildCard(
    { t: (key) => key, section: () => document.createElement('div') }, null);
  return {
    document, keys, card, first, last,
    closes: () => closes,
    press: pressKeys(keys),
    record: () => card.el.querySelector('.deck-ed-shortcut-rec').click(),
  };
}

test('Esc while recording stops the recording, the next Esc closes the window', () => {
  const r = recorder();
  r.record();
  assert.equal(r.card.recording(), true);
  r.press('Escape');
  assert.equal(r.card.recording(), false);
  assert.equal(r.closes(), 0);
  r.press('Escape');
  assert.equal(r.closes(), 1);
});

test('Tab while recording is a key like the others: the focus stays, then goes back to going round', () => {
  const r = recorder();
  r.record();
  r.press('Tab', { combo: 'ctrl+tab' });
  assert.equal(r.document.activeElement, r.first);
  assert.equal(r.card.recording(), false);
  const key = {};
  r.card.collect(key);
  assert.equal(key.shortcut, 'ctrl+tab');
  r.press('Tab');
  assert.equal(r.document.activeElement, r.last);
});

test('the editor closing in the middle of a recording lets go of the keyboard', () => {
  const r = recorder();
  r.record();
  assert.equal(r.keys.length, 2);
  r.card.dispose();
  assert.equal(r.keys.length, 1);
});

test('the main key comes last, and Save as preset is a tool, not a fourth key', () => {
  const src = read('../js/deck-editor.js');
  const at = ['btnDel', 'btnCancel', 'btnSave'].map((key) => src.indexOf(`actions.appendChild(${key});`));
  assert.ok(at[0] > 0 && at[0] < at[1] && at[1] < at[2], 'Delete, Cancel, Save');
  assert.match(src, /styleTools\.appendChild\(btnSavePreset\);/);
  assert.doesNotMatch(src, /actions\.appendChild\(btnSavePreset\)/);
});

test('a press beside the key editor closes only an untouched key', () => {
  assert.match(read('../js/deck-editor.js'),
    /e\.target === backdrop && JSON\.stringify\(collectKey\(true\)\) === pristine\) close\(\);/);
});

test('the key editor holds the keyboard, and gives it back before it goes', () => {
  const src = read('../js/deck-editor.js');
  assert.match(src, /backdrop\.letGo = window\.DialogFocus\.hold\(modal, \{[^}]*onEsc: close,/);
  assert.match(src, /leavesKeys: \(\) => shortcut\.recording\(\)/);
  const closing = between(src, 'function close() {', 'm.remove();');
  assert.match(closing, /if \(m\.letGo\) m\.letGo\(\);/);
});

test('Deck appearance and the mixer hold the keyboard too, also in the Deck popup', () => {
  const src = read('../js/deck.js');
  assert.match(src, /deckStyleLetGo = window\.DialogFocus\.hold\(dialog, \{ onEsc: closeDeckStyleModal \}\);/);
  assert.match(src, /deckMixLetGo = window\.DialogFocus\.hold\(modal, \{ onEsc: closeDeckMixer \}\);/);
  const page = read('../deck-popup.html');
  const helper = page.indexOf('js/dialog-focus.js');
  assert.ok(helper > 0 && helper < page.indexOf('js/deck.js'), 'loaded before the Deck');
});

test('promos and the screensaver wait for all four windows', () => {
  for (const file of ['../js/ambient-mode.js', '../js/interrupt-queue.js']) {
    const src = read(file);
    for (const name of ['.deck-ed-backdrop', '.deck-mix-backdrop', '.deck-style-modal']) {
      assert.ok(src.includes(name), `${file} lists ${name}`);
    }
  }
});

test('the window keys are drawn marks, never characters that change with the font', () => {
  const deck = read('../js/deck.js');
  const windows = [
    read('../js/deck-editor.js'),
    read('../js/deck-editor-shortcut.js'),
    between(deck, 'function openDeckStyleModal(', 'deckStyleLetGo = window.DialogFocus.hold'),
    between(deck, 'function openAutoSwitchDialog(', '// ── Smart Profiles: foreground-app'),
    between(deck, 'function openDeckMixer(', 'deckMixLetGo = window.DialogFocus.hold'),
  ].join('\n');
  assert.doesNotMatch(windows, /['"`][^'"`\n]*[✕✖＋][^'"`\n]*['"`]/);
});

test('every skin changes the Deck windows through their tokens, not by repainting their parts', () => {
  const css = read('../components/DeckPanel/DeckPanel.css');
  assert.match(css, /\.deck-ed-modal, \.deck-mix-modal, \.deck-style-dialog, \.deck-asw \{[^}]*--ded-on:/);
  const contract = read('../styles/theme-contract.css');
  assert.ok(contract.includes('.deck-style-dialog, .deck-ed-modal, .deck-mix-modal, .deck-asw'));
  assert.doesNotMatch(contract, /\.deck-style-modal,/, 'the overlay stays see-through');
});

test('the four windows share one backdrop, so none reads lighter than the others', () => {
  const css = read('../components/DeckPanel/DeckPanel.css');
  assert.match(css, /\.deck-ed-backdrop, \.deck-mix-backdrop, \.deck-style-modal \{[^}]*backdrop-filter: blur\(22px\)/);
  for (const name of ['.deck-ed-backdrop', '.deck-mix-backdrop', '.deck-style-modal']) {
    const own = between(css, `\n${name} {`, '}');
    assert.doesNotMatch(own, /background|backdrop-filter/, name);
  }
});

test('on a phone the tools stay beside the preview, and the presets scroll on a row of their own', () => {
  const css = read('../components/DeckPanel/DeckPanel.css');
  const phone = between(css, '@media (max-width: 760px) and (min-height: 521px) {', '/* Short viewports');
  assert.match(phone, /\.deck-ed-body \{ flex-direction: column; \}/, 'a phone on its side keeps the rail: no height for a strip');
  assert.match(phone, /\.deck-ed-side \{[^}]*flex-flow: row wrap;[^}]*overflow: hidden;/);
  assert.match(phone, /\.deck-ed-styletools \{ order: 1; flex: 1 1 0; min-width: 0;/);
  assert.match(phone, /\.deck-ed-side \.deck-ed-presets \{ order: 2; flex: 1 0 100%;[^}]*overflow-x: auto;/);
});
