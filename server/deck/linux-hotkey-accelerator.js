'use strict';
// Turns a key combination into the accelerator GNOME understands, reads what gsettings prints
// about shortcuts, and writes the command the desktop runs on the shortcut.

const MODIFIERS = new Map([
  ['ctrl', '<Control>'], ['control', '<Control>'],
  ['alt', '<Alt>'], ['option', '<Alt>'],
  ['shift', '<Shift>'],
  ['super', '<Super>'], ['win', '<Super>'], ['meta', '<Super>'], ['cmd', '<Super>'],
]);

// GDK key names for the keys whose name is not simply the character. Anything
// not listed falls through to the single-character/function-key rules below;
// anything that matches neither is rejected rather than guessed, because an
// accelerator GNOME cannot parse is stored happily and then never fires.
const KEY_NAMES = new Map([
  ['space', 'space'], ['enter', 'Return'], ['return', 'Return'], ['esc', 'Escape'],
  ['escape', 'Escape'], ['tab', 'Tab'], ['backspace', 'BackSpace'], ['delete', 'Delete'],
  ['del', 'Delete'], ['insert', 'Insert'], ['home', 'Home'], ['end', 'End'],
  ['pageup', 'Page_Up'], ['pagedown', 'Page_Down'], ['up', 'Up'], ['down', 'Down'],
  ['left', 'Left'], ['right', 'Right'], ['comma', 'comma'], ['period', 'period'],
  ['slash', 'slash'], ['backslash', 'backslash'], ['minus', 'minus'], ['plus', 'plus'],
  ['equal', 'equal'], ['semicolon', 'semicolon'], ['apostrophe', 'apostrophe'],
  ['grave', 'grave'], ['bracketleft', 'bracketleft'], ['bracketright', 'bracketright'],
]);

function toAccelerator(combo) {
  const parts = String(combo || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const mods = [];
  let key = null;
  for (const p of parts) {
    if (MODIFIERS.has(p)) {
      const m = MODIFIERS.get(p);
      if (!mods.includes(m)) mods.push(m);
      continue;
    }
    if (key) return null;           // two non-modifier keys is not a combo
    key = p;
  }
  if (!key) return null;
  let name = KEY_NAMES.get(key) || null;
  if (!name && /^f([1-9]|1[0-9]|2[0-4])$/.test(key)) name = 'F' + key.slice(1);
  if (!name && /^[a-z0-9]$/.test(key)) name = key;
  if (!name) return null;
  // A bare key with no modifier would swallow that key desktop-wide.
  if (!mods.length) return null;
  // GNOME's canonical order; the panel writes them this way and comparing
  // against existing bindings depends on matching it.
  const order = ['<Control>', '<Alt>', '<Shift>', '<Super>'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return mods.join('') + name;
}

// GNOME writes accelerators in one canonical order, but it ACCEPTS several
// spellings and other applications use them freely: `<Primary>` for Control,
// `<Ctrl>`, `<Mod1>`/`<Mod4>`, and the modifiers in any order at all. Comparing
// the raw strings therefore missed every clash not spelled exactly the way
// toAccelerator spells it — which is most two-modifier ones — and a duplicate
// binding is precisely the case GNOME resolves by firing NEITHER shortcut. The
// registration reported `listening` and the hotkey silently never worked.
const MOD_ALIASES = new Map([
  ['primary', '<Control>'], ['control', '<Control>'], ['ctrl', '<Control>'], ['ctl', '<Control>'],
  ['alt', '<Alt>'], ['mod1', '<Alt>'],
  ['shift', '<Shift>'],
  ['super', '<Super>'], ['mod4', '<Super>'], ['meta', '<Super>'], ['hyper', '<Super>'], ['win', '<Super>'],
]);
const MOD_ORDER = ['<Control>', '<Alt>', '<Shift>', '<Super>'];

// One comparable form for an accelerator from anywhere. Returns '' for anything
// unparseable, which never matches a real binding — an unknown modifier is not
// ours to guess at.
function normalizeAccel(accel) {
  let rest = String(accel || '').trim();
  const mods = [];
  let m;
  while ((m = rest.match(/^<([^>]+)>/))) {
    const alias = MOD_ALIASES.get(m[1].toLowerCase());
    if (!alias) return '';
    if (!mods.includes(alias)) mods.push(alias);
    rest = rest.slice(m[0].length);
  }
  const key = rest.trim().toLowerCase();
  if (!key || !mods.length) return '';
  mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return mods.join('') + key;
}

// `gsettings list-recursively <schema>` prints "schema key value" per line, and
// keybinding values are GVariant arrays of strings: ['<Super>s', '<Alt>F1'].
function bindingsFrom(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    const m = line.match(/^\S+\s+\S+\s+(.*)$/);
    if (!m) continue;
    for (const s of m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
      const v = s[1].replace(/\\'/g, "'");
      if (v) out.push(v);
    }
  }
  return out;
}

// GVariant array of object paths -> JS array.
function parsePathArray(raw) {
  const s = String(raw || '').trim();
  if (!s || s === '@as []') return [];
  return [...s.matchAll(/'([^']*)'/g)].map((m) => m[1]).filter(Boolean);
}

// The command the desktop runs on the shortcut. curl first because it is on
// essentially every desktop install and its failure mode is a clean non-zero
// exit; bash's /dev/tcp is the last resort precisely because it needs no
// package at all, which is what makes it the right floor rather than the right
// default.
function commandFor(port, tools = {}, route = '/search/hotkey-press') {
  const url = `http://127.0.0.1:${port}${route}`;
  if (tools.curl) return `${tools.curl} -sS -m 2 -o /dev/null -X POST ${url}`;
  if (tools.wget) return `${tools.wget} -q -T 2 -O /dev/null --method=POST ${url}`;
  return `/bin/bash -c "exec 3<>/dev/tcp/127.0.0.1/${port}; printf 'POST ${route} HTTP/1.0\\r\\n\\r\\n' >&3; exec 3<&-"`;
}

module.exports = {
  MODIFIERS, KEY_NAMES, toAccelerator, MOD_ALIASES, MOD_ORDER, normalizeAccel, bindingsFrom,
  parsePathArray, commandFor,
};
