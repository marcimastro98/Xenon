// js/capture-replay-key.js: the Instant Replay save shortcut in Settings → Capture.
// Pinned here: the button shows the server's combo and the line says what the
// server made of it (works only while the replay is on, a Deck key on the same
// combo wins); recording takes the next combo, Esc cancels, a combo something
// else owns is refused with the owner's name and never posted; the second
// button turns it off and brings the default back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(DIR, 'js', f), 'utf8');
const HTML = readFileSync(path.join(DIR, 'index.html'), 'utf8');
const IDS = ['settings-replay-key', 'settings-replay-key-off', 'settings-replay-key-state'];

const el = (id) => ({
  id, hidden: false, textContent: '', attrs: {}, classes: new Set(),
  setAttribute(k, v) { this.attrs[k] = v; },
  get classList() { const c = this.classes; return { toggle: (n, on) => (on ? c.add(n) : c.delete(n)) }; },
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function load({ hotkeys = { slots: { replay: 'listening' }, taken: [{ combo: 'ctrl+shift+f10', slot: 'replay' }], deck: [] }, answer = { ok: true } } = {}) {
  const els = Object.fromEntries(IDS.map((id) => [id, el(id)]));
  const posts = [];
  const status = [];
  let shown = 0;
  const listeners = {};
  const window = {
    addEventListener(name, fn) { (listeners[name] ||= new Set()).add(fn); },
    removeEventListener(name, fn) { if (listeners[name]) listeners[name].delete(fn); },
    CaptureSettingsPane: { show: () => { shown++; } },
  };
  const sandbox = {
    window,
    document: { getElementById: (id) => els[id] || null },
    navigator: { platform: 'Win32', userAgent: '' },
    t: (k, fb) => fb || k,
    fetch: async () => ({ ok: true, json: async () => hotkeys }),
    apiJson: async (_url, opts) => { posts.push(JSON.parse(opts.body)); return answer; },
    setSettingsStatus: (k, kind) => status.push([k, kind]),
    setTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(read('deck-shortcuts.js'), sandbox);
  vm.runInContext(read('deck-editor-shortcut.js'), sandbox);
  vm.runInContext(read('capture-replay-key.js'), sandbox);
  // A keydown as the browser sends it, through the listener the recorder holds.
  const press = (e) => {
    const ev = { preventDefault() {}, stopImmediatePropagation() {}, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...e };
    for (const fn of [...(listeners.keydown || [])]) fn(ev);
  };
  const holding = () => (listeners.keydown ? listeners.keydown.size : 0);
  return { K: window.CaptureReplayKey, els, posts, status, press, holding, shown: () => shown };
}

test('the button shows the combo in force; the line says it works, or why not', async () => {
  const { K, els } = load();
  K.render({ replay: true, replayKey: 'ctrl+shift+f10' });
  await flush();
  assert.equal(els['settings-replay-key'].textContent, 'Ctrl + Shift + F10');
  assert.equal(els['settings-replay-key-off'].textContent, 'Turn off');
  assert.equal(els['settings-replay-key-state'].textContent, 'deck_shortcut_st_listening');
  assert.equal(els['settings-replay-key-state'].classes.has('settings-note-warn'), false);
  // Replay off: the shortcut is not held, and the line says when it works.
  K.render({ replay: false, replayKey: 'ctrl+shift+f10' });
  await flush();
  assert.equal(els['settings-replay-key-state'].textContent, 'settings_replay_key_idle');
});

test('off: the button records a new one, the second brings the default back', async () => {
  const { K, els, posts } = load();
  K.render({ replay: true, replayKey: 'off' });
  await flush();
  assert.equal(els['settings-replay-key'].textContent, 'Record a shortcut');
  assert.equal(els['settings-replay-key-off'].textContent, 'Use Ctrl + Shift + F10');
  assert.equal(els['settings-replay-key-state'].textContent, 'settings_replay_key_none_hint');
  K.toggleOff();
  await flush();
  assert.deepEqual(posts, [{ replayKey: '' }]);
  K.render({ replay: true, replayKey: 'ctrl+shift+f10' });
  K.toggleOff();
  await flush();
  assert.deepEqual(posts[1], { replayKey: 'off' });
});

test('recording: the next combo is saved and the keyboard is let go; Esc cancels', async () => {
  const { K, els, posts, press, holding, shown, status } = load();
  K.render({ replay: true, replayKey: 'ctrl+shift+f10' });
  K.record();
  assert.equal(els['settings-replay-key'].textContent, 'Press the keys…');
  assert.equal(els['settings-replay-key'].attrs['aria-pressed'], 'true');
  assert.equal(els['settings-replay-key-off'].hidden, true);
  press({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
  assert.equal(holding(), 1, 'only a modifier so far: still recording');
  press({ key: 'R', code: 'KeyR', altKey: true, shiftKey: true });
  await flush();
  assert.equal(holding(), 0);
  assert.deepEqual(posts, [{ replayKey: 'alt+shift+r' }]);
  assert.deepEqual(status, [['settings_saved', 'ok']]);
  assert.equal(shown(), 1, 'the pane reloads with the server truth');
  K.record();
  press({ key: 'Escape', code: 'Escape' });
  assert.equal(holding(), 0);
  assert.equal(posts.length, 1, 'Esc saves nothing');
  // The same combo again: nothing to save.
  K.record();
  press({ key: 'F10', code: 'F10', ctrlKey: true, shiftKey: true });
  assert.equal(posts.length, 1);
});

test('a combo someone else owns is refused with the reason and never posted', async () => {
  const hotkeys = {
    slots: { replay: 'listening', overlay: 'listening' },
    taken: [{ combo: 'ctrl+shift+f10', slot: 'replay' }, { combo: 'ctrl+shift+f9', slot: 'overlay' }, { combo: 'ctrl+alt+shift+k', slot: 'deck-0', keyId: 'k1' }],
    deck: [{ keyId: 'k1', combo: 'ctrl+alt+shift+k', title: 'Mute', state: 'listening' }],
  };
  const { K, els, posts, press } = load({ hotkeys });
  K.render({ replay: true, replayKey: 'ctrl+shift+f10' });
  await flush();
  const line = els['settings-replay-key-state'];
  const cases = [
    [{ key: 'F10', code: 'F10', altKey: true }, 'deck_shortcut_res_nvidia'],
    [{ key: 'G', code: 'KeyG', altKey: true, metaKey: true }, 'deck_shortcut_res_gamebar'],
    [{ key: 'F9', code: 'F9', ctrlKey: true, shiftKey: true }, 'settings_replay_key_used_overlay'],
    [{ key: 'C', code: 'KeyC', ctrlKey: true }, 'deck_shortcut_invalid'],
  ];
  for (const [e, why] of cases) {
    K.record();
    press(e);
    assert.equal(line.textContent, why, e.code);
    assert.equal(line.classes.has('settings-note-warn'), true, e.code);
  }
  // Another key's combo names the key.
  K.record();
  press({ key: 'K', code: 'KeyK', ctrlKey: true, altKey: true, shiftKey: true });
  assert.equal(line.textContent, 'deck_shortcut_used_key'.replace('{name}', 'Mute'));
  assert.deepEqual([...K.refusalOf('ctrl+alt+shift+k')], ['deck_shortcut_used_key', 'Mute']);
  assert.equal(posts.length, 0, 'nothing refused is ever posted');
  // Recording again clears the refusal.
  K.record();
  assert.equal(line.textContent, 'deck_shortcut_press_hint');
});

test('a refusal from the server (stored elsewhere first) shows its owner; a failed save says so', async () => {
  const reserved = load({ answer: { ok: false, error: 'reserved', owner: 'gamebar' } });
  reserved.K.render({ replay: true, replayKey: 'ctrl+shift+f10' });
  reserved.K.record();
  reserved.press({ key: 'P', code: 'KeyP', ctrlKey: true, altKey: true, shiftKey: true });
  await flush();
  assert.equal(reserved.els['settings-replay-key-state'].textContent, 'deck_shortcut_res_gamebar');
  assert.equal(reserved.els['settings-replay-key-state'].classes.has('settings-note-warn'), true);
  const failed = load({ answer: null });
  failed.K.render({ replay: true, replayKey: 'ctrl+shift+f10' });
  failed.K.record();
  failed.press({ key: 'P', code: 'KeyP', ctrlKey: true, altKey: true, shiftKey: true });
  await flush();
  assert.deepEqual(failed.status, [['settings_capture_failed', 'error']]);
});

test('a Deck key on the same combo wins, and the line says so', async () => {
  const hotkeys = { slots: { 'deck-0': 'listening' }, taken: [{ combo: 'ctrl+shift+f10', slot: 'deck-0', keyId: 'k1' }], deck: [] };
  const { K, els } = load({ hotkeys });
  K.render({ replay: true, replayKey: 'ctrl+shift+f10' });
  await flush();
  assert.equal(els['settings-replay-key-state'].textContent, 'deck_shortcut_st_duplicate');
  assert.equal(els['settings-replay-key-state'].classes.has('settings-note-warn'), true);
});

test('the markup has the row inside the replay group, and the script is loaded after the pane', () => {
  const group = HTML.slice(HTML.indexOf('id="settings-replay-group"'), HTML.indexOf('<!-- Recording options'));
  for (const id of IDS) assert.ok(group.includes(`id="${id}"`), id);
  assert.ok(HTML.indexOf('src="js/capture-replay-key.js"') > HTML.indexOf('src="js/capture-settings-pane.js"'));
  assert.ok(HTML.indexOf('src="js/capture-replay-key.js"') > HTML.indexOf('src="js/deck-editor-shortcut.js"'));
});
