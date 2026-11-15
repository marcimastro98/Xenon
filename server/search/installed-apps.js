'use strict';

// Installed applications on macOS and Linux, for the search's Applications
// tier. Windows has its own enumeration in server.js (Start Menu shortcuts and
// Store apps); off Windows that tier answered nothing at all, so typing an
// app's name found its files and never the app.
//
//   macOS  the .app bundles in /Applications (and Utilities), ~/Applications
//          and /System/Applications: one level, never inside a bundle
//   Linux  the .desktop entries in the XDG application directories, flatpak's
//          exports included, without the ones marked NoDisplay or Hidden and
//          without anything that is not Type=Application
//
// Entries are enumerated here and launched by an opaque search id: a path from
// the wire is never launched (the same contract as the Windows list).

const path = require('path');
const fsDefault = require('fs');
const os = require('os');

// One .desktop file, the keys this needs: the [Desktop Entry] group only,
// `Name` (a `Name[lang]` for the given language wins), and the flags that
// mean "not an app to offer".
function parseDesktopEntry(text, lang) {
  let inEntry = false;
  const out = { name: '', localName: '', type: '', noDisplay: false, hidden: false };
  const want = lang ? 'name[' + String(lang).toLowerCase() + ']' : null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) { inEntry = line === '[Desktop Entry]'; continue; }
    if (!inEntry) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'Name') out.name = value;
    else if (want && key.toLowerCase() === want) out.localName = value;
    else if (key === 'Type') out.type = value;
    else if (key === 'NoDisplay') out.noDisplay = /^true$/i.test(value);
    else if (key === 'Hidden') out.hidden = /^true$/i.test(value);
  }
  return out;
}

function linuxAppDirs(env, home) {
  const e = env || {};
  const dataHome = e.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const dataDirs = (e.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return [
    path.join(dataHome, 'applications'),
    ...dataDirs.map((d) => path.join(d, 'applications')),
    '/var/lib/flatpak/exports/share/applications',
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'applications'),
  ];
}

function macAppDirs(home) {
  return [
    '/Applications', '/Applications/Utilities',
    path.join(home, 'Applications'),
    '/System/Applications', '/System/Applications/Utilities',
  ];
}

async function listPosixApps(opts = {}) {
  const fs = opts.fs || fsDefault;
  const platform = opts.platform || process.platform;
  const home = opts.home || os.homedir();
  const byName = new Map();
  if (platform === 'darwin') {
    for (const dir of macAppDirs(home)) {
      let entries = [];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        if (!ent.name.endsWith('.app') || ent.name.startsWith('.')) continue;
        const name = ent.name.slice(0, -4);
        if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { name, kind: 'macapp', target: path.join(dir, ent.name) });
      }
    }
  } else if (platform === 'linux') {
    // Earlier directories win, as XDG says: the user's own entry overrides the
    // system one with the same file name.
    const seenIds = new Set();
    for (const dir of linuxAppDirs(opts.env || process.env, home)) {
      let entries = [];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        if (!ent.name.endsWith('.desktop') || seenIds.has(ent.name)) continue;
        seenIds.add(ent.name);
        const full = path.join(dir, ent.name);
        let text;
        try { text = await fs.promises.readFile(full, 'utf8'); } catch { continue; }
        const d = parseDesktopEntry(text, opts.lang);
        if (d.type !== 'Application' || d.noDisplay || d.hidden) continue;
        const name = d.localName || d.name;
        if (!name) continue;
        if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { name, kind: 'desktop', target: full });
      }
    }
  }
  return [...byName.values()];
}

module.exports = { parseDesktopEntry, listPosixApps, linuxAppDirs, macAppDirs };
