'use strict';
// Community gallery ("Store") — browse artifacts published on the project
// site and install them through the NORMAL import pipeline.
//
// The catalog arrives via GET /api/community/catalog (server-normalized, TTL
// cached — see server/community-catalog.js). Every field is still treated as
// untrusted text here (textContent only), and tapping Import NEVER applies
// anything: it feeds the entry's share code into PresetShare.openImport, so
// the user gets the exact same per-kind preview/permission dialogs as a
// hand-pasted code. Live previews exist only for 'bg' entries and run inside
// the same sandboxed iframe the import preview uses (CustomBg.buildSrcdoc),
// created lazily while the card is on screen and torn down when it leaves.
//
// The presentation is a proper storefront: a cinematic hero spotlight, an
// icon category rail, and premium product cards — but every install still
// funnels through the one import boundary. Only the STATIC icon markup below
// is ever assigned via innerHTML; all catalog-supplied text stays textContent.
(function () {
  const t = (k, fb) => {
    const v = (typeof window.t === 'function') ? window.t(k) : k;
    return (v === k && fb != null) ? fb : v;
  };
  const el = makeEl; // shared DOM factory from utils.js
  const BMC_URL = 'https://www.buymeacoffee.com/marcimastro98';
  const HUB_BASE = 'https://xenon-supporter-hub.xenonedge.workers.dev';
  // Default reservation target for limited-edition drops (the project Discord
  // invite). A drop may override it via limited.reserveUrl, but only a Discord
  // https URL survives — re-checked here even though the server already
  // allowlisted it, so a bad value can never reach an href.
  const DISCORD_URL = 'https://discord.gg/MBVrw9kZyg';
  // Where supporters send their email/donation screenshot to be registered and
  // receive their personal access code (rendered only as a mailto: link).
  const SUPPORT_EMAIL = 'supportxenon@protonmail.com';
  function reserveUrlFor(entry) {
    const u = entry && entry.limited && entry.limited.reserveUrl;
    if (typeof u === 'string') {
      try {
        const p = new URL(u);
        const h = p.hostname.toLowerCase();
        if (p.protocol === 'https:' && (h === 'discord.gg' || h === 'discord.com' || h === 'www.discord.com')) return p.toString();
      } catch (e) { /* fall through to the default invite */ }
    }
    return DISCORD_URL;
  }

  function directClaimUrlFor(entry) {
    const limited = entry && entry.limited;
    if (!limited || limited.fulfillment !== 'hub' || limited.channels !== 'both') return '';
    if (typeof limited.dropId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,60}$/.test(limited.dropId)) return '';
    return HUB_BASE + '/limited/claim/' + encodeURIComponent(limited.dropId) + '?source=web';
  }

  function appendLimitedButtons(parent, entry) {
    const group = el('div', 'cgal-limited-buttons');
    const claimUrl = directClaimUrlFor(entry);
    if (claimUrl) {
      const claim = document.createElement('a');
      claim.className = 'cgal-btn cgal-claim'; claim.href = claimUrl;
      claim.target = '_blank'; claim.rel = 'noopener noreferrer';
      claim.appendChild(icon('limited'));
      claim.appendChild(el('span', null, t('gallery_claim_copy', 'Claim your copy')));
      group.appendChild(claim);
    }
    const discord = document.createElement('a');
    discord.className = 'cgal-btn cgal-discord'; discord.href = reserveUrlFor(entry);
    discord.target = '_blank'; discord.rel = 'noopener noreferrer';
    discord.appendChild(icon('discord'));
    discord.appendChild(el('span', null, t('gallery_reserve', 'Open Discord')));
    group.appendChild(discord);
    parent.appendChild(group);
  }

  async function hydrateLimitedStatus(entries) {
    const automatic = (entries || []).filter((entry) => entry && entry.limited && entry.limited.fulfillment === 'hub');
    const ids = [...new Set(automatic.map((entry) => entry.limited.dropId).filter(Boolean))];
    if (!ids.length) return;
    try {
      const out = await api('/api/community/limited-status?ids=' + encodeURIComponent(ids.join(',')));
      if (!out || !out.ok || !out.drops) return;
      automatic.forEach((entry) => {
        const live = out.drops[entry.limited.dropId];
        if (live) Object.assign(entry.limited, live);
      });
    } catch (e) { /* catalog fallback counters remain usable offline */ }
  }

  const api = apiJson; // shared fetch-JSON helper from utils.js

  let overlayEl = null;
  let detailEl = null;          // stacked detail overlay (a card opened up close)
  let zoomEl = null;            // fullscreen screenshot zoom (over everything)
  let previewObserver = null;   // IntersectionObserver for lazy bg previews
  // Screenshot sidecars are served from a Cloudflare R2 bucket (assets.xenon-app.com)
  // so binary blobs don't bloat the site repo; the URL is still derived from the
  // (charset-pinned) entry id — never from catalog-supplied text. A missing shot
  // 404s cleanly, so the webp→png→generated-canvas fallback in buildMedia/buildGallery
  // is unchanged. Publishing a drop now uploads shots to R2 instead of committing them.
  const SHOTS_BASE = 'https://assets.xenon-app.com/community/shots/';
  // Kind display order for the grouped ("browse all") view.
  const KIND_ORDER = ['bundle', 'theme', 'bg', 'page', 'widget', 'deck', 'ambient', 'icons', 'sounds'];
  const PAGE = 9;              // load-more page size for flat (filtered) views
  const SECTION_PREVIEW = 4;   // cards per kind before "See all"
  // Browse state (kept while the overlay is open).
  let searchQuery = '';
  let activeKind = '';
  let sortBy = 'feat';
  let shown = PAGE;
  let limitedOnly = false;   // dedicated "Limited edition" entry point
  let activeTab = 'browse';  // 'browse' (the catalog) | 'installed' (this machine)

  // ── Inline SVG icon set (STATIC, trusted markup — the ONLY innerHTML use). ──
  // Lucide-style 24px stroke glyphs so the rail and section heads read premium
  // and consistent instead of emoji. currentColor inherits the element colour.
  const S0 = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">';
  const ICONS = {
    store: S0 + '<path d="M3 9l1.6-4.5A1 1 0 0 1 5.5 4h13a1 1 0 0 1 .95.7L21 9"/><path d="M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z"/><path d="M5 13.5V20h14v-6.5"/><path d="M9.5 20v-4h5v4"/></svg>',
    all: S0 + '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/></svg>',
    theme: S0 + '<path d="M12 3c-4.9 0-9 3.6-9 8.4 0 3 2.3 5.1 5.1 5.1H10a1.8 1.8 0 0 1 1.4 3 1.6 1.6 0 0 0 1.3.6c4.6-.3 8.3-4.2 8.3-8.9C21 6.4 16.9 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="12" cy="8" r="1"/><circle cx="16.5" cy="11" r="1"/></svg>',
    bg: S0 + '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 16l4.5-4.5a1.5 1.5 0 0 1 2 0L16 18"/><path d="M14 15l1.8-1.8a1.5 1.5 0 0 1 2 0L21 16"/><circle cx="8" cy="9.5" r="1.4"/></svg>',
    page: S0 + '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 8.5h17"/><path d="M8.5 8.5V20"/></svg>',
    widget: S0 + '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M8 15.5a4 4 0 0 1 8 0"/><path d="M12 15.5V12"/></svg>',
    deck: S0 + '<rect x="3.5" y="4.5" width="4.3" height="4.3" rx="1.2"/><rect x="9.9" y="4.5" width="4.3" height="4.3" rx="1.2"/><rect x="16.3" y="4.5" width="4.3" height="4.3" rx="1.2"/><rect x="3.5" y="11" width="4.3" height="4.3" rx="1.2"/><rect x="9.9" y="11" width="4.3" height="4.3" rx="1.2"/><rect x="16.3" y="11" width="4.3" height="4.3" rx="1.2"/><rect x="3.5" y="17.5" width="4.3" height="2.3" rx="1.1"/><rect x="9.9" y="17.5" width="10.7" height="2.3" rx="1.1"/></svg>',
    ambient: S0 + '<path d="M20.5 14.3A8 8 0 1 1 9.7 3.5a6.3 6.3 0 0 0 10.8 10.8z"/></svg>',
    bundle: S0 + '<path d="M21 8.5l-9-5-9 5 9 5 9-5z"/><path d="M3 8.5V16l9 5 9-5V8.5"/><path d="M12 13.5V21"/></svg>',
    limited: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2.2l1.9 5.6a2 2 0 0 0 1.3 1.3l5.6 1.9-5.6 1.9a2 2 0 0 0-1.3 1.3L12 19.8l-1.9-5.6a2 2 0 0 0-1.3-1.3L3.2 11l5.6-1.9a2 2 0 0 0 1.3-1.3z"/></svg>',
    supporters: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 20.4l-1.5-1.3C5.7 14.9 3 12.4 3 9.3A4.3 4.3 0 0 1 7.3 5c1.5 0 3 .8 3.7 2 .7-1.2 2.2-2 3.7-2A4.3 4.3 0 0 1 21 9.3c0 3.1-2.7 5.6-7.5 9.8z"/></svg>',
    search: S0 + '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.2-4.2"/></svg>',
    check: S0 + '<path d="M20 6.5L9.2 17.3 4 12.1"/></svg>',
    update: S0 + '<path d="M12 4v10"/><path d="M8 8l4-4 4 4"/><path d="M5 18a7 7 0 0 0 14 0"/></svg>',
    refresh: S0 + '<path d="M20 11a8 8 0 1 0-1.8 6.3"/><path d="M20 5.5V11h-5.5"/></svg>',
    close: S0 + '<path d="M6 6l12 12M18 6L6 18"/></svg>',
    back: S0 + '<path d="M15 5l-7 7 7 7"/></svg>',
    expand: S0 + '<path d="M9 4H5a1 1 0 0 0-1 1v4"/><path d="M15 4h4a1 1 0 0 1 1 1v4"/><path d="M9 20H5a1 1 0 0 1-1-1v-4"/><path d="M15 20h4a1 1 0 0 0 1-1v-4"/></svg>',
    lock: S0 + '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 3l2.5 5.6 6.1.6-4.6 4 1.4 6-5.4-3.2L6.1 19.2l1.4-6-4.6-4 6.1-.6z"/></svg>',
    discord: S0 + '<path d="M21 12a8 8 0 0 1-8 8H8l-5 2 1.6-4A8 8 0 1 1 21 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg>',
  };
  function icon(name, cls) {
    const s = el('span', 'cgal-ic' + (cls ? ' ' + cls : ''));
    if (ICONS[name]) s.innerHTML = ICONS[name];   // static constant markup only
    return s;
  }
  function kindIcon(kind) { return icon(ICONS[kind] ? kind : 'widget'); }

  // Redraw generated canvas previews to the new size when the window resizes
  // (desktop browser) — the bitmap is fixed at draw time and would otherwise
  // stretch. Bound to the overlay lifecycle so nothing lingers after close.
  let resizeTimer = null;
  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!overlayEl) return;
      overlayEl.querySelectorAll('.cgal-media canvas').forEach((cv) => { if (cv._cgEntry) drawPreview(cv, cv._cgEntry); });
    }, 150);
  }

  function close() {
    if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
    window.removeEventListener('resize', onResize);
    closeZoom();
    // The detail scrim lives inside overlayEl, so it's removed with the store —
    // just drop its document-level Escape listener and the reference.
    if (detailEl) { document.removeEventListener('keydown', detailEl._onKey); detailEl = null; }
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  }

  function kindLabel(kind) {
    return t('gallery_kind_' + kind, t('preset_kind_' + kind, kind));
  }

  // ── Anonymous star ratings (proxied: /api/community/ratings|rate) ──────────
  // Aggregates load once per gallery render (batched ids, TTL-cached by the
  // local server) and paint into every .cgal-stars slot in the DOM. Averages
  // show only once an entry reaches the server's minimum vote count, so a
  // single vote can't dress up as consensus.
  let ratingsMap = {};
  let ratingsMin = 3;
  async function loadRatings(entries) {
    const ids = (entries || []).map((e) => e && e.id).filter(Boolean);
    if (!ids.length) return;
    for (let i = 0; i < ids.length; i += 100) {
      const out = await api('/api/community/ratings?ids=' + encodeURIComponent(ids.slice(i, i + 100).join(',')));
      if (!out || !out.ok || !out.ratings) continue;
      ratingsMin = Number(out.minDisplayCount) || ratingsMin;
      Object.assign(ratingsMap, out.ratings);
    }
    paintStars();
  }
  function starsText(r) {
    if (!r || !Number.isFinite(Number(r.avg)) || (Number(r.count) || 0) < ratingsMin) return '';
    return '★ ' + Number(r.avg).toFixed(1) + ' · ' + r.count;
  }
  function paintStars() {
    if (!overlayEl) return;
    overlayEl.querySelectorAll('.cgal-stars[data-id]').forEach((slot) => {
      slot.textContent = starsText(ratingsMap[slot.dataset.id]);
    });
  }
  // The detail view's interactive vote row: current average + five tap targets.
  // Fetched with mine=1 (the local server attaches the install id) so the
  // user's own vote is highlighted; a tap posts and repaints optimistically.
  function ratingBoxInto(host, entry) {
    const box = el('div', 'cgal-rate');
    const avg = el('span', 'cgal-rate-avg');
    const row = el('div', 'cgal-rate-row');
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', t('gallery_rate_title', 'Rate this'));
    box.appendChild(row); box.appendChild(avg);
    host.appendChild(box);
    let mine = 0;
    let voted = false;   // the user has cast a vote in this session
    const paint = () => {
      avg.textContent = starsText(ratingsMap[entry.id]) || t('gallery_rate_first', 'Be among the first to rate this');
      row.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i < mine));
    };
    for (let n = 1; n <= 5; n++) {
      const b = el('button', 'cgal-rate-star', '★');
      b.type = 'button';
      b.setAttribute('aria-label', n + '/5');
      b.addEventListener('click', async () => {
        const prev = mine;
        mine = n; voted = true; paint();
        const out = await api('/api/community/rate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entryId: entry.id, stars: n }),
        });
        if (out && out.ok) {
          if (window.XenonToast) XenonToast.show({ type: 'success', title: t('gallery_rating_saved', 'Thanks — rating saved!') });
          // Refresh the aggregate so the average reflects the new vote.
          const fresh = await api('/api/community/ratings?ids=' + encodeURIComponent(entry.id) + '&mine=1');
          if (fresh && fresh.ok && fresh.ratings) { Object.assign(ratingsMap, fresh.ratings); paintStars(); }
          paint();
        } else {
          mine = prev; paint();
          if (window.XenonToast) XenonToast.show({ type: 'error', title: t('gallery_rating_error', 'Couldn’t save the rating — try again later.') });
        }
      });
      row.appendChild(b);
    }
    paint();
    api('/api/community/ratings?ids=' + encodeURIComponent(entry.id) + '&mine=1').then((out) => {
      if (out && out.ok && out.ratings) {
        Object.assign(ratingsMap, out.ratings);
        // Don't let this late-resolving read stomp a vote the user already cast
        // (a slow hub + a fast tap would otherwise "undo" the saved vote).
        if (!voted) {
          const r = ratingsMap[entry.id];
          if (r && Number.isFinite(Number(r.mine))) mine = Number(r.mine);
        }
        paint();
      }
    }).catch(() => { /* offline — the control still works for a later tap */ });
  }

  // Lazy live preview for 'bg' entries: mount the sandboxed iframe only while
  // the card is visible, and only for inline codes (a codeFile entry would need
  // a fetch per card — not worth it for a browse view).
  function armPreview(host, entry) {
    if (entry.kind !== 'bg' || !entry.code || !window.CustomBg || !window.PresetShare) return;
    if (!previewObserver) {
      previewObserver = new IntersectionObserver((records) => {
        for (const r of records) {
          const box = r.target;
          if (r.isIntersecting && !document.body.classList.contains('game-mode')) {
            if (!box.firstChild && box._cgCode) {
              const frame = document.createElement('iframe');
              frame.className = 'cgal-preview-frame';
              frame.setAttribute('sandbox', 'allow-scripts');
              frame.setAttribute('referrerpolicy', 'no-referrer');
              frame.srcdoc = CustomBg.buildSrcdoc(box._cgCode, box._cgAssets, box._cgFps);
              box.appendChild(frame);
            }
          } else {
            box.replaceChildren();   // off-screen → stop the animation entirely
          }
        }
      }, { threshold: 0.15 });
    }
    const env = PresetShare.decodePreset(entry.code);
    if (!env || env.kind !== 'bg' || typeof env.data.code !== 'string') return;
    host._cgCode = env.data.code;
    // Bundled images ride the envelope — the preview must show them, or an
    // image-based background would look broken here yet fine on import.
    host._cgAssets = CustomBg.sanitizeBgAssets ? CustomBg.sanitizeBgAssets(env.data.assets) : null;
    // Preview at the background's own frame cap, so the smoothness (and cost)
    // the user judges is what an install would actually run at.
    host._cgFps = env.data.fps;
    previewObserver.observe(host);
  }

  async function resolveCode(entry) {
    if (entry.code) return entry.code;
    const d = await api('/api/community/code?id=' + encodeURIComponent(entry.id));
    return (d && d.ok && typeof d.code === 'string') ? d.code : null;
  }

  // ── Generated preview (fallback when an entry ships no screenshot) ──────────
  // Colours come only from the server-validated preview swatches (hex), used as
  // canvas fills — so a card is never an empty box.
  function catColors(entry) { const p = entry.preview || {}; return { a: p.accent || '#1ed760', b: p.bg || '#0a0f0d', t: p.text || '#e9f2ee' }; }
  function rgbaOf(c, al) { c = String(c || '#888').replace('#', ''); if (c.length === 3) c = c.split('').map((x) => x + x).join(''); if (c.length > 6) c = c.slice(0, 6); const n = parseInt(c, 16) || 0; return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + (al == null ? 1 : al) + ')'; }
  function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function drawPreview(canvas, entry) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 260, h = canvas.clientHeight || 146;
    if (!w || !h) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const g = canvas.getContext('2d'); if (!g) return; g.scale(dpr, dpr);
    const { a, b, t } = catColors(entry);
    g.fillStyle = b; g.fillRect(0, 0, w, h);
    const rg = g.createRadialGradient(w * 0.72, -h * 0.1, 0, w * 0.72, -h * 0.1, w * 0.9);
    rg.addColorStop(0, rgbaOf(a, 0.2)); rg.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = rg; g.fillRect(0, 0, w, h);
    const k = entry.kind;
    if (k === 'bg' || k === 'ambient') {
      for (let i = 0; i < 4; i++) { g.beginPath(); const y = h * (0.35 + i * 0.16); g.moveTo(0, y); for (let x = 0; x <= w; x += 12) g.lineTo(x, y + Math.sin(x * 0.03 + i * 1.3) * (10 - i * 1.5)); g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fillStyle = rgbaOf(a, 0.12 + i * 0.05); g.fill(); }
      if (k === 'ambient') { g.fillStyle = rgbaOf(t, 0.9); g.font = '700 ' + Math.round(h * 0.26) + 'px monospace'; g.textAlign = 'center'; g.fillText('21:48', w / 2, h * 0.54); }
    } else if (k === 'widget') {
      const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.26;
      g.lineWidth = r * 0.28; g.strokeStyle = rgbaOf(t, 0.14); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = a; g.lineCap = 'round'; g.beginPath(); g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 1.35); g.stroke();
      g.fillStyle = rgbaOf(t, 0.9); g.font = '800 ' + Math.round(r * 0.7) + 'px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('72', cx, cy + 1);
    } else if (k === 'deck') {
      const cols = 4, rows = 2, pad = w * 0.08, gap = w * 0.03, kw = (w - pad * 2 - gap * (cols - 1)) / cols, kh = kw * 0.86, oy = (h - (kh * rows + gap * (rows - 1))) / 2; let n = 0;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const x = pad + c * (kw + gap), y = oy + r * (kh + gap), lit = (n % 3 === 0); rr(g, x, y, kw, kh, 6); g.fillStyle = lit ? rgbaOf(a, 0.9) : rgbaOf(t, 0.08); g.fill(); g.fillStyle = lit ? rgbaOf(b, 0.85) : rgbaOf(t, 0.5); g.beginPath(); g.arc(x + kw / 2, y + kh / 2, kw * 0.16, 0, Math.PI * 2); g.fill(); n++; }
    } else { // theme / page / bundle → mini dashboard
      const pad = w * 0.07;
      rr(g, pad, h * 0.1, w - pad * 2, h * 0.11, 5); g.fillStyle = rgbaOf(t, 0.08); g.fill();
      rr(g, pad + 6, h * 0.13, w * 0.16, h * 0.05, 3); g.fillStyle = a; g.fill();
      const areaY = h * 0.26, areaH = h * 0.62, gap = w * 0.03, colW = (w - pad * 2 - gap) / 2;
      rr(g, pad, areaY, colW, areaH, 6); g.fillStyle = rgbaOf(t, 0.06); g.fill();
      rr(g, pad + colW * 0.12, areaY + areaH * 0.5, colW * 0.5, h * 0.04, 3); g.fillStyle = rgbaOf(a, 0.8); g.fill();
      rr(g, pad + colW * 0.12, areaY + areaH * 0.66, colW * 0.7, h * 0.03, 3); g.fillStyle = rgbaOf(t, 0.2); g.fill();
      rr(g, pad + colW + gap, areaY, colW, areaH * 0.46, 6); g.fillStyle = rgbaOf(t, 0.06); g.fill();
      rr(g, pad + colW + gap, areaY + areaH * 0.54, colW, areaH * 0.46, 6); g.fillStyle = rgbaOf(a, 0.14); g.fill();
      rr(g, pad + colW + gap + colW * 0.1, areaY + areaH * 0.68, colW * 0.55, h * 0.035, 3); g.fillStyle = rgbaOf(a, 0.85); g.fill();
      if (k === 'bundle') { const ky = h * 0.8, kw = w * 0.1; for (let i = 0; i < 5; i++) { rr(g, pad + i * (kw + w * 0.02), ky, kw, h * 0.11, 4); g.fillStyle = i % 2 ? a : rgbaOf(t, 0.1); g.fill(); } }
    }
  }

  // ── Media area (screenshot › live bg preview › generated canvas) ──────────
  // Shared by product cards and the hero spotlight. Always ends up filled.
  function buildMedia(entry, opts) {
    opts = opts || {};
    const media = el('div', 'cgal-media' + (opts.hero ? ' cgal-media-hero' : ''));
    const shotCount = entry.shots || (entry.screenshot ? 1 : 0);
    if (shotCount > 0) {
      const strip = el('div', 'cgal-shots');
      const shotUrl = (i, ext) => SHOTS_BASE + encodeURIComponent(entry.id) + (i === 1 ? '' : '-' + i) + '.' + ext;
      for (let i = 1; i <= shotCount; i++) {
        const shot = document.createElement('img');
        shot.className = 'cgal-shot'; shot.loading = 'lazy'; shot.alt = '';
        let triedPng = false;
        shot.addEventListener('error', () => {
          if (!triedPng) { triedPng = true; shot.src = shotUrl(i, 'png'); return; }
          shot.remove();
          if (!strip.querySelector('img')) {
            const cv = document.createElement('canvas'); cv._cgEntry = entry; media.insertBefore(cv, strip); strip.remove();
            requestAnimationFrame(() => drawPreview(cv, entry));
          }
        });
        shot.src = shotUrl(i, 'webp');
        strip.appendChild(shot);
      }
      media.appendChild(strip);
      if (shotCount > 1) { const dots = el('div', 'cgal-shotdots'); for (let i = 0; i < shotCount; i++) dots.appendChild(el('span', 'cgal-shotdot' + (i === 0 ? ' on' : ''))); media.appendChild(dots); }
    } else if (entry.kind === 'bg' && entry.code) {
      // Live animated bg preview (sandboxed iframe, lazily mounted on screen).
      const prev = el('div', 'cgal-preview');
      media.appendChild(prev);
      armPreview(prev, entry);
    } else {
      const cv = document.createElement('canvas'); cv._cgEntry = entry;
      media.appendChild(cv);
      requestAnimationFrame(() => drawPreview(cv, entry));
    }
    media.appendChild(el('div', 'cgal-media-veil'));
    return media;
  }

  // Publisher / author byline (publisher v2 wins; its link renders only because
  // the server already scheme+host-allowlisted it — github.com https).
  function bylineInto(host, entry) {
    host.appendChild(document.createTextNode(t('gallery_by', 'by') + ' '));
    if (entry.publisher && entry.publisher.handle) {
      if (entry.publisher.url) {
        const a = document.createElement('a');
        a.href = entry.publisher.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = '@' + entry.publisher.handle;
        host.appendChild(a);
      } else { host.appendChild(document.createTextNode('@' + entry.publisher.handle)); }
    } else { host.appendChild(document.createTextNode(entry.author || '—')); }
    if (entry.authorSupporter) { host.appendChild(document.createTextNode(' ')); const st = icon('star', 'cgal-authorstar'); st.title = t('gallery_supporter_badge', 'Xenon supporter'); host.appendChild(st); }
  }

  // The import button — normal + supporter (locked) both funnel through the one
  // import boundary; version gating is a server-computed verdict we just render.
  function importButton(entry, cls, label, iconName) {
    const b = el('button', cls); b.type = 'button';
    if (iconName) b.appendChild(icon(iconName));
    b.appendChild(el('span', null, label));
    if (entry.needsNewerApp) b.disabled = true;
    b.addEventListener('click', async () => {
      b.disabled = true;
      const code = await resolveCode(entry);
      b.disabled = false;
      if (!code) {
        if (window.XenonToast) XenonToast.show({ type: 'error', title: t('gallery_error', 'Could not load this entry.') });
        return;
      }
      close();
      if (window.PresetShare) PresetShare.openImport(code, { source: 'catalog', sourceId: entry.id, sourceVersion: entry.version || '' });
    });
    return b;
  }

  // ── Fullscreen screenshot zoom (opened from the detail gallery) ─────────────
  function closeZoom() {
    if (!zoomEl) return;
    document.removeEventListener('keydown', zoomEl._onKey);
    zoomEl.remove(); zoomEl = null;
  }
  function openZoom(urls, startIdx) {
    if (!urls || !urls.length) return;
    closeZoom();
    let i = Math.max(0, Math.min(urls.length - 1, startIdx || 0));
    const z = el('div', 'cgal-zoom' + (urls.length < 2 ? ' single' : ''));
    const img = document.createElement('img'); img.className = 'cgal-zoom-img'; img.alt = '';
    const show = () => { img.src = urls[i] || ''; };
    const prev = el('button', 'cgal-zoom-arrow cgal-zoom-prev'); prev.type = 'button'; prev.appendChild(icon('back'));
    const next = el('button', 'cgal-zoom-arrow cgal-zoom-next'); next.type = 'button'; next.appendChild(icon('back'));
    const x = el('button', 'cgal-zoom-x'); x.type = 'button'; x.appendChild(icon('close'));
    prev.addEventListener('click', (e) => { e.stopPropagation(); i = (i - 1 + urls.length) % urls.length; show(); });
    next.addEventListener('click', (e) => { e.stopPropagation(); i = (i + 1) % urls.length; show(); });
    x.addEventListener('click', closeZoom);
    z.addEventListener('click', (e) => { if (e.target === z) closeZoom(); });
    z._onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeZoom(); }
      else if (e.key === 'ArrowLeft') { i = (i - 1 + urls.length) % urls.length; show(); }
      else if (e.key === 'ArrowRight') { i = (i + 1) % urls.length; show(); }
    };
    document.addEventListener('keydown', z._onKey);
    z.appendChild(x); z.appendChild(prev); z.appendChild(img); z.appendChild(next);
    show();
    document.body.appendChild(z); zoomEl = z;
  }

  // ── Large media gallery for the detail view (all shots, zoomable) ───────────
  // Screenshots become a swipeable stage with prev/next, a thumbnail rail and
  // click-to-zoom; a bg entry shows its live sandboxed preview; everything else
  // falls back to the generated canvas — so the stage is never an empty box.
  function buildGallery(entry) {
    const gal = el('div', 'cgal-gal');
    const stage = el('div', 'cgal-gal-stage');
    const shotCount = entry.shots || (entry.screenshot ? 1 : 0);
    const shotUrl = (i, ext) => SHOTS_BASE + encodeURIComponent(entry.id) + (i === 1 ? '' : '-' + i) + '.' + ext;
    if (shotCount > 0) {
      const track = el('div', 'cgal-gal-track');
      const thumbs = el('div', 'cgal-gal-thumbs');
      const count = el('div', 'cgal-gal-count', '1 / ' + shotCount);
      const resolved = [];       // best-known URL per slide (webp, or png after a fallback)
      let idx = 0;
      const goTo = (n) => {
        idx = (n + shotCount) % shotCount;
        track.style.transform = 'translateX(-' + (idx * 100) + '%)';
        thumbs.querySelectorAll('.cgal-gal-thumb').forEach((th, k) => th.classList.toggle('on', k === idx));
        count.textContent = (idx + 1) + ' / ' + shotCount;
      };
      for (let i = 1; i <= shotCount; i++) {
        const slot = i - 1;
        resolved[slot] = shotUrl(i, 'webp');
        const slide = el('div', 'cgal-gal-slide');
        const img = document.createElement('img'); img.loading = 'lazy'; img.alt = '';
        let triedPng = false;
        img.addEventListener('error', () => { if (!triedPng) { triedPng = true; resolved[slot] = shotUrl(i, 'png'); img.src = resolved[slot]; } });
        img.addEventListener('click', () => openZoom(resolved, slot));
        img.src = resolved[slot];
        slide.appendChild(img); track.appendChild(slide);
        const th = el('button', 'cgal-gal-thumb' + (i === 1 ? ' on' : '')); th.type = 'button';
        const tim = document.createElement('img'); tim.loading = 'lazy'; tim.alt = '';
        let tTriedPng = false;
        tim.addEventListener('error', () => { if (!tTriedPng) { tTriedPng = true; tim.src = shotUrl(i, 'png'); } });
        tim.src = shotUrl(i, 'webp');
        th.appendChild(tim); th.addEventListener('click', () => goTo(slot)); thumbs.appendChild(th);
      }
      stage.appendChild(track);
      const zoomBtn = el('button', 'cgal-gal-zoom'); zoomBtn.type = 'button'; zoomBtn.title = t('gallery_zoom', 'Zoom'); zoomBtn.appendChild(icon('expand'));
      zoomBtn.addEventListener('click', () => openZoom(resolved, idx));
      stage.appendChild(zoomBtn);
      if (shotCount > 1) {
        const prev = el('button', 'cgal-gal-arrow cgal-gal-prev'); prev.type = 'button'; prev.appendChild(icon('back'));
        const next = el('button', 'cgal-gal-arrow cgal-gal-next'); next.type = 'button'; next.appendChild(icon('back'));
        prev.addEventListener('click', () => goTo(idx - 1)); next.addEventListener('click', () => goTo(idx + 1));
        stage.appendChild(prev); stage.appendChild(next); stage.appendChild(count);
      }
      gal.appendChild(stage);
      if (shotCount > 1) gal.appendChild(thumbs);
      return gal;
    }
    if (entry.kind === 'bg' && entry.code && window.CustomBg && window.PresetShare) {
      const env = PresetShare.decodePreset(entry.code);
      if (env && env.kind === 'bg' && typeof env.data.code === 'string') {
        const frame = document.createElement('iframe');
        frame.className = 'cgal-gal-frame';
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        const assets = CustomBg.sanitizeBgAssets ? CustomBg.sanitizeBgAssets(env.data.assets) : null;
        frame.srcdoc = CustomBg.buildSrcdoc(env.data.code, assets, env.data.fps);
        stage.appendChild(frame);
        gal.appendChild(stage);
        return gal;
      }
    }
    const cv = document.createElement('canvas'); cv._cgEntry = entry;
    stage.appendChild(cv);
    requestAnimationFrame(() => drawPreview(cv, entry));
    gal.appendChild(stage);
    return gal;
  }

  // ── Detail view: full gallery + complete info + the one CTA ─────────────────
  // A stacked overlay inside the store (closes back to the grid). Same import
  // boundary — the CTA still funnels through PresetShare.openImport.
  function openDetail(entry) {
    if (!overlayEl) return;
    if (detailEl) { document.removeEventListener('keydown', detailEl._onKey); detailEl.remove(); detailEl = null; }
    const limited = !!entry.limited;
    const locked = !limited && !!(entry.locked || entry.supportersOnly);
    const scrim = el('div', 'cgal-detail-scrim');
    const modal = el('div', 'cgal-detail' + (limited ? ' is-limited' : locked ? ' is-sup' : ''));
    const closeDetail = () => { if (detailEl) { document.removeEventListener('keydown', detailEl._onKey); detailEl.remove(); detailEl = null; } };

    const head = el('div', 'cgal-detail-head');
    const back = el('button', 'cgal-iconbtn'); back.type = 'button'; back.title = t('gallery_back', 'Back'); back.appendChild(icon('back'));
    const x = el('button', 'cgal-iconbtn'); x.type = 'button'; x.title = t('gallery_close', 'Close'); x.appendChild(icon('close'));
    back.addEventListener('click', closeDetail); x.addEventListener('click', closeDetail);
    head.appendChild(back); head.appendChild(el('div', 'cgal-detail-htitle', entry.name)); head.appendChild(x);

    const body = el('div', 'cgal-detail-body');
    body.appendChild(buildGallery(entry));

    const info = el('div', 'cgal-detail-info');
    const tier = el('div', 'cgal-detail-tier');
    if (limited) { tier.classList.add('t-limited'); tier.appendChild(icon('limited')); tier.appendChild(el('span', null, t('gallery_limited_badge', 'Limited'))); }
    else if (locked) { tier.classList.add('t-sup'); tier.appendChild(icon('supporters')); tier.appendChild(el('span', null, t('gallery_locked_badge', 'Supporters'))); }
    else { tier.appendChild(kindIcon(entry.kind)); tier.appendChild(el('span', null, kindLabel(entry.kind))); }
    info.appendChild(tier);

    info.appendChild(el('h3', 'cgal-detail-name', entry.name));
    const by = el('div', 'cgal-detail-by'); bylineInto(by, entry); info.appendChild(by);

    const meta = el('div', 'cgal-detail-meta');
    if (entry.version) meta.appendChild(el('span', 'cgal-metachip', 'v' + entry.version));
    if (entry.category) meta.appendChild(el('span', 'cgal-metachip', t('gallery_cat_' + entry.category.replace('-', '_'), entry.category)));
    if (meta.childElementCount) info.appendChild(meta);

    // Star rating: live average + this install's own vote (five tap targets).
    // Only for content the user can actually have installed — a locked
    // supporter drop or a limited/sold-out entry can't be tried without
    // unlocking, so rating it would be a non-owner vote; those show no control
    // (their cards still display the aggregate where one exists).
    if (!locked && !limited) ratingBoxInto(info, entry);

    if (entry.description) info.appendChild(el('p', 'cgal-detail-desc', entry.description));

    if (entry.preview && (entry.preview.accent || entry.preview.bg || entry.preview.text)) {
      const sw = el('div', 'cgal-detail-swatches');
      for (const key of ['accent', 'bg', 'text']) {
        const v = entry.preview[key]; if (!v) continue;
        const row = el('div', 'cgal-detail-sw');
        const dot = el('span', 'preset-swatch-dot'); dot.style.background = v; row.appendChild(dot);
        row.appendChild(el('span', 'cgal-detail-sw-hex', v));
        sw.appendChild(row);
      }
      if (sw.childElementCount) info.appendChild(sw);
    }

    if (Array.isArray(entry.tags) && entry.tags.length) {
      const tags = el('div', 'cgal-tags');
      entry.tags.forEach((tag) => tags.appendChild(el('span', 'cgal-tag', '#' + tag)));
      info.appendChild(tags);
    }

    const cta = el('div', 'cgal-detail-cta');
    if (limited) {
      const lim = entry.limited;
      if (lim.soldOut) cta.appendChild(el('span', 'cgal-soldout', t('gallery_limited_soldout', 'Sold out')));
      else {
        const total = Math.max(1, Number(lim.total) || 0), left = Math.max(0, Number(lim.left) || 0);
        const meterWrap = el('div', 'cgal-hero-meter');
        const bar = el('div', 'cgal-hero-bar'); const fill = el('div', 'cgal-hero-barfill');
        fill.style.width = Math.round(((total - left) / total) * 100) + '%'; bar.appendChild(fill); meterWrap.appendChild(bar);
        meterWrap.appendChild(el('span', 'cgal-hero-left', t('gallery_limited_left', '{n} of {t} left').replace('{n}', String(lim.left)).replace('{t}', String(lim.total))));
        cta.appendChild(meterWrap);
        appendLimitedButtons(cta, entry);
      }
    } else if (locked) {
      cta.appendChild(importButton(entry, 'cgal-btn cgal-btn-hero cgal-unlock', t('gallery_unlock', 'Unlock with a code'), 'lock'));
    } else {
      cta.appendChild(importButton(entry, 'cgal-btn cgal-btn-hero primary', t('gallery_import', 'Import…')));
    }
    if (entry.needsNewerApp) cta.appendChild(el('span', 'cgal-needs', t('gallery_requires_version', 'Requires Xenon') + ' v' + entry.appVersionMin));
    info.appendChild(cta);

    body.appendChild(info);
    modal.appendChild(head); modal.appendChild(body);
    scrim.appendChild(modal);
    scrim.addEventListener('click', (ev) => { if (ev.target === scrim) closeDetail(); });
    scrim._onKey = (e) => { if (e.key === 'Escape' && !zoomEl) closeDetail(); };
    document.addEventListener('keydown', scrim._onKey);
    overlayEl.appendChild(scrim);
    detailEl = scrim;
  }

  // "How it works" for the Supporters tier — a compact perks panel (what you
  // get, how long it lasts, the Discord role) with the two CTAs. Kept out of the
  // shelf itself so the dense Store stays glanceable; opened on demand.
  function openSupporterInfo() {
    if (!overlayEl) return;
    if (detailEl) { document.removeEventListener('keydown', detailEl._onKey); detailEl.remove(); detailEl = null; }
    const scrim = el('div', 'cgal-detail-scrim');
    const modal = el('div', 'cgal-info is-sup');
    const closeIt = () => { if (detailEl) { document.removeEventListener('keydown', detailEl._onKey); detailEl.remove(); detailEl = null; } };
    const head = el('div', 'cgal-detail-head');
    const mark = el('div', 'cgal-info-mark'); mark.appendChild(icon('supporters'));
    head.appendChild(mark);
    head.appendChild(el('div', 'cgal-detail-htitle', t('gallery_supporters_section', 'Supporters')));
    const x = el('button', 'cgal-iconbtn'); x.type = 'button'; x.title = t('gallery_close', 'Close'); x.appendChild(icon('close')); x.addEventListener('click', closeIt);
    head.appendChild(x);
    const body = el('div', 'cgal-info-body');
    body.appendChild(el('p', 'cgal-info-lead', t('gallery_supporters_lead', 'Themes and packs reserved for Xenon supporters — become one to unlock them.')));
    const ul = el('ul', 'cgal-info-perks');
    ['gallery_sup_perk1', 'gallery_sup_perk2', 'gallery_sup_perk3', 'gallery_sup_code_note'].forEach((k) => {
      const li = document.createElement('li');
      li.appendChild(icon('check', 'cgal-info-tick'));
      li.appendChild(el('span', null, t(k, '')));
      ul.appendChild(li);
    });
    body.appendChild(ul);
    // Codes now arrive automatically by email (supporter hub); Discord/email
    // stays as the didn't-get-it fallback, with the address right there.
    const note = el('div', 'cgal-info-note');
    note.appendChild(el('span', null, t('gallery_sup_register', 'Your personal code arrives by email right after you support. Didn’t get it? Reach us on Discord or at')));
    const mail = document.createElement('a');
    mail.className = 'cgal-info-mail'; mail.href = 'mailto:' + SUPPORT_EMAIL; mail.textContent = SUPPORT_EMAIL;
    note.appendChild(mail);
    body.appendChild(note);
    const cta = el('div', 'cgal-info-cta');
    const bmc = document.createElement('a'); bmc.className = 'cgal-btn cgal-info-bmc'; bmc.href = BMC_URL; bmc.target = '_blank'; bmc.rel = 'noopener noreferrer'; bmc.appendChild(icon('supporters')); bmc.appendChild(el('span', null, t('gallery_supporters_join', 'Become a supporter')));
    const disc = document.createElement('a'); disc.className = 'cgal-btn'; disc.href = DISCORD_URL; disc.target = '_blank'; disc.rel = 'noopener noreferrer'; disc.textContent = t('gallery_sup_discord', 'Join the Discord');
    cta.appendChild(bmc); cta.appendChild(disc);
    body.appendChild(cta);
    modal.appendChild(head); modal.appendChild(body);
    scrim.appendChild(modal);
    scrim.addEventListener('click', (ev) => { if (ev.target === scrim) closeIt(); });
    scrim._onKey = (e) => { if (e.key === 'Escape' && !zoomEl) closeIt(); };
    document.addEventListener('keydown', scrim._onKey);
    overlayEl.appendChild(scrim);
    detailEl = scrim;
  }

  // Open the detail view from a card/hero click, unless the tap landed on an
  // actual control (Import/Reserve button, a byline link) — those act directly.
  function wireCardOpen(node, entry) {
    node.classList.add('cgal-clickable');
    node.tabIndex = 0; node.setAttribute('role', 'button');
    node.addEventListener('click', (ev) => { if (ev.target.closest('.cgal-card-actions, .cgal-hero-cta, a, button')) return; openDetail(entry); });
    node.addEventListener('keydown', (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === node) { ev.preventDefault(); openDetail(entry); } });
  }

  // ── Cinematic hero spotlight for the "browse all" view ──────────────────────
  // Features the top limited drop (else the featured browse entry). Big media,
  // exclusivity treatment, a single decisive CTA.
  function heroBanner(entry) {
    const limited = !!entry.limited;
    const locked = !limited && !!(entry.locked || entry.supportersOnly);
    const hero = el('div', 'cgal-hero' + (limited ? ' is-limited' : locked ? ' is-sup' : ''));

    const media = buildMedia(entry, { hero: true });
    // Theme swatches float over the media so a theme hero reads its palette.
    if (entry.preview && (entry.preview.accent || entry.preview.bg || entry.preview.text)) {
      const sw = el('div', 'cgal-swatches');
      for (const key of ['accent', 'bg', 'text']) { const v = entry.preview[key]; if (!v) continue; const dot = el('span', 'preset-swatch-dot'); dot.style.background = v; sw.appendChild(dot); }
      if (sw.childElementCount) media.appendChild(sw);
    }
    hero.appendChild(media);

    const info = el('div', 'cgal-hero-info');
    const eyebrow = el('div', 'cgal-hero-eyebrow');
    if (limited) { eyebrow.appendChild(icon('limited')); eyebrow.appendChild(el('span', null, t('gallery_limited_section', 'Limited edition'))); }
    else if (locked) { eyebrow.appendChild(icon('supporters')); eyebrow.appendChild(el('span', null, t('gallery_supporters_section', 'Supporters'))); }
    else { eyebrow.appendChild(icon('limited')); eyebrow.appendChild(el('span', null, t('gallery_sort_feat', 'Featured'))); }
    eyebrow.appendChild(el('span', 'cgal-hero-kind', kindLabel(entry.kind)));
    info.appendChild(eyebrow);

    info.appendChild(el('h4', 'cgal-hero-title', entry.name));
    const by = el('div', 'cgal-hero-by'); bylineInto(by, entry); info.appendChild(by);
    if (entry.description) info.appendChild(el('p', 'cgal-hero-desc', entry.description));

    if (Array.isArray(entry.tags) && entry.tags.length) {
      const tags = el('div', 'cgal-tags');
      entry.tags.slice(0, 4).forEach((tag) => tags.appendChild(el('span', 'cgal-tag', '#' + tag)));
      info.appendChild(tags);
    }

    const cta = el('div', 'cgal-hero-cta');
    if (limited) {
      const lim = entry.limited;
      if (lim.soldOut) {
        cta.appendChild(el('span', 'cgal-soldout', t('gallery_limited_soldout', 'Sold out')));
      } else {
        const total = Math.max(1, Number(lim.total) || 0);
        const left = Math.max(0, Number(lim.left) || 0);
        const meter = el('div', 'cgal-hero-meter');
        const bar = el('div', 'cgal-hero-bar'); const fill = el('div', 'cgal-hero-barfill');
        fill.style.width = Math.round(((total - left) / total) * 100) + '%'; bar.appendChild(fill); meter.appendChild(bar);
        meter.appendChild(el('span', 'cgal-hero-left', t('gallery_limited_left', '{n} of {t} left').replace('{n}', String(lim.left)).replace('{t}', String(lim.total))));
        info.appendChild(meter);
        appendLimitedButtons(cta, entry);
      }
    } else if (locked) {
      cta.appendChild(importButton(entry, 'cgal-btn cgal-btn-hero cgal-unlock', t('gallery_unlock', 'Unlock with a code'), 'lock'));
    } else {
      cta.appendChild(importButton(entry, 'cgal-btn cgal-btn-hero primary', t('gallery_import', 'Import…')));
    }
    if (entry.needsNewerApp) cta.appendChild(el('span', 'cgal-needs', t('gallery_requires_version', 'Requires Xenon') + ' v' + entry.appVersionMin));
    info.appendChild(cta);
    hero.appendChild(info);
    wireCardOpen(hero, entry);
    return hero;
  }

  // One uniform product card.
  function renderCard(entry) {
    const locked = !!(entry.locked || entry.supportersOnly);
    const limited = !!entry.limited;
    const card = el('div', 'cgal-card' + (limited ? ' is-limited' : locked ? ' is-sup' : '') + (limited && entry.limited.soldOut ? ' dim' : ''));
    card.id = 'cgal-' + entry.id;
    wireCardOpen(card, entry);

    const media = buildMedia(entry);
    // Tier pill (top-left) — the loudest signal on the card.
    const tier = el('div', 'cgal-tier');
    if (limited) { tier.classList.add('t-limited'); tier.appendChild(icon('limited')); tier.appendChild(el('span', null, t('gallery_limited_badge', 'Limited'))); }
    else if (locked) { tier.classList.add('t-sup'); tier.appendChild(icon('supporters')); tier.appendChild(el('span', null, t('gallery_locked_badge', 'Supporters'))); }
    else { tier.appendChild(kindIcon(entry.kind)); tier.appendChild(el('span', null, kindLabel(entry.kind))); }
    media.appendChild(tier);
    // Theme swatches (server-validated hex — used only as CSS background).
    if (entry.preview && (entry.preview.accent || entry.preview.bg || entry.preview.text)) {
      const sw = el('div', 'cgal-swatches');
      for (const key of ['accent', 'bg', 'text']) { const v = entry.preview[key]; if (!v) continue; const dot = el('span', 'preset-swatch-dot'); dot.style.background = v; sw.appendChild(dot); }
      if (sw.childElementCount) media.appendChild(sw);
    }
    if (locked) { const lk = el('div', 'cgal-lock'); lk.appendChild(icon('lock')); media.appendChild(lk); }
    card.appendChild(media);

    const body = el('div', 'cgal-body');
    const nameRow = el('div', 'cgal-name', entry.name);
    if (entry.version) nameRow.appendChild(el('span', 'cgal-version', ' v' + entry.version));
    body.appendChild(nameRow);
    const by = el('div', 'cgal-author'); bylineInto(by, entry);
    if (entry.category) { by.appendChild(document.createTextNode(' · ')); by.appendChild(el('span', 'cgal-catlabel', t('gallery_cat_' + entry.category.replace('-', '_'), entry.category))); }
    // Async-filled star slot (paintStars) — empty until the aggregates land,
    // and stays empty below the minimum vote count.
    const stars = el('span', 'cgal-stars', starsText(ratingsMap[entry.id]));
    stars.dataset.id = entry.id;
    by.appendChild(stars);
    body.appendChild(by);
    if (entry.description) body.appendChild(el('div', 'cgal-desc', entry.description));
    if (Array.isArray(entry.tags) && entry.tags.length) {
      const tags = el('div', 'cgal-tags');
      entry.tags.slice(0, 3).forEach((tag) => tags.appendChild(el('span', 'cgal-tag', '#' + tag)));
      body.appendChild(tags);
    }

    const row = el('div', 'cgal-card-actions');
    if (limited) {
      const lim = entry.limited;
      if (lim.soldOut) {
        row.appendChild(el('span', 'cgal-soldout', t('gallery_limited_soldout', 'Sold out')));
      } else {
        appendLimitedButtons(row, entry);
        row.appendChild(el('span', 'cgal-limcount',
          t('gallery_limited_left', '{n} of {t} left').replace('{n}', String(lim.left)).replace('{t}', String(lim.total))));
      }
      body.appendChild(row); card.appendChild(body);
      return card;
    }
    row.appendChild(importButton(entry, locked ? 'cgal-btn cgal-unlock' : 'cgal-btn primary', locked ? t('gallery_unlock', 'Unlock with a code') : t('gallery_import', 'Import…'), locked ? 'lock' : null));
    if (entry.needsNewerApp) row.appendChild(el('span', 'cgal-needs', t('gallery_requires_version', 'Requires Xenon') + ' v' + entry.appVersionMin));
    body.appendChild(row);
    card.appendChild(body);
    return card;
  }

  // Available updates for INSTALLED catalog content. Two joins, one verdict:
  //   - SDK packages: entries whose pkgId matches an installed manifest with an
  //     older version (the original join);
  //   - every other kind (themes, decks, pages, icon/sound packs, bundles…):
  //     entries whose id matches a contentInstalls receipt recorded with an
  //     older sourceVersion (receipts carry {sourceId, sourceVersion} since
  //     v4.5.3 — older receipts lack the field and are fail-closed skipped).
  // Best-effort (empty when nothing installed / offline). THE single
  // update-join implementation — Settings' installed-packages manager and the
  // daily check consume it via window.CommunityGallery.findUpdates, so the
  // surfaces can never disagree about whether an update exists. Locked entries
  // are excluded: they can't be one-click updated (the code needs an access
  // code). "Update" is always a normal re-import: full preview + permission
  // re-approval by construction, never a silent swap.
  async function findUpdates(entries) {
    // Fail-CLOSED parse (mirrors server/semver.js, which is server-only):
    // installed manifest versions are loosely validated ('v1.2.3',
    // '2.0.0-beta' survive install), and coercing junk to 0.0.0 would show a
    // false "update available" badge inviting a downgrade-reinstall. A
    // malformed side must never produce an update hint.
    const parse = (v) => (/^[0-9]+(\.[0-9]+)*$/.test(String(v)) ? String(v).split('.').map(Number) : null);
    const less = (a, b) => {
      const pa = parse(a), pb = parse(b);
      if (!pa || !pb) return false;
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
      }
      return false;
    };
    let installed = new Map();
    try {
      const inst = await api('/sdk/widgets');
      installed = new Map(((inst && inst.packages) || []).map((p) => [p.id, String(p.version || '0.0.0')]));
    } catch { /* SDK off / offline → pkg join contributes nothing */ }
    // Newest receipt per catalog entry id. Receipts are appended
    // chronologically, so a plain forward walk leaves the latest version in
    // the map — an update re-import "wins" and clears the badge. hubSettings
    // is a shared-script-scope global from settings.js (bare name, guarded —
    // same access pattern preset-share.js uses).
    const receipts = new Map();
    try {
      const list = (typeof hubSettings !== 'undefined' && hubSettings && Array.isArray(hubSettings.contentInstalls))
        ? hubSettings.contentInstalls : [];
      for (const rec of list) {
        if (rec && typeof rec.sourceId === 'string' && rec.sourceId && typeof rec.sourceVersion === 'string' && rec.sourceVersion) {
          receipts.set(rec.sourceId, rec.sourceVersion);
        }
      }
    } catch { /* settings unavailable → receipts join contributes nothing */ }
    if (!installed.size && !receipts.size) return [];
    return entries.filter((e) => {
      if (!e || !e.version || e.locked) return false;
      if (e.pkgId) return installed.has(e.pkgId) && less(installed.get(e.pkgId), e.version);
      return receipts.has(e.id) && less(receipts.get(e.id), e.version);
    });
  }

  function matchesBrowse(entry) {
    if (searchQuery) {
      const hay = [entry.name, entry.author, entry.description,
        entry.publisher && entry.publisher.handle, ...(entry.tags || [])].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(searchQuery.replace(/^#/, ''))) return false;
    }
    return true;
  }
  function sortList(list) {
    if (sortBy === 'name') return list.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (sortBy === 'new') return list.slice().sort((a, b) => (b._i || 0) - (a._i || 0));
    return list.slice().sort((a, b) => (a._i || 0) - (b._i || 0));   // 'feat' = catalog order
  }

  // Shimmer skeleton so the first paint reads as a loading store, not a blank box.
  function skeleton(n) {
    const wrap = el('div', 'cgal-grid');
    for (let i = 0; i < (n || 6); i++) {
      const c = el('div', 'cgal-card cgal-skel');
      c.appendChild(el('div', 'cgal-media cgal-skel-media'));
      const b = el('div', 'cgal-body');
      b.appendChild(el('div', 'cgal-skel-line w70'));
      b.appendChild(el('div', 'cgal-skel-line w40'));
      b.appendChild(el('div', 'cgal-skel-line w90'));
      b.appendChild(el('div', 'cgal-skel-btn'));
      c.appendChild(b); wrap.appendChild(c);
    }
    return wrap;
  }

  async function render(body, filterKind, force) {
    // A re-render (↻) replaces every card — release the old ones from the
    // preview observer or refreshed grids pile up detached nodes + bg code.
    if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
    body.replaceChildren(skeleton(6));
    const out = await api('/api/community/catalog' + (force ? '?refresh=1' : ''));
    if (!overlayEl) return;   // closed while loading
    if (!out || !out.ok) {
      body.replaceChildren(el('div', 'cgal-status', t('gallery_error', 'Could not load the gallery. Check your connection and retry.')));
      return;
    }
    const all = Array.isArray(out.entries) ? out.entries : [];
    await hydrateLimitedStatus(all);
    if (!overlayEl) return;
    all.forEach((e, i) => { if (e) e._i = i; });
    // Two special tiers get their own treatment; everything else is the browse set.
    const limited = all.filter((e) => e && e.limited);
    const supporters = all.filter((e) => e && !e.limited && (e.locked || e.supportersOnly));
    const browse = all.filter((e) => e && !e.limited && !(e.locked || e.supportersOnly));
    if (filterKind && filterKind !== '__limited') activeKind = filterKind;

    // Dedicated limited-only view (opened from the Settings entry point).
    if (limitedOnly) {
      const frag = document.createDocumentFragment();
      const lim = sortList(limited);
      if (lim.length) { frag.appendChild(heroBanner(lim[0])); if (lim.length > 1) { const lgrid = el('div', 'cgal-grid'); lim.slice(1).forEach((e) => lgrid.appendChild(renderCard(e))); frag.appendChild(lgrid); } }
      else frag.appendChild(el('div', 'cgal-status', t('gallery_limited_empty', 'No limited drops right now — check back soon.')));
      body.replaceChildren(frag);
      return;
    }

    const updates = await findUpdates(browse);
    if (!overlayEl) return;

    // ── Toolbar: search + sort select + kind rail ──
    // No category filter: `category` says what a creation is ABOUT, `kind` says
    // what it IS, and the two taxonomies collided on "Deck" — the same single
    // entry answered both, so the dropdown read as a duplicate of the rail. It
    // earned little else: most entries carry `style` and some carry nothing.
    // The category survives as a label on the card; only the filter is gone.
    const bar = el('div', 'cgal-toolbar');
    const searchRow = el('div', 'cgal-searchrow');
    const searchBox = el('div', 'cgal-searchbox');
    searchBox.appendChild(icon('search', 'cgal-search-ic'));
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'cgal-search';
    search.placeholder = t('gallery_search_ph', 'Search name, author, #tag…');
    search.value = searchQuery;
    let searchTimer = null;
    search.addEventListener('input', () => {
      searchQuery = search.value.trim().toLowerCase(); shown = PAGE;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => paintGrid(), 150);
    });
    searchBox.appendChild(search);
    searchRow.appendChild(searchBox);

    const sortWrap = el('div', 'cgal-select');
    const selSort = document.createElement('select'); selSort.className = 'cgal-select-el'; selSort.setAttribute('data-cs-fixed', '');
    [['feat', t('gallery_sort_feat', 'Featured')], ['new', t('gallery_sort_new', 'Newest')], ['name', t('gallery_sort_name', 'Name A–Z')]]
      .forEach(([v, label]) => { const o = document.createElement('option'); o.value = v; o.textContent = label; selSort.appendChild(o); });
    selSort.value = sortBy;
    selSort.addEventListener('change', () => { sortBy = selSort.value; paintGrid(); });
    sortWrap.appendChild(selSort); searchRow.appendChild(sortWrap);
    if (window.initCustomSelect) initCustomSelect(selSort);
    bar.appendChild(searchRow);

    // Icon category rail.
    const seg = el('div', 'cgal-rail');
    const kinds = KIND_ORDER.filter((k) => browse.some((e) => e.kind === k));
    const mkSeg = (iconName, label, k, cls) => {
      const b = el('button', 'cgal-railbtn' + (cls ? ' ' + cls : '')); b.type = 'button'; b.dataset.k = k;
      b.appendChild(icon(iconName));
      b.appendChild(el('span', 'cgal-railtxt', label));
      b.addEventListener('click', () => { activeKind = (k === 'all') ? '' : k; shown = PAGE; syncControls(); paintGrid(); });
      return b;
    };
    seg.appendChild(mkSeg('all', t('gallery_all', 'All'), 'all'));
    if (limited.length) seg.appendChild(mkSeg('limited', t('gallery_limited_badge', 'Limited'), '__limited', 'lim'));
    if (supporters.length) seg.appendChild(mkSeg('supporters', t('gallery_supporters_section', 'Supporters'), '__supporters', 'sup'));
    kinds.forEach((k) => seg.appendChild(mkSeg(k, kindLabel(k), k)));
    bar.appendChild(seg);

    function syncControls() {
      seg.querySelectorAll('.cgal-railbtn').forEach((b) => b.classList.toggle('active', b.dataset.k === (activeKind || 'all')));
      selSort.value = sortBy;
    }

    const host = el('div', 'cgal-gridhost');
    const stale = out.stale ? el('div', 'cgal-status cgal-stale', t('gallery_stale', 'Offline — showing the last saved copy.')) : null;

    // ── View builders ──
    function section(k, items, iconName, titleText) {
      const wrap = el('div', 'cgal-kblock');
      const head = el('div', 'cgal-khead');
      const l = el('div', 'cgal-khead-l');
      l.appendChild(icon(iconName || k, 'cgal-khead-ic'));
      l.appendChild(el('span', 'cgal-khead-title', titleText || kindLabel(k)));
      l.appendChild(el('span', 'cgal-khead-cnt', String(items.length)));
      head.appendChild(l);
      if (items.length > SECTION_PREVIEW && k !== '__updates') {
        const sa = el('button', 'cgal-seeall'); sa.type = 'button';
        sa.appendChild(el('span', null, t('gallery_seeall', 'See all'))); sa.appendChild(document.createTextNode(' ' + items.length + ' →'));
        sa.addEventListener('click', () => { activeKind = k; shown = PAGE; syncControls(); paintGrid(); });
        head.appendChild(sa);
      }
      wrap.appendChild(head);
      const grid = el('div', 'cgal-grid');
      items.slice(0, k === '__updates' ? items.length : SECTION_PREVIEW).forEach((e) => grid.appendChild(renderCard(e)));
      wrap.appendChild(grid);
      return wrap;
    }
    // A premium "shelf" for the two exclusive tiers (Limited and Supporters) —
    // deliberately on par: a tinted bordered container, a lead line, an optional
    // join action in the head, and the tier's own cards. Same footprint so
    // neither reads as the poor cousin of the other.
    function featureSection(opts) {
      const wrap = el('div', 'cgal-kblock cgal-feat-block ' + (opts.cls || ''));
      const head = el('div', 'cgal-khead');
      const l = el('div', 'cgal-khead-l');
      l.appendChild(icon(opts.iconName, 'cgal-khead-ic'));
      l.appendChild(el('span', 'cgal-khead-title', opts.title));
      l.appendChild(el('span', 'cgal-khead-cnt', String(opts.items.length)));
      head.appendChild(l);
      const actions = el('div', 'cgal-khead-actions');
      if (opts.items.length > SECTION_PREVIEW) {
        const sa = el('button', 'cgal-seeall'); sa.type = 'button';
        sa.appendChild(el('span', null, t('gallery_seeall', 'See all'))); sa.appendChild(document.createTextNode(' ' + opts.items.length + ' →'));
        sa.addEventListener('click', () => { activeKind = opts.seeAllKind; shown = PAGE; syncControls(); paintGrid(); });
        actions.appendChild(sa);
      }
      if (opts.onInfo) {
        const info = el('button', 'cgal-seeall cgal-feat-how'); info.type = 'button';
        info.appendChild(el('span', null, t('gallery_sup_how', 'How it works')));
        info.addEventListener('click', opts.onInfo);
        actions.appendChild(info);
      }
      if (opts.joinLabel) {
        const join = document.createElement('a');
        join.className = 'cgal-btn cgal-feat-join';
        join.href = opts.joinHref; join.target = '_blank'; join.rel = 'noopener noreferrer';
        if (opts.joinIcon) join.appendChild(icon(opts.joinIcon));
        join.appendChild(el('span', null, opts.joinLabel));
        actions.appendChild(join);
      }
      if (actions.childElementCount) head.appendChild(actions);
      wrap.appendChild(head);
      if (opts.lead) wrap.appendChild(el('p', 'cgal-feat-lead', opts.lead));
      const grid = el('div', 'cgal-grid');
      opts.items.slice(0, SECTION_PREVIEW).forEach((e) => grid.appendChild(renderCard(e)));
      wrap.appendChild(grid);
      return wrap;
    }
    function flatInto(frag, list) {
      list = sortList(list);
      if (!list.length) { frag.appendChild(el('div', 'cgal-status', t('gallery_empty', 'Nothing here yet — new community creations will appear as they are published.'))); return; }
      const grid = el('div', 'cgal-grid');
      list.slice(0, shown).forEach((e) => grid.appendChild(renderCard(e)));
      frag.appendChild(grid);
      if (list.length > shown) {
        const lm = el('div', 'cgal-loadmore');
        const b = el('button', 'cgal-btn cgal-loadmore-btn', t('gallery_loadmore', 'Show more ({n})').replace('{n}', String(list.length - shown))); b.type = 'button';
        b.addEventListener('click', () => { shown += PAGE; paintGrid(); });
        lm.appendChild(b); frag.appendChild(lm);
      }
    }

    function paintGrid() {
      if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
      const frag = document.createDocumentFragment();
      if (activeKind === '__limited') {
        const lim = sortList(limited.filter(matchesBrowse));
        if (lim.length) { frag.appendChild(heroBanner(lim[0])); if (lim.length > 1) { const g = el('div', 'cgal-grid'); lim.slice(1).forEach((e) => g.appendChild(renderCard(e))); frag.appendChild(g); } }
        else frag.appendChild(el('div', 'cgal-status', t('gallery_limited_empty', 'No limited drops right now — check back soon.')));
        host.replaceChildren(frag); return;
      }
      if (activeKind === '__supporters') { flatInto(frag, supporters.filter(matchesBrowse)); host.replaceChildren(frag); return; }

      let pool = browse.filter(matchesBrowse);
      if (activeKind) pool = pool.filter((e) => e.kind === activeKind);

      const browsingAll = !activeKind && !searchQuery;
      // Filtered views must keep the exclusive tiers findable: a search or a
      // kind filter includes matching limited + supporters entries in
      // the results (each card carries its own tier badge and CTA). Without
      // this, searching a locked theme's name says "Nothing here yet" even
      // though the entry exists — the tier shelves render only in browse-all.
      if (!browsingAll) {
        let tierPool = limited.concat(supporters).filter(matchesBrowse);
        if (activeKind) tierPool = tierPool.filter((e) => e.kind === activeKind);
        pool = pool.concat(tierPool);
      }
      if (browsingAll) {
        // Hero priority ladder (what leads the Store, big, up top):
        //   1. an AVAILABLE limited drop  →  2. a supporter/paid creation
        //   →  3. the featured free creation.
        // A sold-out limited never leads (dead end) — it still shows in its own
        // Limited section below. This is the "entice, don't frustrate" order.
        const availLimited = sortList(limited).filter((e) => !(e.limited && e.limited.soldOut));
        const heroEntry = availLimited[0]
          || sortList(supporters)[0]
          || (pool.length ? sortList(pool)[0] : (limited.length ? sortList(limited)[0] : null));
        const heroId = heroEntry ? heroEntry.id : null;
        if (heroEntry) frag.appendChild(heroBanner(heroEntry));
        if (updates.length) frag.appendChild(section('__updates', updates, 'update', t('gallery_updates', 'Updates for your widgets')));
        // Two exclusive shelves, on par with each other: Limited then Supporters.
        const restLimited = sortList(limited).filter((e) => e.id !== heroId);
        if (restLimited.length) frag.appendChild(featureSection({
          items: restLimited, iconName: 'limited', cls: 'is-limited', seeAllKind: '__limited',
          title: t('gallery_limited_section', 'Limited edition'),
          lead: t('gallery_limited_lead_short', 'A fixed number of copies worldwide — reserved on Discord.'),
        }));
        const restSupporters = sortList(supporters).filter((e) => e.id !== heroId);
        if (restSupporters.length) frag.appendChild(featureSection({
          items: restSupporters, iconName: 'supporters', cls: 'is-sup', seeAllKind: '__supporters',
          title: t('gallery_supporters_section', 'Supporters'),
          lead: t('gallery_supporters_lead', 'Themes and packs reserved for Xenon supporters — become one to unlock them.'),
          joinLabel: t('gallery_supporters_join', 'Become a supporter'), joinHref: BMC_URL, joinIcon: 'supporters',
          onInfo: openSupporterInfo,
        }));
        KIND_ORDER.forEach((k) => { const items = sortList(pool.filter((e) => e.kind === k && e.id !== heroId)); if (items.length) frag.appendChild(section(k, items)); });
        host.replaceChildren(frag);
        return;
      }
      flatInto(frag, pool);
      host.replaceChildren(frag);
    }

    const shell = document.createDocumentFragment();
    shell.appendChild(bar); shell.appendChild(host); if (stale) shell.appendChild(stale);
    body.replaceChildren(shell);
    syncControls();
    paintGrid();
    // Star aggregates: best-effort async fill (a hub hiccup just leaves the
    // slots empty — the gallery never waits on it). paintGrid rebuilds cards
    // from the already-loaded map, so one load per render is enough.
    loadRatings(all).catch(() => { /* offline — slots stay empty */ });
  }

  // filterKind doubles as a deep-link: a real kind ('widget', 'ambient', …)
  // preselects the browse rail, while '__limited' / '__installed' open a whole
  // view. Keep the pseudo-kinds out of the rail — they are not catalog kinds.
  function open(filterKind) {
    close();
    searchQuery = ''; activeKind = ''; sortBy = 'feat'; shown = PAGE;
    limitedOnly = (filterKind === '__limited');
    activeTab = (filterKind === '__installed') ? 'installed' : 'browse';
    const browseKind = (filterKind === '__limited' || filterKind === '__installed') ? undefined : filterKind;
    if (window.InstalledManager) InstalledManager.reset();
    const bd = el('div', 'preset-modal-overlay cgal-overlay');
    const modal = el('div', 'preset-modal cgal-modal');

    // Premium storefront header: brand mark + title + tagline, actions on the right.
    const head = el('div', 'cgal-topbar');
    const brand = el('div', 'cgal-brand');
    brand.appendChild(icon(limitedOnly ? 'limited' : 'store', 'cgal-brand-mark'));
    const brandTxt = el('div', 'cgal-brand-txt');
    brandTxt.appendChild(el('h3', 'cgal-brand-title', limitedOnly ? t('gallery_limited_section', 'Limited edition') : t('ui_store', 'Store')));
    brandTxt.appendChild(el('p', 'cgal-brand-sub', limitedOnly
      ? t('gallery_limited_lead_short', 'A fixed number of copies worldwide — reserved on Discord.')
      : t('gallery_lead', 'Themes, backgrounds, widgets, scenes and packages shared by the community.')));
    brand.appendChild(brandTxt);
    head.appendChild(brand);

    const controls = el('div', 'cgal-head-actions');
    const trust = el('div', 'cgal-trust');
    trust.appendChild(icon('check'));
    trust.appendChild(el('span', null, t('gallery_trust', 'Preview before install')));
    controls.appendChild(trust);
    const refresh = el('button', 'cgal-iconbtn'); refresh.type = 'button'; refresh.title = t('gallery_refresh', 'Refresh'); refresh.appendChild(icon('refresh'));
    const x = el('button', 'cgal-iconbtn'); x.type = 'button'; x.title = t('gallery_close', 'Close'); x.appendChild(icon('close'));
    x.addEventListener('click', close);
    controls.appendChild(refresh); controls.appendChild(x);
    head.appendChild(controls);
    modal.appendChild(head);

    // Two tabs: the catalog, and what this machine already has. The limited-only
    // deep link stays a single dedicated view — it has no "installed" half.
    let tabsEl = null;
    if (!limitedOnly) {
      tabsEl = el('div', 'cgal-tabs');
      const mkTab = (id, label, iconName) => {
        const b = el('button', 'cgal-tab'); b.type = 'button'; b.dataset.tab = id;
        b.appendChild(icon(iconName));
        b.appendChild(el('span', 'cgal-tab-txt', label));
        b.addEventListener('click', () => { if (activeTab === id) return; activeTab = id; syncTabs(); paintTab(false); });
        return b;
      };
      tabsEl.appendChild(mkTab('browse', t('gallery_tab_browse', 'Browse'), 'store'));
      tabsEl.appendChild(mkTab('installed', t('gallery_tab_installed', 'Installed'), 'check'));
      modal.appendChild(tabsEl);
    }
    function syncTabs() {
      if (!tabsEl) return;
      tabsEl.querySelectorAll('.cgal-tab').forEach((b) => {
        const on = b.dataset.tab === activeTab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    function paintTab(force) {
      if (activeTab === 'installed') {
        // Leaving the catalog: drop the lazy bg-preview observer so the browse
        // grid's sandboxed preview frames stop running behind the tab.
        if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
        if (window.InstalledManager) InstalledManager.render(body, force);
        else body.replaceChildren(el('div', 'cgal-status', t('gallery_error', 'Could not load the gallery. Check your connection and retry.')));
        return;
      }
      render(body, browseKind, force);
    }

    const body = el('div', 'cgal-scroll');
    modal.appendChild(body);
    bd.appendChild(modal);
    bd.addEventListener('click', (ev) => { if (ev.target === bd) close(); });
    refresh.addEventListener('click', () => paintTab(true));
    document.body.appendChild(bd);
    overlayEl = bd;
    window.addEventListener('resize', onResize);
    syncTabs();
    paintTab(false);
  }

  // Open the Store straight onto one entry's detail view — used by the "new
  // drop" modal so its CTA lands the user on the real purchase/reserve context
  // (same import boundary; openDetail just stacks over the freshly-opened store).
  function openEntry(entry) {
    if (!entry) { open(); return; }
    open(entry.limited ? '__limited' : undefined);
    openDetail(entry);
  }
  // Open the Store and surface the Supporters "how it works" perks panel — the
  // donate/convert path for the supporter drop modal.
  function openSupporters() { open(); openSupporterInfo(); }

  // kindIcon + SHOTS_BASE are shared with the Installed tab
  // (js/installed-manager.js) so both surfaces draw from ONE icon set and ONE
  // sidecar path rule. shotUrl derives from the entry id the server already
  // charset-pinned — never from catalog-supplied text.
  const shotUrl = (entryId, i, ext) => SHOTS_BASE + encodeURIComponent(entryId) + (i === 1 ? '' : '-' + i) + '.' + ext;
  window.CommunityGallery = { open, close, findUpdates, openEntry, openSupporters, kindIcon, shotUrl };
})();
