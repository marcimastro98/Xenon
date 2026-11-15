// The one question a backup import asks at the PC: keep the Deck keys that start things?
// The yes travels in the request beside the file, never in the file, and only from the PC.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { test } from 'node:test';

import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { deckOnImport, deckActionsHeldBack } = require('../settings/backup-keep.js');
const { importRequest, REQUEST_ROOM } = require('../settings/backup-request.js');
const { branches } = require('../settings/routes.js');
const { remoteMayRun, remoteMayLaunch, guardedIn } = require('../paired/remote-actions.js');
const { normalizeDeckStore } = require('../deck/store-normalize.js');
const { REMOTE_DENY } = require('../paired/refused-paths.js');

const deckOf = (/** @type {any[]} */ keys, extra = {}) => ({
  configs: { main: { profiles: [{ id: 'p1', root: { pages: [{ keys }] } }] } }, rev: 3, ...extra,
});
const keyAt = (/** @type {any} */ store, /** @type {number} */ index) => store.configs.main.profiles[0].root.pages[0].keys[index];
const NOTES = { type: 'openApp', path: '/opt/notes/notes' };
const TOOL = { type: 'openApp', path: '/opt/tool/tool' };
const SCRIPT = { type: 'runScript', path: '/opt/tool/run.sh' };
const FILE_DECK = deckOf([
  { id: 'a', kind: 'action', title: 'Notes', triggers: { tap: NOTES } },
  { id: 'b', kind: 'action', title: 'Tool', triggers: { tap: TOOL, hold: { type: 'media', cmd: 'next' }, double: { type: 'hotkey', keys: 'ctrl+alt+t' } } },
  { id: 'c', kind: 'action', title: 'Steps', triggers: { tap: { steps: [{ action: SCRIPT, delayMs: 0 }, { action: TOOL, delayMs: 10 }] } } },
  { id: 'd', kind: 'action', title: 'Hook', triggers: { tap: { type: 'webhook', url: 'https://example.com/hook?token=secret', method: 'POST' } } },
  { id: 'e', kind: 'action', title: 'Type', triggers: { tap: { type: 'typeText', text: 'my password' } } },
]);
const HERE = deckOf([{ id: 'a', kind: 'action', title: 'Notes', triggers: { tap: NOTES } }]);
const bundleOf = (/** @type {any} */ deck, extra = {}) => ({ xenonBackup: 2, data: { deck }, ...extra });

test('without the yes the keys come in empty, and the answer says how many and what they would start', () => {
  const written = deckOnImport(FILE_DECK, HERE);
  const held = deckActionsHeldBack(FILE_DECK, written);
  assert.equal(held?.keys, 4, 'four keys lost an action; the key this PC already had did not');
  // Kind and program, name or shortcut. Never a web address or a typed text: they can hold a secret.
  assert.deepEqual(held?.actions, [
    { type: 'openApp', what: '/opt/tool/tool' }, { type: 'hotkey', what: 'ctrl+alt+t' }, { type: 'runScript', what: '/opt/tool/run.sh' },
    { type: 'webhook', what: '' }, { type: 'typeText', what: '' },
  ]);
  assert.equal(JSON.stringify(held).includes('secret'), false);
  assert.equal(JSON.stringify(held).includes('password'), false);
  assert.deepEqual([held?.more, held?.tooDeep], [0, 0]);
  for (const value of Object.values(held ?? {}).flat()) assert.ok(['number', 'object'].includes(typeof value));
});

test('the list is capped, and says how many more', () => {
  const many = deckOf(Array.from({ length: 30 }, (_, n) => ({ id: `k${n}`, kind: 'action', triggers: { tap: { type: 'openApp', path: `/opt/app${n}/run` } } })));
  const held = deckActionsHeldBack(many, deckOnImport(many, null));
  assert.deepEqual([held?.keys, held?.actions.length, held?.more], [30, 8, 22]);
  const long = deckOf([{ id: 'k', kind: 'action', triggers: { tap: { type: 'openApp', path: `/opt/${'a'.repeat(400)}` } } }]);
  assert.ok((deckActionsHeldBack(long, deckOnImport(long, null))?.actions[0].what.length ?? 999) <= 160);
});

