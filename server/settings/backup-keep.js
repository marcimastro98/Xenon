'use strict';

// What a backup import never takes from the file, because it belongs to this PC.
// The secrets have their own module (secrets.js); this is the rest.

const { normalizeServerAppFavorites } = require('./normalize-favorites.js');
const { normalizeDeckStore } = require('../deck/store-normalize.js');
const { guardedIn, canonical, introduces, FREE } = require('../remote-actions.js');

/** @param {any} value @returns {Record<string, any> | null} the value when it is an object with keys, not a list */
const plain = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const pathKey = (/** @type {any} */ value) => String(value || '').trim().toLowerCase();

const DROPPED = Symbol('dropped');

/**
 * A copy of one piece of a Deck store without the guarded actions `held` does not list.
 * A step is nothing without its action, so it goes with it. A place in a list is kept and left
 * empty: the keys of a page are found by their place.
 * @param {any} node @param {Set<string>} held
 * @returns {any}
 */
function withoutNewGuarded(node, held) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item) => { const kept = withoutNewGuarded(item, held); return kept === DROPPED ? null : kept; });
  }
  if (typeof node.type === 'string' && !FREE.has(node.type)) {
    const action = canonical(node);
    if (action && !held.has(action)) return DROPPED;
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const name of Object.keys(node)) {
    const kept = withoutNewGuarded(node[name], held);
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
 * @param {any} fromFile the Deck store in the file
 * @param {any} here the Deck store saved on this PC
 */
function deckOnImport(fromFile, here) {
  return normalizeDeckStore(withoutNewGuarded(normalizeDeckStore(fromFile), guardedIn(here)));
}

/**
 * Whether the Deck of the file holds a guarded action that the Deck of this PC does not hold after
 * the import: the person is told, and sets those keys up again here.
 * @param {any} fromFile the Deck store in the file
 * @param {any} now the Deck store of this PC after the import
 */
const deckActionsHeldBack = (fromFile, now) => !!plain(fromFile) && introduces(now, fromFile);

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
  const known = new Set((Array.isArray(saved) ? saved : []).map((fav) => pathKey(fav?.path)).filter(Boolean));
  return normalizeServerAppFavorites(fromFile).map((fav) => (known.has(pathKey(fav.path)) ? fav : { ...fav, path: '' }));
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
 * @returns {string[]} 'pcControl' and 'widgetPermissions', each only when it applies
 */
function setUpAgainOnImport(fromFile, written) {
  const file = plain(fromFile) ?? {};
  const now = plain(written) ?? {};
  const needs = [];
  if (plain(file.aiFeatures)?.pcControl === true && plain(now.aiFeatures)?.pcControl !== true) needs.push('pcControl');
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
  return incoming;
}

module.exports = { settingsBeforeImport, keepThisPcOnImport, setUpAgainOnImport, deckOnImport, deckActionsHeldBack };
