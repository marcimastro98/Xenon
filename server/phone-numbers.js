'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Phone-number identity — PURE, no I/O, unit-tested.
//
// One job: decide whether two spellings are the same person, so a caller can be
// given a name. The phone is not consistent with itself about this. The same
// contact is stored as `+393463331166` in one place and `346 333 1166` in
// another, the call log writes the international form and the phonebook often
// does not, and a number typed by hand has spaces, dots or brackets in it.
//
// The rule, and why it is not "compare the digits":
//
//   Long numbers are compared on their last MATCH_DIGITS digits, because that
//   is the part that survives every spelling: the country code is the piece
//   that appears and disappears, and no amount of prefix logic can be right for
//   every country without a table this feature does not deserve.
//
//   Short numbers are compared EXACTLY. A five-digit service number sharing its
//   digits with the tail of somebody's mobile is not that person, and matching
//   loosely there would put a friend's name on a bank's SMS sender. Loose
//   matching is safe when both sides are long; it is a wrong name when they are
//   not, and a wrong name on an incoming call is worse than no name at all.
// ─────────────────────────────────────────────────────────────────────────────

// Nine is comfortably longer than any national subscriber number we would want
// to collide (Italian mobiles are 10 with the leading 3) and short enough to
// survive a country code that one side wrote and the other did not.
const MATCH_DIGITS = 9;

// Below this, a number is a short code / service number and gets exact
// comparison. Seven keeps real landlines (which are longer everywhere we ship)
// on the loose path.
const SHORT_NUMBER_MAX = 6;

function digitsOf(value) {
  return String(value == null ? '' : value).replace(/[^\d]/g, '');
}

// The comparable identity of a number. Two values match when, and only when,
// their keys are equal.
function matchKey(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  // 00 is the international prefix written the old way; dropping it makes
  // 00393463331166 and +393463331166 the same number, which they are.
  const digits = digitsOf(raw.replace(/^00/, '+'));
  if (!digits) return '';
  if (digits.length <= SHORT_NUMBER_MAX) return 'x' + digits;   // exact bucket
  return 'n' + digits.slice(-MATCH_DIGITS);
}

function sameNumber(a, b) {
  const ka = matchKey(a);
  return !!ka && ka === matchKey(b);
}

// Build the caller → contact lookup once, then answer every incoming call and
// every call-log row from it. A phonebook of a few hundred entries is looked at
// on every render, so this is a Map rather than a scan.
//
// First writer wins on a collision: the phonebook order is the phone's own, and
// silently preferring a later duplicate would make the resolved name depend on
// something the user cannot see.
function buildIndex(contacts) {
  const index = new Map();
  const list = Array.isArray(contacts) ? contacts : [];
  for (const contact of list) {
    if (!contact || !contact.name) continue;
    const numbers = Array.isArray(contact.numbers) ? contact.numbers : [];
    for (const entry of numbers) {
      const value = entry && typeof entry === 'object' ? entry.value : entry;
      const key = matchKey(value);
      if (!key || index.has(key)) continue;
      index.set(key, { name: contact.name, number: String(value || ''), kind: (entry && entry.kind) || '' });
    }
  }
  return index;
}

// The name for a number, or '' when nobody matches. Never guesses: an unknown
// number is shown as a number, which is what every phone does and what the user
// can act on.
function lookup(index, number) {
  if (!index || typeof index.get !== 'function') return null;
  const key = matchKey(number);
  if (!key) return null;
  return index.get(key) || null;
}

// Light display tidy-up: collapse whitespace and drop the separators people
// type, while leaving the number itself exactly as the phone spelled it. No
// reformatting into a national style — getting that wrong for one country is a
// number the user reads as unfamiliar.
function displayNumber(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// Is this something we can hand to the dialer? Deliberately permissive about
// the shape (short codes and international forms are both real) and strict
// about the characters, so nothing but a number ever reaches the phone.
function dialable(value) {
  const raw = displayNumber(value);
  if (!raw || raw.length > 32) return '';
  if (!/^\+?[\d\s().*#-]+$/.test(raw)) return '';
  const compact = raw.replace(/[\s().-]/g, '');
  if (!/\d/.test(compact)) return '';
  return compact;
}

module.exports = {
  digitsOf,
  matchKey,
  sameNumber,
  buildIndex,
  lookup,
  displayNumber,
  dialable,
  MATCH_DIGITS,
  SHORT_NUMBER_MAX,
};
