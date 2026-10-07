// Which pages of the site exist in which languages. One list, read by the
// builder of the copies (build-page-langs.mjs), the shared header's language
// menu (site-chrome.mjs) and the sitemap (build-seo.mjs), so the three can never
// disagree about where a page lives.
//
// English is always the page at the root; every other language is a static
// copy at /<lang>/<page>. The home's copies are built by build-i18n.mjs from the
// home's own tables; every other page's copies come from tools/i18n/<name>.json
// (see page-i18n.mjs) or, for the pages that still carry their dictionary
// inline, from that inline table.

export const LANG_NAMES = { en: 'English', it: 'Italiano', es: 'Español', ja: '日本語', ko: '한국어', zh: '中文' };
export const OG_LOCALE = { en: 'en_US', it: 'it_IT', es: 'es_ES', ja: 'ja_JP', ko: 'ko_KR', zh: 'zh_CN' };
export const HOME_LANGS = ['it', 'es', 'ja', 'ko', 'zh'];

// Every page ships in the same six languages as the home. English is the page
// itself and the source every translation is made from; a language whose
// dictionary is not written yet is simply not built (and not listed).
export const ALL = ['es', 'it', 'ja', 'ko', 'zh'];
export const LANG_PAGES = [
  { page: 'download.html', langs: ALL, dict: 'download' },
  { page: 'faq.html', langs: ALL, dict: 'faq' },
  { page: 'phone.html', langs: ALL, dict: 'phone' },
  { page: 'xeneon-edge-widgets.html', langs: ALL, dict: 'xeneon-edge-widgets' },
  { page: 'tablet-dashboard.html', langs: ALL, dict: 'tablet-dashboard' },
  { page: 'linux.html', langs: ALL, dict: 'linux' },
  { page: 'xenon-exe.html', langs: ALL, dict: 'xenon-exe' },
  { page: 'privacy.html', langs: ALL, dict: 'privacy' },
  { page: 'mac.html', langs: ALL, dict: 'mac' },
  { page: 'widgets.html', langs: ALL, dict: 'widgets' },
  { page: 'deck.html', langs: ALL, dict: 'deck' },
  { page: 'claude-code.html', langs: ALL, dict: 'claude-code' },
  { page: 'codex.html', langs: ALL, dict: 'codex' },
  { page: 'sensor-panel.html', langs: ALL, dict: 'sensor-panel' },
];

// Every language a page is published in, English first.
export function langsOf(page) {
  if (page === '' || page === 'index.html') return ['en', ...HOME_LANGS];
  const p = LANG_PAGES.find((x) => x.page === page);
  return p ? ['en', ...p.langs.filter((l) => READY(p, l))] : ['en'];
}

// A language is published once its dictionary has entries for it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const I18N_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'i18n');
const cache = new Map();
function READY(entry, lang) {
  return Object.keys(readDictFiles(entry.dict)[lang] || {}).length > 0;
}

// A page's dictionary: tools/i18n/<name>.json, with any per-language file
// tools/i18n/<name>.<lang>.json merged over it. Separate files let several
// translators work on one page at once without writing the same file.
export function readDictFiles(name) {
  if (cache.has(name)) return cache.get(name);
  const dict = {};
  const merge = (file) => {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    for (const [l, table] of Object.entries(d)) {
      if (l.startsWith('_') || !table || typeof table !== 'object') continue;
      dict[l] = Object.assign({}, dict[l] || {}, table);
    }
  };
  merge(path.join(I18N_DIR, name + '.json'));
  let files = [];
  try { files = fs.readdirSync(I18N_DIR); } catch { files = []; }
  for (const f of files) if (f.startsWith(name + '.') && f.endsWith('.json') && f !== name + '.json') merge(path.join(I18N_DIR, f));
  cache.set(name, dict);
  return dict;
}

// The URL path of a page in a language ('' is the home).
export function pathOf(page, lang) {
  const file = page === 'index.html' ? '' : page;
  return lang === 'en' ? '/' + file : '/' + lang + '/' + file;
}

// The language menu of the shared header: links to the published copies, the
// current one marked. Same markup on the English page and on every copy.
export function langMenu(page, lang) {
  const items = langsOf(page).map((l) => `<li><a href="${pathOf(page, l)}" hreflang="${l}" lang="${l}"${l === lang ? ' aria-current="page"' : ''}>${LANG_NAMES[l]} <span>${l.toUpperCase()}</span></a></li>`).join('');
  return `<details class="xh-lang"><summary aria-label="Language"><span>${lang.toUpperCase()}</span></summary><ul>${items}</ul></details>`;
}
