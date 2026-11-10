// The FAQ answers what people ask before and while they use Xenon (what it is,
// which screen, games, widgets, backups), not mostly antivirus trouble. Every
// question is translated in all 7 site languages, amounts name their currency,
// and the two anchors other pages link to (#warnings, #mac-linux) still land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(root, 'docs', 'faq.html'), 'utf8');
const dict = {};
for (const f of ['faq.json', 'faq.es.json', 'faq.fr.json']) {
  for (const [l, t] of Object.entries(JSON.parse(readFileSync(join(root, 'tools', 'i18n', f), 'utf8')))) dict[l] = { ...dict[l], ...t };
}
const LANGS = ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh'];
const QUESTIONS = [
  'what', 'edge', 'screen', 'os',
  'free', 'trial', 'sparks', 'refund',
  'games', 'cheat', 'sensors', 'replay', 'bit', 'deck', 'add', 'make', 'connect', 'backup',
  'virus', 'closes', 'temp', 'update',
  'data', 'help',
];
// The app and the home use these names; the FAQ must not fall back to the English widget names.
const STALE_WORDS = {
  en: /dashboard(?!\.html)|\btiles?\b/i,
  it: /dashboard(?!\.html)|riquadr|\bsupporter\b|\bdrop\b|\bLyrics\b|Developer cleanup/,
  es: /dashboard(?!\.html)|\bmosaicos?\b|\bsupporter\b|\bdrops?\b|\bLyrics\b|Developer cleanup/,
  fr: /tableau de bord|\btuiles?\b|\bdrops?\b|\bLyrics\b|Developer cleanup/,
  ja: /ダッシュボード|タイル|ドロップ|Lyrics|Developer cleanup/,
  ko: /대시보드|타일|서포터|드롭|Lyrics|Developer cleanup/,
  zh: /仪表盘|磁贴|Lyrics|Developer cleanup/,
};

test('the page asks the agreed questions, in order', () => {
  const keys = [...html.matchAll(/<summary data-i18n="f\.q\.([a-z]+)">/g)].map((m) => m[1]);
  assert.deepEqual(keys, QUESTIONS);
});

test('the anchors other pages link to still exist', () => {
  assert.match(html, /id="warnings"/);
  assert.match(html, /<details id="mac-linux">\s*<summary data-i18n="f\.q\.os">/);
});

test('the jump links reach all five sections', () => {
  for (const id of ['start', 'price', 'using', 'warnings', 'privacy']) {
    assert.match(html, new RegExp(`<a href="#${id}"`), `no link to #${id}`);
    assert.match(html, new RegExp(`<h2 id="${id}">`), `no section #${id}`);
  }
});

test('every language says what Xenon is today, in the words of the app', () => {
  for (const l of LANGS) {
    for (const [k, v] of Object.entries(dict[l])) {
      if (k.startsWith('meta.')) continue;
      const text = v.replace(/https?:[^'"\s]+/g, '').replace(/Hall of Supporters/g, '');
      assert.doesNotMatch(text, STALE_WORDS[l], `${l} ${k}`);
    }
  }
});

test('the privacy answer owns up to the counters and the trial email', () => {
  const data = dict.en['f.a.data'];
  assert.match(data, /three anonymous counters/);
  assert.match(data, /Settings &rarr; General &rarr; Updates/);
  assert.match(data, /ask for the trial, which needs an email address/);
  assert.doesNotMatch(data, /no analytics|behavioural tracking|only thing you ever enter/i);
});

test('uninstalling names the place Windows really shows it', () => {
  assert.match(dict.en['f.a.update'], /Settings &rarr; Apps &rarr; Installed apps/);
  assert.match(dict.en['f.a.update'], /--keep-data/);
});

test('the trial link keeps the reader in their language', () => {
  assert.doesNotMatch(dict.en['f.a.trial'], /\?lang=/);
  for (const l of LANGS.filter((x) => x !== 'en')) assert.match(dict[l]['f.a.trial'], new RegExp(`/trial\\?lang=${l}'`), l);
});

test('the anti-cheat answer names the driver and the way out in every language', () => {
  for (const l of LANGS) {
    assert.match(dict[l]['f.a.cheat'], /<code>PawnIO\.sys<\/code>/, l);
    assert.match(dict[l]['f.a.cheat'], /<code>winget upgrade namazso\.PawnIO<\/code>/, l);
    assert.match(dict[l]['f.a.cheat'], /2\.1\.0/, l);
  }
});

test('every question and answer is in all 7 languages, with no leftover keys', () => {
  const used = new Set([...html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map((m) => m[1]));
  for (const l of LANGS) {
    for (const k of used) assert.ok(dict[l]?.[k], `${l} is missing ${k}`);
    for (const k of Object.keys(dict[l])) assert.ok(used.has(k) || k.startsWith('meta.'), `${l} keeps an unused key ${k}`);
  }
});

test('amounts name their currency, and copy has no em-dashes', () => {
  for (const l of LANGS) {
    for (const [k, v] of Object.entries(dict[l])) {
      assert.doesNotMatch(v, /\$\s?\d/, `${l} ${k} writes a dollar sign`);
      assert.doesNotMatch(v, /—/, `${l} ${k} has an em-dash`);
    }
  }
  assert.match(dict.en['f.a.free'], /5 USD a month/);
});

test('the dropped questions are gone', () => {
  assert.doesNotMatch(html, /port 3030 is already in use|Do I have to use the app\?/);
});