test('with the yes the file\'s keys come in as written, and only the literal true is a yes', () => {
  const kept = deckOnImport(FILE_DECK, HERE, true);
  assert.deepEqual(kept, normalizeDeckStore(FILE_DECK));
  assert.equal(deckActionsHeldBack(FILE_DECK, kept), null, 'nothing left to ask about');
  assert.deepEqual(remoteMayRun(TOOL, kept), { ok: true });
  for (const notYes of [undefined, false, null, 1, 'true', {}, []]) {
    const written = deckOnImport(FILE_DECK, HERE, /** @type {any} */ (notYes));
    assert.deepEqual(keyAt(written, 1).triggers, { hold: { type: 'media', cmd: 'next' } }, String(notYes));
    assert.equal(remoteMayLaunch(TOOL.path, [], written), false);
  }
});

test('what lies deeper than the walk looks is dropped and counted, with or without the yes', () => {
  /** @type {any} */
  let nest = { triggers: { tap: TOOL } };
  for (let n = 0; n < 60; n++) nest = { inner: nest };
  const file = deckOf([{ id: 'deep', kind: 'action', title: 'Deep', nest }, { id: 'b', kind: 'action', triggers: { tap: TOOL } }]);
  for (const keep of [false, true]) {
    const written = deckOnImport(file, null, keep);
    assert.equal(JSON.stringify(keyAt(written, 0)).includes('/opt/tool/tool'), false, 'the deep action is not written');
    // What the paired-device rule can see and what was written are the same thing.
    assert.equal(guardedIn(written).size, keep ? 1 : 0);
    const held = deckActionsHeldBack(file, written);
    assert.equal(held?.tooDeep, 1, 'counted');
    assert.equal(held?.keys, keep ? 0 : 1, 'only the key within reach can be asked about');
  }
  // The same limit on both sides: an action at the deepest level the rule sees is kept when held here.
  const flat = deckOf([{ id: 'a', kind: 'action', triggers: { tap: NOTES } }]);
  assert.deepEqual(deckOnImport(flat, flat), normalizeDeckStore(flat));
});

test('the request: the yes is read beside the file, and a file that carries it says nothing', () => {
  const bundle = bundleOf(FILE_DECK);
  assert.deepEqual(importRequest({ bundle, keepDeckActions: true }), { bundle, keepDeckActions: true });
  assert.deepEqual(importRequest({ bundle }), { bundle, keepDeckActions: false });
  for (const notYes of [false, 1, 'true', 'yes', {}, null]) assert.equal(importRequest({ bundle, keepDeckActions: notYes }).keepDeckActions, false);
  // The older shape, the file as it is: all of it is the file, its own word is not read.
  const carried = { ...bundle, keepDeckActions: true };
  assert.deepEqual(importRequest(carried), { bundle: carried, keepDeckActions: false });
  assert.equal(importRequest({ ...bundle, keepDeckActions: true, bundle }).keepDeckActions, false, 'a file that also wraps itself');
  // Inside the file, anywhere: the request around it decides.
  const inside = bundleOf(FILE_DECK, { keepDeckActions: true });
  inside.data.keepDeckActions = true;
  inside.data.deck.keepDeckActions = true;
  assert.equal(importRequest({ bundle: inside }).keepDeckActions, false);
  for (const odd of [null, 7, 'text', [], { bundle: [] }, { bundle: 'x', keepDeckActions: true }]) assert.equal(importRequest(odd).keepDeckActions, false);
  assert.ok(REQUEST_ROOM >= '{"keepDeckActions":true,"bundle":}'.length);
});

/** The route with an engine that imports only the Deck, the way the engine's own code does it. */
async function post(/** @type {string} */ body, { isRemote = false, here = HERE } = {}) {
  /** @type {any[]} */
  const calls = [];
  /** @type {any} */
  let written = here;
  const applyBackup = async (/** @type {any} */ bundle, /** @type {any} */ how) => {
    calls.push(how);
    if (!bundle || bundle.xenonBackup !== 2 || !bundle.data) return { ok: false, error: 'bad_format' };
    written = deckOnImport(bundle.data.deck, here, how.keepDeckActions === true && !how.remote);
    const deckActions = deckActionsHeldBack(bundle.data.deck, written);
    return { ok: true, restored: ['deck'], needsSetup: deckActions ? ['deckActions'] : [], deckActions };
  };
  /** @type {any} */
  let answer = null;
  await branches['POST /backup/import'](Readable.from([Buffer.from(body)]), null, { json: (/** @type {any} */ out) => { answer = out; }, err500: (/** @type {string} */ why) => { answer = { failed: why }; }, isRemote }, { applyBackup });
  return { answer, calls, written };
}

