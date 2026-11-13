// Reads the old single server/js/i18n.js (every language in one file, later
// blocks patching earlier ones) by running its data half in an empty sandbox,
// the way a browser would, and says for each language which words are its own
// and which it only had because of the `...i18n.en` spread.

import vm from 'node:vm';

// From this line on the file is functions (t, setLang…); before it, data.
export const RUNTIME_AT = '\nfunction t(key) {';
const SPREAD_LINE = /^[ \t]*\.\.\.i18n\.en,[ \t]*$/gm;
const ENGLISH = 'en';

/** @param {string} source @returns {{ data: string, runtime: string }} */
export function halves(source) {
  const at = source.indexOf(RUNTIME_AT);
  if (at < 0) throw new Error('i18n.js: the line "function t(key) {" was not found');
  return { data: source.slice(0, at), runtime: source.slice(at) };
}

const isText = (value) => typeof value === 'string';

// Objects made in the sandbox belong to it: copy them into plain ones, and
// refuse anything that is not text or a list of text.
function plainTables(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('i18n.js: no table named i18n');
  const tables = {};
  for (const lang of Object.keys(raw)) {
    const table = {};
    for (const key of Object.keys(raw[lang] || {})) {
      const value = raw[lang][key];
      if (isText(value)) table[key] = value;
      else if (Array.isArray(value) && value.every(isText)) table[key] = [...value];
      else throw new Error(`${lang}.${key}: ${typeof value} is neither text nor a list of text`);
    }
    tables[lang] = table;
  }
  return tables;
}

function run(data) {
  return plainTables(vm.runInNewContext(`${data}\ni18n;`, Object.create(null), { filename: 'i18n.js', timeout: 20000 }));
}

export const sameValue = (a, b) => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b);

/** True while the file still holds the words themselves. */
export function isLegacy(source) {
  return Object.keys(run(halves(source).data)).length > 0;
}

// A spread written any other way would be copied into a language as its own words.
function refuseOtherSpreads(data) {
  const odd = data.split('\n').find((line) => line.includes('...') && /\.\.\.\s*[A-Za-z_$]/.test(line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '').replace(/\/\/.*$/, '')));
  if (odd) throw new Error(`i18n.js: a spread this tool does not know: ${odd.trim().slice(0, 80)}`);
}

/**
 * @param {string} source the old file
 * @returns {{
 *   langs: string[],
 *   resolved: Record<string, Record<string, string | string[]>>,
 *   own: Record<string, Record<string, string | string[]>>,
 *   inherited: Record<string, string[]>,
 *   spreads: number,
 *   runtime: string,
 * }} `resolved` is what a browser held, `own` the same without the English spread
 */
export function readLegacy(source) {
  const { data, runtime } = halves(source);
  const resolved = run(data);
  let spreads = 0;
  const bare = data.replace(SPREAD_LINE, () => { spreads += 1; return ''; });
  refuseOtherSpreads(bare);
  const own = run(bare);
  const english = resolved[ENGLISH];
  if (!english) throw new Error('i18n.js: no English table');
  const inherited = {};
  for (const lang of Object.keys(resolved)) {
    for (const key of Object.keys(own[lang])) {
      if (!sameValue(own[lang][key], resolved[lang][key])) {
        throw new Error(`${lang}.${key}: the English spread replaces this translation in the old file`);
      }
    }
    inherited[lang] = Object.keys(resolved[lang]).filter((key) => !Object.hasOwn(own[lang], key));
    // A copy of English taken before English changed would stop being said once it is dropped.
    const stale = inherited[lang].filter((key) => !sameValue(resolved[lang][key], english[key]));
    if (stale.length) throw new Error(`${lang}: ${stale.length} inherited strings differ from English today (${stale.slice(0, 5).join(', ')})`);
  }
  return { langs: Object.keys(resolved), resolved, own, inherited, spreads, runtime };
}
