import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';

// Bit's local server, on the side the fake-server tests in ai-local-server.test.mjs
// cannot see: the panel, the strings, and the key on its way through the settings.
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const fields = require('../js/local-server-fields.js');
const server = require('../ai-local-server.js');
const creds = require('../ai-provider-creds.js');
const { SECRET_KEY_GROUPS, stripSettingsSecrets } = require('../js/settings-secrets.js');

const LANGUAGES = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

function i18nTable() {
  const src = appStringsSource();
  const ctx = { module: {} };
  vm.runInNewContext(`${src.slice(0, src.search(/^function /m))}\nthis.table = i18n;`, ctx);
  return ctx.table;
}

// Every key the panel and the chat can ask for, read from where they ask.
function localServerKeys() {
  const html = read('index.html');
  const panel = html.slice(html.indexOf('id="settings-localapi-panel"'), html.indexOf('<!-- Claude Code / Codex'));
  const keys = new Set(['ai_provider_localapi', 'lyrics_opt_cost_localapi', 'ai_localserver_tools_context', 'ai_localserver_tools_refused']);
  for (const [, key] of panel.matchAll(/data-i18n="([a-z_]+)"/g)) keys.add(key);
  for (const [, key] of read('js/ai-local-server-settings.js').matchAll(/'(settings_[a-z_]+)'/g)) keys.add(key);
  const codes = read('js/ai.js').match(/AI_LOCAL_SERVER_ERRORS = new Set\(\[([^\]]+)\]/)[1];
  for (const [, code] of codes.matchAll(/'([a-z_]+)'/g)) keys.add('ai_localserver_' + code);
  return [...keys];
}

test('every string of the local server exists, on its own, in all 11 languages', () => {
  const table = i18nTable();
  const keys = localServerKeys();
  assert.ok(keys.length >= 24, `only ${keys.length} keys found: the scan lost its anchors`);
  for (const lang of LANGUAGES) {
    for (const key of keys) {
      assert.equal(typeof table[lang][key], 'string', `${lang}.${key} is missing`);
      assert.ok(table[lang][key].trim(), `${lang}.${key} is empty`);
    }
  }
  const own = keys.filter((key) => key.includes('localapi') || key.includes('localserver'));
  for (const lang of LANGUAGES.filter((code) => code !== 'en')) {
    for (const key of own) {
      assert.notEqual(table[lang][key], table.en[key], `${lang}.${key} is still the English text`);
    }
  }
});

test('the count in the connected line survives every translation', () => {
  const table = i18nTable();
  for (const lang of LANGUAGES) assert.match(table[lang].settings_localapi_state_ok, /\{n\}/, lang);
});

test('the user-visible strings carry no em dash', () => {
  const table = i18nTable();
  for (const lang of LANGUAGES) {
    for (const key of localServerKeys()) assert.ok(!table[lang][key].includes('—'), `${lang}.${key}`);
  }
});

test('the server and the dashboard check the fields with the same code', () => {
  assert.equal(server.sanitizeUrl, fields.sanitizeUrl);
  assert.equal(server.sanitizeModel, fields.sanitizeModel);
  const settings = read('js/settings.js');
  assert.match(settings, /localApiUrl: LocalServerFields\.sanitizeUrl\(value\.localApiUrl\)/);
  assert.match(settings, /localApiModel: LocalServerFields\.sanitizeModel\(value\.localApiModel\)/);
});

test('an address off this machine never survives, on either side', () => {
  for (const bad of ['http://192.168.1.20:8080', 'http://example.com', 'http://127.0.0.1.example.com', 'file:///c:/x', 'http://user:pw@127.0.0.1:8080', 'nonsense', '']) {
    assert.equal(fields.sanitizeUrl(bad), fields.DEFAULT_URL, bad);
  }
  assert.equal(fields.sanitizeUrl('http://localhost:1234/v1'), 'http://localhost:1234');
  assert.equal(fields.sanitizeUrl('http://[::1]:1234'), 'http://[::1]:1234');
});

test('model names keep the slashes and colons local servers use', () => {
  for (const name of ['qwen2.5:7b', 'lmstudio-community/Qwen3-8B-GGUF', 'C:/models/a b.gguf']) {
    assert.equal(fields.sanitizeModel(name), name);
  }
  assert.equal(fields.sanitizeModel('a\nb'), 'auto');
  assert.equal(fields.sanitizeModel('x'.repeat(201)), 'auto');
});

test('the key is a server-only secret: redacted on the wire, kept on a normal save', () => {
  assert.ok(SECRET_KEY_GROUPS.ai.includes('localApiKey'));
  const wire = creds.redactAiProviderCreds({ localApiKey: 'sk-local' });
  assert.equal(wire.localApiKey, '');
  assert.equal(wire.localApiKeySet, true);
  const kept = creds.preserveAiProviderCreds({ localApiKey: '', localApiKeySet: true }, { localApiKey: 'sk-local' });
  assert.equal(kept.localApiKey, 'sk-local');
  const removed = creds.preserveAiProviderCreds({ localApiKey: '', localApiKeySet: false }, { localApiKey: 'sk-local' });
  assert.equal(removed.localApiKey, '');
});

test('the key never reaches the dashboard mirror', () => {
  const out = stripSettingsSecrets({ localApiKey: 'sk-local', localApiUrl: 'http://127.0.0.1:8080' });
  assert.equal(out.localApiKey, '');
  assert.equal(out.localApiUrl, 'http://127.0.0.1:8080');
});

test('the panel has every control its script reaches for, and loads in order', () => {
  const html = read('index.html');
  for (const [, id] of read('js/ai-local-server-settings.js').matchAll(/field\('([a-z-]+)'\)/g)) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  for (const id of ['settings-localapi-model', 'settings-localapi-model-custom', 'settings-localapi-model-used', 'ai-provider-localapi']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.indexOf('js/local-server-fields.js') < html.indexOf('js/settings.js"'), 'settings.js reads LocalServerFields at load');
});

test('every list of providers on the client knows it', () => {
  assert.match(read('js/settings.js'), /AI_PROVIDER_IDS = \[[^\]]*'localapi'/);
  for (const file of ['js/ai.js', 'js/performance.js']) {
    assert.match(read(file), /\['ollama', 'localapi', 'openai'/, file);
  }
  for (const file of ['js/ai.js', 'js/media.js', 'js/disk-widget.js', 'js/performance.js']) {
    assert.match(read(file), /=== 'ollama' \|\| \w+ === 'localapi'\) return true/, file);
  }
});
