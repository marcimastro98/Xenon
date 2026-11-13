// Writes the app's words as files: one table per language (server/js/i18n/<code>.js)
// in one fixed shape, and the small js/i18n.js that keeps the functions. The same
// table always gives the same text, so writing twice changes nothing.

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const ESCAPES = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\t': '\\t' };
// Characters nobody can see in an editor (control codes, no-break and zero-width
// spaces, line separators) are written as \uXXXX.
const HIDDEN = [[0x00, 0x1f], [0x7f, 0xa0], [0xad, 0xad], [0x200b, 0x200f], [0x2028, 0x202f], [0x2060, 0x2064], [0xfeff, 0xfeff]];
const isHidden = (code) => HIDDEN.some(([from, to]) => code >= from && code <= to);

export const ENGLISH = 'en';
export const OPEN = 'module.exports = {';
export const CLOSE = '};';

const hex = (ch) => `${'\\'}u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** @param {string} text @returns {string} a single-quoted JavaScript string */
export function quote(text) {
  let out = '';
  for (const ch of text) out += ESCAPES[ch] || (ch.length === 1 && isHidden(ch.charCodeAt(0)) ? hex(ch) : ch);
  return `'${out}'`;
}

/** @param {string | string[]} value */
export function literal(value) {
  if (typeof value === 'string') return quote(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return `[${value.map(quote).join(', ')}]`;
  throw new Error(`not text nor a list of text: ${typeof value}`);
}

export const keyText = (key) => (IDENTIFIER.test(key) ? key : quote(key));

/**
 * The keys of `table` in English's order; keys English lacks go last, in the
 * order the table has them.
 * @param {Record<string, unknown>} table
 * @param {string[]} englishKeys
 */
export function orderLike(table, englishKeys) {
  const first = englishKeys.filter((key) => Object.hasOwn(table, key));
  const known = new Set(first);
  return [...first, ...Object.keys(table).filter((key) => !known.has(key))];
}

function header(code) {
  if (code === ENGLISH) {
    return [
      "// Xenon's words in English, one key per line: the full list. Every other",
      '// language follows this order, and a key one of them lacks is read from here',
      '// (t() in js/i18n.js: the language, then English, then the key itself).',
    ];
  }
  return [
    `// Xenon's words in this language (${code}), one key per line, in the order of`,
    '// en.js. A key with no translation yet is left out: it reads in English until',
    '// someone writes it here, so never fill a gap with the English text.',
  ];
}

/**
 * @param {string} code
 * @param {Record<string, string | string[]>} table the language's own words
 * @param {string[]} englishKeys
 * @returns {string} the whole file, LF line endings
 */
export function renderLanguage(code, table, englishKeys) {
  const lines = ["'use strict';", ...header(code),
    '// Read by server/app-strings/tables.js; node tools/restructure/i18n-split.mjs --write',
    '// puts a hand edit back in this shape.', OPEN];
  for (const key of orderLike(table, englishKeys)) lines.push(`  ${keyText(key)}: ${literal(table[key])},`);
  lines.push(CLOSE, '');
  return lines.join('\n');
}

/** The lines of a language file between its braces: one `  key: value,` each. */
export function entryLines(fileText) {
  const lines = fileText.split('\n');
  const from = lines.indexOf(OPEN);
  const to = lines.lastIndexOf(CLOSE);
  if (from < 0 || to < from) throw new Error('not a language file written by i18n-split');
  return lines.slice(from + 1, to);
}

const CORE_HEAD = `'use strict';

// The app's words on a page: t() and the functions that put them on screen.
// The words themselves are one file per language, js/i18n/<code>.js. The server
// hands a page the languages it needs in front of the functions below
// (/layer-i18n.js, server/layer-strings.js: the saved language, the browser's and
// English), and js/i18n-load.js fetches the others when they are asked for.
// Loaded on its own this file has no words and t() answers with the key.
const i18n = {};
`;

/** @param {string} runtime the old file from "\nfunction t(key) {" to its end, untouched */
export function renderCore(runtime) {
  return CORE_HEAD + runtime;
}