test('the route: without the yes, with it, and with a file that claims it', async () => {
  const bundle = bundleOf(FILE_DECK);
  const plainSend = await post(JSON.stringify({ bundle }));
  assert.deepEqual(plainSend.calls, [{ remote: false, keepDeckActions: false }]);
  assert.deepEqual(plainSend.answer.needsSetup, ['deckActions']);
  assert.equal(plainSend.answer.deckActions.keys, 4);
  assert.equal(remoteMayLaunch(TOOL.path, [], plainSend.written), false);

  const yes = await post(JSON.stringify({ keepDeckActions: true, bundle }));
  assert.deepEqual(yes.calls, [{ remote: false, keepDeckActions: true }]);
  assert.deepEqual([yes.answer.needsSetup, yes.answer.deckActions], [[], null]);
  assert.deepEqual(keyAt(yes.written, 1).triggers.tap, TOOL);

  // The file sent as it is, the older shape: still imported, and its own flag changes nothing.
  for (const carried of [{ ...bundle, keepDeckActions: true }, { xenonBackup: 2, keepDeckActions: true, data: { deck: FILE_DECK, keepDeckActions: true } }]) {
    for (const body of [JSON.stringify(carried), JSON.stringify({ bundle: carried })]) {
      const sent = await post(body);
      assert.deepEqual(sent.calls, [{ remote: false, keepDeckActions: false }]);
      assert.equal(sent.answer.deckActions.keys, 4);
      assert.deepEqual(keyAt(sent.written, 1).triggers, { hold: { type: 'media', cmd: 'next' } });
    }
  }
  // A file shaped like the request itself is not a backup once the page has put it in its place.
  const shaped = await post(JSON.stringify({ bundle: { keepDeckActions: true, bundle } }));
  assert.deepEqual([shaped.calls[0].keepDeckActions, shaped.answer.error], [false, 'bad_format']);
});

test('a paired device is still refused the route, and its yes would not count either', async () => {
  assert.ok(REMOTE_DENY.has('/backup/import'));
  const remote = await post(JSON.stringify({ keepDeckActions: true, bundle: bundleOf(FILE_DECK) }), { isRemote: true });
  assert.deepEqual(remote.calls, [{ remote: true, keepDeckActions: false }]);
  assert.equal(remoteMayLaunch(TOOL.path, [], remote.written), false);
});

