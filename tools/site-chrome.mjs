#!/usr/bin/env node
// The site's shared header and footer: one source for every page except the
// home (which carries its own copy of the same bar, with in-page anchors).
//
//   node tools/site-chrome.mjs          rewrite the chrome of every hand page
//   import { headerHtml, footerHtml }   used by tools/build-seo.mjs for the
//                                       generated catalog and creator pages
//
// The markup lives between <!-- xenon:header --> / <!-- /xenon:header --> and
// <!-- xenon:footer --> / <!-- /xenon:footer --> markers, so a rerun replaces
// exactly what it wrote. Styles are in docs/site.css (.xh / .xf), behaviour in
// docs/chrome.js (menu, OS-aware Download, star count, labels in the page's
// language). Node builtins only: CI has no npm install.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANG_PAGES, HOME_LANGS, langMenu, langsOf } from './lang-pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DL = 'https://github.com/marcimastro98/Xenon/releases/latest/download/Xenon-Setup-x64.exe';
const SITE = 'https://xenon-app.com';

const ICON = {
  cup: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2.4 6.2h13.4v7a5.5 5.5 0 0 1-5.5 5.5H7.9a5.5 5.5 0 0 1-5.5-5.5v-7Zm14 2.2h1.7a3.7 3.7 0 0 1 0 7.4h-1.9a7.4 7.4 0 0 0 .2-1.9V8.4Zm.3 2v3.4h1.4a1.7 1.7 0 0 0 0-3.4h-1.4ZM2 20.6h14.2v1.9H2v-1.9Z"/></svg>',
  dc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.1 14.1 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.1.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.029 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03ZM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z"/></svg>',
  gh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z"/></svg>',
};

// Labels carry data-xl keys; docs/chrome.js swaps them into the page language.
const NAV = [
  ['/#widgets', 'widgets', 'Widgets'],
  ['/demo/', 'demo', 'Demo'],
  ['/catalog/', 'catalog', 'Catalog'],
  ['/create/', 'create', 'Create'],
  ['/#support', 'support', 'Support'],
  ['/faq.html', 'help', 'Help'],
];

const LANG_BLOCK = `<div class="lang" id="lang">
        <button class="lang-btn" id="lang-btn" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Language"><span id="lang-cur">EN</span></button>
        <div class="lang-menu" id="lang-menu" role="listbox">
          <button type="button" data-lang="en" role="option" lang="en">English</button>
          <button type="button" data-lang="it" role="option" lang="it">Italiano</button>
          <button type="button" data-lang="es" role="option" lang="es">Español</button>
          <button type="button" data-lang="ja" role="option" lang="ja">日本語</button>
          <button type="button" data-lang="ko" role="option" lang="ko">한국어</button>
          <button type="button" data-lang="zh" role="option" lang="zh">中文</button>
        </div>
      </div>`;

