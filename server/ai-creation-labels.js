'use strict';
// The names Settings → Xenon AI shows for the creation models and reasoning
// levels, in the user's language, so the assistant calls them the same way
// ("Approfondito", not "Thorough"). Read from the app's own strings
// (js/i18n.js), never copied, so the two cannot drift.

const fs = require('fs');
const path = require('path');

const I18N_FILE = path.join(__dirname, 'js', 'i18n.js');
const KEYS = Object.freeze({
  models: ['haiku', 'sonnet', 'opus'].map((m) => [m, 'settings_xenon_model_' + m]),
  efforts: ['low', 'medium', 'high'].map((e) => [e, 'settings_xenon_effort_' + e]),
});
const BLOCK_START = /^(?: {2}([a-z]{2}): \{|Object\.assign\(i18n\.([a-z]{2}), \{)\s*$/;
const ENTRY = /^\s+([A-Za-z0-9_]+): (['"])(.*)\2,?\s*$/;

let _strings = null; // Promise<{ [lang]: { [key]: text } }>

// Every key per language, the last definition winning as it does in the browser.
function parseStrings(source) {
  const out = {};
  let lang = null;
  for (const line of source.split('\n')) {
    const start = BLOCK_START.exec(line);
    if (start) { lang = start[1] || start[2]; out[lang] = out[lang] || {}; continue; }
    if (!lang) continue;
    const m = ENTRY.exec(line);
    if (m) out[lang][m[1]] = m[3];
  }
  return out;
}

// "Approfondito: più curato, …" → "Approfondito". Full-width colons included.
const nameOf = (label) => String(label || '').split(/\s*[:：]/)[0].trim();

async function loadStrings() {
  if (!_strings) _strings = fs.promises.readFile(I18N_FILE, 'utf8').then(parseStrings).catch(() => ({}));
  return _strings;
}

// { models: { haiku, sonnet, opus }, efforts: { low, medium, high }, reasoning } in `lang`,
// English for a language or key the app does not have.
async function namesFor(lang) {
  const all = await loadStrings();
  const pick = (key) => nameOf((all[lang] && all[lang][key]) || (all.en && all.en[key]));
  const names = {};
  for (const [group, pairs] of Object.entries(KEYS)) names[group] = Object.fromEntries(pairs.map(([id, key]) => [id, pick(key)]));
  names.reasoning = pick('settings_xenon_effort');
  return names;
}

// Every English string whose key starts with `prefix`, keyed by the rest of
// the key: ('deck_info_') -> { openApp: 'Opens a program…', … }. The assistant
// reads what each Deck action does from the same text the Deck editor shows.
async function englishByPrefix(prefix) {
  const en = (await loadStrings()).en || {};
  const out = {};
  for (const [key, text] of Object.entries(en)) if (key.startsWith(prefix)) out[key.slice(prefix.length)] = text;
  return out;
}

module.exports = { namesFor, englishByPrefix, parseStrings, nameOf, _reset: () => { _strings = null; } };
