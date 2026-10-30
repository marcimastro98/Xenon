'use strict';
// Keyboard shortcuts on Deck keys: a combination pressed anywhere on the PC runs
// the key's tap, steps and pauses included. The combo is stored on the key
// (`key.shortcut`, so it travels with the Deck in a backup and goes away with
// the key); the server registers it next to the page shortcuts, through the
// same Xenon Helper / desktop path (server.js _hotkeyBindings).
//
// Pure and requireable: shared by the client (window.DeckShortcuts), the server
// and the tests. No DOM use; comboFromKeyEvent only reads the event's fields.

const MODIFIERS = Object.freeze(['ctrl', 'alt', 'shift', 'win']);
// The keys every platform's registrar can name: the Windows helper, the macOS
// helper (F1-F12 only) and the GNOME accelerator mapping all agree on these.
const KEY_RE = /^([a-z0-9]|f([1-9]|1[0-2])|space)$/;
const FKEY_RE = /^f([1-9]|1[0-2])$/;
const ALTGR_KEY_RE = /^[a-z0-9]$/;

// Combinations other software (or the OS) already owns, by who owns them, so
// the editor can say why one is refused. Ctrl+Alt+letter/digit is checked by
// rule below: on many keyboard layouts that IS AltGr, which types characters.
const RESERVED = Object.freeze({
  system: ['alt+f4', 'ctrl+f4', 'shift+f10', 'ctrl+f5', 'shift+win+s', 'ctrl+win+d', 'ctrl+win+f4',
    'ctrl+shift+win+b', 'shift+win+3', 'shift+win+4', 'shift+win+5', 'shift+win+q', 'ctrl+win+q', 'ctrl+win+f'],
  nvidia: ['alt+f1', 'alt+f9', 'alt+f10', 'alt+shift+f10'],
  gamebar: ['alt+win+r', 'alt+win+g', 'alt+win+b', 'alt+win+m', 'alt+win+t'],
  apps: ['ctrl+shift+t', 'ctrl+shift+n', 'ctrl+shift+v', 'ctrl+shift+z', 'ctrl+shift+c', 'ctrl+shift+i',
    'ctrl+shift+s', 'ctrl+shift+p', 'ctrl+shift+f', 'ctrl+shift+j', 'ctrl+shift+b', 'ctrl+shift+o', 'ctrl+shift+w'],
});

// Steps that only a dashboard can perform (a sound the browser plays, the AI
// chat, the mixer overlay). The server hands these to one dashboard on this PC;
// everything else runs on the server like a key press does.
const CLIENT_ACTIONS = Object.freeze(['playSound', 'soundStopAll', 'ai', 'appMixer']);

// How many keys may hold a shortcut: the helpers register at most 16 combos in
// all, and the Spotlight and page shortcuts take theirs first.
const MAX_SHORTCUTS = 16;

function parts(combo) {
  const mods = new Set();
  let key = '';
  let extra = false;
  String(combo || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean).forEach((tok) => {
    if (tok === 'control') tok = 'ctrl';
    if (tok === 'cmd' || tok === 'command' || tok === 'meta' || tok === 'super') tok = 'win';
    if (tok === 'option' || tok === 'opt') tok = 'alt';
    if (MODIFIERS.includes(tok)) mods.add(tok);
    else if (key) extra = true;
    else key = tok;
  });
  return { mods, key, extra };
}

// The canonical spelling ("ctrl+shift+f9", modifiers in a fixed order), or ''
// when it is not a shortcut this feature takes: one key from the shared set,
// and two modifiers, or one in front of an F-key. One modifier on a letter is
// what every app uses for its own commands (Ctrl+C), so it is never global.
function normalizeShortcut(combo) {
  const { mods, key, extra } = parts(combo);
  if (extra || !KEY_RE.test(key)) return '';
  if (mods.size < 2 && !(mods.size === 1 && FKEY_RE.test(key))) return '';
  return MODIFIERS.filter((m) => mods.has(m)).concat(key).join('+');
}

// Who already uses a valid combo ('system', 'nvidia', 'gamebar', 'apps',
// 'altgr'), or '' when it is free as far as we know.
function reservedBy(combo) {
  const c = normalizeShortcut(combo);
  if (!c) return '';
  for (const [owner, list] of Object.entries(RESERVED)) if (list.includes(c)) return owner;
  const { mods, key } = parts(c);
  if (mods.size === 2 && mods.has('ctrl') && mods.has('alt') && ALTGR_KEY_RE.test(key)) return 'altgr';
  return '';
}

// A keydown → a combo, read from the PHYSICAL key (e.code) so the layout and
// Shift never change the letter: RegisterHotKey works on keys, not characters.
// null while only modifiers are down, or for a key outside the shared set.
function comboFromKeyEvent(e) {
  if (!e) return null;
  const code = String(e.code || '');
  let key = '';
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) key = m[1].toLowerCase();
  // The top row only: the helpers register the digit keys, not the keypad.
  else if ((m = /^Digit([0-9])$/.exec(code))) key = m[1];
  else if ((m = /^F([0-9]{1,2})$/.exec(code))) key = 'f' + m[1];
  else if (code === 'Space') key = 'space';
  if (!KEY_RE.test(key)) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('win');
  return mods.concat(key).join('+');
}

