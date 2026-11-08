'use strict';

// The English name of each app language, for the line an AI prompt carries
// ("answer in Italian"). One map for every prompt: the copies it replaces fell
// behind the app's languages, so a Russian or Dutch chat lost its language line
// and a Spanish voice clip went to transcription with no language at all.
// The keys are the codes of SUPPORTED_LANGS (packages/core/src/constants.js);
// a test keeps the two equal.
const AI_LANG_NAMES = Object.freeze({
  it: 'Italian', en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese',
  es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', ru: 'Russian', nl: 'Dutch',
});

// The name for a code or a locale ('pt-BR' -> 'Portuguese'). Anything else gets
// `fallback`: each prompt decides whether that is English or no language line.
function aiLangName(lang, fallback = '') {
  const code = String(lang || '').toLowerCase().slice(0, 2);
  return Object.hasOwn(AI_LANG_NAMES, code) ? AI_LANG_NAMES[code] : fallback;
}

module.exports = { AI_LANG_NAMES, aiLangName };
