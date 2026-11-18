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
// docs/chrome.js (menu, OS-aware Download, labels in the page's
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
  down: '<svg class="xh-down" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10.4 2.5h3.2v8.6h3.9L12 16.7l-5.5-5.6h3.9zM3.5 18.3h17v3.2h-17z"/></svg>',
  gh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z"/></svg>',
};

// Xenon's official channels: an icon row under the footer's brand, in this
// order. The home (docs/index.html) draws the same marks from its sprite and
// lists the same addresses in its Organization sameAs, held equal by
// server/test/site-social.test.mjs. Brand names read the same in every
// language, so the labels are not translated (as Discord and GitHub already).
export const SOCIAL = [
  { k: 'yt', label: 'YouTube', href: 'https://www.youtube.com/@xenon-app',
    d: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814ZM9.545 15.568V8.432L15.818 12l-6.273 3.568Z' },
  { k: 'ig', label: 'Instagram', href: 'https://www.instagram.com/xenon.app/', evenodd: true,
    d: 'M7.5 2h9A5.5 5.5 0 0 1 22 7.5v9a5.5 5.5 0 0 1-5.5 5.5h-9A5.5 5.5 0 0 1 2 16.5v-9A5.5 5.5 0 0 1 7.5 2Zm0 2A3.5 3.5 0 0 0 4 7.5v9A3.5 3.5 0 0 0 7.5 20h9a3.5 3.5 0 0 0 3.5-3.5v-9A3.5 3.5 0 0 0 16.5 4h-9ZM12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm5.25-3.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Z' },
  { k: 'tt', label: 'TikTok', href: 'https://www.tiktok.com/@xenon.app',
    d: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07Z' },
  { k: 'fb', label: 'Facebook', href: 'https://www.facebook.com/profile.php?id=61596514267824',
    d: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z' },
  { k: 'dc', label: 'Discord', href: 'https://discord.gg/MBVrw9kZyg' },
  { k: 'gh', label: 'GitHub', href: 'https://github.com/marcimastro98/Xenon' },
];
for (const s of SOCIAL) {
  if (s.d) ICON[s.k] = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor"${s.evenodd ? ' fill-rule="evenodd"' : ''} d="${s.d}"/></svg>`;
}
const socialRow = () => `<ul class="xf-social">${SOCIAL.map(({ k, label, href }) =>
  `<li><a href="${href}"${k === 'dc' ? ' data-discord' : ''} target="_blank" rel="noopener" aria-label="${label}">${ICON[k]}</a></li>`).join('')}</ul>`;

// The wordmark: Bit next to the name, drawn in the page so it takes the ink of the
// sheet it stands on (.mark-i in docs/site.css). Lowercase like the logo; the label
// gives readers "Xenon".
export const BIT_PATHS = '<path class="bb" d="M4 0h1v2H4zM1 2h6v1H1zM0 3h8v6H0zM1 9h6v1H1zM1 10h2v1H1zM5 10h2v1H5z"/><path class="bf" d="M2 4h1v2H2zM5 4h1v2H5zM2 7h1v1H2zM3 8h2v1H3zM5 7h1v1H5z"/>';
export const BRAND = `<a class="xh-brand" href="/" aria-label="Xenon"><svg class="mark-i" viewBox="0 0 8 11" shape-rendering="crispEdges" aria-hidden="true">${BIT_PATHS}</svg>xenon</a>`;

// Labels carry data-xl keys; docs/chrome.js swaps them into the page language.
// The same five on a phone and on the home (docs/index.html), held equal by
// server/test/site-menu.test.mjs. The fourth field marks a Beta place.
const NAV = [
  ['/demo/', 'demo', 'Demo'],
  ['/catalog/', 'catalog', 'Catalog'],
  ['/maker/', 'maker', 'Maker', true],
  ['/#support', 'supporters', 'Supporters'],
  ['/faq.html', 'help', 'Help'],
];

const navItem = ([href, k, label, beta]) => beta
  ? `<li><a href="${href}"><span data-xl="${k}">${label}</span><span class="xh-beta" data-xl="beta">Beta</span></a></li>`
  : `<li><a href="${href}" data-xl="${k}">${label}</a></li>`;

const LANG_BLOCK = `<div class="lang" id="lang">
        <button class="lang-btn" id="lang-btn" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Language"><span id="lang-cur">EN</span></button>
        <div class="lang-menu" id="lang-menu" role="listbox">
          <button type="button" data-lang="en" role="option" lang="en">English</button>
          <button type="button" data-lang="it" role="option" lang="it">Italiano</button>
          <button type="button" data-lang="es" role="option" lang="es">Español</button>
          <button type="button" data-lang="fr" role="option" lang="fr">Français</button>
          <button type="button" data-lang="ja" role="option" lang="ja">日本語</button>
          <button type="button" data-lang="ko" role="option" lang="ko">한국어</button>
          <button type="button" data-lang="zh" role="option" lang="zh">中文</button>
        </div>
      </div>`;

export function headerHtml({ lang = false, page = '' } = {}) {
  const items = NAV.map(navItem).join('');
  // No language menu: no line at all, so the page carries no blank indented line.
  const langHtml = page ? langMenu(page, 'en') : (lang ? LANG_BLOCK : '');
  return `<!-- xenon:header -->
<header class="xh" id="xh">
  <div class="xh-w">
    ${BRAND}
    <nav class="xh-nav" aria-label="Main"><ul>${items}</ul></nav>
    <div class="xh-end">
      <div class="xh-marks">
        <a class="xh-mk dc" href="https://discord.gg/MBVrw9kZyg" data-discord target="_blank" rel="noopener" aria-label="Discord">${ICON.dc}<span class="xh-n" data-count="dc"></span></a>
        <a class="xh-mk gh" href="https://github.com/marcimastro98/Xenon" target="_blank" rel="noopener" aria-label="GitHub">${ICON.gh}${ICON.down}<span class="xh-n xh-n-long" data-count="dl"></span></a>
      </div>${langHtml ? `\n      ${langHtml}` : ''}
      <a class="xh-dl" id="xh-dl" href="${DL}" data-track="download_click" data-track-location="nav" data-xl="download">Download</a>
      <button class="xh-menu" id="xh-menu" type="button" aria-expanded="false" aria-controls="xh-mnav"><span class="xh-bars" aria-hidden="true"></span><span class="xh-sr" data-xl="menu">Menu</span></button>
    </div>
  </div>
  <nav class="xh-mnav" id="xh-mnav" aria-label="Menu">
    <div class="xh-mtop">
      ${BRAND}
      <button class="xh-menu xh-mclose" id="xh-mclose" type="button"><span class="xh-bars" aria-hidden="true"></span><span class="xh-sr" data-xl="close">Close</span></button>
    </div>
    <ul class="xh-mlist">${items}</ul>
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

const BIT_LINE = "Bit lives in the Vitals widget and has opinions about your posture.";
const LEGAL_LINE = "Xenon is an independent project. Xeneon and iCUE are trademarks of CORSAIR. Every other name and logo belongs to its owner.";

export function footerHtml() {
  const col = (k, title, links) => `<div class="xf-col"><h2 data-xl="${k}">${title}</h2><ul>${links.map(([h, lk, t, ext]) =>
    `<li><a href="${h}"${lk ? ` data-xl="${lk}"` : ''}${ext ? ' target="_blank" rel="noopener"' : ''}>${t}</a></li>`).join('')}</ul></div>`;
  return `<!-- xenon:footer -->
<footer class="xf">
  <div class="xf-w">
    <div class="xf-brand">
      ${BRAND}
      <p data-xl="tag">Free widgets for your PC, on any screen. Windows, with macOS and Linux in beta.</p>
      <div class="xf-bit"><span data-xl="bit">${BIT_LINE}</span></div>
      ${socialRow()}
    </div>
    ${col('app', 'App', [['/download.html', 'f.download', 'Download'], ['/demo/', 'f.demo', 'Browser demo'], ['/catalog/', 'f.catalog', 'Catalog'], ['/maker/', 'f.maker', 'Xenon Maker'], ['/create/', 'f.create', 'Make widgets'], ['/releases.html', 'f.releases', 'Releases']])}
    ${col('guides', 'Guides', [['/xeneon-edge-widgets.html', 'f.edge', 'Xenon on the Xeneon Edge'], ['/tablet-dashboard.html', 'f.tablet', 'Tablet or phone as a dashboard'], ['/phone.html', 'f.phone', 'Pairing a phone'], ['/single-screen.html', 'f.onescreen', 'Xenon on one screen'], ['/fps-overlay.html', 'f.fps', 'FPS overlay'], ['/screen-recorder.html', 'f.recorder', 'Screen recorder'], ['/mac.html', 'f.mac', 'Xenon on a Mac'], ['/linux.html', 'f.linux', 'Xenon on Linux'], ['/widgets.html', 'f.widgets', 'Every widget'], ['/deck.html', 'f.deck', 'Deck keys'], ['/claude-code.html', 'f.claude', 'Claude Code on a touchscreen'], ['/codex.html', 'f.codex', 'OpenAI Codex on a touchscreen'], ['/sensor-panel.html', 'f.sensor', 'A sensor panel for your PC'], ['/compare.html', 'f.compare', 'Xenon and other tools'], ['/xenon-exe.html', 'f.exe', 'Is the installer safe?']])}
    ${col('project', 'Project', [['/#support', 'f.support', 'Supporters'], ['https://github.com/marcimastro98/Xenon', '', 'GitHub', true], ['https://discord.gg/MBVrw9kZyg', '', 'Discord', true], ['/faq.html', 'f.faq', 'Help and questions'], ['/privacy.html', 'f.privacy', 'Privacy']])}
    <div class="xf-col" data-theme-switch></div>
    <div class="xf-bottom"><span data-xl="legal">${LEGAL_LINE}</span></div>
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
  ['single-screen.html', 'f.onescreen'],
  ['fps-overlay.html', 'f.fps'],
  ['screen-recorder.html', 'f.recorder'],
  ['mac.html', 'f.mac'],
  ['linux.html', 'f.linux'],
  ['widgets.html', 'f.widgets'],
  ['deck.html', 'f.deck'],
  ['claude-code.html', 'f.claude'],
  ['codex.html', 'f.codex'],
  ['sensor-panel.html', 'f.sensor'],
  ['compare.html', 'f.compare'],
  ['xenon-exe.html', 'f.exe'],
];
// Pages with a breadcrumb that are not guides.
const CRUMB_ONLY = { '5.html': 'v5', 'download.html': 'f.download', 'faq.html': 'f.faq', 'pawnio.html': 'f.pawnio', 'privacy.html': 'f.privacy', 'releases.html': 'f.releases' };

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
  { file: 'docs/pawnio.html', lang: false },
  { file: 'docs/mac.html', lang: false },
  { file: 'docs/widgets.html', lang: false },
  { file: 'docs/deck.html', lang: false },
  { file: 'docs/claude-code.html', lang: false },
  { file: 'docs/codex.html', lang: false },
  { file: 'docs/single-screen.html', lang: false },
  { file: 'docs/fps-overlay.html', lang: false },
  { file: 'docs/screen-recorder.html', lang: false },
  { file: 'docs/5.html', lang: false },
  { file: 'docs/sensor-panel.html', lang: false },
  { file: 'docs/compare.html', lang: false },
  { file: 'docs/catalog/index.html', lang: true, oldHeader: /<nav class="top">[\s\S]*?<\/nav>\n/ },
  { file: 'docs/create/index.html', lang: false, oldHeader: /<header class="topbar">[\s\S]*?<\/header>\n/, footerBeforeBody: true },
  { file: 'docs/submit/index.html', lang: true, oldHeader: /<header class="top">[\s\S]*?<\/header>\n/, footerBeforeBody: true },
  { file: 'docs/submit/status/index.html', lang: false },
  { file: 'docs/get/index.html', lang: false },
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