// "Ctrl + Shift + F9" (or the macOS names) for showing a combo to a person.
function formatShortcut(combo, mac) {
  const c = normalizeShortcut(combo) || String(combo || '');
  if (!c) return '';
  const names = mac
    ? { ctrl: 'Control', alt: 'Option', shift: 'Shift', win: 'Cmd', space: 'Space' }
    : { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', space: 'Space' };
  return c.split('+').map((p) => names[p] || p.toUpperCase()).join(' + ');
}

// Every action key of one stored Deck config, folders included, with the
// profile it sits in. Tolerates any shape: the store is client-owned data.
function eachConfigKey(config, fn) {
  const profiles = config && Array.isArray(config.profiles) ? config.profiles : [];
  const walk = (folder, profile, depth) => {
    if (!folder || !Array.isArray(folder.pages) || depth > 8) return;
    for (const page of folder.pages) {
      const keys = page && Array.isArray(page.keys) ? page.keys : [];
      for (const key of keys) {
        if (!key || typeof key !== 'object') continue;
        if (key.kind === 'folder') walk(key.folder, profile, depth + 1);
        else if (key.kind === 'action') fn(key, profile);
      }
    }
  };
  for (const profile of profiles) if (profile) walk(profile.root, profile, 0);
}

// The shortcuts of every Deck, in a stable order (instance, profile, slot), as
// { combo, keyId, instance, title }. A combo held by two keys goes to the first;
// the rest come back in `duplicates` so the editor can say so.
function collectShortcuts(configs) {
  const src = configs && typeof configs === 'object' ? configs : {};
  const list = [];
  const duplicates = [];
  const seen = new Set();
  for (const instance of Object.keys(src).sort()) {
    if (instance.indexOf('__') === 0) continue;
    eachConfigKey(src[instance], (key, profile) => {
      const combo = normalizeShortcut(key.shortcut);
      if (!combo || typeof key.id !== 'string' || !key.id) return;
      const entry = { combo, keyId: key.id, instance, title: String(key.title || ''), profile: String((profile && profile.name) || ''), does: singleAction(key) };
      if (seen.has(combo)) { duplicates.push(entry); return; }
      seen.add(combo);
      list.push(entry);
    });
  }
  return { list, duplicates };
}

// What a one-step key does, as { type, mode }, so the Xenon menu can show the
// shortcut next to the same action (server/xenon-menu.js); null for macros.
function singleAction(key) {
  const t = shortcutTrigger(key);
  const step = t && Array.isArray(t.steps) ? (t.steps.length === 1 ? t.steps[0] && t.steps[0].action : null) : t;
  if (!step || typeof step.type !== 'string') return null;
  return { type: step.type, mode: typeof step.mode === 'string' ? step.mode : '' };
}

// Fits the Deck shortcuts after the bindings already in the helper's table
// (Spotlight, page shortcuts), which keep their combos and their places:
// { bindings: [{ slot, combo, keyId }], refused: { keyId: 'clash' | 'full' } }.
// Slots are numbered in order; a binding's INDEX in the whole table is what
// the helper reports, so the numbering only names the row.
function planBindings(taken, list, max) {
  const before = Array.isArray(taken) ? taken : [];
  const used = new Set(before.map((b) => normalizeShortcut(b.combo) || String(b.combo || '').toLowerCase()));
  const room = Math.max(0, (Number.isFinite(max) ? max : MAX_SHORTCUTS) - before.length);
  const bindings = [];
  const refused = {};
  for (const s of Array.isArray(list) ? list : []) {
    if (used.has(s.combo)) { refused[s.keyId] = 'clash'; continue; }
    if (bindings.length >= room) { refused[s.keyId] = 'full'; continue; }
    used.add(s.combo);
    bindings.push({ slot: 'deck-' + bindings.length, combo: s.combo, keyId: s.keyId });
  }
  return { bindings, refused };
}

// One key by id across every Deck, with where it lives: { key, instance } or null.
function findKey(configs, keyId) {
  const src = configs && typeof configs === 'object' ? configs : {};
  let found = null;
  for (const instance of Object.keys(src).sort()) {
    if (found || instance.indexOf('__') === 0) continue;
    eachConfigKey(src[instance], (key) => {
      if (!found && key.id === keyId) found = { key, instance };
    });
  }
  return found;
}

// What a shortcut runs: the key's tap, or a momentary key's press. A switch
// runs its tap too; the server cannot see whether the key is lit.
function shortcutTrigger(key) {
  const t = key && key.triggers && typeof key.triggers === 'object' ? key.triggers : {};
  return t.tap || t.press || null;
}

const DECK_SHORTCUTS_API = Object.freeze({
  MODIFIERS, RESERVED, CLIENT_ACTIONS, MAX_SHORTCUTS,
  normalizeShortcut, reservedBy, comboFromKeyEvent, formatShortcut,
  eachConfigKey, collectShortcuts, planBindings, findKey, shortcutTrigger,
});
if (typeof window !== 'undefined') window.DeckShortcuts = DECK_SHORTCUTS_API;
if (typeof module !== 'undefined' && module.exports) module.exports = DECK_SHORTCUTS_API;
