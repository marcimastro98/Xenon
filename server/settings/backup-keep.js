'use strict';

// What a backup import never takes from the file, because it belongs to this PC.
// The secrets have their own module (secrets.js); this is the rest.

const { normalizeServerAppFavorites } = require('./normalize-favorites.js');
const { normalizeDeckStore } = require('../deck/store-normalize.js');
const { POWERSHELL_SUPPORTED } = require('../powershell/supported.js');
const { guardedIn, canonical, FREE } = require('../paired/remote-actions.js');

/** @param {any} value @returns {Record<string, any> | null} the value when it is an object with keys, not a list */
const plain = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const pathKey = (/** @type {any} */ value) => String(value || '').trim().toLowerCase();

const DROPPED = Symbol('dropped');
// As deep as remote-actions.js looks for the actions a Deck holds (guardedIn). What lies deeper
// is not seen there, so it is never kept here and always counted: no Deck a person built nests so far.
const DEPTH = 40;
// How many actions the question after an import lists by name.
const LISTED = 8;

/** @typedef {{ keys: Set<object>, actions: Map<string, { type: string, what: string }>, tooDeep: number }} Found */
/** @returns {Found} */
const nothingFound = () => ({ keys: new Set(), actions: new Map(), tooDeep: 0 });

/**
 * One action for the list: its kind, and the program, name or shortcut it carries. Never a web
 * address, a typed text or a message: those can hold a password, and the list is shown on a screen.
 * @param {string} action the action as canonical() writes it
 */
function named(action) {
  const read = JSON.parse(action);
  const what = [read.path, read.name, read.app, read.keys].find((value) => typeof value === 'string' && value.trim()) ?? '';
  return { type: String(read.type).slice(0, 40), what: what.trim().slice(0, 160) };
}

/**
 * A copy of one piece of a Deck store without the guarded actions `held` does not list, and
 * without anything deeper than DEPTH. What was left out is noted in `found`: the one walk drops
 * and counts, so the two can never disagree.
 * A step is nothing without its action, so it goes with it. A place in a list is kept and left
 * empty: the keys of a page are found by their place.
 * @param {any} node
 * @param {Set<string> | null} held the actions that stay; null keeps every action (the person said so at the PC)
 * @param {Found} found
 * @param {number} [depth] @param {object | null} [key] the key this piece belongs to
 * @returns {any}
 */
function withoutNewGuarded(node, held, found, depth = 0, key = null) {
  if (!node || typeof node !== 'object') return node;
  if (depth > DEPTH) { found.tooDeep += 1; return DROPPED; }
  if (Array.isArray(node)) {
    return node.map((item) => { const kept = withoutNewGuarded(item, held, found, depth + 1, key); return kept === DROPPED ? null : kept; });
  }
  if (held && typeof node.type === 'string' && !FREE.has(node.type)) {
    const action = canonical(node);
    if (action && !held.has(action)) {
      found.keys.add(key ?? node);
      if (!found.actions.has(action)) found.actions.set(action, named(action));
      return DROPPED;
    }
  }
  const inKey = plain(node.triggers) ? node : key;
  /** @type {Record<string, any>} */
  const out = {};
  for (const name of Object.keys(node)) {
    const kept = withoutNewGuarded(node[name], held, found, depth + 1, inKey);
    if (kept === DROPPED && name === 'action') return DROPPED;
    if (kept !== DROPPED) out[name] = kept;
  }
  return out;
}

/**
 * The Deck of a backup as this PC stores it, without the actions that start a program, type,
 * call out or go live (every action remote-actions.js guards) unless this PC's Deck already holds
 * exactly that action. A key that loses its action stays where it is, with its face, and does
 * nothing until the person gives it an action at this PC. Restoring a backup on the PC that made
 * it loses nothing: every guarded action of the file is already here.
 * A key runs with one tap, and a paired device may run whatever a key holds (remoteMayRun,
 * remoteMayLaunch): the file's word alone must not be enough for either.
 * `keep` is the person's yes, given at the PC after being shown what the keys would start
 * (backup-request.js): then the actions come in as the file has them. It is never read from the file.
 * @param {any} fromFile the Deck store in the file
 * @param {any} here the Deck store saved on this PC
 * @param {boolean} [keep]
 */
function deckOnImport(fromFile, here, keep = false) {
  return normalizeDeckStore(withoutNewGuarded(normalizeDeckStore(fromFile), keep === true ? null : guardedIn(here), nothingFound()));
}

/**
 * What the Deck of the file holds that the Deck of this PC does not hold after the import, for the
 * question the page asks at the PC: how many keys, and a short list of what they would start.
 * `tooDeep` counts what was left out for its depth alone: no answer brings that in.
 * @param {any} fromFile the Deck store in the file
 * @param {any} now the Deck store of this PC after the import
 * @returns {{ keys: number, actions: { type: string, what: string }[], more: number, tooDeep: number } | null} null when nothing was held back
 */
function deckActionsHeldBack(fromFile, now) {
  if (!plain(fromFile)) return null;
  const found = nothingFound();
  withoutNewGuarded(normalizeDeckStore(fromFile), guardedIn(now), found);
  if (!found.keys.size && !found.tooDeep) return null;
  const actions = [...found.actions.values()];
  return { keys: found.keys.size, actions: actions.slice(0, LISTED), more: Math.max(0, actions.length - LISTED), tooDeep: found.tooDeep };
}

