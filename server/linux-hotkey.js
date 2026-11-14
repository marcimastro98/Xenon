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
// A fixed, named path per SLOT. Slots are what the server binds: 'spotlight'
// (the search popup) and 'page-<n>' (a dashboard page shortcut). Spotlight
// keeps the path it has always had, so an existing registration is updated in
// place instead of being orphaned beside a new one.
const KEY_ROOT = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/';
const KEY_PATH = KEY_ROOT + 'xenon-spotlight/';
const SLOT_SPOTLIGHT = 'spotlight';
const KEY_NAME = 'Xenon Search';

// Slot ids reach dconf as part of an object path, so they are held to the
// alphabet a path can carry — anything else is refused rather than escaped.
function keyPathFor(slot) {
  if (slot === SLOT_SPOTLIGHT) return KEY_PATH;
  if (!/^[a-z0-9-]{1,32}$/.test(String(slot || ''))) return null;
  return KEY_ROOT + 'xenon-' + slot + '/';
}
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

const {
  toAccelerator, normalizeAccel, bindingsFrom, parsePathArray, commandFor,
} = require('./deck/linux-hotkey-accelerator.js');


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

  // `mine` are the paths this process owns right now: none of them is a
  // conflict, because the point of a sync is to rewrite them. Without it the
  // second page shortcut read the first one as somebody else's binding.
  async function existingBindings(mine) {
    const ours = new Set(mine || [KEY_PATH]);
    const found = [];
    for (const schema of CONFLICT_SCHEMAS) {
      const raw = await runner('gsettings', ['list-recursively', schema]);
      if (raw) found.push(...bindingsFrom(raw));
    }
    // Other custom shortcuts the user made, which live behind their own paths
    // and therefore do not show up in the schema listings above.
    const paths = parsePathArray(await runner('gsettings', ['get', SCHEMA, 'custom-keybindings']));
    for (const p of paths) {
      if (ours.has(p)) continue;      // our own registrations are not conflicts
      const raw = await runner('gsettings', ['get', `${CUSTOM_SCHEMA}:${p}`, 'binding']);
      const v = String(raw || '').trim().replace(/^'|'$/g, '');
      if (v) found.push(v);
    }
    return found;
  }

  // Drop a set of our own paths from the desktop's list and wipe what they
  // held, in one pass — the list is a single gsettings key, so removing them
  // one at a time would be several read-modify-writes racing each other.
  async function dropPaths(drop) {
    const gone = new Set(drop.filter(Boolean));
    if (!gone.size) return;
    const paths = parsePathArray(await runner('gsettings', ['get', SCHEMA, 'custom-keybindings']));
    if (paths.some((p) => gone.has(p))) {
      const left = paths.filter((p) => !gone.has(p));
      const value = left.length ? '[' + left.map((p) => `'${p}'`).join(', ') + ']' : '@as []';
      await runner('gsettings', ['set', SCHEMA, 'custom-keybindings', value]);
    }
    // Reset each entry's own keys too, so an unregistered shortcut leaves no
    // orphan under dconf that a later re-register would silently inherit.
    for (const path of gone) {
      for (const key of ['name', 'command', 'binding']) {
        await runner('gsettings', ['reset', `${CUSTOM_SCHEMA}:${path}`, key]);
      }
    }
  }

  async function unregister() {
    await dropPaths([KEY_PATH]);
    return { ok: true };
  }

  // Write one slot. `taken` is the conflict list, gathered once by the caller:
  // re-reading the whole desktop per slot is several gsettings calls each, and
  // the answer cannot change between them anyway.
  async function writeSlot({ slot, combo, name, route }, taken, mine) {
    const path = keyPathFor(slot);
    if (!path) return { ok: false, state: 'error' };
    const accel = toAccelerator(combo);
    if (!accel) return { ok: false, state: 'error' };

    // Compared in normalised form, never as raw strings: the desktop is full of
    // equivalent spellings (see normalizeAccel).
    const wanted = normalizeAccel(accel);
    if (taken.some((b) => normalizeAccel(b) === wanted)) {
      return { ok: false, state: 'taken', accelerator: accel };
    }

    const command = commandFor(port, { curl: lookup('curl'), wget: lookup('wget') }, route);
    const entry = `${CUSTOM_SCHEMA}:${path}`;
    if (await runner('gsettings', ['set', entry, 'name', name]) === null) return { ok: false, state: 'error' };
    if (await runner('gsettings', ['set', entry, 'command', command]) === null) return { ok: false, state: 'error' };
    if (await runner('gsettings', ['set', entry, 'binding', accel]) === null) return { ok: false, state: 'error' };

    // Adding the path LAST: gnome-settings-daemon reacts to this key, and a
    // path added before the entry is filled in makes it read a half-written
    // shortcut and bind nothing.
    const paths = parsePathArray(await runner('gsettings', ['get', SCHEMA, 'custom-keybindings']));
    if (!paths.includes(path)) {
      const next = [...paths, path];
      const value = '[' + next.map((p) => `'${p}'`).join(', ') + ']';
      if (await runner('gsettings', ['set', SCHEMA, 'custom-keybindings', value]) === null) {
        return { ok: false, state: 'error' };
      }
    }
    // Two of our own slots on the same accelerator is the same silent failure
    // as clashing with another app — GNOME fires neither — so a slot that is
    // written becomes a conflict for the slots after it.
    mine.push(accel);
    return { ok: true, state: 'listening', accelerator: accel, command };
  }

  async function register(combo) {
    if (!(await gnomeAvailable())) return { ok: false, state: 'unsupported_de' };
    const taken = await existingBindings([KEY_PATH]);
    return writeSlot({ slot: SLOT_SPOTLIGHT, combo, name: KEY_NAME, route: '/search/hotkey-press' }, taken, []);
  }

  // Make the desktop's shortcuts match `wanted` exactly: write every one of
  // them, and remove the slots we own that are no longer asked for. `keep` is
  // the slots this call must not touch (the Spotlight shortcut has its own
  // lifecycle and is registered separately).
  async function syncSlots(wanted, keep = [SLOT_SPOTLIGHT]) {
    if (!(await gnomeAvailable())) {
      return { ok: false, state: 'unsupported_de', slots: {} };
    }
    const wantedPaths = wanted.map((b) => keyPathFor(b.slot)).filter(Boolean);
    const keepPaths = keep.map(keyPathFor).filter(Boolean);
    const protectedPaths = new Set([...wantedPaths, ...keepPaths]);

    // Ours, from an earlier save, that nobody wants any more.
    const present = parsePathArray(await runner('gsettings', ['get', SCHEMA, 'custom-keybindings']));
    await dropPaths(present.filter((p) => p.startsWith(KEY_ROOT + 'xenon-') && !protectedPaths.has(p)));

    const taken = await existingBindings(protectedPaths);
    const mine = [];
    const slots = {};
    for (const binding of wanted) {
      slots[binding.slot] = await writeSlot(binding, [...taken, ...mine], mine);
    }
    return { ok: true, slots };
  }

  return { register, unregister, syncSlots, available: gnomeAvailable, keyPath: KEY_PATH, keyPathFor };
}

module.exports = {
  createLinuxHotkey, toAccelerator, normalizeAccel, bindingsFrom, parsePathArray, commandFor,
  keyPathFor, KEY_PATH, KEY_ROOT, SLOT_SPOTLIGHT, SCHEMA, CUSTOM_SCHEMA,
};