export function headerHtml({ lang = false, page = '' } = {}) {
  const items = NAV.map(([href, k, label]) => `<li><a href="${href}" data-xl="${k}">${label}</a></li>`).join('');
  return `<!-- xenon:header -->
<header class="xh" id="xh">
  <div class="xh-w">
    <a class="xh-brand" href="/" aria-label="Xenon"><span class="xh-mark"><img src="/images/logo-x.png" alt="" width="170" height="134"></span>Xenon</a>
    <nav class="xh-nav" aria-label="Main"><ul>${items}</ul></nav>
    <div class="xh-end">
      <div class="xh-marks">
        <a class="xh-mk cup" href="https://www.buymeacoffee.com/marcimastro98" target="_blank" rel="noopener" data-track="coffee_click" data-track-location="nav">${ICON.cup}<span class="xh-sr" data-xl="coffee">Buy me a coffee</span></a>
        <a class="xh-mk dc" href="https://discord.gg/MBVrw9kZyg" data-discord target="_blank" rel="noopener" aria-label="Discord">${ICON.dc}</a>
        <a class="xh-mk gh" href="https://github.com/marcimastro98/Xenon" target="_blank" rel="noopener" aria-label="GitHub">${ICON.gh}<span class="xh-stars" hidden><span class="xh-star" aria-hidden="true">★</span><span class="n"></span></span></a>
      </div>
      ${page ? langMenu(page, 'en') : (lang ? LANG_BLOCK : '')}
      <a class="xh-dl" id="xh-dl" href="${DL}" data-track="download_click" data-track-location="nav" data-xl="download">Download</a>
      <button class="xh-menu" id="xh-menu" type="button" aria-expanded="false" aria-controls="xh-mnav"><span class="xh-bars" aria-hidden="true"></span><span class="xh-sr" data-xl="menu">Menu</span></button>
    </div>
  </div>
  <nav class="xh-mnav" id="xh-mnav" aria-label="Menu">
    <div class="xh-mtop">
      <a class="xh-brand" href="/" aria-label="Xenon"><span class="xh-mark"><img src="/images/logo-x.png" alt="" width="170" height="134"></span>Xenon</a>
      <button class="xh-menu xh-mclose" id="xh-mclose" type="button"><span class="xh-bars" aria-hidden="true"></span><span class="xh-sr" data-xl="close">Close</span></button>
    </div>
    <ul class="xh-mlist"><li><a href="/#screens" data-xl="screens">Screens</a></li>${items}</ul>
    <div class="xh-mfoot">
      <a class="xh-key" href="/#install" data-xl="install">Install</a>
      <ul class="xh-mlinks">
        <li><a href="https://www.buymeacoffee.com/marcimastro98" target="_blank" rel="noopener" data-track="coffee_click" data-track-location="nav_menu">${ICON.cup}<span data-xl="coffee">Buy me a coffee</span></a></li>
        <li><a href="https://discord.gg/MBVrw9kZyg" data-discord target="_blank" rel="noopener">${ICON.dc}<span>Discord</span></a></li>
        <li><a href="https://github.com/marcimastro98/Xenon" target="_blank" rel="noopener">${ICON.gh}<span>GitHub</span></a></li>
      </ul>
    </div>
  </nav>
</header>
<!-- /xenon:header -->`;
}

export function footerHtml() {
  const col = (k, title, links) => `<div class="xf-col"><h2 data-xl="${k}">${title}</h2><ul>${links.map(([h, lk, t, ext]) =>
    `<li><a href="${h}"${lk ? ` data-xl="${lk}"` : ''}${ext ? ' target="_blank" rel="noopener"' : ''}>${t}</a></li>`).join('')}</ul></div>`;
  return `<!-- xenon:footer -->
<footer class="xf">
  <div class="xf-w">
    <div class="xf-brand">
      <a class="xh-brand" href="/" aria-label="Xenon"><span class="xh-mark"><img src="/images/logo-x.png" alt="" width="170" height="134" loading="lazy"></span>Xenon</a>
      <p data-xl="tag">A free touch dashboard for the screens next to your PC. Windows, with macOS and Linux in beta.</p>
    </div>
    ${col('app', 'App', [['/download.html', 'f.download', 'Download'], ['/demo/', 'f.demo', 'Browser demo'], ['/catalog/', 'f.catalog', 'Catalog'], ['/create/', 'f.create', 'Make widgets'], ['/releases.html', 'f.releases', 'Releases']])}
    ${col('guides', 'Guides', [['/xeneon-edge-widgets.html', 'f.edge', 'Xenon on the Xeneon Edge'], ['/tablet-dashboard.html', 'f.tablet', 'Tablet or phone as a dashboard'], ['/phone.html', 'f.phone', 'Pairing a phone'], ['/mac.html', 'f.mac', 'Xenon on a Mac'], ['/linux.html', 'f.linux', 'Xenon on Linux'], ['/widgets.html', 'f.widgets', 'Every widget'], ['/deck.html', 'f.deck', 'Deck keys'], ['/claude-code.html', 'f.claude', 'Claude Code on a touchscreen'], ['/codex.html', 'f.codex', 'OpenAI Codex on a touchscreen'], ['/sensor-panel.html', 'f.sensor', 'A sensor panel for your PC'], ['/xenon-exe.html', 'f.exe', 'Is the installer safe?']])}
    ${col('project', 'Project', [['/#support', 'f.support', 'Supporters'], ['https://github.com/marcimastro98/Xenon', '', 'GitHub', true], ['https://discord.gg/MBVrw9kZyg', '', 'Discord', true], ['/faq.html', 'f.faq', 'Help and questions'], ['/privacy.html', 'f.privacy', 'Privacy']])}
    <div class="xf-col" data-theme-switch></div>
    <div class="xf-bottom"><span data-xl="legal">Xenon is an independent project. Xeneon and iCUE are trademarks of CORSAIR.</span></div>
  </div>
</footer>
<!-- /xenon:footer -->`;
}

