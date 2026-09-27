// "This month" on the Xenon site (xenon-app.com): up to three catalog entries, told in the page.
//
// What to show is decided in the supporter hub (admin, "Site banners") and published as
// /community/site-promo.json, the same static-file path the in-app messages take. Everything the
// block says about a pack itself (its name, its picture, its colours, whether it is for supporters,
// when it ends) is read from /community/catalog.json, so a row can never promise something the
// catalog does not say.
//
// One format: an in-flow block the home places in its catalog section ([data-promo-block]). It
// never overlays anything, so there is nothing to dismiss and nothing to remember per visitor.
//
// House rules, each one there for a reason:
//   - Each row is dressed in its entry's own preview palette, contrast-checked (4.5:1), with the
//     site's dark ground as the fallback.
//   - Urgency comes from data only. "N days left" appears when the ENTRY really ends within 14 days,
//     never otherwise (fake countdowns are what the Dutch regulator fined Epic for in 2024). A
//     promo's own activeUntil only decides when the row is shown; it says nothing about the pack.
//   - One link per row. Every string from the feed goes through textContent.
//   - After every render the shown entry ids are announced (window.__xenonPromoIds and the
//     'xenon:promo' event), so the home's own drop cards can hide them: an entry never shows twice.
//
// Self-contained like consent.js and theme.js: its own CSS (prefix xp-), its own strings in the
// site's six languages, only site.css tokens. The pure half is exported for node (server/test).
(function () {
  'use strict';

  // ── The pure core ─────────────────────────────────────────────────────────────
  const LANGS = ['en', 'it', 'es', 'ja', 'ko', 'zh'];
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
  const MAX_LIVE = 3;          // rows at once; the hub refuses a fourth overlapping promo
  const ORDER_MAX = 3;
  const SOON_DAYS = 14;
  const FALLBACK = { bg: '#0A0C0B', fg: '#E9ECEA', ac: '#E9ECEA' };
  const SHOTS = 'https://assets.xenon-app.com/community/shots/';

  const STR = {
    en: { head: 'This month', pause: 'Pause', play: 'Play', until: 'Available until {d}', left: '{n} days left', last: 'Last day', sup: 'Included with supporter access', free: 'Free in the Xenon catalog', see: 'See {name}', preview: 'Preview, not published' },
    it: { head: 'Questo mese', pause: 'Pausa', play: 'Riproduci', until: 'Disponibile fino al {d}', left: 'Ancora {n} giorni', last: 'Ultimo giorno', sup: 'Incluso per i sostenitori', free: 'Gratis nel catalogo Xenon', see: 'Vedi {name}', preview: 'Anteprima, non pubblicato' },
    es: { head: 'Este mes', pause: 'Pausa', play: 'Reproducir', until: 'Disponible hasta el {d}', left: 'Quedan {n} días', last: 'Último día', sup: 'Incluido para patrocinadores', free: 'Gratis en el catálogo de Xenon', see: 'Ver {name}', preview: 'Vista previa, sin publicar' },
    ja: { head: '今月', pause: '一時停止', play: '再生', until: '{d}まで', left: '残り{n}日', last: '最終日', sup: 'サポーター特典に含まれます', free: 'Xenonカタログで無料', see: '{name}を見る', preview: 'プレビュー（未公開）' },
    ko: { head: '이번 달', pause: '일시정지', play: '재생', until: '{d}까지', left: '{n}일 남음', last: '마지막 날', sup: '서포터 혜택에 포함', free: 'Xenon 카탈로그에서 무료', see: '{name} 보기', preview: '미리보기, 게시되지 않음' },
    zh: { head: '本月', pause: '暂停', play: '播放', until: '到 {d} 为止', left: '还剩 {n} 天', last: '最后一天', sup: '支持者专享', free: 'Xenon 目录中免费', see: '查看 {name}', preview: '预览，未发布' },
  };
  const tr = (l, k) => { const d = STR[l] || STR.en; return d[k] != null ? d[k] : STR.en[k]; };

  // Capped by code point, so a cut never leaves half an emoji behind.
  const str = (v, max) => Array.from(typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '').slice(0, max).join('');
  const isDate = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
  const isIso = (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));

  function httpsUrl(v, hosts) {
    if (typeof v !== 'string' || !v) return null;
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' || u.username || u.password) return null;
      return hosts.indexOf(u.hostname) === -1 ? null : u;
    } catch (e) { return null; }
  }

  // One promo from the feed, rebuilt from known keys only (the legacy "format" and "inside" are
  // simply not read). Returns null when anything present is malformed: a promo is shown whole or
  // not at all. A missing order is 1; an order outside 1..3 is refused, as the hub refuses it.
  function validatePromo(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = typeof raw.id === 'string' ? raw.id : '';
    const entryId = typeof raw.entryId === 'string' ? raw.entryId : '';
    if (!ID_RE.test(id) || !ID_RE.test(entryId)) return null;
    let order = 1;
    if (raw.order != null && raw.order !== '') {
      if (!Number.isInteger(raw.order) || raw.order < 1 || raw.order > ORDER_MAX) return null;
      order = raw.order;
    }
    const out = { id, entryId, order, text: {} };
    for (const k of ['activeFrom', 'activeUntil']) {
      if (raw[k] == null || raw[k] === '') continue;
      if (!isIso(raw[k])) return null;
      out[k] = raw[k];
    }
    if (out.activeFrom && out.activeUntil && Date.parse(out.activeFrom) > Date.parse(out.activeUntil)) return null;
    if (raw.video != null && raw.video !== '') {
      const u = httpsUrl(raw.video, [MEDIA_HOST]);
      if (!u || u.pathname.indexOf(MEDIA_PATH) !== 0 || !/\.(mp4|webm)$/i.test(u.pathname)) return null;
      out.video = u.toString();
    }
    if (raw.url != null && raw.url !== '') {
      const u = httpsUrl(raw.url, LINK_HOSTS);
      if (!u) return null;
      out.url = u.toString();
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
  function rank(a, b) {
    return (a.order - b.order) || (startOf(b) - startOf(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  // The rows to show now: live promos whose entry is in the catalog and open, by order, then the
  // most recently started, then id; one row per entry; at most three. A promo whose entry is
  // missing or closed is skipped rather than shown with half its facts.
  function pickLive(promos, entries, now) {
    const byId = new Map();
    (Array.isArray(entries) ? entries : []).forEach((e) => { if (e && typeof e === 'object' && ID_RE.test(String(e.id || ''))) byId.set(e.id, e); });
    const live = (Array.isArray(promos) ? promos : [])
      .filter((p) => p && isLive(p, now) && entryOpen(byId.get(p.entryId), now))
      .sort(rank);
    const out = [];
    const seen = new Set();
    for (const p of live) {
      if (seen.has(p.entryId)) continue;
      seen.add(p.entryId);
      out.push({ promo: p, entry: byId.get(p.entryId) });
      if (out.length === MAX_LIVE) break;
    }
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
  // it fills the link under text in the ground colour); the site's dark ground otherwise.
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
    return { title: own.title || en.title || '', line: own.line || en.line || '', cta: own.cta || en.cta || '' };
  }

  // Everything one row says, in one language, at one instant. Plain strings only.
  function describe(p, entry, lang, now) {
    const tx = textFor(p, lang);
    const name = tx.title || str(entry && entry.name, CAP.title) || p.entryId;
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
    const shots = entry && entry.shots;
    return {
      name,
      tier: tr(lang, entry && (entry.locked === true || entry.supportersOnly === true) ? 'sup' : 'free'),
      line: tx.line,
      when,
      soon: !!days,
      cta: tx.cta || tr(lang, 'see').replace('{name}', name),
      href: p.url || '/catalog/#' + p.entryId,
      external: !!p.url && !/^https:\/\/(www\.)?xenon-app\.com\//.test(p.url),
      shot: Number.isInteger(shots) && shots < 1 ? '' : SHOTS + p.entryId + '.webp',
      video: p.video || '',
    };
  }

  const core = { LANGS, CAP, LINK_HOSTS, MEDIA_HOST, MAX_LIVE, SOON_DAYS, STR, validatePromo, normalizeFeed, isLive, entryOpen, pickLive, endOf, daysLeft, contrast, paletteOf, textFor, describe };
  if (typeof module === 'object' && module.exports) { module.exports = core; return; }
  if (typeof document === 'undefined') return;

  // ── The page half ─────────────────────────────────────────────────────────────
  const HUB_ORIGIN = 'https://xenon-supporter-hub.xenonedge.workers.dev';

  let PREVIEW = false;
  let PREVIEW_LANG = null;     // the language tab the hub admin is looking at, in its preview
  let picked = null;           // the language the page last announced ('xenon:lang' detail)
  function lang() {
    for (const l of [PREVIEW_LANG, picked, window.__XENON_SITE_LANG]) if (LANGS.indexOf(l) !== -1) return l;
    let s = null;
    try { s = localStorage.getItem('xenon.site.lang'); } catch (e) { /* private mode */ }
    if (LANGS.indexOf(s) !== -1) return s;
    const nav = window.navigator || {};
    for (const w of nav.languages || [nav.language || 'en']) { const x = String(w).slice(0, 2).toLowerCase(); if (LANGS.indexOf(x) !== -1) return x; }
    return 'en';
  }
  const mq = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
  const withMotion = () => mq('(min-width: 900px)') && !mq('(prefers-reduced-motion: reduce)');

  const STYLE = [
    '[data-promo-block][hidden]{display:none}',
    '.xp-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px 14px;margin:0 0 14px}',
    '.xp-h{margin:0;font:500 12px/1.3 var(--mono);letter-spacing:0;color:var(--muted)}',
    '.xp-mark{font:600 11.5px/1.3 var(--mono);color:var(--gold)}',
    '.xp-rows{display:grid;gap:14px}',
    '.xp-row{display:grid;grid-template-columns:minmax(0,42fr) minmax(0,58fr);background:var(--xp-bg);color:var(--xp-fg);border:1px solid color-mix(in srgb,var(--xp-fg) 16%,transparent);border-radius:2px;overflow:hidden;font-family:var(--sans)}',
    '.xp-shot{position:relative;align-self:stretch;aspect-ratio:16/7;overflow:hidden;background:radial-gradient(120% 130% at 20% 10%,color-mix(in srgb,var(--xp-ac) 34%,transparent),var(--xp-bg) 62%)}',
    '.xp-shot img,.xp-shot video{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover}',
    '.xp-main{min-width:0;padding:20px 24px 22px;display:grid;gap:8px;align-content:center;justify-items:start}',
    '.xp-tier{margin:0;font:500 11.5px/1.4 var(--mono);color:var(--xp-ac)}',
    '.xp-name{margin:0;font:640 21px/1.15 var(--sans);color:var(--xp-fg);overflow-wrap:anywhere}',
    '.xp-line{margin:0;max-width:52ch;font-size:15px;line-height:1.5;color:var(--xp-fg);overflow-wrap:anywhere}',
    '.xp-act{display:flex;align-items:center;flex-wrap:wrap;gap:10px 18px;margin-top:6px}',
    '.xp-row .xp-go{display:inline-flex;align-items:center;min-height:40px;padding:9px 16px;border-radius:3px;background:var(--xp-ac);color:var(--xp-bg);font:600 14px/1.2 var(--sans);text-decoration:none}',
    '.xp-row .xp-go:hover{filter:brightness(1.08)}',
    '.xp-go:focus-visible,.xp-pp:focus-visible{outline:2px solid var(--xp-fg);outline-offset:3px}',
    '.xp-when{font:400 12px/1.4 var(--mono);color:var(--xp-fg)}',
    '.xp-when.soon{font-weight:600;color:var(--xp-ac)}',
    '.xp-pp{position:absolute;right:10px;bottom:10px;min-width:28px;min-height:28px;padding:0 10px;border:1px solid color-mix(in srgb,var(--xp-fg) 30%,transparent);border-radius:2px;background:var(--xp-bg);color:var(--xp-fg);font:500 11.5px/1 var(--mono);cursor:pointer}',
    '@media (max-width:720px){.xp-row{grid-template-columns:minmax(0,1fr)}.xp-main{padding:16px 16px 18px}.xp-name{font-size:19px}}',
  ].join('');

  function css() {
    if (document.getElementById('xp-promo-style')) return;
    const s = document.createElement('style');
    s.id = 'xp-promo-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  let observers = [];

  // The picture: the real shot, or the loop when there is one and the screen is a wide one that
  // has not asked for less motion. The loop plays only while it is in view, and has its own pause.
  function media(f, l) {
    const box = el('div', 'xp-shot');
    // Built only when it is shown: a detached <img> with a src is still a download.
    const pic = () => {
      if (!f.shot) return;
      const img = el('img');
      img.alt = '';                           // the name sits right beside it
      img.width = 1280; img.height = 560;     // the box's 16:7; the CSS crops any shot into it
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = f.shot;
      img.addEventListener('error', () => img.remove(), { once: true });
      box.appendChild(img);
    };
    if (!f.video || !withMotion()) { pic(); return box; }
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'none';
    v.setAttribute('muted', ''); v.setAttribute('loop', ''); v.setAttribute('playsinline', '');
    v.width = 1280; v.height = 560;
    if (f.shot) v.poster = f.shot;
    v.src = f.video;
    const pp = el('button', 'xp-pp');
    pp.type = 'button';
    let held = !('IntersectionObserver' in window);   // no way to know it is seen: wait for a tap
    let inView = false;
    const sync = () => {
      pp.textContent = tr(l, held ? 'play' : 'pause');
      if (inView && !held) v.play().catch(() => { held = true; pp.textContent = tr(l, 'play'); });
      else v.pause();
    };
    pp.addEventListener('click', () => { held = !held; if (!held) inView = true; sync(); });
    v.addEventListener('error', () => { held = true; v.remove(); pp.remove(); pic(); }, { once: true });
    box.appendChild(v);
    box.appendChild(pp);
    if (!held) {
      const io = new IntersectionObserver((es) => { inView = es[es.length - 1].isIntersecting; sync(); }, { threshold: 0.35 });
      io.observe(box);
      observers.push(io);
    }
    sync();
    return box;
  }

  function row(pick, l) {
    const p = pick.promo;
    const f = describe(p, pick.entry, l, Date.now());
    const pal = paletteOf(pick.entry);
    const art = el('article', 'xp-row');
    art.style.setProperty('--xp-bg', pal.bg);
    art.style.setProperty('--xp-fg', pal.fg);
    art.style.setProperty('--xp-ac', pal.ac);
    art.appendChild(media(f, l));
    const main = el('div', 'xp-main');
    main.appendChild(el('p', 'xp-tier', f.tier));
    main.appendChild(el('h4', 'xp-name', f.name));
    main.appendChild(el('p', 'xp-line', f.line));
    const act = el('div', 'xp-act');
    const a = el('a', 'xp-go', f.cta);
    a.href = f.href;
    if (f.external) { a.target = '_blank'; a.rel = 'noopener'; }
    a.setAttribute('data-track', 'promo_click');
    a.setAttribute('data-track-format', 'block');
    a.setAttribute('data-track-id', p.id);
    act.appendChild(a);
    if (f.when) act.appendChild(el('span', 'xp-when' + (f.soon ? ' soon' : ''), f.when));
    main.appendChild(act);
    art.appendChild(main);
    return art;
  }

  function announce(ids) {
    window.__xenonPromoIds = ids.slice();
    try { document.dispatchEvent(new CustomEvent('xenon:promo', { detail: { ids: ids.slice() } })); } catch (e) { /* very old engine */ }
  }

  function render(picks) {
    const box = document.querySelector('[data-promo-block]');
    observers.forEach((o) => o.disconnect());
    observers = [];
    if (!box) { announce([]); return; }
    box.textContent = '';
    if (picks.length) {
      css();
      const l = lang();
      const head = el('div', 'xp-head');
      head.appendChild(el('h3', 'xp-h', tr(l, 'head')));
      if (PREVIEW) head.appendChild(el('span', 'xp-mark', tr(l, 'preview')));
      box.appendChild(head);
      const rows = el('div', 'xp-rows');
      picks.forEach((pick) => rows.appendChild(row(pick, l)));
      box.appendChild(rows);
    }
    box.hidden = !picks.length;
    announce(picks.map((pick) => pick.promo.entryId));
  }

  let repaint = () => render([]);
  document.addEventListener('xenon:lang', (ev) => {
    if (ev && LANGS.indexOf(ev.detail) !== -1) picked = ev.detail;
    repaint();
  });

  async function load() {
    const box = document.querySelector('[data-promo-block]');
    if (!box) { announce([]); return; }
    box.hidden = true;
    const get = (u) => fetch(u, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const promos = normalizeFeed(await get('/community/site-promo.json'));
    // Most of the time nothing is scheduled: then the catalog is not worth a request of its own.
    if (!promos.some((p) => isLive(p, Date.now()))) { render([]); return; }
    const cat = await get('/community/catalog.json');
    const entries = cat && Array.isArray(cat.entries) ? cat.entries : [];
    repaint = () => render(pickLive(promos, entries, Date.now()));
    repaint();
  }

  // The hub's live preview: the real page, framed by the admin, drawing a draft it is sent. Only a
  // framed page listens, and only to the hub's own origin, so no link can ever make xenon-app.com
  // show a row that was not published. Nothing is stored and nothing live is drawn beside it.
  function previewMode() {
    PREVIEW = true;
    render([]);
    window.addEventListener('message', (ev) => {
      if (ev.origin !== HUB_ORIGIN) return;
      const d = ev.data;
      if (!d || d.type !== 'xenon-promo-preview') return;
      const p = validatePromo(d.promo);
      const r = d.entry && typeof d.entry === 'object' && ID_RE.test(String(d.entry.id || '')) ? d.entry : null;
      const e = r ? {
        id: r.id, name: str(r.name, CAP.title), locked: r.locked === true, supportersOnly: r.supportersOnly === true,
        active: r.active === true || r.active === false ? r.active : undefined,
        activeUntil: isDate(r.activeUntil) ? r.activeUntil : '',
        shots: Number.isInteger(r.shots) ? r.shots : undefined,
        preview: r.preview && typeof r.preview === 'object' ? r.preview : null,
      } : null;
      PREVIEW_LANG = LANGS.indexOf(d.lang) !== -1 ? d.lang : null;
      const picks = p && e ? [{ promo: p, entry: e }] : [];
      repaint = () => render(picks);
      repaint();
      // The block lives below the fold; bring it into the frame so the author sees it.
      const box = document.querySelector('[data-promo-block]');
      if (box && picks.length && box.scrollIntoView) box.scrollIntoView({ block: 'center' });
    });
    try { window.parent.postMessage({ type: 'xenon-promo-ready' }, HUB_ORIGIN); } catch (e) { /* not framed by the hub */ }
  }

  function boot() {
    // Not inside the catalog's own layout preview: that frame is about the arrangement.
    if (/(?:^|[#&])sf-preview=/.test(location.hash || '')) { announce([]); return; }
    if (/[?&]promo-preview=1(?:&|$)/.test(location.search || '') && window.parent !== window) { previewMode(); return; }
    load().catch(() => render([]));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
