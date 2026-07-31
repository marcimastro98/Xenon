// Phone view (R1.3) — the dashboard on a screen the user already owns.
//
// The dashboard is a 24-column GridStack. On a 390px phone that is a ~16px
// column: the saved layout renders as a perfect miniature of itself, which is
// unreadable. `breakpoints.css` does not help — its rules target the pre-v4
// `.dashboard-widget[data-dashboard-size]` markup, which the grid replaced.
//
// So below a threshold the tiles STACK: one column, full width, in reading
// order, each keeping a height proportional to the one the user gave it.
//
// The important design decision is that this is PRESENTATION ONLY. It would be
// tempting to use GridStack's own one-column mode (`columnOpts.breakpoints`),
// and that would be a mistake: changing the column count rewrites every tile's
// coordinates and fires `change`, which `dashboard-grid.js` serializes and
// SAVES. Opening the dashboard on a phone would silently rewrite the layout the
// user built on their PC. Nothing here touches the grid engine: it reorders DOM
// nodes and lets CSS take over positioning, so the worst a bug can do is look
// wrong until the next reload.
//
// Nothing is reparented either. `topbar-minimal.js` already moves the topbar's
// children into its rails and puts them back exactly; a second mover would have
// to agree with it about the original slots forever. The dock below is built
// from NEW nodes that simply forward a tap to the real button, so the two
// chromes cannot corrupt each other's idea of where anything belongs.
(function () {
  'use strict';

  // 'auto' | 'on' | 'off'. Local to the device on purpose: which chrome suits
  // THIS screen is not a property of the user's configuration, and a paired
  // phone cannot write settings anyway (see server/remote-access.js).
  const PREF_KEY = 'xenon.phoneView';

  // 24 columns need roughly 22px each to stay legible, so the grid stops being
  // usable somewhere below ~530px. 620 covers every phone in portrait with room
  // to spare while staying clear of the Xeneon Edge mounted vertically (720)
  // and of tablets, whose owners can still turn it on by hand.
  const PHONE_MAX_W = 620;

  // The same phone on its side. Rotating was originally left on the grid on the
  // theory that ~930px is cramped but readable — and it is, horizontally. What
  // runs out is HEIGHT: ~430px clips every tile mid-content and leaves the
  // topbar and the edge rails sitting on top of what is left, which is the one
  // thing this view exists to prevent. A phone is a phone in both orientations.
  //
  // Two bounds, because the dimensions are not interchangeable. The height
  // bound is what identifies the phone; the width bound is what stops this from
  // claiming a deliberately short, wide DESKTOP window, where the grid is still
  // the better answer. The Xeneon Edge (2560x720) is clear of both.
  const PHONE_MAX_H = 500;
  const PHONE_LANDSCAPE_MAX_W = 1000;

  // ── The tablet band ───────────────────────────────────────────────────────
  // Between the phone threshold and here, the 24-column grid is squeezed
  // without anything adapting, and that band is WORSE than the phone: measured
  // at 768x1024 against a real dashboard, 30 elements were clipped by an
  // ancestor with `overflow: hidden` against 9 at 390px. A 768px viewport gives
  // a 32px column, so an 8-column tile is 256px of chrome-heavy widget.
  //
  // 1120 is where `breakpoints.css` already considered the dashboard cramped,
  // so the two agree instead of introducing a second opinion about the same
  // question.
  const TABLET_MAX_W = 1120;

  // A DISPLAY MOUNTED VERTICALLY is not a tablet held in portrait, and the
  // difference matters: a Xeneon Edge stood on its end is 720x2560, inside the
  // width band above, and its owner built a layout for exactly that shape.
  // Restacking it into two columns would throw that away. The two are
  // distinguishable by how extreme the ratio is — 2560/720 is 3.6, while every
  // tablet in portrait sits near 1.4 — so anything this tall keeps the grid.
  const TALL_DISPLAY_RATIO = 2.5;

  // Height per grid row when stacked. The user's `gs-h` is respected as a
  // PROPORTION rather than a pixel size — a tile they made twice as tall stays
  // twice as tall — but clamped, because a 30-row tile would otherwise be three
  // phone screens of one widget.
  const ROW_PX = 26;

  let active = null;         // null = never applied yet
  let dock = null;
  let observer = null;
  let sorting = false;       // guard: reordering nodes re-triggers the observer
  let pending = 0;

  // ── Policy ────────────────────────────────────────────────────────────────

  /**
   * Which layout this viewport wants: 'off' (the grid), 'phone' (one column
   * plus the compact chrome and the thumb dock) or 'tablet' (two columns,
   * ordinary chrome). Pure, so every threshold is testable without a browser.
   *
   * One function rather than two booleans because the three answers are
   * mutually exclusive and their ORDER is the policy — a phone in landscape is
   * inside the tablet width band and must never be answered with 'tablet'.
   */
  function stackMode(input) {
    const o = input || {};
    // An embedded surface is narrow for reasons that have nothing to do with a
    // phone, and it has already been told what to look like. `?panel=…` is the
    // iCUE widget's single-panel embed (breakpoints.css lays it out), and the
    // Edge preview scales the whole body into a 2560x720 stage inside whatever
    // window it was opened in. Restacking either would be answering a question
    // nobody asked — and it wins over an explicit preference, because the
    // preference is about THIS device's dashboard, not about an embed.
    if (o.embedded) return 'off';
    if (o.preference === 'on') return 'phone';
    if (o.preference === 'off') return 'off';
    const w = Number(o.width);
    if (!Number.isFinite(w) || w <= 0) return 'off';
    if (w <= PHONE_MAX_W) return 'phone';
    const h = Number(o.height);
    // Height is optional so a caller that only knows the width still gets an
    // answer instead of a throw or a wrong one. Without it a phone on its side
    // is indistinguishable from a small tablet, and the safe reading of a bare
    // width in this band is the roomier layout.
    const hasH = Number.isFinite(h) && h > 0;
    if (hasH && h <= PHONE_MAX_H && w <= PHONE_LANDSCAPE_MAX_W) return 'phone';
    if (w > TABLET_MAX_W) return 'off';
    if (hasH && h / w >= TALL_DISPLAY_RATIO) return 'off';
    return 'tablet';
  }

  /** Kept as its own name: several callers only ever cared about the phone. */
  function shouldUsePhoneView(input) {
    return stackMode(input) === 'phone';
  }

  function isEmbedded() {
    if (typeof document === 'undefined') return false;
    if (document.body && document.body.hasAttribute('data-panel')) return true;
    return document.documentElement.classList.contains('edge-preview')
      || (document.body && document.body.classList.contains('edge-preview'));
  }

  function readPref() {
    try {
      const v = localStorage.getItem(PREF_KEY);
      return (v === 'on' || v === 'off') ? v : 'auto';
    } catch { return 'auto'; }   // private mode / storage disabled
  }

  // ── Reading order ─────────────────────────────────────────────────────────

  // Reading order over grid coordinates. Pure and exported: this is the whole
  // claim the stacked view makes about matching what the user sees on their PC.
  //
  // NOT a plain sort by (y, x), which is what this was and what made it wrong.
  // `y` is a grid row, so two tiles that sit visibly SIDE BY SIDE can differ in
  // it: measured on a real dashboard, three tiles filling one band were at
  // (x0,y0), (x8,y2) and (x16,y0), and a 2-row nudge — 70px, invisible as a
  // "row" to anybody looking at the screen — sorted the MIDDLE column last. The
  // user reads left, middle, right and gets left, right, middle.
  //
  // So tiles are grouped into visual BANDS first and ordered by x inside each.
  // A tile joins the open band when its top falls in the upper half of the
  // band's first tile: near-aligned tops are one row, and a tile that starts
  // halfway down a tall neighbour is genuinely below it, not beside it. The
  // half is relative to that first tile rather than a fixed number of rows, so
  // the rule means the same thing for a band of short tiles and a band of tall
  // ones; the floor of 2 keeps it from collapsing to "exactly equal" when the
  // anchor is only a few rows high.
  //
  // Ties break on the original DOM position, so the result is stable (two tiles
  // at the same coordinates can only happen mid-heal, and a stable sort keeps
  // the view from flickering while dashboard-layout resolves it).
  function readingOrder(items) {
    const list = (Array.isArray(items) ? items : []).map((it, i) => ({
      i,
      y: Number.isFinite(it && it.y) ? it.y : 0,
      x: Number.isFinite(it && it.x) ? it.x : 0,
      h: Number.isFinite(it && it.h) && it.h > 0 ? it.h : 8,
    }));
    // By y first so the anchor of every band is its topmost tile; x and the DOM
    // index only decide ties here, the real ordering happens per band below.
    list.sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.i - b.i));

    const out = [];
    let band = [];
    let anchor = null;
    const flush = () => {
      if (!band.length) return;
      band.sort((a, b) => (a.x - b.x) || (a.y - b.y) || (a.i - b.i));
      band.forEach((e) => out.push(e.i));
      band = [];
    };
    for (const e of list) {
      if (anchor && e.y > anchor.y + Math.max(2, Math.floor(anchor.h / 2))) {
        flush();
        anchor = null;
      }
      if (!anchor) anchor = e;
      band.push(e);
    }
    flush();
    return out;
  }

  function tileCoords(el) {
    return {
      y: parseInt(el.getAttribute('gs-y'), 10) || 0,
      x: parseInt(el.getAttribute('gs-x'), 10) || 0,
      h: parseInt(el.getAttribute('gs-h'), 10) || 8,
    };
  }

  function sortGrid(grid) {
    const items = [...grid.children].filter((n) => n.classList && n.classList.contains('grid-stack-item'));
    if (items.length < 2) { items.forEach(stampRows); return; }
    const order = readingOrder(items.map(tileCoords));
    // Already correct → touch nothing. Without this the observer below would
    // see its own reorder and loop.
    let sorted = true;
    for (let i = 0; i < order.length; i++) { if (order[i] !== i) { sorted = false; break; } }
    items.forEach(stampRows);
    if (sorted) return;
    const frag = document.createDocumentFragment();
    order.forEach((idx) => frag.appendChild(items[idx]));
    grid.appendChild(frag);
  }

  function stampRows(el) {
    const { h } = tileCoords(el);
    el.style.setProperty('--ph-rows', String(h));
  }

  function clearStamps() {
    document.querySelectorAll('.grid-stack-item').forEach((el) => el.style.removeProperty('--ph-rows'));
  }

  function sortAll() {
    if (!active) return;
    sorting = true;
    try { document.querySelectorAll('.dashboard.grid-stack').forEach(sortGrid); }
    finally { sorting = false; }
  }

  function scheduleSort() {
    if (!active || sorting || pending) return;
    pending = requestAnimationFrame(() => { pending = 0; sortAll(); });
  }

  // ── The thumb dock ────────────────────────────────────────────────────────

  // The topbar's controls sit at the top of a tall screen, which is the one
  // place a thumb cannot reach. These are FORWARDERS, not copies: each finds the
  // real button and clicks it, so state, i18n and behaviour stay in exactly one
  // place, and a chrome that moved that button (the Dynamic Island rails) still
  // works because the lookup is by class, not by position.
  // Forwarders: each aims at a real topbar button that always exists, so this
  // module never learns what any of them do.
  //
  // `dot` names an indicator that lives on the real button and would otherwise
  // be invisible here: the topbar copy is hidden on a phone, so whatever it was
  // telling the user was being told to nobody. It is MIRRORED rather than moved,
  // so the code that owns it keeps writing to exactly one element.
  const DOCK_BUTTONS = [
    { sel: '.qbtn-search', glyph: '⌕', key: 'ph_search' },
    { sel: '.topbtn-xenon', glyph: '✦', key: 'ph_ai' },
    { sel: '.qbtn-apps', glyph: '▦', key: 'ph_apps' },
    { sel: '.qbtn-settings', glyph: '⚙', key: 'ph_settings', dot: 'settings-update-dot' },
  ];

  // Actions registered by a feature that has no topbar button to forward to.
  // A widget TILE cannot be the target — it is only on screen if the user put
  // it on their PC layout, and the phone's primary action cannot depend on
  // that. Registration carries a `run` instead of a `sel`, and this module
  // still learns nothing about the feature: it calls the function.
  const dockActions = [];

  function label(key, fallback) {
    return (typeof t === 'function' ? t(key) : fallback) || fallback;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * The icon a dock button wears. CLONED from the button it forwards to, for
   * the same reason the click is forwarded: the dock stays whatever the topbar
   * is, and this module still never learns what any of them mean.
   *
   * It also fixes something that was wrong on the reporter's screen. The dock
   * used bare Unicode (⌕ ✦ ▦ ⚙) while every other control in the app is an
   * inline SVG — and those code points are whatever the device's font decides:
   * on Android ⚙ commonly resolves to the COLOUR emoji, and ⌕ and ▦ resolve to
   * a missing-glyph box in fonts that do not carry them. So a bar of five
   * controls could render as a mix of a coloured cog, two boxes and a star, on
   * the one surface where the user has nothing else to go on.
   *
   * A registered action has no button to copy, so it supplies `icon`: a path
   * in the same 24x24 box. It is written with setAttribute onto an inert
   * <path>, never as markup — same rule as the tile-shape picker.
   */
  function dockIcon(spec) {
    const src = spec.sel ? document.querySelector(spec.sel + ' svg') : null;
    if (src) {
      const svg = src.cloneNode(true);
      // The clone must not answer to anything that addressed the original.
      svg.removeAttribute('id');
      svg.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      svg.setAttribute('aria-hidden', 'true');
      return svg;
    }
    if (spec.icon) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'currentColor');
      svg.setAttribute('aria-hidden', 'true');
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', String(spec.icon));
      svg.appendChild(p);
      return svg;
    }
    // Last resort, and it stays a resort: better a glyph than an empty button.
    const g = document.createElement('span');
    g.className = 'ph-glyph';
    g.textContent = spec.glyph || '•';
    return g;
  }

  // One observer per mirrored indicator, torn down with the dock. Watching the
  // real element's `hidden` attribute rather than hooking whatever sets it: a
  // wrapper around a function is one rename away from silently doing nothing,
  // and this cannot drift from what is actually on screen.
  const dotWatchers = [];
  function stopDotWatchers() {
    while (dotWatchers.length) dotWatchers.pop().disconnect();
  }

  function mirrorDot(btn, id) {
    const real = document.getElementById(id);
    if (!real) return;
    const copy = document.createElement('span');
    copy.className = 'ph-dot';
    copy.setAttribute('aria-hidden', 'true');
    btn.appendChild(copy);
    const sync = () => { copy.hidden = !!real.hidden; };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(real, { attributes: true, attributeFilter: ['hidden'] });
    dotWatchers.push(mo);
  }

  function pageDots() {
    return [...document.querySelectorAll('.pager-dots .pager-dot')];
  }

  function stepPage(dir) {
    const dots = pageDots();
    if (dots.length < 2) return;
    let at = dots.findIndex((d) => d.classList.contains('is-active'));
    if (at < 0) at = 0;
    const next = at + dir;
    if (next < 0 || next >= dots.length) return;
    dots[next].click();          // the dot owns the navigation; we only aim it
  }

  function syncDockPages() {
    if (!dock) return;
    const dots = pageDots();
    const many = dots.length > 1;
    dock.classList.toggle('has-pages', many);
    if (!many) return;
    let at = dots.findIndex((d) => d.classList.contains('is-active'));
    if (at < 0) at = 0;
    dock.querySelector('.ph-page-at').textContent = (at + 1) + '/' + dots.length;
    dock.querySelector('.ph-prev').disabled = at === 0;
    dock.querySelector('.ph-next').disabled = at === dots.length - 1;
  }

  function buildDock() {
    if (dock) return dock;
    dock = document.createElement('nav');
    dock.className = 'ph-dock';
    dock.setAttribute('aria-label', label('ph_dock', 'Comandi rapidi'));

    const pages = document.createElement('div');
    pages.className = 'ph-pages';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'ph-btn ph-step ph-prev';
    prev.textContent = '‹';
    // A bare chevron is not a name. Without these the two most-tapped controls
    // on the bar announce themselves as "‹" and "›" to a screen reader, and
    // read as nothing at all under a magnifier.
    prev.title = label('ph_prev', 'Pagina precedente');
    prev.setAttribute('aria-label', prev.title);
    prev.addEventListener('click', () => stepPage(-1));
    const at = document.createElement('span');
    at.className = 'ph-page-at';
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'ph-btn ph-step ph-next';
    next.textContent = '›';
    next.title = label('ph_next', 'Pagina successiva');
    next.setAttribute('aria-label', next.title);
    next.addEventListener('click', () => stepPage(1));
    pages.append(prev, at, next);

    const acts = document.createElement('div');
    acts.className = 'ph-acts';
    for (const spec of [...dockActions, ...DOCK_BUTTONS]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ph-btn ph-act' + (spec.run ? ' ph-btn-action' : '');
      const name = label(spec.key, '');
      const ico = document.createElement('span');
      ico.className = 'ph-ico';
      ico.appendChild(dockIcon(spec));
      // The caption is what makes this a bar of controls rather than a row of
      // symbols. It can be clipped on a narrow screen in a long language, so
      // the accessible name stays on the BUTTON and never depends on it —
      // and a spec whose full name is a sentence ("An den PC senden") may name
      // a shorter key for the caption alone.
      const lab = document.createElement('span');
      lab.className = 'ph-lab';
      lab.textContent = spec.short ? label(spec.short, name) : name;
      b.append(ico, lab);
      b.title = name;
      b.setAttribute('aria-label', name);
      if (spec.dot) mirrorDot(b, spec.dot);
      if (spec.id) b.dataset.phAction = spec.id;
      b.addEventListener('click', () => {
        if (spec.run) { try { spec.run(); } catch (e) { console.warn('[phone-view] dock action failed', spec.id, e); } return; }
        const real = document.querySelector(spec.sel);
        // No silent no-op: a dock button whose target is gone (a chrome that
        // removed it, a build that renamed it) should say so in the console
        // rather than feel broken.
        if (real) real.click();
        else console.warn('[phone-view] no target for dock button', spec.sel);
      });
      acts.appendChild(b);
    }
    // ── Why the actions come FIRST and the pager last ────────────────────────
    // Occupying a row protects the dock from anything the DASHBOARD anchors to
    // the bottom of the screen (see below), but it cannot protect it from the
    // BROWSER: a mobile browser floats its own control over the page, and the
    // corner it picks is the bottom-right one. Reported on Android 16 (a
    // Firefox-based browser over Tailscale): its floating button sat exactly on
    // top of the dock's tail, which was the Settings forwarder — and phone view
    // hides the topbar's own Settings button, so that was the ONLY route to the
    // panel. The user's workaround was to ask the AI to open it.
    //
    // No page-level fix can win that argument, so the corner is CONCEDED rather
    // than contested: the pager goes there because it is the one dock control
    // with a second route (the pager swipes, and its dots are still live), while
    // the forwarders — none of which have another route on this chrome — anchor
    // to the left and put Settings nearer the middle of the bar than either
    // edge. On a single-page dashboard the pager is hidden, so the corner a
    // browser is most likely to steal is simply empty.
    //
    // The rule for anything added here: whatever ends up flush against an edge
    // must be reachable some other way.
    dock.append(acts, pages);
    // Inside the shell's grid, as a real third row — NOT floating over the page.
    // A fixed bar would have to win a z-index argument against every small thing
    // the dashboard anchors to the bottom of the screen (the Discord invite, the
    // event toasts, the Game Companion strip, the vitals pet, which walks along
    // it) while still losing to every modal. Occupying a row means nothing can be
    // underneath it, and the argument disappears instead of being won.
    const shell = document.querySelector('.shell');
    (shell || document.body).appendChild(dock);
    return dock;
  }

  /**
   * The one way the dock goes away. It owns MutationObservers now (the mirrored
   * indicators), and the three places that used to drop the node inline would
   * each have had to remember them — which is exactly how an observer survives
   * its element.
   */
  function destroyDock() {
    stopDotWatchers();
    if (dock) { dock.remove(); dock = null; }
  }

  // ── Enable / disable ──────────────────────────────────────────────────────

  function enable(mode) {
    // A mode CHANGE (phone ⇄ tablet) has to re-apply even though the view is
    // already on: the classes and the dock differ, and an early return keyed
    // only on `active` would leave a rotated tablet wearing the phone's chrome.
    if (active === mode) return;
    active = mode;
    const cl = document.documentElement.classList;
    cl.add('is-stacked');
    cl.toggle('is-phone', mode === 'phone');
    cl.toggle('is-tablet', mode === 'tablet');
    // The dock exists because the topbar sits where a thumb cannot reach on a
    // tall phone. A tablet keeps the real topbar, so a second copy of the same
    // four buttons would be clutter, not reach.
    if (mode === 'phone') buildDock();
    else destroyDock();
    sortAll();
    syncDockPages();
    // Tiles are added, removed, re-sized and re-grouped by the layout module
    // long after boot. Watch the coordinates rather than hook applyDashboardLayout:
    // a wrapper around a core function is one rename away from silently doing
    // nothing, whereas an observer on the attributes we actually read cannot
    // drift. Guarded + idempotent, so our own reorder does not re-trigger it.
    if (!observer) {
      observer = new MutationObserver(() => { if (!sorting) scheduleSort(); });
    }
    document.querySelectorAll('.pager').forEach((p) => observer.observe(p, {
      childList: true, subtree: true, attributeFilter: ['gs-x', 'gs-y', 'gs-h'],
    }));
  }

  function disable() {
    if (!active) return;
    active = null;
    document.documentElement.classList.remove('is-stacked', 'is-phone', 'is-tablet');
    if (observer) observer.disconnect();
    if (pending) { cancelAnimationFrame(pending); pending = 0; }
    clearStamps();
    destroyDock();
    // The DOM order stays as we left it. That is deliberate and harmless:
    // GridStack positions by attribute, not by document order, so the desktop
    // layout renders identically either way — and reshuffling nodes back would
    // be a second chance to get it wrong.
  }

  function sync() {
    const want = stackMode({
      width: window.innerWidth,
      height: window.innerHeight,
      preference: readPref(),
      embedded: isEmbedded(),
    });
    const was = active;
    if (want === 'off') disable(); else enable(want);
    // The Dynamic Island is a chrome for a screen with room beside the tiles;
    // topbar-minimal.js refuses to enable it while the phone view is on. Tell it
    // to re-decide whenever we cross the threshold, or a dashboard that was
    // wearing the island keeps wearing it — pill clipped off both edges, rails
    // over the content. Only on a CHANGE: apply() is cheap but not free, and
    // this runs on every resize tick.
    // Compared as the MODE, not as a boolean: phone → tablet keeps the view on
    // while changing whether the island may come back, and a boolean would miss
    // exactly that transition.
    if (was !== active && window.TopbarMinimal && typeof window.TopbarMinimal.apply === 'function') {
      try { window.TopbarMinimal.apply(); } catch { /* chrome choice must never break the layout */ }
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  let resizeT = null;
  function onResize() {
    clearTimeout(resizeT);
    resizeT = setTimeout(sync, 150);
  }

  function init() {
    sync();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.addEventListener('xenon:page-change', () => { scheduleSort(); syncDockPages(); });
    // The dots are re-rendered wholesale on page add/remove/rename, so re-read
    // them rather than caching the list.
    const dotsHost = document.getElementById('pager-dots');
    if (dotsHost) new MutationObserver(syncDockPages).observe(dotsHost, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    // Edge preview is toggled at runtime and marks itself with a class on <html>
    // rather than by resizing anything, so a resize listener would never see it.
    new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }

  // Browser wiring only when there is a browser. The two decisions worth
  // testing — the threshold policy and the reading order — are pure, and the
  // node test suite requires this file to reach them.
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    // Published BEFORE init(): topbar-minimal.js asks `PhoneView.isActive()` to
    // decide whether to put the Dynamic Island up, and init() can reach it
    // synchronously. Assigning after would leave that first decision reading an
    // undefined PhoneView — the island would go up on a phone exactly once, on
    // the load where it matters.
    window.PhoneView = {
      init, sync, enable, disable,
      /** True for BOTH stacked modes — topbar-minimal.js asks this to decide
       *  whether the Dynamic Island may go up, and the answer is no in either:
       *  the island's pill and edge rails need room BESIDE the tiles, which is
       *  the one thing neither of these layouts has. */
      isActive: () => !!active,
      /** 'phone' | 'tablet' | null — for anything that needs to tell them apart. */
      mode: () => active,
      /**
       * Register a dock button for a feature with no topbar button to forward
       * to. Idempotent by id, and safe to call before or after the dock exists:
       * a later call rebuilds it. `remove: true` takes one away again, which is
       * what a feature switched off in Settings must do — a dock button that
       * does nothing is worse than no button.
       *
       * `icon` is an SVG path in a 24x24 box — the dock has no button of ours to
       * copy one from for a registered action. `short` names a second i18n key
       * for the CAPTION only, for a feature whose real name is a sentence; the
       * accessible name stays `key`.
       *
       * @param {{id:string, glyph:string, key:string, run:Function,
       *          icon?:string, short?:string, remove?:boolean}} spec
       */
      addDockAction(spec) {
        if (!spec || !spec.id) return;
        const at = dockActions.findIndex((a) => a.id === spec.id);
        if (spec.remove) { if (at >= 0) dockActions.splice(at, 1); }
        else if (at >= 0) dockActions[at] = spec;
        else dockActions.push(spec);
        if (active === 'phone') {
          destroyDock();
          buildDock();
          syncDockPages();
        }
      },
      /** 'auto' | 'on' | 'off' — persisted per device, never to the server. */
      setPreference(v) {
        try { localStorage.setItem(PREF_KEY, (v === 'on' || v === 'off') ? v : 'auto'); } catch { /* storage off */ }
        sync();
      },
      getPreference: readPref,
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      stackMode, shouldUsePhoneView, readingOrder,
      PHONE_MAX_W, PHONE_MAX_H, PHONE_LANDSCAPE_MAX_W, ROW_PX,
      TABLET_MAX_W, TALL_DISPLAY_RATIO,
    };
  }
})();