// ── Guide navigation ───────────────────────────────────────────────────────
// Every guide opens with a breadcrumb and ends with the other guides, so no
// guide is reachable only from the footer. The list is in the order a visitor
// meets the screens; a guide joins it once its file exists, so a page can be
// listed here before it is written. Labels are the footer's (docs/chrome.js).
export const GUIDES = [
  ['xeneon-edge-widgets.html', 'f.edge'],
  ['tablet-dashboard.html', 'f.tablet'],
  ['phone.html', 'f.phone'],
  ['mac.html', 'f.mac'],
  ['linux.html', 'f.linux'],
  ['widgets.html', 'f.widgets'],
  ['deck.html', 'f.deck'],
  ['claude-code.html', 'f.claude'],
  ['codex.html', 'f.codex'],
  ['sensor-panel.html', 'f.sensor'],
  ['xenon-exe.html', 'f.exe'],
];
// Pages with a breadcrumb that are not guides.
const CRUMB_ONLY = { 'download.html': 'f.download', 'faq.html': 'f.faq', 'privacy.html': 'f.privacy', 'releases.html': 'f.releases' };

let labelCache = null;
export function chromeLabels() {
  if (labelCache) return labelCache;
  const src = fs.readFileSync(path.join(ROOT, 'docs', 'chrome.js'), 'utf8');
  const m = /var L = (\{[\s\S]*?\});\r?\n/.exec(src);
  labelCache = m ? JSON.parse(m[1]) : { en: {} };
  return labelCache;
}
const tl = (lang, key) => {
  const L = chromeLabels();
  return (L[lang] && L[lang][key]) || (L.en && L.en[key]) || key;
};
const escT = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const guideExists = (page) => fs.existsSync(path.join(ROOT, 'docs', page));

// The breadcrumb, with its BreadcrumbList. Links are root paths; the language
// builder points them at the copies. The JSON-LD carries the copy's own URLs.
export function crumbsHtml(page, lang = 'en') {
  const key = (GUIDES.find((g) => g[0] === page) || [])[1] || CRUMB_ONLY[page];
  if (!key) return '<!-- xenon:crumbs --><!-- /xenon:crumbs -->';
  const copy = lang !== 'en' && langsOf(page).includes(lang);
  const home = lang === 'en' || !HOME_LANGS.includes(lang) ? '/' : '/' + lang + '/';
  const self = copy ? '/' + lang + '/' + page : '/' + page;
  const ld = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Xenon', item: SITE + home },
      { '@type': 'ListItem', position: 2, name: tl(lang, key), item: SITE + self },
    ],
  };
  return `<!-- xenon:crumbs --><nav class="xc" aria-label="${escT(tl(lang, 'crumbs'))}"><ol><li><a href="/" data-xl="home">${escT(tl(lang, 'home'))}</a></li><li><a href="/${page}" aria-current="page" data-xl="${key}">${escT(tl(lang, key))}</a></li></ol></nav><script type="application/ld+json">${JSON.stringify(ld)}</script><!-- /xenon:crumbs -->`;
}

// The other guides, at the end of a guide. Non-guides get an empty block.
export function guidesHtml(page, lang = 'en') {
  if (!GUIDES.some((g) => g[0] === page)) return '<!-- xenon:guides --><!-- /xenon:guides -->';
  const items = GUIDES.filter(([p]) => p !== page && guideExists(p))
    .map(([p, key]) => `<li><a href="/${p}" data-xl="${key}">${escT(tl(lang, key))}</a></li>`).join('');
  return `<!-- xenon:guides --><nav class="xg" aria-labelledby="xg-h"><h2 id="xg-h" data-xl="more">${escT(tl(lang, 'more'))}</h2><ul>${items}</ul><p class="xg-dl"><a href="/download.html" data-xl="f.download">${escT(tl(lang, 'f.download'))}</a></p></nav><!-- /xenon:guides -->`;
}

