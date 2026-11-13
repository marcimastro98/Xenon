// Checks that the app says the same thing before and after its words were split
// into one file per language: the answers of t() itself, the tables a page
// holds, and what is wrong in the words whichever way they are stored.

import vm from 'node:vm';

const ENGLISH = 'en';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Every answer of a strings script's own t(), asked in every language. The
 * script is the old js/i18n.js or what the server builds for a page.
 * @param {string} script
 * @param {string[]} langs
 * @param {string[]} keys
 * @returns {Record<string, unknown[]>} language -> one answer per key
 */
export function answers(script, langs, keys) {
  const box = vm.createContext({});
  // `lang` lives in js/state.js on a real page.
  vm.runInContext(`let lang = '${ENGLISH}';\n${script}`, box, { timeout: 60000 });
  const ask = vm.runInContext('(langs, keys) => JSON.stringify(langs.map((l) => { lang = l; return keys.map((k) => t(k)); }))', box);
  const rows = JSON.parse(ask(langs, keys));
  return Object.fromEntries(langs.map((code, i) => [code, rows[i]]));
}

/** @param {Record<string, object>[]} tableSets @returns {string[]} every key of every language */
export function allKeys(...tableSets) {
  const keys = new Set();
  for (const tables of tableSets) for (const table of Object.values(tables)) for (const key of Object.keys(table)) keys.add(key);
  return [...keys];
}

/** @returns {{ compared: number, mismatches: { lang: string, key: string, before: unknown, after: unknown }[] }} */
export function compareAnswers(before, after, langs, keys) {
  const mismatches = [];
  for (const lang of langs) {
    keys.forEach((key, i) => {
      if (!same(before[lang][i], after[lang][i])) mismatches.push({ lang, key, before: before[lang][i], after: after[lang][i] });
    });
  }
  return { compared: langs.length * keys.length, mismatches };
}

/**
 * How two sets of tables differ, pair by pair.
 * @returns {{ pairs: number, changed: string[], gone: string[], added: string[] }} entries are "lang.key"
 */
export function compareTables(before, after) {
  const out = { pairs: 0, changed: [], gone: [], added: [] };
  for (const lang of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[lang] || {};
    const now = after[lang] || {};
    for (const key of Object.keys(was)) {
      out.pairs += 1;
      if (!Object.hasOwn(now, key)) out.gone.push(`${lang}.${key}`);
      else if (!same(was[key], now[key])) out.changed.push(`${lang}.${key}`);
    }
    for (const key of Object.keys(now)) if (!Object.hasOwn(was, key)) out.added.push(`${lang}.${key}`);
  }
  return out;
}

const placeholders = (value) => [...String(value).matchAll(/\{([A-Za-z_]\w*)\}/g)].map((m) => m[1]).sort().join(',');

/**
 * What is wrong in the words themselves, wherever they are stored.
 * @param {Record<string, Record<string, string | string[]>>} own each language's own words
 * @returns {{
 *   notInEnglish: { lang: string, key: string }[],
 *   placeholders: { lang: string, key: string, english: string, own: string }[],
 *   untranslated: Record<string, number>,
 *   englishOnly: string[],
 * }}
 */
export function defects(own) {
  const english = own[ENGLISH] || {};
  const out = { notInEnglish: [], placeholders: [], untranslated: {}, englishOnly: [] };
  const others = Object.keys(own).filter((lang) => lang !== ENGLISH);
  for (const lang of others) {
    for (const [key, value] of Object.entries(own[lang])) {
      if (!Object.hasOwn(english, key)) { out.notInEnglish.push({ lang, key }); continue; }
      if (typeof value !== 'string' || typeof english[key] !== 'string') continue;
      if (placeholders(value) !== placeholders(english[key])) {
        out.placeholders.push({ lang, key, english: placeholders(english[key]), own: placeholders(value) });
      }
    }
    out.untranslated[lang] = Object.keys(english).filter((key) => !Object.hasOwn(own[lang], key)).length;
  }
  out.englishOnly = Object.keys(english).filter((key) => others.length > 0 && others.every((lang) => !Object.hasOwn(own[lang], key)));
  return out;
}
