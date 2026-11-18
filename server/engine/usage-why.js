'use strict';

// Why one counted use failed, as ONE word the hub accepts (its src/usage-features.js
// ERROR_KINDS). Never the error text itself, which can carry an argument of the action.

// The reasons the app can give (the hub's list also holds the Maker's sign-in ones).
const ERROR_KINDS = Object.freeze(['unavailable', 'failed', 'refused', 'nothing', 'busy', 'other']);

// A request the feature turned down because it was asked wrong (a scene name
// that does not exist, a bad screen number): the answer carries the valid
// choices and Bit asks again. Counted as a use, not a failure, or the failed
// count of every feature Bit can call says how often Bit guessed, not whether
// the feature works.
//
// The same goes for a request the person's own setup turns down on purpose: a
// shortcut already taken or reserved, a widget or function that is not there, a
// permission not granted. The feature answered as it should.
const ASKED_WRONG_RE = /^(bad_|unknown_|needs_)|^(ambiguous|in_use|reserved|no_widget|no_function|not_granted)$/;

/** @param {unknown} error */
const askedWrong = (error) => ASKED_WRONG_RE.test(String(error || ''));

// The error word of a result → one word from ERROR_KINDS. Rules in order; a word
// nobody mapped is 'other', so a new error never leaks its own text.
/** @type {Array<[RegExp, string]>} */
const KIND_RULES = [
  [/unavailable$|^unsupported$/, 'unavailable'],
  [/failed$|^http_/, 'failed'],
  [/^(over_exclusive|screen_alerts_off|history_off|companion_off|blocked_ext|args_not_supported|sized_by_itself)$/, 'refused'],
  [/^running$/, 'busy'],
  [/^(no_|not_|nothing_|first_session$)/, 'nothing'],
];

/** @param {unknown} error @returns {string} */
function kindOf(error) {
  const word = String(error || '');
  const rule = KIND_RULES.find(([re]) => re.test(word));
  return rule ? rule[1] : 'other';
}

module.exports = { ERROR_KINDS, askedWrong, kindOf };
