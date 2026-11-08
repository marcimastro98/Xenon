// One way of speaking to the reader per language. French and Russian mixed the polite
// and the familiar form (vous/tu, вы/ты), sometimes in one window. The app speaks to the
// reader with vous and вы. Lines in the reader's own voice, said TO Bit (a starter
// prompt, "Set it up for me"), keep tu: that is how French speaks to an assistant.
// Portuguese mixed Brazil and Portugal (você and tela beside tu and ecrã); the app's
// Portuguese is Portugal's, with tu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

function strings() {
  const box = {
    window: {},
    document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { language: 'en' },
  };
  vm.runInNewContext(SRC + '\n;this.__i18n = i18n;', box);
  return box.__i18n;
}
const ALL = strings();

// The words of a form, whole words only, in any script.
const words = (list) => new RegExp('(?<!\\p{L})(' + list + ')(?!\\p{L})', 'iu');
const using = (lang, re, skip = new Set()) => Object.entries(ALL[lang])
  .filter(([key, text]) => !skip.has(key) && typeof text === 'string' && text !== ALL.en[key] && re.test(text))
  .map(([key, text]) => `${key}: ${text}`);

// The reader talking to Bit or to the app, not the app talking to the reader.
const FR_READER_VOICE = new Set([
  'bit_start_tour', 'bit_start_widget', 'bit_start_timer', 'bit_start_music_timer', 'wn_s_bit_ask',
  'gallery_ask_bit_draft', 'capg_tx_bit_prompt', 'deck_ph_prompt', 'settings_bg_code_ai_hint',
  'settings_replay_on_hint', 'ra_https_setup',
  // "Ton" here is the noun: the tone of Bit's roasts.
  'settings_vpet_tone',
]);

test('French speaks to the reader with vous', () => {
  assert.deepEqual(using('fr', words('tu|ton|ta|tes|toi'), FR_READER_VOICE), []);
});

test('Russian speaks to the reader with вы', () => {
  // Possessives one by one: a stem would also catch творение (a creation).
  assert.deepEqual(using('ru', words('ты|тебя|тебе|тобой|твой|твоя|твоё|твое|твои|твоего|твоей|твоему|твоим|твоих|твою|твоими')), []);
});

test("Portuguese is Portugal's: tu, and its words for screen, phone, settings", () => {
  assert.deepEqual(using('pt', words('você|vocês')), []);
  // Search keywords keep both countries' words on purpose, so either one finds the setting.
  const keywords = new Set(Object.keys(ALL.pt).filter((key) => /_kw_/.test(key)));
  assert.deepEqual(using('pt', words('tela|telas|celular|usuário|usuários|aplicativo|aplicativos|Configurações|Conexões|digite|lixeira|abas'), keywords), []);
});

test('the reader-voice exceptions still exist, so the list cannot hide a new line', () => {
  for (const key of FR_READER_VOICE) assert.ok(key in ALL.fr, key + ' is gone: drop it from the list');
});
