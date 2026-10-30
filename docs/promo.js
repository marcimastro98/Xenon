// The month's drops on the Xenon site (xenon-app.com), in two places:
//   strip      a band above the header, on every page, until the visitor closes it
//   panel      a card at the bottom right (computer) or along the bottom edge (phone), on every
//              page once half of it has been read, once per drop. Never a modal and never on
//              arrival: see the Panel section for the reasons. The hub's formats "spotlight" and
//              "corner" both draw this panel; when both are set, spotlight wins.
//
// What to show is decided in the supporter hub (admin, "Site banners") and published as
// /community/site-promo.json. Everything a banner says about the pack itself (its name, whether it
// is for supporters, when it ends) is read from /community/catalog.json, so a banner can never
// promise something the catalog does not say.
//
// The look: a banner is a piece of the pack laid in the site's grey room. The site has no colour
// of its own, so each banner carries the pack's own PAPER and INK (the hub row's `look`, taken by
// the launch kit from the pack's art direction and the loop's first frame). What pulls the eye is
// the product, large and moving. Deliberately absent, because each reads as template output:
// kickers above the name, chips, icons beside words, glows, gradients, bounce, rounded surfaces.
//
// House rules, each one there for a reason:
//   - Urgency comes from data only. "N days left" appears when the ENTRY really ends within 14
//     days, never otherwise (fake countdowns are what the Dutch regulator fined Epic for in 2024).
//   - The language is the PAGE's (<html lang>), never the browser's: an English page is English.
//   - Nothing overlays the page before the cookie choice is made, and nothing opens over another
//     dialog, a lightbox or a deep link.
//   - A moving loop has a pause (WCAG 2.2.2): the picture itself is the button.
//   - Every string from the feed goes through textContent.
//
// Self-contained like consent.js and theme.js: its own CSS (prefix xp-), its own strings in the
// site's seven languages, only site.css tokens. The pure half is exported for node (server/test).
(function () {
  'use strict';

  // ── The pure core ─────────────────────────────────────────────────────────────
  const LANGS = ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh'];
  const FORMATS = ['spotlight', 'strip', 'corner'];
  const ALIASES = { card: 'corner' };     // the 26 Sep feed called the corner card "card"
  const ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
  const HEX_RE = /^#[0-9a-f]{6}$/i;
  // The catalog's own ISO_DATE_RE (server/community-catalog.js): a date or a datetime.
  const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  const MEDIA_HOST = 'assets.xenon-app.com';
  const MEDIA_PATH = '/community/promo/';
  // Mirrors LINK_HOSTS in the hub's site-promo-admin.js (the publisher); a promo naming any other
  // host is dropped here, so a hand-edited feed cannot send visitors off-site.
  const LINK_HOSTS = ['xenon-app.com', 'www.xenon-app.com', 'github.com', 'www.github.com', 'discord.gg', 'discord.com', 'www.discord.com'];
  const CAP = { title: 60, line: 180, cta: 32 };
  const SOON_DAYS = 14;
  // The loop is rendered at 16:7 (launch-kit.mjs --only banner), which the slice maths relies on.
  const FRAME = 7 / 16;
  // A neutral sheet for a row that carries no look of its own.
  const FALLBACK_LOOK = { paper: '#EEEFEC', ink: '#151716' };

  const KIND = {
    en: { widget: 'A widget', theme: 'A theme', bg: 'A background', ambient: 'An Ambient scene', bundle: 'A pack', deck: 'A Deck profile' },
    fr: { widget: 'Un widget', theme: 'Un thème', bg: 'Un arrière-plan', ambient: 'Une scène Ambiant', bundle: 'Un pack', deck: 'Un profil de Deck' },
    it: { widget: 'Un widget', theme: 'Un tema', bg: 'Uno sfondo', ambient: 'Una scena Ambient', bundle: 'Un pacchetto', deck: 'Un profilo Deck' },
    es: { widget: 'Un widget', theme: 'Un tema', bg: 'Un fondo', ambient: 'Una escena Ambient', bundle: 'Un paquete', deck: 'Un perfil de Deck' },
    ja: { widget: 'ウィジェット', theme: 'テーマ', bg: '背景', ambient: 'アンビエントシーン', bundle: 'パック', deck: 'Deckプロファイル' },
    ko: { widget: '위젯', theme: '테마', bg: '배경', ambient: '앰비언트 장면', bundle: '팩', deck: 'Deck 프로필' },
    zh: { widget: '小组件', theme: '主题', bg: '背景', ambient: '环境场景', bundle: '合集', deck: 'Deck 配置' },
  };
  const STR = {
    en: { supK: '{k} for Xenon supporters.', freeK: '{k}, free in the Xenon catalog.', sup: 'For Xenon supporters.', free: 'Free in the Xenon catalog.', unlock: 'Unlock', get: 'Get it', see: 'See {name}', close: 'Close', pause: 'Pause the loop', play: 'Play the loop', until: 'Available until {d}.', left: '{n} days left.', last: 'Last day.', preview: 'Preview, not published' },
    fr: { supK: '{k} pour les supporters de Xenon.', freeK: '{k}, gratuit dans le catalogue Xenon.', sup: 'Pour les supporters de Xenon.', free: 'Gratuit dans le catalogue Xenon.', unlock: 'Déverrouiller', get: 'Obtenez-le', see: 'Voir {name}', close: 'Fermer', pause: 'Mettre la boucle en pause', play: 'Lire la boucle', until: 'Disponible jusqu\'au {d}.', left: '{n} jours restants.', last: 'Dernier jour.', preview: 'Aperçu, non publié' },
    it: { supK: '{k} per chi sostiene Xenon.', freeK: '{k} gratis nel catalogo Xenon.', sup: 'Per chi sostiene Xenon.', free: 'Gratis nel catalogo Xenon.', unlock: 'Sblocca', get: 'Prendilo', see: 'Vedi {name}', close: 'Chiudi', pause: 'Metti in pausa', play: 'Riproduci', until: 'Disponibile fino al {d}.', left: 'Ancora {n} giorni.', last: 'Ultimo giorno.', preview: 'Anteprima, non pubblicato' },
    es: { supK: '{k} para quienes apoyan Xenon.', freeK: '{k} gratis en el catálogo de Xenon.', sup: 'Para quienes apoyan Xenon.', free: 'Gratis en el catálogo de Xenon.', unlock: 'Desbloquear', get: 'Conseguir', see: 'Ver {name}', close: 'Cerrar', pause: 'Pausar', play: 'Reproducir', until: 'Disponible hasta el {d}.', left: 'Quedan {n} días.', last: 'Último día.', preview: 'Vista previa, sin publicar' },
    ja: { supK: 'Xenonサポーター向けの{k}。', freeK: 'Xenonカタログの無料の{k}。', sup: 'Xenonサポーター向け。', free: 'Xenonカタログで無料。', unlock: '解除する', get: '入手', see: '{name}を見る', close: '閉じる', pause: '一時停止', play: '再生', until: '{d}まで。', left: '残り{n}日。', last: '最終日。', preview: 'プレビュー（未公開）' },
    ko: { supK: 'Xenon 서포터를 위한 {k}.', freeK: 'Xenon 카탈로그의 무료 {k}.', sup: 'Xenon 서포터 전용.', free: 'Xenon 카탈로그에서 무료.', unlock: '잠금 해제', get: '받기', see: '{name} 보기', close: '닫기', pause: '일시정지', play: '재생', until: '{d}까지.', left: '{n}일 남음.', last: '마지막 날.', preview: '미리보기, 게시되지 않음' },
    zh: { supK: '为 Xenon 支持者准备的{k}。', freeK: 'Xenon 目录中的免费{k}。', sup: '为 Xenon 支持者准备。', free: 'Xenon 目录中免费。', unlock: '解锁', get: '获取', see: '查看 {name}', close: '关闭', pause: '暂停', play: '播放', until: '到 {d} 为止。', left: '还剩 {n} 天。', last: '最后一天。', preview: '预览，未发布' },
  };
  const tr = (l, k) => { const d = STR[l] || STR.en; return d[k] != null ? d[k] : STR.en[k]; };

  // Capped by code point, so a cut never leaves half an emoji behind.
  const str = (v, max) => Array.from(typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '').slice(0, max).join('');
  const isDate = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
  const isIso = (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));
  const frac = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

  function httpsUrl(v, hosts) {
    if (typeof v !== 'string' || !v) return null;
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' || u.username || u.password) return null;
      return hosts.indexOf(u.hostname) === -1 ? null : u;
    } catch (e) { return null; }
  }
  function mediaUrl(v, ext) {
    const u = httpsUrl(v, [MEDIA_HOST]);
    return u && u.pathname.indexOf(MEDIA_PATH) === 0 && ext.test(u.pathname) ? u.toString() : null;
  }

  function lum(hex) {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  // One promo from the feed, rebuilt from known keys only. Returns null when anything present is
  // malformed: a promo is shown whole or not at all. Two optional parts degrade instead, because
  // they are dress rather than content: a look that does not read (under 4.5:1) becomes the
  // neutral sheet, and a slice outside the frame is ignored.
  function validatePromo(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = typeof raw.id === 'string' ? raw.id : '';
    const entryId = typeof raw.entryId === 'string' ? raw.entryId : '';
    if (!ID_RE.test(id) || !ID_RE.test(entryId)) return null;
    const format = ALIASES[raw.format] || raw.format;
    if (FORMATS.indexOf(format) === -1) return null;
    const out = { id, entryId, format, text: {} };
    for (const k of ['activeFrom', 'activeUntil']) {
      if (raw[k] == null || raw[k] === '') continue;
      if (!isIso(raw[k])) return null;
      out[k] = raw[k];
    }
    if (out.activeFrom && out.activeUntil && Date.parse(out.activeFrom) > Date.parse(out.activeUntil)) return null;
    if (raw.video != null && raw.video !== '') {
      out.video = mediaUrl(raw.video, /\.(mp4|webm)$/i);
      if (!out.video) return null;
    }
    if (raw.poster != null && raw.poster !== '') {
      out.poster = mediaUrl(raw.poster, /\.(png|webp|jpe?g)$/i);
      if (!out.poster) return null;
    }
    if (raw.url != null && raw.url !== '') {
      const u = httpsUrl(raw.url, LINK_HOSTS);
      if (!u) return null;
      out.url = u.toString();
    }
    const lk = raw.look && typeof raw.look === 'object' ? raw.look : null;
    if (lk && HEX_RE.test(lk.paper || '') && HEX_RE.test(lk.ink || '') && contrast(lk.paper, lk.ink) >= 4.5) {
      out.look = { paper: lk.paper, ink: lk.ink };
    }
    const sl = raw.slice && typeof raw.slice === 'object' ? raw.slice : null;
    if (sl && frac(sl.x) && frac(sl.y) && frac(sl.w) && sl.w >= 0.05 && sl.x + sl.w <= 1) {
      out.slice = { x: sl.x, y: sl.y, w: sl.w };
    }
    const text = raw.text && typeof raw.text === 'object' ? raw.text : {};
    for (const l of LANGS) {
      const t = text[l];
      if (!t || typeof t !== 'object') continue;
      const one = { title: str(t.title, CAP.title), line: str(t.line, CAP.line), cta: str(t.cta, CAP.cta) };
      if (one.title || one.line || one.cta) out.text[l] = one;
    }
    // English is the fallback for every other language, so it must say something.
    if (!out.text.en || !out.text.en.line) return null;
    return out;
  }

  function normalizeFeed(json) {
    const list = json && Array.isArray(json.promos) ? json.promos : [];
    return list.slice(0, 24).map(validatePromo).filter(Boolean);
  }

  function isLive(p, now) {
    if (p.activeFrom && now < Date.parse(p.activeFrom)) return false;
    if (p.activeUntil && now > Date.parse(p.activeUntil)) return false;
    return true;
  }

  // The catalog entry, with the catalog's own meaning (visible() there, isEntryVisible() in the
  // app): `active` is a hard override, otherwise the date window decides.
  function entryOpen(e, now) {
    if (!e || e.active === false) return false;
    if (e.active === true) return true;
    if (e.activeFrom && isDate(e.activeFrom) && now < Date.parse(e.activeFrom)) return false;
    if (e.activeUntil && isDate(e.activeUntil) && now > Date.parse(e.activeUntil)) return false;
    return true;
  }

  const startOf = (p) => (p.activeFrom ? Date.parse(p.activeFrom) : -Infinity);

  // The newest supporter pack open now (limited editions are sold apart, so they are left out).
  // The thanks page shows it instead of a fixed screenshot, so its picture is never out of date.
  function newestDrop(entries, now) {
    let best = null;
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || !e.supportersOnly || e.limited || !ID_RE.test(String(e.id || '')) || !entryOpen(e, now)) continue;
      if (!best || String(e.addedAt || '') > String(best.addedAt || '')) best = e;
    }
    return best;
  }
  const dropShot = (id) => 'https://' + MEDIA_HOST + '/community/shots/' + encodeURIComponent(id) + '.webp';

  // What each place shows now: one live promo per format whose entry is in the catalog and open.
  // The hub refuses two live in the same place; should a hand-edited feed carry them anyway, the
  // one that started last wins, then the id, so the choice is stable. A promo whose entry is
  // missing or closed is skipped rather than shown with half its facts.
  function pickPerFormat(promos, entries, now) {
    const byId = new Map();
    (Array.isArray(entries) ? entries : []).forEach((e) => { if (e && typeof e === 'object' && ID_RE.test(String(e.id || ''))) byId.set(e.id, e); });
    const out = { spotlight: null, strip: null, corner: null };
    (Array.isArray(promos) ? promos : [])
      .filter((p) => p && isLive(p, now) && entryOpen(byId.get(p.entryId), now))
      .sort((a, b) => (startOf(b) - startOf(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .forEach((p) => { if (!out[p.format]) out[p.format] = { promo: p, entry: byId.get(p.entryId) }; });
    return out;
  }

  // When the pack really stops being available: the entry's activeUntil, if it is still ahead.
  // `active: true` resurfaces an entry past its dates, so its date ends nothing.
  function endOf(entry, now) {
    if (!entry || entry.active === true || !isDate(entry.activeUntil)) return null;
    const t = Date.parse(entry.activeUntil);
    return t > now ? t : null;
  }

  // Whole days left, only inside the last SOON_DAYS; null otherwise (no countdown without a real end).
  function daysLeft(end, now) {
    if (end == null || !Number.isFinite(end)) return null;
    const ms = end - now;
    if (ms <= 0 || ms > SOON_DAYS * 86400000) return null;
    return Math.max(1, Math.ceil(ms / 86400000));
  }

  const lookOf = (p) => (p && p.look) || { ...FALLBACK_LOOK };

  // The slice of the loop the strip shows, as CSS for the <video>: the loop is sized so that
  // `w` of its width fills the box, shifted left by `x`, and its line `y` sits on the box's centre.
  // Margins in % resolve against the box's WIDTH, which is what makes the vertical shift exact.
  function sliceCss(s) {
    if (!s) return null;
    const pct = (v) => (Math.round(v * 100) / 100) + '%';
    return { width: pct(100 / s.w), left: pct(-100 * s.x / s.w), marginTop: pct(-100 * s.y * FRAME / s.w) };
  }

  function textFor(p, lang) {
    const own = p.text[lang] || {};
    const en = p.text.en || {};
    return { title: own.title || en.title || '', line: own.line || en.line || '', cta: own.cta || en.cta || '' };
  }

  // Everything a banner says, in one language, at one instant. Plain strings only.
  function describe(p, entry, lang, now) {
    const tx = textFor(p, lang);
    const name = tx.title || str(entry && entry.name, CAP.title) || p.entryId;
    const sup = !!entry && (entry.locked === true || entry.supportersOnly === true);
    const kind = (entry && (KIND[lang] || KIND.en)[entry.kind]) || '';
    const what = kind ? tr(lang, sup ? 'supK' : 'freeK').replace('{k}', kind) : tr(lang, sup ? 'sup' : 'free');
    const end = endOf(entry, now);
    const days = daysLeft(end, now);
    let when = '';
    if (days === 1) when = tr(lang, 'last');
    else if (days) when = tr(lang, 'left').replace('{n}', String(days));
    else if (end != null) {
      // UTC on purpose: activeUntil is authored as an end-of-day stamp, and a local render turns
      // "31 July" into "1 August" east of Greenwich, a date nobody wrote.
      try { when = tr(lang, 'until').replace('{d}', new Date(end).toLocaleDateString(lang, { day: 'numeric', month: 'long', timeZone: 'UTC' })); } catch (e) { when = ''; }
    }
    return {
      name,
      what: when ? what + ' ' + when : what,
      soon: !!days,
      line: tx.line,
      cta: tx.cta || tr(lang, 'see').replace('{name}', name),
      go: tr(lang, sup ? 'unlock' : 'get'),
      href: p.url || '/catalog/#' + p.entryId,
      external: !!p.url && !/^https:\/\/(www\.)?xenon-app\.com\//.test(p.url),
      video: p.video || '',
      poster: p.poster || '',
    };
  }

  // Which language a page is in: the page's own word first (the home sets XLANG and <html lang>,
  // the copies inject __XENON_SITE_LANG, every page carries lang), then what the visitor last
  // picked, then the browser. The browser comes last on purpose: an English page is English.
  function pageLang(sources) {
    for (const s of sources) {
      const l = String(s || '').slice(0, 2).toLowerCase();
      if (LANGS.indexOf(l) !== -1) return l;
    }
    return 'en';
  }

  const core = { LANGS, FORMATS, CAP, LINK_HOSTS, MEDIA_HOST, SOON_DAYS, STR, KIND, FALLBACK_LOOK, validatePromo, normalizeFeed, isLive, entryOpen, pickPerFormat, endOf, daysLeft, contrast, lookOf, sliceCss, textFor, describe, pageLang, newestDrop, dropShot };
  if (typeof module === 'object' && module.exports) { module.exports = core; return; }
  if (typeof document === 'undefined') return;
  window.XenonPromo = core;

  // ── The page half ─────────────────────────────────────────────────────────────
  const HUB_ORIGIN = 'https://xenon-supporter-hub.xenonedge.workers.dev';
  const DISMISS_KEY = 'xenon.site.promo.v1';      // { "strip:<promo id>": ts, "panel:<entry id>": ts }
  const CONSENT_KEY = 'xenon.site.consent';

  let PREVIEW = false;
  let PREVIEW_LANG = null;
  function lang() {
    let stored = null;
    try { stored = localStorage.getItem('xenon.site.lang'); } catch (e) { /* private mode */ }
    const nav = window.navigator || {};
    return pageLang([PREVIEW_LANG, window.XLANG, document.documentElement && document.documentElement.lang, window.__XENON_SITE_LANG, stored].concat(nav.languages || [nav.language]));
  }
  const mq = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
  const desktop = () => mq('(min-width: 900px) and (pointer: fine)');
  const reduced = () => mq('(prefers-reduced-motion: reduce)');

  function readJson(store, key) {
    try { const v = JSON.parse(store.getItem(key) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; }
  }
  function dismissed(format, id) { return !PREVIEW && Object.prototype.hasOwnProperty.call(readJson(localStorage, DISMISS_KEY), format + ':' + id); }
  function dismiss(format, id) {
    if (PREVIEW) return;
    try {
      const all = readJson(localStorage, DISMISS_KEY);
      all[format + ':' + id] = Date.now();
      const keys = Object.keys(all).sort((a, b) => all[b] - all[a]).slice(0, 40);
      localStorage.setItem(DISMISS_KEY, JSON.stringify(Object.fromEntries(keys.map((k) => [k, all[k]]))));
    } catch (e) { /* private mode: it comes back next visit, which is fine */ }
  }
  function consentDecided() { try { return !!localStorage.getItem(CONSENT_KEY); } catch (e) { return true; } }
  function whenConsented(fn) {
    if (PREVIEW || consentDecided()) { fn(); return; }
    document.addEventListener('xenon:consent', function once() { document.removeEventListener('xenon:consent', once); fn(); });
  }
  // Something the visitor asked for is on screen: a deep link, an open dialog, the lightbox.
  function screenBusy() {
    if (location.hash && location.hash.length > 1) return true;
    return !!document.querySelector('dialog[open], #xc-consent:not([hidden]), .lb.open, [data-lightbox].open');
  }

  const STYLE = [
    '.xp{--paper:#EEEFEC;--ink:#151716;--xp-d:var(--f-display,var(--display));--xp-t:var(--f-text,var(--sans));background:var(--paper);color:var(--ink);font-family:var(--xp-t);-webkit-font-smoothing:antialiased;box-sizing:border-box}',
    '.xp *{box-sizing:border-box}',
    '.xp-name{margin:0;font-family:var(--xp-d);font-weight:800;line-height:.95;letter-spacing:-.01em;color:var(--ink);overflow-wrap:anywhere}',
    '.xp-line{margin:0;font-weight:400;line-height:1.4;color:var(--ink)}',
    '.xp-what{margin:0;font:500 14px/1.4 var(--xp-t);color:var(--ink);opacity:.74}',
    '.xp-what.soon{opacity:1;font-weight:700}',
    '.xp-go{display:inline-flex;align-items:center;justify-content:center;background:var(--ink);color:var(--paper);text-decoration:none;font:700 17px/1 var(--xp-t);padding:17px 24px;border-radius:6px;white-space:nowrap}',
    '.xp-go:hover{text-decoration:underline;text-underline-offset:3px}',
    '.xp-go:active{transform:translateY(1px)}',
    '.xp a:focus-visible,.xp button:focus-visible{outline:3px solid var(--ink);outline-offset:3px}',
    '.xp-x{border:0;background:none;color:var(--ink);cursor:pointer;font:300 26px/1 var(--xp-t);width:44px;height:44px;display:grid;place-items:center;flex:0 0 auto}',
    '.xp-media{position:relative;display:block;width:100%;overflow:hidden;background:var(--paper);border:0;padding:0;margin:0;cursor:pointer}',
    '.xp-media video,.xp-media img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}',
    // Panel: one straight move in from the edge it sits on, nothing else moving.
    '.xp-panel{transform:translateY(calc(100% + 40px));visibility:hidden}',
    '.xp-panel.in{transform:none;visibility:visible;transition:transform .22s cubic-bezier(.3,0,.2,1)}',
    '@media (prefers-reduced-motion: reduce){.xp-panel.in{transition:none}}',
    // Panel, phone: along the bottom edge, not modal, about a third of the screen at most.
    '.xp-drawer{position:fixed;left:0;right:0;bottom:0;z-index:90;border-top:1px solid var(--ink);padding-bottom:env(safe-area-inset-bottom)}',
    // The loop never takes more than a seventh of the height, and a short phone (an iPhone SE is
    // 667px) gets the words alone: the panel stays about a third of the screen at most.
    '.xp-drawer .xp-media{aspect-ratio:16/5.4;max-height:14vh;border-bottom:1px solid var(--ink)}',
    '@media (max-height:700px){.xp-drawer .xp-media{display:none}}',
    '.xp-drawer .xp-media video,.xp-drawer .xp-media img{object-position:50% 0}',
    '.xp-drawer .xp-body{padding:8px 16px 14px}',
    '.xp-drawer .xp-top{display:flex;align-items:flex-start;gap:8px;margin-right:-8px}',
    '.xp-drawer .xp-name{font-size:25px;flex:1 1 auto;min-width:0;padding-top:8px}',
    '.xp-drawer .xp-line{font-size:15px;line-height:1.35;margin-top:2px}',
    '.xp-drawer .xp-row{display:flex;align-items:center;gap:12px;margin-top:10px}',
    '.xp-drawer .xp-what{flex:1 1 auto;min-width:0}',
    '.xp-drawer .xp-go{padding:13px 18px;font-size:16px}',
    // Strip: the pack's paper as a band above the header; on a wide screen a thin live slice of
    // the product runs through it. The header below it moves down by its height.
    '.xp-strip{position:sticky;top:0;z-index:31;height:44px;border-bottom:1px solid var(--ink)}',
    '.xp-strip .xp-in{position:relative;max-width:1440px;margin:0 auto;height:100%;display:flex;align-items:center;gap:18px;padding:0 52px 0 var(--pad,24px)}',
    '.xp-strip .xp-id{display:flex;min-width:0}',
    '.xp-strip .xp-id .xp-what{display:none}',
    '.xp-strip .xp-name{font-size:19px;white-space:nowrap}',
    '.xp-strip .xp-media{width:240px;height:100%;flex:0 0 auto;border-left:1px solid var(--ink);border-right:1px solid var(--ink)}',
    '.xp-strip .xp-media video,.xp-strip .xp-media img{inset:auto;top:50%;height:auto;object-fit:fill}',
    '.xp-strip .xp-line{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1 1 auto}',
    '.xp-strip .xp-cta{color:var(--ink);font:700 15px/1 var(--xp-t);text-decoration:underline;text-underline-offset:4px;text-decoration-thickness:2px;white-space:nowrap}',
    '.xp-strip .xp-x{position:absolute;top:0;right:4px;font-size:22px}',
    '@media (max-width:899px){.xp-strip{height:52px}.xp-strip .xp-in{gap:12px;padding-right:48px}.xp-strip .xp-line,.xp-strip .xp-media{display:none}.xp-strip .xp-id{flex:1 1 auto;display:grid;gap:3px}.xp-strip .xp-name{font-size:17px;overflow:hidden;text-overflow:ellipsis}.xp-strip .xp-id .xp-what{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.xp-strip .xp-x{top:4px}}',
    // Panel, computer: a card of the same paper in the bottom corner, over the margin, not the text.
    '.xp-corner{position:fixed;right:24px;bottom:24px;z-index:85;width:340px;border:1px solid var(--ink)}',
    '.xp-corner .xp-media{aspect-ratio:16/7;border-bottom:1px solid var(--ink)}',
    '.xp-corner .xp-body{position:relative;padding:18px 18px 20px}',
    '.xp-corner .xp-name{font-size:34px;padding-right:32px}',
    '.xp-corner .xp-line{font-size:15.5px;margin-top:8px}',
    '.xp-corner .xp-what{margin-top:8px}',
    '.xp-corner .xp-go{width:100%;margin-top:16px}',
    '.xp-corner .xp-x{position:absolute;top:8px;right:4px}',
    '.xp-mark{position:absolute;left:0;top:0;padding:6px 8px;background:var(--ink);color:var(--paper);font:600 12px/1 var(--xp-t)}',
  ].join('');

  function css() {
    if (document.getElementById('xp-promo-style')) return;
    const s = document.createElement('style');
    s.id = 'xp-promo-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  function dress(node, p) {
    const lk = lookOf(p);
    node.style.setProperty('--paper', lk.paper);
    node.style.setProperty('--ink', lk.ink);
    return node;
  }
  function track(a, format, id) {
    a.setAttribute('data-track', 'promo_click');
    a.setAttribute('data-track-format', format);
    a.setAttribute('data-track-id', id);
    return a;
  }
  function link(f, cls, label, format, id) {
    const a = el('a', cls, label);
    a.href = f.href;
    if (f.external) { a.target = '_blank'; a.rel = 'noopener'; }
    return track(a, format, id);
  }
  function closer(cls, l, fn) {
    const b = el('button', 'xp-x ' + cls, '×');
    b.type = 'button';
    b.setAttribute('aria-label', tr(l, 'close'));
    b.addEventListener('click', fn);
    return b;
  }

  // The picture. The loop when there is one and the visitor has not asked for less motion, the
  // still otherwise. The picture itself is the pause button, and the loop only runs while seen.
  let observers = [];
  function media(f, l, slice) {
    const box = el('button', 'xp-media');
    box.type = 'button';
    const still = () => {
      if (!f.poster) return;
      const img = el('img');
      img.alt = '';
      img.decoding = 'async';
      img.src = f.poster;
      if (slice) Object.assign(img.style, slice);
      box.appendChild(img);
    };
    if (!f.video || reduced()) { still(); box.disabled = true; box.style.cursor = 'default'; return box; }
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'metadata';
    v.setAttribute('muted', ''); v.setAttribute('loop', ''); v.setAttribute('playsinline', ''); v.setAttribute('aria-hidden', 'true');
    if (f.poster) v.poster = f.poster;
    v.src = f.video;
    if (slice) Object.assign(v.style, slice);
    let held = false;
    let inView = !('IntersectionObserver' in window);
    const sync = () => {
      box.setAttribute('aria-label', tr(l, held ? 'play' : 'pause'));
      if (inView && !held) { const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); } else v.pause();
    };
    box.addEventListener('click', () => { held = !held; sync(); });
    v.addEventListener('error', () => { v.remove(); still(); box.disabled = true; }, { once: true });
    box.appendChild(v);
    if (!inView) {
      const io = new IntersectionObserver((es) => { inView = es[es.length - 1].isIntersecting; sync(); }, { threshold: 0.2 });
      io.observe(box);
      observers.push(io);
    }
    sync();
    return box;
  }

  // ── Strip ───────────────────────────────────────────────────────────────────────
  // Headers that stick to the top: the home's and the shared one every other page carries.
  const HEADERS = ['#hd', '#xh'];
  function offsetHeaders(px) {
    HEADERS.forEach((q) => {
      const h = document.querySelector(q);
      if (!h) return;
      h.style.top = px ? px + 'px' : '';
    });
  }
  function renderStrip(pick, l) {
    const old = document.querySelector('.xp-strip');
    if (old) old.remove();
    offsetHeaders(0);
    if (!pick || dismissed('strip', pick.promo.id)) return;
    const p = pick.promo;
    const f = describe(p, pick.entry, l, Date.now());
    const s = dress(el('div', 'xp xp-strip'), p);
    s.setAttribute('role', 'region');
    s.setAttribute('aria-label', f.name);
    const inner = el('div', 'xp-in');
    const id = el('span', 'xp-id');
    id.appendChild(el('strong', 'xp-name', f.name));
    id.appendChild(el('span', 'xp-what', f.what));
    inner.appendChild(id);
    if (p.slice && (f.video || f.poster)) inner.appendChild(media(f, l, sliceCss(p.slice)));
    inner.appendChild(el('span', 'xp-line', f.line));
    const wide = mq('(min-width: 900px)');
    inner.appendChild(link(f, 'xp-cta', wide ? f.cta : f.go, 'strip', p.id));
    inner.appendChild(closer('', l, () => { dismiss('strip', p.id); s.remove(); offsetHeaders(0); }));
    s.appendChild(inner);
    if (PREVIEW) s.appendChild(el('span', 'xp-mark', tr(l, 'preview')));
    document.body.insertBefore(s, document.body.firstChild);
    offsetHeaders(s.getBoundingClientRect().height);
  }

  // ── Panel ───────────────────────────────────────────────────────────────────────
  // The month's drop, once per drop and only to someone already reading. It waits until half the
  // page has gone by (NN/g, "Popups: 10 Problematic Trends", 2019: a box on arrival is the one people
  // hate most; Google Search Central treats a box covering the page a search result opened as
  // intrusive), covers nothing (a corner card on a computer, the bottom edge on a phone, never a
  // modal), and is remembered as soon as it shows, so it never comes back for that drop (Wikimedia
  // banner tests: one ask, then quiet). The hub's "spotlight" and "corner" both land here; spotlight wins.
  const HALF = 0.5;
  function halfRead() {
    const max = (document.documentElement.scrollHeight || 0) - (window.innerHeight || 0);
    return max > 0 && (window.scrollY || 0) >= max * HALF;
  }

  // A press on a button or link is someone doing something (copying a code,
  // opening an entry): the panel must not land on top of what they just did.
  const CONTROL_QUIET_MS = 4000;
  let lastControl = 0;
  const onControl = (e) => !!(e && e.target && e.target.closest
    && e.target.closest('a, button, input, select, textarea, label, [role="button"]'));
  const justActed = () => Date.now() - lastControl < CONTROL_QUIET_MS;
  let controlWatch = false;

  function buildPanel(pick, l) {
    const p = pick.promo;
    const f = describe(p, pick.entry, l, Date.now());
    const wide = desktop();
    const s = dress(el('aside', 'xp xp-panel ' + (wide ? 'xp-corner' : 'xp-drawer')), p);
    s.setAttribute('aria-label', f.name);
    if (f.video || f.poster) s.appendChild(media(f, l));
    const body = el('div', 'xp-body');
    const x = closer('', l, () => s.remove());
    const what = el('p', 'xp-what' + (f.soon ? ' soon' : ''), f.what);
    if (wide) {
      body.appendChild(el('h2', 'xp-name', f.name));
      if (f.line) body.appendChild(el('p', 'xp-line', f.line));
      body.appendChild(what);
      body.appendChild(link(f, 'xp-go', f.cta, p.format, p.id));
      body.appendChild(x);
    } else {
      const top = el('div', 'xp-top');
      top.appendChild(el('h2', 'xp-name', f.name));
      top.appendChild(x);
      body.appendChild(top);
      if (f.line) body.appendChild(el('p', 'xp-line', f.line));
      const row = el('div', 'xp-row');
      row.appendChild(what);
      row.appendChild(link(f, 'xp-go', f.go, p.format, p.id));
      body.appendChild(row);
    }
    s.appendChild(body);
    if (PREVIEW) s.appendChild(el('span', 'xp-mark', tr(l, 'preview')));
    return s;
  }
  function showPanel(pick, l) {
    const s = buildPanel(pick, l);
    document.body.appendChild(s);
    requestAnimationFrame(() => requestAnimationFrame(() => s.classList.add('in')));
  }

  let panelWatch = null;
  function renderPanel(pick, l, force) {
    document.querySelectorAll('.xp-panel').forEach((n) => n.remove());
    if (panelWatch) { document.removeEventListener('scroll', panelWatch, true); panelWatch = null; }
    if (!pick) return;
    if (force) { showPanel(pick, l); return; }
    const drop = pick.entry.id;
    if (dismissed('panel', drop)) return;
    if (!controlWatch) {
      controlWatch = true;
      document.addEventListener('pointerdown', (e) => { if (onControl(e)) lastControl = Date.now(); }, { capture: true, passive: true });
    }
    whenConsented(() => {
      panelWatch = () => {
        if (!halfRead() || document.visibilityState === 'hidden' || screenBusy() || justActed()) return;
        document.removeEventListener('scroll', panelWatch, true);
        panelWatch = null;
        dismiss('panel', drop);
        showPanel(pick, l);
      };
      document.addEventListener('scroll', panelWatch, { passive: true, capture: true });
    });
  }

  function render(picks, opts) {
    observers.forEach((o) => o.disconnect());
    observers = [];
    const l = lang();
    const any = picks.spotlight || picks.strip || picks.corner;
    if (any) css();
    renderStrip(picks.strip, l);
    renderPanel(picks.spotlight || picks.corner, l, !!(opts && opts.force));
  }

  async function load() {
    const get = (u) => fetch(u, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const promos = normalizeFeed(await get('/community/site-promo.json'));
    // Most of the time nothing is scheduled: then the catalog is not worth a request of its own.
    if (!promos.some((p) => isLive(p, Date.now()))) return;
    const cat = await get('/community/catalog.json');
    const entries = cat && Array.isArray(cat.entries) ? cat.entries : [];
    render(pickPerFormat(promos, entries, Date.now()));
  }

  // The hub's live preview: the real page, framed by the admin, drawing a draft it is sent. Only a
  // framed page listens, and only to the hub's own origin, so no link can ever make xenon-app.com
  // show a banner that was not published. Nothing is stored and nothing live is drawn beside it.
  function previewMode() {
    PREVIEW = true;
    window.addEventListener('message', (ev) => {
      if (ev.origin !== HUB_ORIGIN) return;
      const d = ev.data;
      if (!d || d.type !== 'xenon-promo-preview') return;
      const p = validatePromo(d.promo);
      const r = d.entry && typeof d.entry === 'object' && ID_RE.test(String(d.entry.id || '')) ? d.entry : null;
      const e = r ? {
        id: r.id, kind: typeof r.kind === 'string' ? r.kind : '', name: str(r.name, CAP.title),
        locked: r.locked === true, supportersOnly: r.supportersOnly === true,
        active: r.active === true || r.active === false ? r.active : undefined,
        activeUntil: isDate(r.activeUntil) ? r.activeUntil : '',
      } : null;
      PREVIEW_LANG = LANGS.indexOf(d.lang) !== -1 ? d.lang : null;
      const picks = { spotlight: null, strip: null, corner: null };
      if (p && e) picks[p.format] = { promo: p, entry: e };
      render(picks, { force: true });
    });
    try { window.parent.postMessage({ type: 'xenon-promo-ready' }, HUB_ORIGIN); } catch (e) { /* not framed by the hub */ }
  }

  function boot() {
    if (/[?&]promo-preview=1(?:&|$)/.test(location.search || '') && window.parent !== window) { previewMode(); return; }
    // Never inside a frame (the home's live demo, the catalog's layout preview), and never on the
    // demo, which is the dashboard itself.
    if (window.parent !== window || /(?:^|[#&])sf-preview=/.test(location.hash || '') || /^\/([a-z]{2}\/)?demo\//.test(location.pathname || '')) return;
    load().catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
