'use strict';
// The Bit's extras the author may keep for supporters, each set 'free' or 'supporter' in the
// hub's console (its src/bit-perks.js lists the same ids) and told with the hub's items
// (POST /bit/items, items.js keeps the word on disk so it holds offline). Free until the hub
// says otherwise. A supporters' extra opens like a supporters' item (keep.js): one /redeem of
// its entry with the pass this PC keeps, then it is this Bit's for good (bit.json `perks`).
// The gate is at choosing: what the person already has is never taken away when the hub
// changes its word, and the app being source-available makes it an honest gate, not DRM.
//
//   allScreens  one Bit going from screen to screen on the desktop (prefs.desk 'all')
//   moreKeys    up to Pocket.MAX_KEYS quick keys in the pocket instead of Pocket.FREE_KEYS

const Pocket = require('./pocket.js');

const PERKS = Object.freeze({
  allScreens: Object.freeze({ entry: 'bit-perk-all-screens', source: 'bit-allscreens' }),
  moreKeys: Object.freeze({ entry: 'bit-perk-more-keys', source: 'bit-morekeys' }),
});
const IDS = Object.freeze(Object.keys(PERKS));

const ALL_FREE = Object.freeze(Object.fromEntries(IDS.map((id) => [id, 'free'])));
let access = ALL_FREE; // the hub's last word (items.js)

/** The hub's word, checked: every extra present, anything but 'supporter' read as free. */
function accessOf(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return Object.freeze(Object.fromEntries(IDS.map((id) => [id, src[id] === 'supporter' ? 'supporter' : 'free'])));
}

/** items.js, on reading its file and on each answer of the hub. */
function setAccess(raw) { access = accessOf(raw); }

/** The extras this Bit opened, as bit.json keeps them. */
const openedOf = (raw) => (Array.isArray(raw) ? IDS.filter((id) => raw.includes(id)) : []);

const isOpen = (id, opened) => access[id] !== 'supporter' || opened.includes(id);

/** What a change of prefs asks that this Bit has not opened: the extra's id, or ''. */
function lockedBy(prev, next, opened) {
  if (next.desk === 'all' && prev.desk !== 'all' && !isOpen('allScreens', opened)) return 'allScreens';
  const keys = Array.isArray(next.keys) ? next.keys.length : 0;
  const had = Array.isArray(prev.keys) ? prev.keys.length : 0;
  if (keys > Math.max(Pocket.FREE_KEYS, had) && !isOpen('moreKeys', opened)) return 'moreKeys';
  return '';
}

/** For the surfaces: each extra, who it is for and whether this Bit has it. */
function view(opened) {
  return Object.fromEntries(IDS.map((id) => [id, { access: access[id], open: isOpen(id, opened) }]));
}

module.exports = { PERKS, IDS, accessOf, setAccess, access: () => access, openedOf, isOpen, lockedBy, view };
