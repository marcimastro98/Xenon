'use strict';
// The picture of a Linux app, for the lists that name open apps. Nothing on the
// window says it, so the app's .desktop file does: found by the window's class,
// its Icon= line then points into the icon theme. An app with no match has no
// picture and the list shows its name alone.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const SIZES = ['48x48', '64x64', '128x128', '256x256', '32x32'];
const MAX_ICON_BYTES = 12000;   // base64 of this stays under the stored cap (layers-model.js)
const MAX_DESKTOP_BYTES = 256 * 1024;

function dataHomes() {
  const home = os.homedir();
  const shared = String(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return [
    process.env.XDG_DATA_HOME || path.join(home, '.local/share'),
    path.join(home, '.local/share/flatpak/exports/share'),
    '/var/lib/flatpak/exports/share',
    '/var/lib/snapd/desktop',
    ...shared,
  ];
}

/** The first `key=` value of the [Desktop Entry] group. */
function desktopValue(text, key) {
  let inEntry = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) { inEntry = line === '[Desktop Entry]'; continue; }
    if (inEntry && line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return '';
}

async function readSmall(file, cap) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > cap) return null;
    return await fs.readFile(file);
  } catch { return null; }
}

async function desktopFiles(homes) {
  const lists = await Promise.all(homes.map(async (home) => {
    const dir = path.join(home, 'applications');
    const names = await fs.readdir(dir).catch(() => []);
    return names.filter((n) => n.endsWith('.desktop')).map((n) => path.join(dir, n));
  }));
  return lists.flat();
}

// A file named after the class is the usual case; StartupWMClass is what the
// app says about itself when its file is called something else.
async function desktopFor(cls, files) {
  const want = String(cls || '').toLowerCase();
  if (!want) return '';
  const byName = files.find((f) => path.basename(f, '.desktop').toLowerCase() === want)
    || files.find((f) => path.basename(f, '.desktop').toLowerCase().split('.').pop() === want);
  if (byName) {
    const text = await readSmall(byName, MAX_DESKTOP_BYTES);
    if (text) return String(text);
  }
  for (const file of files) {
    const text = await readSmall(file, MAX_DESKTOP_BYTES);
    if (text && desktopValue(text, 'StartupWMClass').toLowerCase() === want) return String(text);
  }
  return '';
}

function iconCandidates(icon, homes) {
  if (path.isAbsolute(icon)) return [icon];
  const out = [];
  for (const home of homes) {
    const theme = path.join(home, 'icons/hicolor');
    for (const size of SIZES) out.push(path.join(theme, size, 'apps', `${icon}.png`));
    out.push(path.join(theme, 'scalable/apps', `${icon}.svg`));
    out.push(path.join(home, 'pixmaps', `${icon}.png`), path.join(home, 'pixmaps', `${icon}.svg`));
  }
  return out;
}

function asDataUrl(file, bytes) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return `data:image/png;base64,${bytes.toString('base64')}`;
  if (ext === '.svg') return `data:image/svg+xml;base64,${bytes.toString('base64')}`;
  return null;
}

async function iconFile(icon, homes) {
  for (const file of iconCandidates(icon, homes)) {
    const bytes = await readSmall(file, MAX_ICON_BYTES);
    const url = bytes && asDataUrl(file, bytes);
    if (url) return url;
  }
  return null;
}

/** `lookup(cls)` → a data URL or null. Answers are kept: an app's picture does
 *  not change while it runs, and the list is read on every open of the menu. */
function createAppIcons(homes = dataHomes()) {
  const known = new Map();
  let files = null;
  async function find(cls) {
    if (!files) files = await desktopFiles(homes);
    const icon = desktopValue(await desktopFor(cls, files), 'Icon');
    return icon ? iconFile(icon, homes) : null;
  }
  return function lookup(cls) {
    const key = String(cls || '').toLowerCase();
    if (!known.has(key)) known.set(key, find(key).catch(() => null));
    return known.get(key);
  };
}

module.exports = { createAppIcons, desktopValue };