test('the engine takes the yes only from its caller, and gives the answer its own field', () => {
  const source = engineSource();
  const apply = source.slice(source.indexOf('async function applyBackup('));
  const body = apply.slice(0, apply.indexOf('\n}\n'));
  assert.match(body, /^async function applyBackup\(bundle, \{ remote = false, keepDeckActions = false \} = \{\}\) \{/);
  assert.match(body, /const store = deckOnImport\(d\.deck, cur, keepDeckActions === true && !remote\);/);
  assert.match(body, /needsSetup, needsWidgets, deckActions: deckActionsHeldBack\(d\.deck, deckNow\) \}/);
  // Nothing in the import reads the word from the file.
  assert.doesNotMatch(body, /(bundle|d|data)\??\.keepDeckActions|\[['"]keepDeckActions['"]\]/);
  assert.equal(body.match(/keepDeckActions/g)?.length, 2);
  const routes = readFileSync(new URL('../settings/routes.js', import.meta.url), 'utf8');
  assert.match(routes, /keepDeckActions: asked\.keepDeckActions && !isRemote/);
});

// ── The page ────────────────────────────────────────────────────────────────

const tables = require('../app-strings/tables.js');
const words = Object.fromEntries(tables.LANGS.map((/** @type {string} */ code) => [code, tables.parse(readFileSync(new URL(`../js/i18n/${code}.js`, import.meta.url), 'utf8'), code)]));
const KEYS = ['settings_backup_deck_actions', 'settings_backup_deck_keep_title', 'settings_backup_deck_keep_ask', 'settings_backup_deck_keep_yes', 'settings_backup_deck_keep_no', 'settings_backup_deck_more'];

test('every language has the question in its own words', () => {
  assert.equal(tables.LANGS.length, 11);
  for (const code of tables.LANGS) {
    for (const key of KEYS) {
      assert.ok(typeof words[code][key] === 'string' && words[code][key].trim(), `${code} has its own ${key}`);
      assert.doesNotMatch(words[code][key], /—/, `${code} ${key} has no long dash`);
      if (code !== 'en') assert.notEqual(words[code][key], words.en[key], `${code} ${key} is translated`);
    }
    for (const key of ['settings_backup_deck_keep_ask', 'settings_backup_deck_more']) assert.equal(words[code][key].split('{n}').length, 2, `${code} ${key} says the number once`);
  }
});

const PAGE = readFileSync(new URL('../js/settings/backup-reset.js', import.meta.url), 'utf8');
const NASTY = '<img src=x onerror=alert(1)>';

/** The page's own code, with an engine that answers `answers` in turn and a person who answers `says`. */
async function importOnPage(/** @type {any[]} */ answers, /** @type {any} */ says, fileText = JSON.stringify(bundleOf(FILE_DECK))) {
  /** @type {any[]} */
  const sent = [];
  /** @type {any[]} */
  const asked = [];
  /** @type {Record<string, string>} */
  const parked = {};
  let reloads = 0;
  /** @type {any} */
  const sandbox = {
    console: { error: () => {} },
    sessionStorage: { getItem: (/** @type {string} */ k) => parked[k] ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { parked[k] = v; }, removeItem: (/** @type {string} */ k) => { delete parked[k]; } },
    document: { getElementById: () => null, addEventListener: () => {} },
    location: { reload: () => { reloads += 1; } },
    setTimeout: () => 0,
    fetch: async (/** @type {string} */ url, /** @type {any} */ init) => {
      sent.push({ url, method: init.method, body: init.body });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { json: async () => next };
    },
  };
  if (says !== 'no prompt') sandbox.settingsPrompt = async (/** @type {any} */ opts) => { asked.push(opts); return says; };
  sandbox.window = sandbox;
  sandbox.t = (/** @type {string} */ key) => words.en[key] ?? key;
  vm.createContext(sandbox);
  vm.runInContext(PAGE, sandbox);
  await sandbox.importBackupFile({ files: [{ text: async () => fileText }] });
  const summary = parked['xenon.backupImportSummary'] ? JSON.parse(parked['xenon.backupImportSummary']) : null;
  return { sent, asked, summary, reloads, sandbox };
}

const HELD = { ok: true, restored: ['deck'], failed: [], needsSetup: ['spotify', 'deckActions'], needsWidgets: [],
  deckActions: { keys: 3, actions: [{ type: 'openApp', what: '/opt/tool/tool' }, { type: 'runScript', what: NASTY }, { type: 'madeUp', what: '' }], more: 2, tooDeep: 0 } };
const KEPT = { ok: true, restored: ['deck'], failed: [], needsSetup: ['spotify'], needsWidgets: [], deckActions: null };

test('the page asks, and keep sends the same file again with the yes', async () => {
  const text = JSON.stringify(bundleOf(FILE_DECK, { keepDeckActions: true }));
  const run = await importOnPage([HELD, KEPT], true, text);
  assert.equal(run.asked.length, 1);
  const [question] = run.asked;
  assert.equal(question.type, 'confirm');
  assert.equal(question.cautious, true, 'the button in focus is the one that leaves them off');
  assert.equal(question.message, words.en.settings_backup_deck_keep_ask.replace('{n}', '3'));
  assert.deepEqual([question.okLabel, question.cancelLabel], [words.en.settings_backup_deck_keep_yes, words.en.settings_backup_deck_keep_no]);
  // The list: the action's own name where there is one, the text as it came, and how many more.
  assert.deepEqual(question.lines, [`${words.en.deck_act_openApp}: /opt/tool/tool`, `${words.en.deck_act_runScript}: ${NASTY}`, 'madeUp', words.en.settings_backup_deck_more.replace('{n}', '2')]);
  // Two requests to the same route. The file is inside each, never at the top; only the second says yes.
  assert.deepEqual(run.sent.map((one) => [one.url, one.method]), [['/backup/import', 'POST'], ['/backup/import', 'POST']]);
  const [first, second] = run.sent.map((one) => JSON.parse(one.body));
  assert.deepEqual(Object.keys(first), ['bundle']);
  assert.deepEqual(Object.keys(second), ['keepDeckActions', 'bundle']);
  assert.equal(second.keepDeckActions, true);
  assert.deepEqual(first.bundle, JSON.parse(text));
  assert.deepEqual(second.bundle, JSON.parse(text));
  assert.equal(importRequest(first).keepDeckActions, false, 'the flag the file carries is not the request\'s');
  assert.deepEqual(run.summary.needsSetup, ['spotify']);
  assert.equal(run.reloads, 1);
});

test('leave them off sends nothing more, and the message after it does not ask again', async () => {
  for (const says of [false, null]) {
    const run = await importOnPage([HELD], says);
    assert.equal(run.sent.length, 1);
    assert.deepEqual(run.summary.needsSetup, ['spotify']);
    assert.equal(run.reloads, 1);
  }
});

test('no question when nothing was held back, and none the page could not answer', async () => {
  const none = await importOnPage([KEPT], true);
  assert.deepEqual([none.asked.length, none.sent.length, none.reloads], [0, 1, 1]);
  // Held back for depth alone, or an answer that is not a count: nothing a yes could bring in.
  for (const deckActions of [{ keys: 0, actions: [], more: 0, tooDeep: 2 }, { keys: '3' }, 'all', null]) {
    const run = await importOnPage([{ ...HELD, deckActions }], true);
    assert.deepEqual([run.asked.length, run.sent.length], [0, 1]);
    assert.deepEqual(run.summary.needsSetup, ['spotify', 'deckActions']);
  }
  // No window to ask in: the message after the reload says to import the file again.
  const silent = await importOnPage([HELD], 'no prompt');
  assert.deepEqual([silent.sent.length, silent.summary.needsSetup], [1, ['spotify', 'deckActions']]);
  const shown = [];
  silent.sandbox.backupToast = (/** @type {string} */ key, /** @type {string} */ meta) => shown.push(meta);
  silent.sandbox.showPendingBackupSummary();
  assert.ok(shown[0].endsWith(words.en.settings_backup_deck_actions));
  assert.match(words.en.settings_backup_deck_actions, /Import the backup again to keep them/);
});

test('a second import that fails leaves the first one standing, with its message', async () => {
  const run = await importOnPage([HELD, new Error('offline')], true);
  assert.equal(run.sent.length, 2);
  assert.deepEqual(run.summary.needsSetup, ['spotify', 'deckActions']);
  assert.equal(run.reloads, 1);
});

test('the window writes the list as text, and opens on the button that leaves the keys off', async () => {
  /** @type {any[]} */
  const made = [];
  const element = (/** @type {string} */ tag) => {
    /** @type {any} */
    const node = { tag, children: [], listeners: {}, attributes: {}, className: '', textContent: '' };
    node.appendChild = (/** @type {any} */ child) => { node.children.push(child); return child; };
    node.addEventListener = (/** @type {string} */ kind, /** @type {Function} */ fn) => { node.listeners[kind] = fn; };
    node.setAttribute = (/** @type {string} */ name, /** @type {string} */ value) => { node.attributes[name] = value; };
    node.remove = () => {};
    Object.defineProperty(node, 'innerHTML', { set() { throw new Error('innerHTML was written'); } });
    made.push(node);
    return node;
  };
  /** @type {any} */
  let focused = null;
  /** @type {any} */
  const sandbox = {
    document: { createElement: element, body: element('body'), getElementById: () => null },
    DialogFocus: { hold: (/** @type {any} */ _modal, /** @type {any} */ how) => { focused = how.start; return () => {}; } },
    t: (/** @type {string} */ key) => key,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../js/settings/modal.js', import.meta.url), 'utf8'), sandbox);
  const answer = sandbox.settingsPrompt({ type: 'confirm', cautious: true, title: 'Title', message: 'Ask', lines: ['Open app: /opt/tool/tool', NASTY], okLabel: 'Keep them', cancelLabel: 'Leave them off' });
  const list = made.find((node) => node.tag === 'ul');
  assert.equal(list.className, 'preset-modal-lines');
  assert.deepEqual(list.children.map((/** @type {any} */ li) => [li.tag, li.textContent]), [['li', 'Open app: /opt/tool/tool'], ['li', NASTY]]);
  assert.equal(focused.textContent, 'Leave them off');
  made.find((node) => node.tag === 'button' && node.textContent === 'Keep them').listeners.click();
  assert.equal(await answer, true);
  // Without lines the window is as it was: no list at all.
  made.length = 0;
  sandbox.settingsPrompt({ type: 'confirm', title: 'Title', message: 'Ask' });
  assert.equal(made.some((node) => node.tag === 'ul'), false);
  assert.equal(focused.textContent, 'dlg_save');
  // The list wraps long paths and scrolls, in the stylesheet, not inline.
  const css = readFileSync(new URL('../components/SettingsModal/SettingsSharing.css', import.meta.url), 'utf8');
  assert.match(css, /\.preset-modal-lines \{[^}]*overflow-wrap: anywhere;[^}]*\}/);
  assert.match(css, /\.preset-modal-lines \{[^}]*max-height: 40vh; overflow-y: auto;[^}]*\}/);
  assert.doesNotMatch(PAGE.slice(PAGE.indexOf('async function send(')), /innerHTML|\.style\b/);
});
