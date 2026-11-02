'use strict';
// Text placed inside a PowerShell single-quoted string.
//
// PowerShell ends a single-quoted string on FIVE characters, not one: the
// ASCII apostrophe and the typographic quotes U+2018 ‘ U+2019 ’ U+201A ‚
// U+201B ‛. Escaping only the ASCII one (the usual `.replace(/'/g, "''")`)
// lets a value carrying ’ close the string and run whatever follows, and ’ is
// exactly what a file name, a window title or a downloaded file's name can
// hold. Doubling each of them is what PowerShell itself does
// (CodeGeneration.EscapeSingleQuotedStringContent): '' ‘‘ ’’ ‚‚ ‛‛ each read
// back as one literal character, so the value arrives unchanged.
//
// Every PowerShell string built in Node goes through here. A NUL would end
// the argument early on Windows, so it is dropped.

const PS_SINGLE_QUOTES = /['\u2018\u2019\u201A\u201B]/g;

function psEscape(value) {
  return String(value == null ? '' : value).replace(/\0/g, '').replace(PS_SINGLE_QUOTES, (q) => q + q);
}

// The whole literal, quotes included: `'C:\Program Files\x.exe'`.
function psQuote(value) {
  return "'" + psEscape(value) + "'";
}

module.exports = { psEscape, psQuote, PS_SINGLE_QUOTES };
