'use strict';
// Slideshow widget — cycles a user-provided set of images / animated GIFs in a
// dashboard tile. Born from the community "show my folder of GIFs on the Edge"
// ask (the same users behind #99): iCUE's Slideshow needed a second app running
// alongside Xenon; this brings it in-house and nicer — cover/contain fit, tap to
// pause or step through by hand, and a still-frame freeze whenever the pixels
// genuinely aren't being seen, so it never spins the GPU for a screen nobody is
// looking at (the exact lesson of #99). Note it does NOT freeze on inactivity:
// see globalFreeze() for why that signal is wrong for a widget you watch.
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
  // Third storage model, and the one that removes the ceiling entirely: FOLDER.
  // The config holds a folder path on this PC, the server enumerates the image
  // files in it, and the widget asks for them BY INDEX (`/slideshow/file?i=N`).
  // Nothing is copied, the settings blob stays a few dozen bytes whatever the
  // folder holds, and adding a GIF on disk makes it appear without touching the
  // app. The path is never sent back as part of an image request — see
  // server/slideshow-folder.js.
  const SLIDE_SOURCES = ['library', 'folder'];
  const SLIDE_FOLDER_MAX_CHARS = 400;  // a Windows path is <= 260, extended-length ones longer
  // Ceiling on the enumerated set. Not a storage limit — nothing is copied — but a
  // bound on the one piece of sync work the folder source does: sorting the names.
  // Measured with the shared collator in slideshow-folder.js: 20k names sort in
  // ~56ms, 50k in ~136ms. 20k stays well clear of a visible stall while being far
  // beyond any real photo/GIF folder.
  const SLIDE_FOLDER_MAX_FILES = 20000;
  // Same per-file ceiling the upload path enforces (SLIDESHOW_ASSET_MAX_BYTES in
  // server.js), applied to the folder source too. Without it the folder source
  // would be the one way into the widget with no size limit at all, and file size
  // is only half the story: a decoded bitmap costs width × height × 4 bytes
  // whatever the compression and however small the tile, so one camera-resolution
  // image out of a folder can cost hundreds of MB of memory to show. Oversized
  // files are refused at serve time and the tile steps past them.
  const SLIDE_FOLDER_MAX_BYTES = 20 * 1024 * 1024;
  // An animated GIF decodes every frame for as long as it is in the document, and
  // the browser gives no way to pause one; swapping it for a still frame does.
  // This is the ONE case the user gets to choose, because it is the one where
  // stopping a visible widget is a real trade rather than free. Hidden page and
  // off-screen tile always freeze — there is nothing to decide when the pixels
  // cannot be seen. Notably NOT offered: freezing on inactivity (see globalFreeze).
  const PAUSE_KEYS = ['pauseGame'];
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
      source: SLIDE_SOURCES.includes(src.source) ? src.source : 'library',
      folder: sanitizeFolderPath(src.folder),
      shuffle: src.shuffle === true,
      // Default ON: freezing while a game has the machine is the cheap, safe
      // behaviour, so only an explicit `false` turns it off.
      pauseGame: src.pauseGame !== false,
      intervalMs: clampInt(src.intervalMs, INTERVAL_MIN, INTERVAL_MAX, INTERVAL_DEFAULT),
      fit: FIT_MODES.includes(src.fit) ? src.fit : 'cover',
    };
  }

  // Shape-only check — it says nothing about whether the folder exists or is
  // readable, which is the server's job (and its answer is what the settings pane
  // shows). Rejecting control characters here keeps a path with an embedded NUL or
  // newline from ever reaching an fs call.
  function sanitizeFolderPath(value) {
    if (typeof value !== 'string') return '';
    const s = value.trim().slice(0, SLIDE_FOLDER_MAX_CHARS);
    const bad = (ch) => { const c = ch.charCodeAt(0); return c < 32 || c === 127; };
    return Array.prototype.some.call(s, bad) ? '' : s;
  }

  const CAPS = {
    SLIDE_DATA_RE, SLIDE_UPLOAD_RE, SLIDE_MAX_COUNT, SLIDE_MAX_CHARS, SLIDES_TOTAL_MAX,
    SLIDE_SOURCES, SLIDE_FOLDER_MAX_CHARS, SLIDE_FOLDER_MAX_FILES, SLIDE_FOLDER_MAX_BYTES, PAUSE_KEYS,
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

    // ── the playlist ──────────────────────────────────────────────────────────
    // Everything below the config works off ONE ordered array of {uri, name}, so
    // the tile code never has to know whether the images came from the uploaded
    // library or from a folder, or whether the user asked for shuffle.

    // Folder source: the server owns the enumeration and we only learn the COUNT,
    // asking for images by index. Re-checked on a slow cadence (a folder is a
    // human-speed thing) and immediately whenever the configured path changes.
    const FOLDER_RECHECK_MS = 300000;   // 5 min
    let folder = { path: '', count: 0, at: 0, loading: false, error: null };

    let folderReqSeq = 0;   // orphans an in-flight response a forced refetch supersedes
    function refreshFolder(force) {
      const want = String(cfg().folder || '');
      if (!want) { folder = { path: '', count: 0, at: 0, loading: false, error: null }; return; }
      const stale = folder.path !== want || force || (Date.now() - folder.at) > FOLDER_RECHECK_MS;
      // A forced refetch supersedes an in-flight one (the pre-save fetch that
      // raced the settings flush may still be pending with the WRONG answer).
      if (!stale || (folder.loading && !force)) return;
      const seq = ++folderReqSeq;
      folder.loading = true;
      fetch('/slideshow/folder' + (force ? '?refresh=1' : ''))
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))
        .then(d => {
          if (seq !== folderReqSeq) return;   // superseded — never cache a stale answer
          const changed = folder.path !== want || folder.count !== (d.count | 0);
          folder = { path: want, count: d.ok ? (d.count | 0) : 0, at: Date.now(), loading: false, error: d.ok ? null : (d.error || 'read_failed') };
          if (changed) { invalidatePlaylist(); paintAll(); }
        })
        .catch(() => {
          if (seq !== folderReqSeq) return;
          folder = { path: want, count: 0, at: Date.now(), loading: false, error: 'read_failed' };
          invalidatePlaylist();
        });
    }

    // The shuffled ORDER is computed once per (source, length) and kept, so a
    // repaint never reshuffles under the user — a slideshow that jumped to a new
    // random image every time an unrelated setting changed would read as a bug.
    // The materialized array is cached separately and dropped by renderWidgets(),
    // which is exactly when the config can have changed; ticks and repaints in
    // between reuse it instead of rebuilding up to SLIDE_FOLDER_MAX_FILES entries.
    let orderCache = { sig: '', list: [] };
    let listCache = null;
    function invalidatePlaylist() { listCache = null; }
    function playlist() {
      if (listCache) return listCache;
      const c = cfg();
      const isFolder = c.source === 'folder';
      const imgs = (!isFolder && Array.isArray(c.images)) ? c.images : [];
      const len = isFolder ? folder.count : imgs.length;
      // Not shuffled: the source order IS the play order, no copy needed.
      if (!c.shuffle) {
        listCache = isFolder
          ? Array.from({ length: len }, (_, i) => ({ uri: '/slideshow/file?i=' + i, name: '' }))
          : imgs;
        return listCache;
      }
      const sig = (isFolder ? 'f:' + folder.path : 'l') + ':' + len;
      if (orderCache.sig !== sig) {
        const idx = Array.from({ length: len }, (_, i) => i);
        for (let i = idx.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [idx[i], idx[j]] = [idx[j], idx[i]];
        }
        orderCache = { sig, list: idx };
      }
      listCache = orderCache.list
        .map(i => (isFolder ? { uri: '/slideshow/file?i=' + i, name: '' } : imgs[i]))
        .filter(Boolean);
      return listCache;
    }

    // ── freeze while nobody's looking ─────────────────────────────────────────
    // A GIF in an <img> decodes every frame for as long as it is in the document,
    // and the platform offers no pause. Clearing the src DOES stop it, so when the
    // dashboard is idle / in a game / hidden we paint the last frame onto a canvas
    // and drop the src: the tile looks the same and the decoder stops.
    // Deliberately NOT keyed off `ambient-idle`. That class means "no input for a
    // while", not "nobody is watching" — on the Xeneon Edge nobody touches the
    // screen for minutes at a time, which is the NORMAL way this widget is used.
    // Freezing on it stops the slideshow forever exactly where it matters, the
    // same trap `ambient-idle.js` already documents for the ticker marquee (#72).
    // A slideshow is watched, not operated; only signals that mean the pixels
    // genuinely aren't being seen belong here.
    function globalFreeze() {
      if (document.hidden) return true;            // nobody can see it, by definition
      const c = cfg();
      const cls = document.body.classList;
      // A game wants the frames more than the tile does.
      if (c.pauseGame !== false && (cls.contains('game-mode') || cls.contains('perf-active'))) return true;
      // A frosted overlay (Settings, Store, import, drop) blurs the tile out of
      // sight, and a GIF decoding under a backdrop-filter forces the whole blur
      // to recompute every frame — the exact GPU drain ambient-freeze.js pauses
      // the background video for. CSS can't pause a GIF; this swap is the only
      // mechanism that can. Unconditional: behind the haze there is nothing to
      // see, so no user-facing behavior changes.
      if (cls.contains('overlay-frozen')) return true;
      return false;
    }
    // Per-tile: a tile on an unselected page or tab group has no layout box, so
    // its pixels are not on screen even though the dashboard is.
    function shouldFreeze(tile) {
      return globalFreeze() || (tile ? !isShowing(tile) : false);
    }

    // Cap the still's pixel size. Freezing at the source resolution would hand a
    // 4000x3000 photo a 48 MB canvas — more memory than letting it animate, which
    // is the opposite of the point. The tile is small; a still sized to how it is
    // actually drawn is indistinguishable.
    const FREEZE_MAX_PX = 1024;
    function freezeTile(ui) {
      if (ui.frozen) return;
      const img = ui.img;
      // Only worth freezing something actually decoded; an image mid-load has no
      // frame to keep and will paint normally when it arrives.
      if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) return;
      const rendered = Math.max(img.clientWidth, img.clientHeight) || 0;
      const target = Math.min(FREEZE_MAX_PX, Math.max(64, Math.round(rendered * (window.devicePixelRatio || 1))));
      const scale = Math.min(1, target / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = ui.freeze;
      cv.width = Math.max(1, Math.round(img.naturalWidth * scale));
      cv.height = Math.max(1, Math.round(img.naturalHeight * scale));
      try {
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        cv.hidden = false;
        img.hidden = true;
        img.removeAttribute('src');   // this is what stops the decoding
        ui.frozen = true;
      } catch { /* leave it animating rather than blank */ }
    }

    function thawTile(ui) {
      if (!ui.frozen) return;
      ui.frozen = false;
      ui.freeze.hidden = true;
      ui.img.hidden = false;
      // Leave the src empty and let paintTile assign the CURRENT image. Restoring
      // the one we froze would load a stale picture first whenever the rotation
      // moved on while the tile was frozen.
      ui.src = '';
    }
    function tiles() {
      return Array.from(document.querySelectorAll('[data-dashboard-widget="slideshow"]')).filter(n => n.closest('.pager-page'));
    }
    // A tile with no layout box (display:none page, unselected tab group) must not
    // advance — same visibility test the Spotify/Cameras tiles use.
    // "On screen" is not the same as "has a layout box". A page the pager has
    // parked (.is-parked → content-visibility: hidden, DashboardPager.css) is not
    // rendered at all, but it KEEPS its box: getClientRects() still returns a
    // rect, so a rects-only test read a slideshow sitting on another page as
    // visible and never froze it. The tile went on decoding a picture nobody
    // could see — exactly the cost this freeze exists to remove. Layout editing
    // un-parks those pages (same rule as the CSS), so it must not count there.
    function isShowing(tile) {
      if (!tile.getClientRects().length) return false;
      const page = tile.closest('.pager-page');
      if (page && page.classList.contains('is-parked')
        && !document.body.classList.contains('layout-editing')) return false;
      return true;
    }
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
      // Holds the last frame while the tile is frozen (see shouldFreeze).
      const freeze = el('canvas', 'sl-img sl-freeze'); freeze.hidden = true;
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
      root.append(img, freeze, empty, prev, next, pausePip, dots);

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

      // A file can be missing, unreadable or over the size cap (413) — step past it
      // rather than sitting on a broken frame. `misses` guards the case where every
      // image fails: without it each failure would advance and retry forever.
      img.addEventListener('error', () => {
        const list = playlist();
        if (!list.length || ui.misses >= list.length) return;
        ui.misses++;
        step(ui.key, 1, { keepPlaying: true });
      });
      // A tile painted for the first time while already idle has nothing decoded to
      // freeze yet, so it would animate until the next repaint. Freeze on arrival.
      img.addEventListener('load', () => {
        ui.misses = 0;
        if (shouldFreeze(root.closest('[data-dashboard-widget="slideshow"]'))) freezeTile(ui);
      });

      const ui = { root, img, freeze, empty, prev, next, pausePip, dots, key, src: '', frozen: false, misses: 0 };
      mount.replaceChildren(root);
      uiMap.set(mount, ui);
      return ui;
    }

    // A step the USER made parks the slideshow; a step taken to skip a broken image
    // must not, or one unreadable file would silently stop the rotation.
    function step(key, dir, opts) {
      const imgs = playlist();
      if (!imgs.length) return;
      const s = stateOf(key);
      if (!(opts && opts.keepPlaying)) s.paused = true;
      s.idx = (s.idx + dir + imgs.length) % imgs.length;
      paintAll();
    }

    function paintTile(tile) {
      const mount = tile.querySelector('.slideshow-widget-mount');
      if (!mount) return;
      const ui = ensureUI(mount);
      const c = cfg();
      const imgs = playlist();
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
      // Freezing clears the src, so a repaint must not treat the tile as if it
      // still held that image: thaw first, then the normal assignment below runs.
      const wantFreeze = shouldFreeze(tile);
      if (!wantFreeze) thawTile(ui);
      // Only touch src when it actually changes — re-setting it would restart an
      // animated GIF from frame 0 on every unrelated repaint.
      if (ui.src !== uri && !ui.frozen) { ui.img.src = uri; ui.src = uri; }
      ui.img.alt = imgs[s.idx].name || '';
      // Freeze AFTER the src is settled, so the frame we keep is the current image.
      if (wantFreeze) freezeTile(ui);
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
      // A folder can gain or lose images while the slideshow runs; re-check on a
      // slow cadence so it follows the disk without the user reopening Settings.
      // refreshFolder() rebuilds the playlist only when the count actually moved.
      if (cfg().source === 'folder') refreshFolder(false);
      // Frozen means the pixels aren't being seen, so don't advance either:
      // rotating would fetch and decode a new image every interval for nothing.
      // Per-tile visibility is still checked below, as it always was.
      if (globalFreeze()) { schedule(); return; }
      const imgs = playlist();
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
      // Called on every settings apply, so this is the point where the config may
      // have changed underneath the cached playlist — drop it and rebuild.
      invalidatePlaylist();
      if (cfg().source === 'folder') refreshFolder(false);
      paintAll();
      if (!timer) schedule();
    }

    document.addEventListener('visibilitychange', () => { paintAll(); if (!document.hidden) renderWidgets(); });

    // Swiping to another page parks the one we were on, which changes whether each
    // tile is being rendered — but nothing about the body class or the interval
    // tick tells us that. Without this the freeze (and the thaw coming back) waited
    // for the next tick, up to the whole "time per image" setting: two minutes of
    // decoding a page nobody is looking at, which is the case it was written for.
    window.addEventListener('xenon:page-change', () => paintAll());

    // game-mode / perf-active / ambient-idle are body classes flipped by other
    // modules. Without watching them the tile would keep animating until the next
    // interval tick, which can be up to two minutes — long enough that the freeze
    // would look broken. Same approach custom-bg.js uses for the same classes.
    if (document.body) {
      const bodyClassWatch = new MutationObserver(() => paintAll());
      bodyClassWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    // refreshFolderNow: settings.js calls this AFTER the folder save reaches the
    // server. The regular render path caches the first (possibly pre-save, hence
    // wrong-folder) enumeration under the new path for FOLDER_RECHECK_MS; a
    // forced refetch here replaces it with the real answer.
    window.SlideshowWidget = Object.assign({ renderWidgets, sanitizeSlideshow, refreshFolderNow: () => refreshFolder(true) }, CAPS);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign({ sanitizeSlideshow }, CAPS);
  }
})();
