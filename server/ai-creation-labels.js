'use strict';
// The names Settings → Xenon AI shows for the creation models and reasoning
// levels, in the user's language, so the assistant calls them the same way
// ("Approfondito", not "Thorough"). Read from the app's own strings
// (js/i18n/<code>.js through app-strings/tables.js), never copied, so the two
// cannot drift.

const Tables = require('./app-strings/tables.js');

const KEYS = Object.freeze({
  models: ['haiku', 'sonnet', 'opus'].map((m) => [m, 'settings_xenon_model_' + m]),
  efforts: ['low', 'medium', 'high'].map((e) => [e, 'settings_xenon_effort_' + e]),
});

// Only what was asked for is kept, never a whole language.
const names = new Map();     // language -> Promise<names>
const prefixes = new Map();  // prefix -> Promise<{ rest of key: English text }>

// "Approfondito: più curato, …" → "Approfondito". Full-width colons included.
const nameOf = (label) => String(label || '').split(/\s*[:：]/)[0].trim();

// A language's own words; nothing when its file cannot be read, so English answers.
const wordsOf = (code) => Tables.read(code).catch(() => ({}));
const textOf = (value) => (typeof value === 'string' ? value : '');

async function readNames(lang) {
  const english = await wordsOf(Tables.FALLBACK);
  const own = lang === Tables.FALLBACK ? english : await wordsOf(lang);
  const pick = (key) => nameOf(textOf(own[key]) || textOf(english[key]));
  const out = {};
  for (const [group, pairs] of Object.entries(KEYS)) out[group] = Object.fromEntries(pairs.map(([id, key]) => [id, pick(key)]));
  out.reasoning = pick('settings_xenon_effort');
  return out;
}

// { models: { haiku, sonnet, opus }, efforts: { low, medium, high }, reasoning } in `lang`,
// English for a language or key the app does not have.
async function namesFor(lang) {
  const code = Tables.isLanguage(lang) ? lang : Tables.FALLBACK;
  if (!names.has(code)) names.set(code, readNames(code));
  const kept = await names.get(code);
  // A copy: the caller may change what it gets.
  return { models: { ...kept.models }, efforts: { ...kept.efforts }, reasoning: kept.reasoning };
}

async function readByPrefix(prefix) {
  const english = await wordsOf(Tables.FALLBACK);
  const out = {};
  for (const [key, text] of Object.entries(english)) {
    if (key.startsWith(prefix) && typeof text === 'string') out[key.slice(prefix.length)] = text;
  }
  return out;
}

// Every English string whose key starts with `prefix`, keyed by the rest of
// the key: ('deck_info_') -> { openApp: 'Opens a program…', … }. The assistant
// reads what each Deck action does from the same text the Deck editor shows.
async function englishByPrefix(prefix) {
  const wanted = String(prefix);
  if (!prefixes.has(wanted)) {
    if (prefixes.size >= 16) prefixes.clear();
    prefixes.set(wanted, readByPrefix(wanted));
  }
  return { ...(await prefixes.get(wanted)) };
}

module.exports = { namesFor, englishByPrefix, nameOf, _reset: () => { names.clear(); prefixes.clear(); } };