export function fillGuideNav(s, page, lang = 'en') {
  s = s.replace(/<!-- xenon:crumbs -->[\s\S]*?<!-- \/xenon:crumbs -->/, () => crumbsHtml(page, lang));
  return s.replace(/<!-- xenon:guides -->[\s\S]*?<!-- \/xenon:guides -->/, () => guidesHtml(page, lang));
}

// ── Rewriting the hand pages ───────────────────────────────────────────────
// First run: the old header/footer are found by the shape each page had.
// Every run after that: by the markers.
const PAGES = [
  { file: 'docs/404.html', lang: false },
  { file: 'docs/download.html', lang: false },
  { file: 'docs/thanks.html', lang: true },
  { file: 'docs/faq.html', lang: false },
  { file: 'docs/phone.html', lang: false },
  { file: 'docs/privacy.html', lang: false },
  { file: 'docs/linux.html', lang: false },
  { file: 'docs/tablet-dashboard.html', lang: false },
  { file: 'docs/xeneon-edge-widgets.html', lang: false },
  { file: 'docs/xenon-exe.html', lang: false },
  { file: 'docs/mac.html', lang: false },
  { file: 'docs/widgets.html', lang: false },
  { file: 'docs/deck.html', lang: false },
  { file: 'docs/claude-code.html', lang: false },
  { file: 'docs/codex.html', lang: false },
  { file: 'docs/sensor-panel.html', lang: false },
  { file: 'docs/catalog/index.html', lang: true, oldHeader: /<nav class="top">[\s\S]*?<\/nav>\n/ },
  { file: 'docs/create/index.html', lang: false, oldHeader: /<header class="topbar">[\s\S]*?<\/header>\n/, footerBeforeBody: true },
  { file: 'docs/submit/index.html', lang: true, oldHeader: /<header class="top">[\s\S]*?<\/header>\n/, footerBeforeBody: true },
];

function rewrite({ file, lang, oldHeader, noFooter, footerBeforeBody }) {
  const abs = path.join(ROOT, file);
  let s = fs.readFileSync(abs, 'utf8');
  const nl = s.includes('\r\n') ? '\r\n' : '\n';
  s = s.replace(/\r\n/g, '\n');
  const page = path.basename(file);
  const head = headerHtml({ lang, page: file.split('/').length === 2 && LANG_PAGES.some((p) => p.page === page) ? page : '' });
  const foot = footerHtml();

  if (s.includes('<!-- xenon:header -->')) {
    s = s.replace(/<!-- xenon:header -->[\s\S]*?<!-- \/xenon:header -->/, head);
  } else {
    const re = oldHeader || /<header class="top">[\s\S]*?<\/header>\n/;
    if (!re.test(s)) throw new Error(`${file}: no header found`);
    s = s.replace(re, head + '\n');
  }
  if (!noFooter) {
    if (s.includes('<!-- xenon:footer -->')) {
      s = s.replace(/<!-- xenon:footer -->[\s\S]*?<!-- \/xenon:footer -->/, foot);
    } else if (footerBeforeBody) {
      s = s.replace(/<\/body>/, foot + '\n</body>');
    } else {
      const i = s.lastIndexOf('</main>');
      const m = /<footer\b[^>]*>[\s\S]*?<\/footer>\n?/.exec(s.slice(i));
      if (!m) throw new Error(`${file}: no footer after </main>`);
      s = s.slice(0, i) + s.slice(i).replace(m[0], foot + '\n');
    }
  }
  s = fillGuideNav(s, page);
  if (!s.includes('src="/chrome.js"')) {
    s = s.replace('</head>', '<script src="/chrome.js" defer></script>\n</head>');
  }
  fs.writeFileSync(abs, nl === '\r\n' ? s.replace(/\n/g, '\r\n') : s);
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const only = process.argv.slice(2);
  for (const p of PAGES) if (!only.length || only.includes(path.basename(p.file)) || only.includes(p.file)) console.log('chrome:', rewrite(p));
}
