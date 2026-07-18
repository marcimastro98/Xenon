'use strict';
// Slideshow widget — cycles a user-provided set of images / animated GIFs in a
// dashboard tile. Born from the community "show my folder of GIFs on the Edge"
// ask (the same users behind #99): iCUE's Slideshow needed a second app running
// alongside Xenon; this brings it in-house and nicer — cover/contain fit, tap to
// pause or step through by hand, and it rides the same idle / tab-visibility
// pauses the rest of the dashboard uses, so it never spins the GPU cycling images
// for a screen nobody is looking at (the exact lesson of #99).
//
// Images are stored INLINE as data: URIs inside hubSettings.slideshow — the same
// model as the custom-background image assets — so they persist across reloads and
// travel inside the settings backup with zero extra plumbing (no server upload
// store, no asset GC). The deliberate trade is a bounded library size: the
// sanitizer below caps per-image size, the total set and the count.
//
// Dual-mode file, exactly like js/custom-bg.js: the PURE sanitizer + caps at the
// top carry no DOM and are require()d by the server, so the client, the server and
// the settings normalizer all share ONE set of rules and can never drift; the
// browser block below builds the tile UI.
(function () {
  // ── Shared rules (client + server + settings normalizer) ──────────────────
  // GIF stays in the allowlist — animated GIFs are the whole point of the ask.
  //
  // Two storage models, both accepted here:
  //  1. DISK-BACKED (the default now, like iCUE): the image is a file under the
  //     server's data/uploads/ dir and the config stores only a tiny reference
  //     `/uploads/slideshow-*`. The set is bounded by disk, not by localStorage,
  //     so a folder of many GIFs is no longer a problem. New uploads take this path.
  //  2. LEGACY INLINE: an existing slideshow may still carry `data:` base64 URIs
  //     that live in the settings blob. Those are kept working, but stay bounded by
  //     the byte budget below (they weigh on localStorage + the settings backup).
  const SLIDE_DATA_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
  // A server-generated upload reference: `/uploads/slideshow-<ts>-<rand>.<ext>`.
  // The `slideshow-` prefix is what the server's reference-counted GC keys off, so
  // orphaned files are reclaimed when an image is removed (see server.js).
  const SLIDE_UPLOAD_RE = /^\/uploads\/slideshow-[A-Za-z0-9._-]+$/;
  // The count is now the practical bound (disk-backed images cost ~40 chars each in
  // the blob, nothing on localStorage), kept as a sane CEILING so a degenerate set
  // can't grow the array and the one-row-per-image settings list without bound.
  const SLIDE_MAX_COUNT = 200;         // ceiling on the number of images
  const SLIDE_MAX_CHARS = 1400000;     // ~1 MB per LEGACY inline image (base64 chars)
  const SLIDES_TOTAL_MAX = 6000000;    // ~4.4 MB of LEGACY inline images — bounds only
                                       // the base64 set still living in the blob
  const FIT_MODES = ['cover', 'contain'];
  const INTERVAL_MIN = 1500;
  const INTERVAL_MAX = 120000;
  const INTERVAL_DEFAULT = 6000;

  function clampInt(v, lo, hi, dflt) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  }

  // Rebuild a known shape from untrusted input (settings load, backup import, a
  // stale localStorage mirror). Never spread: drop anything that fails the MIME
  // allowlist or the caps. An ORDERED array (order = play order), unlike the
  // custom-bg asset MAP. Fail-closed by construction — a bad entry is skipped, the
  // whole thing never throws.
  function sanitizeSlideshow(value) {
    const src = (value && typeof value === 'object') ? value : {};
    const images = [];
    let total = 0;
    const list = Array.isArray(src.images) ? src.images : [];
    for (const it of list) {
      if (images.length >= SLIDE_MAX_COUNT) break;
      const uri = (it && typeof it.uri === 'string') ? it.uri : '';
      // Disk-backed reference: a tiny path string, no weight on the blob — keep it
      // as-is (the file itself is size-capped by the upload endpoint).
      if (!SLIDE_UPLOAD_RE.test(uri)) {
        // Legacy inline data: URI — still gated by the per-image and total caps so
        // an old base64 set can never bloat the settings blob.
        if (uri.length > SLIDE_MAX_CHARS || !SLIDE_DATA_RE.test(uri)) continue;
        if (total + uri.length > SLIDES_TOTAL_MAX) break;   // set is full — stop, keep what fits
        total += uri.length;
      }
      const name = (it && typeof it.name === 'string') ? it.name.trim().slice(0, 80) : '';
      images.push({ name, uri });
    }
    return {
      images,
      intervalMs: clampInt(src.intervalMs, INTERVAL_MIN, INTERVAL_MAX, INTERVAL_DEFAULT),
      fit: FIT_MODES.includes(src.fit) ? src.fit : 'cover',
    };
  }

  const CAPS = {
    SLIDE_DATA_RE, SLIDE_UPLOAD_RE, SLIDE_MAX_COUNT, SLIDE_MAX_CHARS, SLIDES_TOTAL_MAX,
    FIT_MODES, INTERVAL_MIN, INTERVAL_MAX, INTERVAL_DEFAULT,
  };

  // ── Browser: the tile UI ──────────────────────────────────────────────────
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
    function el(tag, cls, txt) {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (txt != null) n.textContent = txt;
      return n;
    }

    // Per logical tile (keyed by its grid gs-id) we remember which slide it shows
    // and whether the user paused it, so a repaint (a settings tweak, a layout
    // re-apply) doesn't snap every tile back to the first image.
    const tileStates = new Map();   // key -> { idx, paused }
    const uiMap = new WeakMap();    // mount element -> built DOM refs
    let timer = null;

    function cfg() {
      const s = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.slideshow : null;
      return s && typeof s === 'object' ? s : { images: [], intervalMs: INTERVAL_DEFAULT, fit: 'cover' };
    }
    function tiles() {
      return Array.from(document.querySelectorAll('[data-dashboard-widget="slideshow"]')).filter(n => n.closest('.pager-page'));
    }
    // A tile with no layout box (display:none page, unselected tab group) must not
    // advance — same visibility test the Spotify/Cameras tiles use.
    function isShowing(tile) { return tile.getClientRects().length > 0; }
    // Identity from the ATOM (data-dashboard-instance), not the enclosing grid
    // item: inside a tab group the item's gs-id is the GROUP's, so two
    // slideshow tabs would share one position/paused state. Standalone values
    // are unchanged (primary gs-id = 'slideshow', copy gs-id = its instance id).
    function keyOf(tile) {
      return tile.getAttribute('data-dashboard-instance') || 'slideshow';
    }
    function stateOf(key) {
      let s = tileStates.get(key);
      if (!s) { s = { idx: 0, paused: false }; tileStates.set(key, s); }
      return s;
    }

    function ensureUI(mount) {
      const cached = uiMap.get(mount);
      if (cached && cached.root.isConnected) return cached;
      const root = el('div', 'sl-stage');
      const img = el('img', 'sl-img'); img.alt = ''; img.decoding = 'async';
      const empty = el('div', 'sl-empty');
      const emptyText = el('div', 'sl-empty-text', t('slideshow_empty', 'No images yet'));
      const emptyBtn = el('button', 'sl-empty-btn', t('slideshow_empty_add', 'Add images'));
      emptyBtn.type = 'button';
      emptyBtn.addEventListener('click', (e) => { e.stopPropagation(); openSlideshowSettings(); });
      empty.append(emptyText, emptyBtn);
      const prev = el('button', 'sl-nav sl-prev'); prev.type = 'button';
      prev.setAttribute('aria-label', t('slideshow_prev', 'Previous'));
      prev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
      const next = el('button', 'sl-nav sl-next'); next.type = 'button';
      next.setAttribute('aria-label', t('slideshow_next', 'Next'));
      next.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';
      const pausePip = el('div', 'sl-pausepip');
      pausePip.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
      const dots = el('div', 'sl-dots');
      root.append(img, empty, prev, next, pausePip, dots);

      const key = keyOf(mount.closest('[data-dashboard-widget="slideshow"]') || mount);
      // Tap the image → pause / resume; the arrows step by hand (and pause, so a
      // manual browse doesn't get yanked forward a second later).
      root.addEventListener('click', (e) => {
        if (e.target.closest('.sl-nav') || e.target.closest('.sl-empty')) return;
        const s = stateOf(key);
        s.paused = !s.paused;
        paintAll();
      });
      prev.addEventListener('click', (e) => { e.stopPropagation(); step(key, -1); });
      next.addEventListener('click', (e) => { e.stopPropagation(); step(key, 1); });

      const ui = { root, img, empty, prev, next, pausePip, dots, key, src: '' };
      mount.replaceChildren(root);
      uiMap.set(mount, ui);
      return ui;
    }

    function step(key, dir) {
      const imgs = cfg().images || [];
      if (!imgs.length) return;
      const s = stateOf(key);
      s.paused = true;                                   // a manual step parks it
      s.idx = (s.idx + dir + imgs.length) % imgs.length;
      paintAll();
    }

    function paintTile(tile) {
      const mount = tile.querySelector('.slideshow-widget-mount');
      if (!mount) return;
      const ui = ensureUI(mount);
      const c = cfg();
      const imgs = Array.isArray(c.images) ? c.images : [];
      const s = stateOf(ui.key);
      ui.root.classList.toggle('is-empty', imgs.length === 0);
      ui.root.classList.toggle('sl-fit-contain', c.fit === 'contain');
      ui.root.classList.toggle('sl-fit-cover', c.fit !== 'contain');
      const multi = imgs.length > 1;
      ui.prev.hidden = !multi;
      ui.next.hidden = !multi;
      if (!imgs.length) { ui.img.removeAttribute('src'); ui.src = ''; ui.dots.replaceChildren(); ui.pausePip.hidden = true; return; }
      if (s.idx >= imgs.length) s.idx = 0;
      const uri = imgs[s.idx].uri;
      // Only touch src when it actually changes — re-setting it would restart an
      // animated GIF from frame 0 on every unrelated repaint.
      if (ui.src !== uri) { ui.img.src = uri; ui.src = uri; }
      ui.img.alt = imgs[s.idx].name || '';
      ui.pausePip.hidden = !s.paused;
      // Position dots (max 12 shown so a big set doesn't overflow the tile).
      if (multi) {
        const n = Math.min(imgs.length, 12);
        if (ui.dots.childElementCount !== n) {
          const frag = document.createDocumentFragment();
          for (let i = 0; i < n; i++) frag.appendChild(el('span', 'sl-dot'));
          ui.dots.replaceChildren(frag);
        }
        const activeDot = Math.round((s.idx / imgs.length) * n) % n;
        Array.from(ui.dots.children).forEach((d, i) => d.classList.toggle('is-on', i === activeDot));
        ui.dots.hidden = false;
      } else {
        ui.dots.hidden = true;
      }
    }

    function paintAll() { tiles().forEach(paintTile); }

    // Self-scheduling advance loop keyed off the (live) interval setting. Skips
    // hidden tabs and paused / off-screen tiles, so it costs nothing when nobody's
    // watching — no rAF, no per-frame work.
    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onTick, Math.max(INTERVAL_MIN, cfg().intervalMs || INTERVAL_DEFAULT));
    }
    function onTick() {
      const c = cfg();
      const imgs = Array.isArray(c.images) ? c.images : [];
      if (!document.hidden && imgs.length > 1) {
        let moved = false;
        tiles().forEach(tile => {
          const s = stateOf(keyOf(tile));
          if (!s.paused && isShowing(tile)) { s.idx = (s.idx + 1) % imgs.length; moved = true; }
        });
        if (moved) paintAll();
      }
      schedule();
    }

    // ── public API ──
    function renderWidgets() {
      const list = tiles();
      if (!list.length) { if (timer) { clearTimeout(timer); timer = null; } return; }
      paintAll();
      if (!timer) schedule();
    }

    document.addEventListener('visibilitychange', () => { if (!document.hidden) renderWidgets(); });

    window.SlideshowWidget = Object.assign({ renderWidgets, sanitizeSlideshow }, CAPS);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign({ sanitizeSlideshow }, CAPS);
  }
})();
