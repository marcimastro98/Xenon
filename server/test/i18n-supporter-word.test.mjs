// One word for a supporter in each language. People pay on one window and read their code on another:
// a button that says "Hazte suscriptor" here and "Hazte colaborador" there reads as two offers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';

const SRC = appStringsSource();

function strings() {
  const box = {
    window: {},
    document: { documentElement: {}, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { language: 'en' },
    console,
  };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(`${SRC}\n;globalThis.__i18n = i18n;`, box);
  return box.__i18n;
}

// Search keywords keep the other words on purpose, and Twitch has real subscribers.
const OTHER_MEANING = new Set(['settings_kw_support', 'deck_opt_subscribers', 'deck_info_twitchChatMode', 'tww_chat_refused']);
const OTHER_WORDS = {
  es: /colaborador|suscriptor|supporter/i,
  fr: /\b(?:les|aux|des) soutiens\b|\bDevenir soutien\b|\bDevenez soutien\b/,
  de: /Supporter/,
  pt: /apoiador|supporter/i,
  ko: /서포터/,
  ru: /саппортер|сторонник|поддерживающ/i,
};

for (const [lang, other] of Object.entries(OTHER_WORDS)) {
  test(`${lang}: one word for a supporter`, () => {
    const found = Object.entries(strings()[lang])
      .filter(([key, value]) => typeof value === 'string' && !OTHER_MEANING.has(key) && other.test(value))
      .map(([key]) => key);
    assert.deepEqual(found, []);
  });
}

test('the three doors to the plan say the same thing in each language', () => {
  const all = strings();
  for (const lang of ['es', 'fr', 'de', 'pt', 'ko', 'ru']) {
    // The Store button speaks in the first person; the others address the reader as tu (pt-PT).
    assert.equal(all[lang].trial_support, all[lang].gallery_supporters_join.replace('Tornar-me', 'Torna-te'), lang);
    assert.equal(all[lang].trial_support, all[lang].devclean_join, lang);
  }
});
