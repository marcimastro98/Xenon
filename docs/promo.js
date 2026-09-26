// Promo banners for the Xenon site (xenon-app.com): the month's drop, told where people land.
//
// What to show is decided in the supporter hub (admin, "Site banners") and published as
// /community/site-promo.json, the same static-file path the in-app messages take. Everything the
// promo says about the pack itself (its name, its picture, its colours, whether it is for
// supporters, when it ends) is read from /community/catalog.json, so a banner can never promise
// something the catalog does not say.
//
// Four formats, at most one live promo in each:
//   strip      a thin line above the nav
//   band       a full-width band in the page's [data-promo-band] slot (the home: after the live demo)
//   card       a small card in the bottom-right corner (clear of the hero's download button)
//   spotlight  the drop large, the page blurred behind it (a real <dialog>). Desktop only on arrival:
//              on a phone the same promo is a small sheet at the bottom that leaves the page usable.
//
// House rules, each one there for a reason:
//   - The drop dresses its own banner: the entry's own preview palette, contrast-checked, with the
//     site's dark ground as the fallback.
//   - Urgency comes from data only. "N days left" appears when the entry really ends within 14 days,
//     never otherwise (fake countdowns are what the Dutch regulator fined Epic for in 2024).
//   - One button. The decline is "Not now", said plainly.
//   - Nothing opens over the cookie choice, and a dismissal is remembered per promo, so a banner the
//     visitor closed does not come back on the next page.
//   - Every string from the feed goes through textContent.
//
// Self-contained like consent.js and theme.js: its own CSS (prefix xp-), its own strings in the
// site's six languages, only site.css tokens. The pure half is exported for node (server/test).
(function () {
  'use strict';

  // ── The pure core ─────────────────────────────────────────────────────────────
  const FORMATS = ['strip', 'band', 'card', 'spotlight'];
  const LANGS = ['en', 'it', 'es', 'ja', 'ko', 'zh'];
  const ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
  const HEX_RE = /^#[0-9a-f]{6}$/i;
  const MEDIA_HOST = 'assets.xenon-app.com';
  // Mirrors LINK_HOSTS in the hub's site-promo-admin.js (the publisher); a promo naming any other
  // host is dropped here, so a hand-edited feed cannot send visitors off-site.
  const LINK_HOSTS = ['xenon-app.com', 'www.xenon-app.com', 'github.com', 'www.github.com', 'discord.gg', 'discord.com', 'www.discord.com'];
  const CAP = { title: 60, line: 180, cta: 32, inside: 160 };
  const SOON_DAYS = 14;
  const FALLBACK = { bg: '#0A0C0B', fg: '#E9ECEA', ac: '#E9ECEA' };

  const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '').slice(0, max);
  const isDate = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));

  function httpsUrl(v, hosts) {
    if (typeof v !== 'string' || !v) return '';
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' || u.username || u.password) return '';
      if (hosts.indexOf(u.hostname) === -1) return '';
      return u.toString();
    } catch (e) { return ''; }
  }

  // One promo from the feed, rebuilt from known keys only. Returns null when anything required is
  // missing or malformed: a promo is shown whole or not at all.
  function validatePromo(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = typeof raw.id === 'string' ? raw.id : '';
    const entryId = typeof raw.entryId === 'string' ? raw.entryId : '';
    if (!ID_RE.test(id) || !ID_RE.test(entryId)) return null;
    if (FORMATS.indexOf(raw.format) === -1) return null;
    const out = { id, format: raw.format, entryId, text: {}, inside: {} };
    for (const k of ['activeFrom', 'activeUntil']) {
      if (raw[k] == null || raw[k] === '') continue;
      if (!isDate(raw[k])) return null;
      out[k] = raw[k];
    }
    if (out.activeFrom && out.activeUntil && Date.parse(out.activeFrom) > Date.parse(out.activeUntil)) return null;
    if (raw.video != null && raw.video !== '') {
      out.video = httpsUrl(raw.video, [MEDIA_HOST]);
      if (!out.video || !/\.(mp4|webm)$/i.test(new URL(out.video).pathname)) return null;
    }
    if (raw.url != null && raw.url !== '') {
      out.url = httpsUrl(raw.url, LINK_HOSTS);
      if (!out.url) return null;
    }
    const text = raw.text && typeof raw.text === 'object' ? raw.text : {};
    const inside = raw.inside && typeof raw.inside === 'object' ? raw.inside : {};
    for (const l of LANGS) {
      const t = text[l];
      if (t && typeof t === 'object') {
        const one = { title: str(t.title, CAP.title), line: str(t.line, CAP.line), cta: str(t.cta, CAP.cta) };
        if (one.title || one.line || one.cta) out.text[l] = one;
      }
      const ins = str(inside[l], CAP.inside);
      if (ins) out.inside[l] = ins;
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

  // The catalog entry, with the same date meaning the home's #drops uses: not yet opened is
  // nobody's business, ended is over.
  function entryOpen(e, now) {
    if (!e || e.active === false) return false;
    if (e.active === true) return true;
    if (e.activeFrom && isDate(e.activeFrom) && now < Date.parse(e.activeFrom)) return false;
    if (e.activeUntil && isDate(e.activeUntil) && now > Date.parse(e.activeUntil)) return false;
    return true;
  }

  // The first live promo per format, in feed order. A promo whose entry is missing from the catalog
  // or not open is skipped rather than shown with half its facts.
  function pickPerFormat(promos, entries, now) {
    const byId = new Map();
    (Array.isArray(entries) ? entries : []).forEach((e) => { if (e && ID_RE.test(String(e.id || ''))) byId.set(e.id, e); });
    const picks = {};
    for (const p of promos) {
      if (picks[p.format] || !isLive(p, now)) continue;
      const entry = byId.get(p.entryId);
      if (!entryOpen(entry, now)) continue;
      picks[p.format] = { promo: p, entry };
    }
    return picks;
  }

  // When it really ends: the promo's own date, or the entry's.
  function endOf(p, entry) {
    const v = (p && p.activeUntil) || (entry && entry.activeUntil) || '';
    return isDate(v) ? Date.parse(v) : null;
  }

  // Whole days left, only inside the last SOON_DAYS; null otherwise (no countdown without a real end).
  function daysLeft(end, now) {
    if (end == null || !Number.isFinite(end)) return null;
    const ms = end - now;
    if (ms <= 0 || ms > SOON_DAYS * 86400000) return null;
    return Math.max(1, Math.ceil(ms / 86400000));
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

  // The entry's own colours when they read (text 4.5:1 on the ground, the accent 4.5:1 too because
  // it fills the button under text in the ground colour); the site's dark ground otherwise.
  function paletteOf(entry) {
    const pv = entry && entry.preview;
    const bg = pv && HEX_RE.test(pv.bg || '') ? pv.bg : '';
    const fg = pv && HEX_RE.test(pv.text || '') ? pv.text : '';
    const ac = pv && HEX_RE.test(pv.accent || '') ? pv.accent : '';
    if (!bg || !fg || contrast(bg, fg) < 4.5) return { ...FALLBACK };
    return { bg, fg, ac: ac && contrast(ac, bg) >= 4.5 ? ac : fg };
  }

  function textFor(p, lang) {
    const own = p.text[lang] || {};
    const en = p.text.en || {};
    return {
      title: own.title || en.title || '',
      line: own.line || en.line || '',
      cta: own.cta || en.cta || '',
      inside: p.inside[lang] || p.inside.en || '',
    };
  }

  const core = { FORMATS, LANGS, validatePromo, normalizeFeed, isLive, entryOpen, pickPerFormat, endOf, daysLeft, contrast, paletteOf, textFor };
  if (typeof module === 'object' && module.exports) { module.exports = core; return; }
  if (typeof document === 'undefined') return;

  // ── The page half ─────────────────────────────────────────────────────────────
  const HUB_ORIGIN = 'https://xenon-supporter-hub.xenonedge.workers.dev';
  const SHOTS = 'https://assets.xenon-app.com/community/shots/';
  const STORE = 'xenon.site.promo.v1';
  const CONSENT = 'xenon.site.consent';

  const STR = {
    en: { notNow: 'Not now', close: 'Close', pause: 'Pause', play: 'Play', until: 'Available until {d}', left: '{n} days left', last: 'Last day', supShort: 'For supporters', freeShort: 'Free', supLong: 'Included with supporter access', freeLong: 'Free in the Xenon catalog', inside: "What's inside", see: 'See {name}', preview: 'Preview, not published' },
    it: { notNow: 'Non ora', close: 'Chiudi', pause: 'Pausa', play: 'Riproduci', until: 'Disponibile fino al {d}', left: 'Ancora {n} giorni', last: 'Ultimo giorno', supShort: 'Per i sostenitori', freeShort: 'Gratis', supLong: 'Incluso per i sostenitori', freeLong: 'Gratis nel catalogo Xenon', inside: 'Cosa contiene', see: 'Vedi {name}', preview: 'Anteprima, non pubblicato' },
    es: { notNow: 'Ahora no', close: 'Cerrar', pause: 'Pausa', play: 'Reproducir', until: 'Disponible hasta el {d}', left: 'Quedan {n} días', last: 'Último día', supShort: 'Para patrocinadores', freeShort: 'Gratis', supLong: 'Incluido para patrocinadores', freeLong: 'Gratis en el catálogo de Xenon', inside: 'Qué incluye', see: 'Ver {name}', preview: 'Vista previa, sin publicar' },
    ja: { notNow: '今はしない', close: '閉じる', pause: '一時停止', play: '再生', until: '{d}まで', left: '残り{n}日', last: '最終日', supShort: 'サポーター限定', freeShort: '無料', supLong: 'サポーター特典に含まれます', freeLong: 'Xenonカタログで無料', inside: '中身', see: '{name}を見る', preview: 'プレビュー（未公開）' },
    ko: { notNow: '나중에', close: '닫기', pause: '일시정지', play: '재생', until: '{d}까지', left: '{n}일 남음', last: '마지막 날', supShort: '서포터 전용', freeShort: '무료', supLong: '서포터 혜택에 포함', freeLong: 'Xenon 카탈로그에서 무료', inside: '구성', see: '{name} 보기', preview: '미리보기, 게시되지 않음' },
    zh: { notNow: '以后再说', close: '关闭', pause: '暂停', play: '播放', until: '到 {d} 为止', left: '还剩 {n} 天', last: '最后一天', supShort: '仅限支持者', freeShort: '免费', supLong: '支持者专享', freeLong: 'Xenon 目录中免费', inside: '包含内容', see: '查看 {name}', preview: '预览，未发布' },
  };

  let PREVIEW_LANG = null;   // the language tab the hub admin is looking at, in its preview
  function lang() {
    if (LANGS.indexOf(PREVIEW_LANG) !== -1) return PREVIEW_LANG;
    const forced = window.__XENON_SITE_LANG;
    if (LANGS.indexOf(forced) !== -1) return forced;
    let l = null;
    try { l = localStorage.getItem('xenon.site.lang'); } catch (e) { /* private mode */ }
    if (LANGS.indexOf(l) !== -1) return l;
    const wanted = navigator.languages || [navigator.language || 'en'];
    for (const w of wanted) { const s = String(w).slice(0, 2).toLowerCase(); if (LANGS.indexOf(s) !== -1) return s; }
    return 'en';
  }
  const t = (k) => { const d = STR[lang()] || STR.en; return d[k] != null ? d[k] : STR.en[k]; };

  function readStore() { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; } }
  function dismissed(fmt, id) { return !!readStore()[fmt + ':' + id]; }
  function remember(fmt, id) {
    if (PREVIEW) return;                        // a preview never writes the visitor's state
    try {
      const s = readStore();
      s[fmt + ':' + id] = Date.now();
      // Keep it small: the forty most recent answers are all that can still matter.
      const keys = Object.keys(s).sort((a, b) => s[b] - s[a]).slice(0, 40);
      const out = {}; keys.forEach((k) => { out[k] = s[k]; });
      localStorage.setItem(STORE, JSON.stringify(out));
    } catch (e) { /* private mode: it just shows again next visit */ }
  }
  const consentDecided = () => { try { const v = localStorage.getItem(CONSENT); return v === 'granted' || v === 'denied'; } catch (e) { return true; } };
  const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const desktop = () => window.matchMedia && matchMedia('(min-width: 900px) and (pointer: fine)').matches;

  const STYLE = [
    // shared
    '.xp{font-family:var(--sans),system-ui,sans-serif;background:var(--xp-bg);color:var(--xp-fg);-webkit-font-smoothing:antialiased}',
    '.xp *{box-sizing:border-box}',
    '.xp a{color:inherit}',
    '.xp-tier{margin:0;font-size:14px;font-weight:600;color:var(--xp-ac)}',
    '.xp-name{margin:0;font-weight:640;font-stretch:88%;letter-spacing:-0.01em;line-height:.95}',
    '.xp-line{margin:0;line-height:1.45;opacity:.86}',
    '.xp-when{font-family:var(--mono),monospace;font-size:12px;opacity:.74;white-space:nowrap}',
    '.xp-when b{font-weight:600;opacity:1;color:var(--xp-ac)}',
    '.xp .xp-btn{display:inline-flex;align-items:center;min-height:44px;padding:0 20px;border-radius:3px;background:var(--xp-ac);color:var(--xp-bg);font-weight:650;font-size:15px;text-decoration:none;white-space:nowrap}',
    '.xp .xp-btn:hover{filter:brightness(1.08)}',
    '.xp-btn:focus-visible,.xp-x:focus-visible,.xp-quiet:focus-visible,.xp a:focus-visible{outline:2px solid var(--xp-fg);outline-offset:3px}',
    '.xp-x{position:absolute;top:10px;right:10px;width:36px;height:36px;display:grid;place-items:center;background:none;border:0;border-radius:2px;color:var(--xp-fg);opacity:.7;font:400 22px/1 var(--sans),sans-serif;cursor:pointer}',
    '.xp-x:hover{opacity:1}',
    '.xp-quiet{background:none;border:0;padding:8px 2px;color:var(--xp-fg);opacity:.7;font:500 14.5px var(--sans),sans-serif;cursor:pointer;text-decoration:underline;text-underline-offset:3px}',
    '.xp-quiet:hover{opacity:1}',
    '.xp-media{position:relative;background:#000;overflow:hidden}',
    '.xp-media img,.xp-media video{display:block;width:100%;height:100%;object-fit:cover}',
    '.xp-pp{position:absolute;right:10px;bottom:10px;min-height:32px;padding:0 10px;border:0;border-radius:2px;background:rgba(0,0,0,.55);color:#fff;font:500 11.5px var(--mono),monospace;cursor:pointer}',
    '.xp-mark{position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:10001;padding:6px 12px;border-radius:2px;background:#ffb454;color:#241a05;font:600 12px var(--sans),sans-serif}',
    // strip
    '.xp-strip{position:relative;z-index:51;border-bottom:1px solid color-mix(in srgb,var(--xp-fg) 14%,transparent)}',
    '.xp-strip .xp-in{max-width:1320px;margin-inline:auto;padding:0 56px 0 32px;height:44px;display:flex;align-items:center;gap:14px;font-size:14.5px}',
    '.xp-strip img{width:78px;height:22px;object-fit:cover;display:block;flex:none}',
    '.xp-strip .xp-tier{font-size:13px;white-space:nowrap}',
    '.xp-strip .xp-sname{font-weight:650;white-space:nowrap}',
    '.xp-strip .xp-line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1 1 auto}',
    '.xp-strip .xp-go{font-weight:650;color:var(--xp-ac);text-underline-offset:3px;white-space:nowrap}',
    '.xp-strip .xp-x{top:4px;right:8px}',
    '@media (max-width:900px){.xp-strip .xp-line{display:none}.xp-strip .xp-in{justify-content:flex-start}}',
    '@media (max-width:600px){.xp-strip img,.xp-strip .xp-when{display:none}.xp-strip .xp-in{padding-left:16px;gap:10px;font-size:14px}}',
    // band
    '.xp-band{position:relative}',
    '.xp-band .xp-in{max-width:1320px;margin-inline:auto;padding:48px 32px;display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:48px;align-items:center}',
    '.xp-band .xp-media{aspect-ratio:32/9}',
    '.xp-band .xp-tier{margin-bottom:12px}',
    '.xp-band .xp-name{font-size:clamp(38px,4.4vw,60px);margin-bottom:14px}',
    '.xp-band .xp-line{font-size:17px;max-width:44ch}',
    '.xp-band .xp-act{display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin-top:24px}',
    '@media (max-width:900px){.xp-band .xp-in{grid-template-columns:1fr;gap:24px;padding:32px 16px}}',
    // card
    '.xp-card{position:fixed;right:20px;bottom:20px;z-index:85;width:min(360px,calc(100vw - 40px));border:1px solid color-mix(in srgb,var(--xp-fg) 16%,transparent);box-shadow:0 18px 48px rgba(0,0,0,.32);opacity:0;transform:translateY(12px);transition:opacity .4s var(--ease-out,ease),transform .4s var(--ease-out,ease)}',
    '.xp-card.in{opacity:1;transform:none}',
    '.xp-card .xp-media{aspect-ratio:32/9}',
    '.xp-card .xp-body{padding:16px 18px 14px}',
    '.xp-card .xp-name{font-size:26px;margin:6px 0 8px}',
    '.xp-card .xp-line{font-size:14.5px}',
    '.xp-card .xp-act{display:flex;align-items:center;gap:18px;margin-top:14px}',
    '.xp-card .xp-go{font-weight:650;color:var(--xp-ac);text-underline-offset:3px}',
    '.xp-card .xp-x{top:6px;right:6px;background:rgba(0,0,0,.45);color:#fff;opacity:.9}',
    // spotlight
    'dialog.xp-spot{margin:auto;padding:0;border:0;width:min(1080px,calc(100vw - 64px));max-width:none;max-height:calc(100vh - 48px);overflow:auto;border-radius:3px}',
    'dialog.xp-spot::backdrop{background:rgba(8,9,10,.5);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}',
    '@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){dialog.xp-spot::backdrop{background:rgba(8,9,10,.88)}}',
    'dialog.xp-spot[open]{animation:xp-rise .5s var(--ease-out,cubic-bezier(.2,.8,.2,1)) both}',
    'dialog.xp-spot[open]::backdrop{animation:xp-fade .45s ease both}',
    '@keyframes xp-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}',
    '@keyframes xp-fade{from{opacity:0}to{opacity:1}}',
    '.xp-spot .xp-media{aspect-ratio:32/9}',
    '.xp-spot .xp-body{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:40px;padding:32px 40px 34px}',
    '.xp-spot .xp-tier{margin-bottom:12px}',
    '.xp-spot .xp-name{font-size:clamp(44px,5.4vw,76px);margin-bottom:16px}',
    '.xp-spot .xp-name:focus{outline:none}',
    '.xp-spot .xp-line{font-size:18px;max-width:40ch}',
    '.xp-spot .xp-side{display:flex;flex-direction:column;gap:14px;padding-top:6px}',
    '.xp-spot .xp-ins-h{margin:0;font-size:13px;font-weight:600;opacity:.7}',
    '.xp-spot .xp-ins{margin:0;font-size:16px;line-height:1.5}',
    '.xp-spot .xp-act{display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin-top:auto;padding-top:10px}',
    '.xp-spot .xp-x{background:rgba(0,0,0,.45);color:#fff;opacity:.9;z-index:2}',
    // the phone sheet: the same dialog, non-modal, at the bottom, no blur
    'dialog.xp-spot.xp-sheet{position:fixed;inset:auto 0 0 0;margin:0;width:100%;max-height:48vh;border-radius:0;border-top:1px solid color-mix(in srgb,var(--xp-fg) 18%,transparent);z-index:85;animation:xp-up .35s var(--ease-out,ease) both}',
    '@keyframes xp-up{from{transform:translateY(100%)}to{transform:none}}',
    '.xp-sheet .xp-body{grid-template-columns:1fr;gap:10px;padding:16px 16px 18px}',
    '.xp-sheet .xp-name{font-size:32px;margin-bottom:6px}',
    '.xp-sheet .xp-line{font-size:15px}',
    '.xp-sheet .xp-side{padding-top:0}',
    '.xp-sheet .xp-ins-h,.xp-sheet .xp-ins{display:none}',
    '@media (prefers-reduced-motion:reduce){dialog.xp-spot[open],dialog.xp-spot[open]::backdrop,dialog.xp-spot.xp-sheet{animation:none}.xp-card{transition:none}}',
  ].join('');

  function css() {
    if (document.getElementById('xp-promo-style')) return;
    const s = document.createElement('style');
    s.id = 'xp-promo-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  function skin(node, entry) {
    const pal = paletteOf(entry);
    node.classList.add('xp');
    node.style.setProperty('--xp-bg', pal.bg);
    node.style.setProperty('--xp-fg', pal.fg);
    node.style.setProperty('--xp-ac', pal.ac);
  }

  // The facts every format draws from, in the visitor's language.
  function facts(pick) {
    const { promo, entry } = pick;
    const tx = textFor(promo, lang());
    const name = tx.title || String(entry.name || entry.id).slice(0, CAP.title);
    const sup = entry.locked === true;
    const end = endOf(promo, entry);
    const now = Date.now();
    const days = daysLeft(end, now);
    let when = '';
    if (days === 1) when = t('last');
    else if (days) when = t('left').replace('{n}', String(days));
    else if (end) {
      try { when = t('until').replace('{d}', new Date(end).toLocaleDateString(lang(), { day: 'numeric', month: 'long', timeZone: 'UTC' })); } catch (e) { when = ''; }
    }
    return {
      name, sup, when, soon: !!days,
      line: tx.line,
      cta: tx.cta || t('see').replace('{name}', name),
      inside: tx.inside,
      href: promo.url || '/catalog/#' + entry.id,
      shot: SHOTS + entry.id + '.webp',
      video: promo.video || '',
    };
  }

  function whenNode(f) {
    if (!f.when) return null;
    const n = el('span', 'xp-when');
    if (f.soon) { const b = el('b', null, f.when); n.appendChild(b); } else n.textContent = f.when;
    return n;
  }

  function go(f, fmt, id, cls) {
    const a = el('a', cls, f.cta);
    a.href = f.href;
    a.setAttribute('data-track', 'promo_click');
    a.setAttribute('data-track-format', fmt);
    a.setAttribute('data-track-promo', id);
    return a;
  }

  // The picture: the real shot, and the loop when there is one. The video loads only when the
  // format is actually shown, never under reduced motion, and always has its own pause.
  function media(f, withVideo) {
    const box = el('div', 'xp-media');
    const img = el('img');
    img.alt = '';
    img.decoding = 'async';
    img.src = f.shot;
    img.addEventListener('error', () => { img.remove(); });
    box.appendChild(img);
    if (!withVideo || !f.video || reduced()) return box;
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'none';
    v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
    v.poster = f.shot;
    v.src = f.video;
    const pp = el('button', 'xp-pp', t('pause'));
    pp.type = 'button';
    pp.addEventListener('click', () => {
      if (v.paused) { v.play().catch(() => {}); pp.textContent = t('pause'); }
      else { v.pause(); pp.textContent = t('play'); }
    });
    v.addEventListener('error', () => { v.remove(); pp.remove(); });
    box.replaceChild(v, img);
    box.appendChild(pp);
    box._play = () => { v.play().catch(() => { pp.textContent = t('play'); }); };
    return box;
  }

  function closeX(onClose) {
    const x = el('button', 'xp-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', t('close'));
    x.addEventListener('click', onClose);
    return x;
  }

  // ── The four formats ──
  function renderStrip(pick) {
    const f = facts(pick), id = pick.promo.id;
    const bar = el('div', 'xp-strip');
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', f.name);
    skin(bar, pick.entry);
    const inner = el('div', 'xp-in');
    const img = el('img'); img.alt = ''; img.src = f.shot; img.addEventListener('error', () => img.remove());
    inner.appendChild(img);
    inner.appendChild(el('span', 'xp-tier', t(f.sup ? 'supShort' : 'freeShort')));
    inner.appendChild(el('span', 'xp-sname', f.name));
    if (f.line) inner.appendChild(el('span', 'xp-line xp-mid', f.line));
    else inner.appendChild(el('span', 'xp-line'));
    const w = whenNode(f); if (w) inner.appendChild(w);
    inner.appendChild(go(f, 'strip', id, 'xp-go'));
    bar.appendChild(inner);
    bar.appendChild(closeX(() => { remember('strip', id); bar.remove(); }));
    const nav = document.querySelector('nav.top');
    if (nav && nav.parentNode) nav.parentNode.insertBefore(bar, nav);
    else document.body.insertBefore(bar, document.body.firstChild);
    return bar;
  }

  // The band goes only where a page has marked a slot for it ([data-promo-band]), placed below the
  // fold so that filling it after the feed arrives shifts nothing in view. A page without a slot (the
  // catalog, which has its own featured blocks) shows no band.
  function renderBand(pick) {
    const slot = document.querySelector('[data-promo-band]');
    if (!slot) return null;
    const f = facts(pick), id = pick.promo.id;
    const band = el('section', 'xp-band');
    band.setAttribute('aria-label', f.name);
    skin(band, pick.entry);
    const inner = el('div', 'xp-in');
    const m = media(f, true);
    inner.appendChild(m);
    const body = el('div');
    body.appendChild(el('p', 'xp-tier', t(f.sup ? 'supLong' : 'freeLong')));
    body.appendChild(el('h2', 'xp-name', f.name));
    if (f.line) body.appendChild(el('p', 'xp-line', f.line));
    const act = el('div', 'xp-act');
    act.appendChild(go(f, 'band', id, 'xp-btn'));
    const w = whenNode(f); if (w) act.appendChild(w);
    body.appendChild(act);
    inner.appendChild(body);
    band.appendChild(inner);
    band.appendChild(closeX(() => { remember('band', id); band.remove(); }));
    slot.appendChild(band);
    // The loop starts when it scrolls into view.
    if (m._play && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver((es) => {
        if (es.some((e) => e.isIntersecting)) { m._play(); io.disconnect(); }
      }, { threshold: 0.3 });
      io.observe(m);
    }
    return band;
  }

  function renderCard(pick) {
    const f = facts(pick), id = pick.promo.id;
    const card = el('aside', 'xp-card');
    card.setAttribute('aria-label', f.name);
    skin(card, pick.entry);
    card.appendChild(media(f, false));
    const body = el('div', 'xp-body');
    body.appendChild(el('p', 'xp-tier', t(f.sup ? 'supShort' : 'freeShort')));
    body.appendChild(el('h2', 'xp-name', f.name));
    if (f.line) body.appendChild(el('p', 'xp-line', f.line));
    const act = el('div', 'xp-act');
    act.appendChild(go(f, 'card', id, 'xp-go'));
    const later = el('button', 'xp-quiet', t('notNow'));
    later.type = 'button';
    act.appendChild(later);
    const w = whenNode(f); if (w) act.appendChild(w);
    body.appendChild(act);
    card.appendChild(body);
    const bye = () => { remember('card', id); card.classList.remove('in'); setTimeout(() => card.remove(), 420); };
    later.addEventListener('click', bye);
    card.appendChild(closeX(bye));
    document.body.appendChild(card);
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('in')));
    return card;
  }

  function renderSpotlight(pick) {
    if (typeof HTMLDialogElement !== 'function') return null;
    const f = facts(pick), id = pick.promo.id;
    const big = desktop();
    const d = document.createElement('dialog');
    d.className = 'xp-spot' + (big ? '' : ' xp-sheet');
    skin(d, pick.entry);
    const titleId = 'xp-spot-title';
    d.setAttribute('aria-labelledby', titleId);
    const m = media(f, big);
    d.appendChild(m);
    const body = el('div', 'xp-body');
    const main = el('div');
    main.appendChild(el('p', 'xp-tier', t(f.sup ? 'supLong' : 'freeLong')));
    const h = el('h2', 'xp-name', f.name); h.id = titleId;
    main.appendChild(h);
    if (f.line) main.appendChild(el('p', 'xp-line', f.line));
    body.appendChild(main);
    const side = el('div', 'xp-side');
    if (f.inside) { side.appendChild(el('p', 'xp-ins-h', t('inside'))); side.appendChild(el('p', 'xp-ins', f.inside)); }
    const w = whenNode(f); if (w) side.appendChild(w);
    const act = el('div', 'xp-act');
    const cta = go(f, 'spotlight', id, 'xp-btn');
    act.appendChild(cta);
    const later = el('button', 'xp-quiet', t('notNow'));
    later.type = 'button';
    act.appendChild(later);
    side.appendChild(act);
    body.appendChild(side);
    d.appendChild(body);
    const shut = () => { if (d.open) d.close(); };
    d.appendChild(closeX(shut));
    later.addEventListener('click', shut);
    cta.addEventListener('click', () => { remember('spotlight', id); });
    // A click on the backdrop lands on the dialog itself (it has no padding of its own).
    d.addEventListener('click', (e) => { if (e.target === d) shut(); });
    d.addEventListener('close', () => { remember('spotlight', id); d.remove(); });
    document.body.appendChild(d);
    // Focus lands on the title, a static element at the start of the dialog (the APG pattern), so
    // the button does not open already ringed as if the visitor had tabbed to it.
    // show() runs the same focusing steps as showModal(), so the phone sheet needs it too.
    if (big) d.showModal(); else d.show();
    try { h.tabIndex = -1; h.focus({ preventScroll: true }); } catch (e) { /* older engines */ }
    if (m._play) m._play();
    return d;
  }

  // ── Orchestration ──
  let PREVIEW = false;
  const shown = [];
  function clearAll() { while (shown.length) { const n = shown.pop(); if (n && n.close && n.open) n.close(); if (n) n.remove(); } }

  // Something else already owns the screen: a lightbox, another dialog, the catalog's detail view,
  // or a deep link the visitor followed on purpose.
  function screenBusy() {
    if (location.hash && location.hash.length > 1) return true;
    if (document.querySelector('dialog[open]')) return true;
    const lb = document.querySelector('.lightbox.open, .lb.open, .dt.open, #xc-consent');
    return !!lb;
  }

  function whenConsented(fn) {
    if (consentDecided()) { fn(); return; }
    const on = () => { document.removeEventListener('xenon:consent', on); fn(); };
    document.addEventListener('xenon:consent', on);
  }

  function renderAll(picks, options) {
    const opts = options || {};
    clearAll();
    css();
    const ok = (fmt) => picks[fmt] && (opts.force || !dismissed(fmt, picks[fmt].promo.id));
    if (ok('strip')) { const n = renderStrip(picks.strip); if (n) shown.push(n); }
    if (ok('band')) { const n = renderBand(picks.band); if (n) shown.push(n); }
    const spot = ok('spotlight') ? picks.spotlight : null;
    const card = ok('card') ? picks.card : null;
    if (opts.force) {
      if (spot) { const n = renderSpotlight(spot); if (n) shown.push(n); }
      else if (card) { const n = renderCard(card); if (n) shown.push(n); }
      return;
    }
    // Only one of the two that sit over the page, per view: the spotlight when there is one, the
    // corner card otherwise. Both wait for the cookie choice and a moment of the page.
    whenConsented(() => {
      if (spot) setTimeout(() => { if (!screenBusy() && document.visibilityState === 'visible') { const n = renderSpotlight(spot); if (n) shown.push(n); } }, 1500);
      else if (card) setTimeout(() => { if (!document.querySelector('dialog[open]')) { const n = renderCard(card); if (n) shown.push(n); } }, 2500);
    });
  }

  async function load() {
    const get = (u) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [feed, cat] = await Promise.all([get('/community/site-promo.json'), get('/community/catalog.json')]);
    if (!feed || !cat) return;
    const picks = pickPerFormat(normalizeFeed(feed), cat.entries, Date.now());
    if (!Object.keys(picks).length) return;
    renderAll(picks);
    document.addEventListener('xenon:lang', () => { clearAll(); renderAll(pickPerFormat(normalizeFeed(feed), cat.entries, Date.now())); });
  }

  // The hub's live preview: the real page, framed by the admin, drawing a draft it is sent. Only a
  // framed page listens, and only to the hub's own origin, so no link can ever make xenon-app.com
  // show a banner that was not published.
  function previewMode() {
    PREVIEW = true;
    css();
    const mark = el('div', 'xp-mark', t('preview'));
    document.body.appendChild(mark);
    window.addEventListener('message', (ev) => {
      if (ev.origin !== HUB_ORIGIN) return;
      const d = ev.data;
      if (!d || d.type !== 'xenon-promo-preview') return;
      const p = validatePromo(d.promo);
      const e = d.entry && typeof d.entry === 'object' && ID_RE.test(String(d.entry.id || '')) ? {
        id: d.entry.id, name: str(d.entry.name, CAP.title), locked: d.entry.locked === true,
        activeUntil: isDate(d.entry.activeUntil) ? d.entry.activeUntil : '',
        preview: d.entry.preview && typeof d.entry.preview === 'object' ? d.entry.preview : null,
      } : null;
      PREVIEW_LANG = LANGS.indexOf(d.lang) !== -1 ? d.lang : null;
      clearAll();
      if (!p || !e) return;
      renderAll({ [p.format]: { promo: p, entry: e } }, { force: true });
      // The band lives below the fold; bring it into the frame so the author sees it.
      const band = document.querySelector('.xp-band');
      if (band) band.scrollIntoView({ block: 'center' }); else window.scrollTo(0, 0);
    });
    try { window.parent.postMessage({ type: 'xenon-promo-ready' }, HUB_ORIGIN); } catch (e) { /* not framed by the hub */ }
  }

  function boot() {
    // Not inside the catalog's own layout preview: that frame is about the arrangement.
    if (/(?:^|[#&])sf-preview=/.test(location.hash || '')) return;
    if (/[?&]promo-preview=1\b/.test(location.search) && window.parent !== window) { previewMode(); return; }
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
