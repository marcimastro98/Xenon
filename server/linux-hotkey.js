'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// linux-hotkey.js — the global Spotlight shortcut, on Linux.
//
// On Windows the helper owns a RegisterHotKey message loop: one process, any
// desktop, done. Linux has no such call. X11's XGrabKey exists but is invisible
// to a Wayland session, and Wayland deliberately has no protocol letting a
// background client grab a key system-wide — that is the compositor's job, by
// design. So the only correct way to get a global shortcut is to ASK the
// desktop to register one, in the same place the user's own shortcuts live.
//
// On GNOME that place is a gsettings custom keybinding, which is exactly what
// the Settings → Keyboard → Shortcuts panel writes. Xenon adds one entry, under
// its own name, pointing at a command that pokes the local server; removing the
// shortcut removes the entry. The user can see it, edit it and delete it from
// their own Settings app, which is the property that makes writing to their
// keybindings acceptable at all.
//
// Two things this deliberately does NOT do:
//
//   • Guess on other desktops. KDE's kglobalaccel, sway and Hyprland each store
//     shortcuts in a format of their own, and two of those are plain config
//     files that Xenon would have to rewrite and reload behind the user's back.
//     Elsewhere this reports 'unsupported_de' and the UI explains the one-line
//     binding to add by hand.
//   • Claim success it cannot verify. GNOME accepts a conflicting accelerator
//     silently and simply never fires the second one, so the existing bindings
//     are scanned first and a clash is reported as 'taken' — the same state the
//     Windows path reports when another app owns the combo.
// ─────────────────────────────────────────────────────────────────────────────

const { execFile } = require('child_process');

const GS_TIMEOUT_MS = 5000;
const SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';
// A fixed, named path rather than the customN the Settings panel allocates:
// customN is positional, so a user deleting an unrelated shortcut would
// renumber ours. A named path is stable and identifies the owner at a glance.
const KEY_PATH = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/xenon-spotlight/';
const KEY_NAME = 'Xenon Search';
// Where else an accelerator can already be bound. Checked before claiming one,
// because GNOME will not tell us.
const CONFLICT_SCHEMAS = [
  'org.gnome.desktop.wm.keybindings',
  'org.gnome.shell.keybindings',
  'org.gnome.mutter.keybindings',
  'org.gnome.mutter.wayland.keybindings',
  SCHEMA,
];

// ── combo → GNOME accelerator (pure) ────────────────────────────────────────

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
function commandFor(port, tools = {}) {
  const url = `http://127.0.0.1:${port}/search/hotkey-press`;
  if (tools.curl) return `${tools.curl} -sS -m 2 -o /dev/null -X POST ${url}`;
  if (tools.wget) return `${tools.wget} -q -T 2 -O /dev/null --method=POST ${url}`;
  return `/bin/bash -c "exec 3<>/dev/tcp/127.0.0.1/${port}; printf 'POST /search/hotkey-press HTTP/1.0\\r\\n\\r\\n' >&3; exec 3<&-"`;
}

// ── runtime ─────────────────────────────────────────────────────────────────

function run(cmd, args) {
  return new Promise((resolve) => {
    let p;
    try {
      p = execFile(cmd, args, { timeout: GS_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => resolve(err ? null : String(stdout || '')));
    } catch { resolve(null); return; }
    p.on('error', () => resolve(null));
  });
}

function which(bin) {
  const dirs = String(process.env.PATH || '').split(':').filter(Boolean);
  const fs = require('fs');
  for (const d of dirs) {
    const p = require('path').join(d, bin);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

function createLinuxHotkey(o = {}) {
  const port = Number(o.port) || 3030;
  const runner = typeof o.runner === 'function' ? o.runner : run;
  const lookup = typeof o.which === 'function' ? o.which : which;

  async function gnomeAvailable() {
    if (!lookup('gsettings')) return false;
    const schemas = await runner('gsettings', ['list-schemas']);
    return !!schemas && schemas.split('\n').includes(SCHEMA);
  }

  async function existingBindings() {
    const found = [];
    for (const schema of CONFLICT_SCHEMAS) {
      const raw = await runner('gsettings', ['list-recursively', schema]);
      if (raw) found.push(...bindingsFrom(raw));
    }
    // Other custom shortcuts the user made, which live behind their own paths
    // and therefore do not show up in the schema listings above.
    const paths = parsePathArray(await runner('gsettings', ['get', SCHEMA, 'custom-keybindings']));
    for (const p of paths) {
      if (p === KEY_PATH) continue;   // our own previous registration is not a conflict
      const raw = await runner('gsettings', ['get', `${CUSTOM_SCHEMA}:${p}`, 'binding']);
      const v = String(raw || '').trim().replace(/^'|'$/g, '');
      if (v) found.push(v);
    }
    return found;
  }

  async function unregister() {
    const paths = parsePathArray(await runner('gsettings', ['get', SCHEMA, 'custom-keybindings']));
    if (paths.includes(KEY_PATH)) {
      const left = paths.filter((p) => p !== KEY_PATH);
      const value = left.length ? '[' + left.map((p) => `'${p}'`).join(', ') + ']' : '@as []';
      await runner('gsettings', ['set', SCHEMA, 'custom-keybindings', value]);
    }
    // Reset the entry's own keys too, so an unregistered shortcut leaves no
    // orphan under dconf that a later re-register would silently inherit.
    for (const key of ['name', 'command', 'binding']) {
      await runner('gsettings', ['reset', `${CUSTOM_SCHEMA}:${KEY_PATH}`, key]);
    }
    return { ok: true };
  }

  async function register(combo) {
    if (!(await gnomeAvailable())) return { ok: false, state: 'unsupported_de' };
    const accel = toAccelerator(combo);
    if (!accel) return { ok: false, state: 'error' };

    // Compared in normalised form, never as raw strings: the desktop is full of
    // equivalent spellings (see normalizeAccel).
    const wanted = normalizeAccel(accel);
    const taken = await existingBindings();
    if (taken.some((b) => normalizeAccel(b) === wanted)) {
      return { ok: false, state: 'taken', accelerator: accel };
    }

    const command = commandFor(port, { curl: lookup('curl'), wget: lookup('wget') });
    const entry = `${CUSTOM_SCHEMA}:${KEY_PATH}`;
    if (await runner('gsettings', ['set', entry, 'name', KEY_NAME]) === null) return { ok: false, state: 'error' };
    if (await runner('gsettings', ['set', entry, 'command', command]) === null) return { ok: false, state: 'error' };
    if (await runner('gsettings', ['set', entry, 'binding', accel]) === null) return { ok: false, state: 'error' };

    // Adding the path LAST: gnome-settings-daemon reacts to this key, and a
    // path added before the entry is filled in makes it read a half-written
    // shortcut and bind nothing.
    const paths = parsePathArray(await runner('gsettings', ['get', SCHEMA, 'custom-keybindings']));
    if (!paths.includes(KEY_PATH)) {
      const next = [...paths, KEY_PATH];
      const value = '[' + next.map((p) => `'${p}'`).join(', ') + ']';
      if (await runner('gsettings', ['set', SCHEMA, 'custom-keybindings', value]) === null) {
        return { ok: false, state: 'error' };
      }
    }
    return { ok: true, state: 'listening', accelerator: accel, command };
  }

  return { register, unregister, available: gnomeAvailable, keyPath: KEY_PATH };
}

module.exports = {
  createLinuxHotkey, toAccelerator, normalizeAccel, bindingsFrom, parsePathArray, commandFor,
  KEY_PATH, SCHEMA, CUSTOM_SCHEMA,
};