/**
 * The favourite apps of a backup, as a settings save would store them, each with its path only when
 * this PC already starts that program from a favourite. The path is what the dashboard starts with
 * one tap, and what a paired device may start (remote-actions.js remoteMayLaunch): a file must not
 * be able to name a program for either, and it cannot through a Deck key (deckOnImport above).
 * A favourite that loses its path is still listed, and gets
 * the path of this PC the next time its app is seen open (js/app-switcher/favorites.js).
 * @param {any} fromFile @param {any} saved the favourites of this PC
 * @returns {Record<string, any>[]}
 */
function favoritesOnImport(fromFile, saved) {
  // The path that is kept is the one saved on this PC, letter for letter, never the file's:
  // where capitals tell files apart (Linux, macOS) the file's spelling can be another program.
  // The same spelling wins; otherwise the first favourite here that differs only by capitals.
  /** @type {string[]} */
  const here = (Array.isArray(saved) ? saved : []).map((fav) => (typeof fav?.path === 'string' ? fav.path : '')).filter((path) => pathKey(path));
  const exact = new Set(here);
  /** @type {Map<string, string>} */
  const known = new Map();
  for (const path of here) if (!known.has(pathKey(path))) known.set(pathKey(path), path);
  return normalizeServerAppFavorites(fromFile).map((fav) => ({ ...fav, path: exact.has(fav.path) ? fav.path : (known.get(pathKey(fav.path)) ?? '') }));
}

/**
 * The part of the widget settings that an import leaves as this PC has it.
 * @param {Record<string, any> | null} here the widget settings saved on this PC
 */
const widgetsOfThisPc = (here) => ({
  enabled: here?.enabled === true,
  suspended: Array.isArray(here?.suspended) ? here.suspended : [],
  grants: plain(here?.grants) ?? {},
});

/**
 * What the file had switched on that the import left off, for the list shown after it: the
 * person sets these up again at this PC, like a service whose key could not travel.
 * @param {any} fromFile the settings of the backup, as they are in the file
 * @param {any} written the settings of this PC after the import
 * @param {{ pcControl: boolean }} [can] what can exist on this machine. PC Control runs its commands through PowerShell
 *   (the engine offers the tool only with it, server.js): where there is none, there is nothing to turn on again.
 * @returns {string[]} 'pcControl' and 'widgetPermissions', each only when it applies
 */
function setUpAgainOnImport(fromFile, written, can = { pcControl: POWERSHELL_SUPPORTED }) {
  const file = plain(fromFile) ?? {};
  const now = plain(written) ?? {};
  const needs = [];
  if (can.pcControl && plain(file.aiFeatures)?.pcControl === true && plain(now.aiFeatures)?.pcControl !== true) needs.push('pcControl');
  const asked = plain(file.sdkWidgets) ?? {};
  const held = widgetsOfThisPc(plain(now.sdkWidgets));
  const missing = Object.keys(plain(asked.grants) ?? {}).some((id) => !Object.hasOwn(held.grants, id));
  if (missing || (asked.enabled === true && !held.enabled)) needs.push('widgetPermissions');
  return needs;
}

/**
 * The settings saved on this PC, read before an import is merged into them.
 * A file that cannot be parsed counts as "nothing saved": restoring a backup is how a broken
 * settings file gets repaired. Any other failure (a locked or unreadable file) is thrown, so the
 * import fails instead of merging against nothing and dropping every secret saved here.
 * @template T
 * @param {() => Promise<T>} read the engine's settings reader
 * @returns {Promise<T | null>}
 */
async function settingsBeforeImport(read) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * @param {Record<string, any>} incoming the settings of the backup, secrets already merged
 * @param {Record<string, any> | null} prev the settings saved on this PC
 * @returns {Record<string, any>} `incoming`, with what belongs to this PC put back
 */
function keepThisPcOnImport(incoming, prev) {
  if (!incoming.geminiApiKey && prev?.geminiApiKey) incoming.geminiApiKey = prev.geminiApiKey;
  // Access for paired devices is switched at this PC and nowhere else: the switch also moves the
  // listener and drops the devices that are connected. A backup made on another PC, or before
  // the switch was flipped, must not turn it on or off here.
  if (prev?.remoteAccess && typeof prev.remoteAccess === 'object') incoming.remoteAccess = prev.remoteAccess;
  else delete incoming.remoteAccess;
  // PC Control lets the assistant run commands on this PC. It is switched on at this PC, by its
  // own switch: a backup neither turns it on nor off, like a save from a paired device.
  const features = plain(incoming.aiFeatures);
  const pcControl = plain(prev?.aiFeatures)?.pcControl === true;
  if (features || pcControl) incoming.aiFeatures = { ...features, pcControl };
  // What each widget may see and do was allowed on this PC's screen, for the code installed here
  // (the packages do not travel in a backup). A file gives no permission and takes none away.
  // The same goes for the switch that lets community widgets run at all, and for the list of
  // widgets this PC stopped because they were too heavy: both say what runs on this PC.
  const widgets = plain(incoming.sdkWidgets);
  const here = plain(prev?.sdkWidgets);
  if (widgets || here) incoming.sdkWidgets = { ...widgets, ...widgetsOfThisPc(here) };
  if ('appFavorites' in incoming) incoming.appFavorites = favoritesOnImport(incoming.appFavorites, prev?.appFavorites);
  // Whether somebody asked for a browser tab at every sign-in is said with a click at this PC
  // (POST /startup/auto-open) and kept by the engine. A file made on another PC, or written by
  // someone else, must not make this one open a browser when its user signs in.
  incoming.autoOpenArmed = prev?.autoOpenArmed === true;
  return incoming;
}

module.exports = { settingsBeforeImport, keepThisPcOnImport, setUpAgainOnImport, deckOnImport, deckActionsHeldBack };
