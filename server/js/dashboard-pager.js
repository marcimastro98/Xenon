// Dashboard pager — generic horizontal multi-page surface.
// Pure navigation helpers live at the top (no DOM access) so they are unit-
// testable under Node; the DOM controller is added in a later task. The
// bottom export guard is inert in the browser (no `module` global there).
(function () {
  'use strict';

  const WHEEL_THRESHOLD = 24; // px; below this we treat the wheel as noise

  // Keep a page index within [0, count-1]; fall back to 0 when there are none.
  function clampPageIndex(index, count) {
    if (!count || count < 1) return 0;
    return Math.max(0, Math.min(count - 1, index | 0));
  }

  // Index of the page whose id matches, or -1 if no page has that id.
  function resolvePageId(id, pages) {
    if (!Array.isArray(pages)) return -1;
    return pages.findIndex(p => p && p.id === id);
  }

  // Direction to page from a wheel event: +1 next, -1 previous, 0 do nothing.
  // Only a clear horizontal intent pages — plain vertical wheel is left to the
  // inner panels so we never hijack normal scrolling.
  function shouldPageOnWheel(ev) {
    const horizontal = Math.abs(ev.deltaX) >= WHEEL_THRESHOLD ? ev.deltaX : 0;
    const shifted = ev.shiftKey && Math.abs(ev.deltaY) >= WHEEL_THRESHOLD ? ev.deltaY : 0;
    const delta = horizontal || shifted;
    if (!delta) return 0;
    return delta > 0 ? 1 : -1;
  }

  // Which pages should be navigable: while editing, all declared pages (so a
  // module can be sent to an empty page); otherwise only pages holding ≥1
  // visible widget. Order follows `allPageIds`.
  function computeActivePages(allPageIds, widgets, editing) {
    if (!Array.isArray(allPageIds)) return [];
    if (editing) return allPageIds.slice();
    const used = new Set();
    Object.keys(widgets || {}).forEach(id => {
      const w = widgets[id];
      if (w && w.visible && w.page) used.add(w.page);
    });
    return allPageIds.filter(p => used.has(p));
  }

  const pages = [];        // { id, label, element, onEnter, onLeave }
  let viewport = null;     // the scroll-snap container
  let dotsHost = null;     // element that holds the dot buttons
  let currentIndex = 0;
  let scrollSettleTimer = null;
  let entered = new Set(); // ids whose onEnter has fired at least once

  function getCurrentPage() {
    return pages[currentIndex] ? pages[currentIndex].id : null;
  }

  // True when `el` is on the page the user is actually looking at. The pager
  // keeps non-current pages mounted (just transformed off-screen), so a tile on
  // page 2 still has a non-null offsetParent and passes document.hidden — this is
  // the correct gate for "should this widget keep polling / animating". An element
  // not inside any pager page (topbar, lockscreen, modal) is always "current".
  function isOnCurrentPage(el) {
    if (!el || !(el instanceof Element)) return true;
    // Single-panel embeds (?panel=media, ?panel=system, …) show exactly one panel
    // with no pager navigation — never gate their polling on page position, even
    // if the saved layout authored that widget on a non-first page.
    if (typeof document !== 'undefined' && document.body && document.body.dataset.panel) return true;
    const page = el.closest('.pager-page');
    if (!page) return true;
    const cur = pages[currentIndex];
    return !!(cur && cur.element === page);
  }

  function registerPage(page) {
    if (!page || !page.id || !(page.element instanceof Element)) return;
    pages.push({
      id: page.id,
      label: page.label || page.id,
      element: page.element,
      active: true,
      onEnter: typeof page.onEnter === 'function' ? page.onEnter : null,
      onLeave: typeof page.onLeave === 'function' ? page.onLeave : null,
    });
  }

  function renderDots() {
    if (!dotsHost) return;
    dotsHost.textContent = '';
    let activeCount = 0;
    pages.forEach((page, i) => {
      if (page.active === false) return;
      activeCount++;
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'pager-dot' + (i === currentIndex ? ' is-active' : '');
      dot.setAttribute('aria-label', page.label);
      dot.setAttribute('aria-current', i === currentIndex ? 'true' : 'false');
      dot.addEventListener('click', () => goToPage(page.id));
      dotsHost.appendChild(dot);
    });
    // In Layout mode, the dots double as a page manager: reorder the current
    // page (‹ › — swap with its neighbour), remove it (× — disabled when it's
    // the only one) and add a new, unnamed one (+).
    const editing = typeof document !== 'undefined' && document.body.classList.contains('layout-editing');
    if (editing && window.DashboardPages) {
      const label = (key, fb) => (typeof t === 'function' ? t(key) : fb);
      const activeIdx = pages.map((p, i) => (p.active === false ? -1 : i)).filter(i => i >= 0);
      const herePos = activeIdx.indexOf(currentIndex);
      const mkMove = (dir, glyph, key, fb, disabled) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pager-page-btn pager-page-move';
        btn.textContent = glyph;
        btn.title = label(key, fb);
        btn.setAttribute('aria-label', btn.title);
        btn.disabled = disabled;
        btn.addEventListener('click', () => {
          const id = getCurrentPage();
          if (id && typeof window.DashboardPages.move === 'function') window.DashboardPages.move(id, dir);
        });
        return btn;
      };
      dotsHost.appendChild(mkMove(-1, '‹', 'layout_move_page_left', 'Move page left', herePos <= 0));
      dotsHost.appendChild(mkMove(1, '›', 'layout_move_page_right', 'Move page right', herePos < 0 || herePos >= activeIdx.length - 1));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'pager-page-btn pager-page-remove';
      remove.textContent = '×';
      remove.title = label('layout_remove_page', 'Remove page');
      remove.setAttribute('aria-label', remove.title);
      remove.disabled = activeCount <= 1;
      remove.addEventListener('click', () => { const id = getCurrentPage(); if (id) window.DashboardPages.remove(id); });
      dotsHost.appendChild(remove);

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'pager-page-btn pager-page-add';
      add.textContent = '+';
      add.title = label('layout_add_page', 'Add page');
      add.setAttribute('aria-label', add.title);
      add.addEventListener('click', () => window.DashboardPages.add());
      dotsHost.appendChild(add);
    }
  }

  function setCurrentIndex(index) {
    const next = clampPageIndex(index, pages.length);
    if (next === currentIndex) { renderDots(); return; }
    const leaving = pages[currentIndex];
    if (leaving && leaving.onLeave) { try { leaving.onLeave(); } catch (e) { console.error(e); } }
    currentIndex = next;
    const arriving = pages[currentIndex];
    if (arriving && arriving.onEnter && !entered.has(arriving.id)) {
      entered.add(arriving.id);
      try { arriving.onEnter(); } catch (e) { console.error(e); }
    }
    renderDots();
  }

  // Index of the active page whose element offset is nearest the scroll position.
  function nearestActiveIndex() {
    let best = currentIndex, bestDist = Infinity;
    pages.forEach((p, i) => {
      if (p.active === false || !p.element) return;
      const dist = Math.abs(p.element.offsetLeft - viewport.scrollLeft);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    return best;
  }

  // Public: navigate by page id (used by dots, keyboard, and AI go_to_page).
  // Offset-based so hidden pages (removed from flow) don't break the math.
  function goToPage(id) {
    const page = pages.find(p => p.id === id);
    if (!page || page.active === false || !viewport || !page.element) return;
    viewport.scrollTo({ left: page.element.offsetLeft, behavior: 'smooth' });
    setCurrentIndex(pages.indexOf(page));
  }

  function goByDelta(delta) {
    const activeIdx = pages.map((p, i) => (p.active === false ? -1 : i)).filter(i => i >= 0);
    const here = activeIdx.indexOf(currentIndex);
    const next = activeIdx[Math.max(0, Math.min(activeIdx.length - 1, here + (delta < 0 ? -1 : 1)))];
    if (next != null && pages[next]) goToPage(pages[next].id);
  }

  // Show/hide pages by id. Pages not in `activeIds` are hidden (removed from
  // flow) and dropped from the dots; the current page is redirected if hidden.
  function setActivePages(activeIds) {
    const set = new Set(Array.isArray(activeIds) ? activeIds : []);
    pages.forEach(p => {
      p.active = set.has(p.id);
      if (p.element) p.element.hidden = !p.active;
    });
    if (!pages[currentIndex] || pages[currentIndex].active === false) {
      const firstActive = pages.findIndex(p => p.active);
      if (firstActive >= 0) {
        currentIndex = firstActive;
        if (viewport && pages[firstActive].element) viewport.scrollTo({ left: pages[firstActive].element.offsetLeft });
      }
    }
    renderDots();
  }

  // Drag-pan only from page background — never from interactive widgets, so we
  // don't fight dashboard-layout panel reordering or normal control input.
  const INTERACTIVE = '.dashboard-widget, button, input, select, textarea, a, [draggable="true"], [contenteditable]';

  // Swipe-to-change-page is on by default. When the user turns it off in Settings,
  // the native horizontal scroll is blocked with the `.no-swipe` CSS class and the
  // JS drag-pan below early-returns; dot and keyboard navigation still work.
  let swipeEnabled = true;

  // Read the preference from hubSettings (a sibling global) and apply it. Called
  // by settings.js (init + on change) and safe before the viewport exists.
  function refreshSwipe() {
    swipeEnabled = !(typeof hubSettings === 'object' && hubSettings && hubSettings.swipeNavigation === false);
    if (viewport) viewport.classList.toggle('no-swipe', !swipeEnabled);
  }

  function bindEvents() {
    // Reconcile current page after a scroll settles (covers swipe + drag).
    viewport.addEventListener('scroll', () => {
      clearTimeout(scrollSettleTimer);
      scrollSettleTimer = setTimeout(() => {
        setCurrentIndex(nearestActiveIndex());
        // Minimal-topbar mode tags only the VISIBLE page's tiles with the
        // floating-island clearance (the overlap test is viewport-relative), so
        // a freshly-scrolled-to page has no clearance until we re-run it here —
        // otherwise its top-row header sits under the clock pill. Cheap + no-op
        // in full-topbar mode.
        if (window.TopbarMinimal && window.TopbarMinimal.reflowIsland) window.TopbarMinimal.reflowIsland();
      }, 90);
    }, { passive: true });

    viewport.addEventListener('wheel', (ev) => {
      if (!swipeEnabled) return;
      const dir = shouldPageOnWheel(ev);
      if (dir !== 0) { ev.preventDefault(); goByDelta(dir); }
    }, { passive: false });

    let dragStartX = 0, dragStartScroll = 0, dragging = false;
    const editingNow = () => typeof document !== 'undefined' && document.body.classList.contains('layout-editing');
    viewport.addEventListener('pointerdown', (ev) => {
      // While editing the layout, never page-pan: all touches belong to GridStack
      // drag/resize (whose grips/handles sit outside .dashboard-widget, so they'd
      // otherwise start a pan that fights the resize and gets "stuck" on touch).
      if (!swipeEnabled) return;
      if (editingNow()) return;
      if (ev.target.closest(INTERACTIVE)) return; // leave widgets alone
      dragging = true; dragStartX = ev.clientX; dragStartScroll = viewport.scrollLeft;
    });
    viewport.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      viewport.scrollLeft = dragStartScroll - (ev.clientX - dragStartX);
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      goToPage(pages[nearestActiveIndex()].id);
    };
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);

    document.addEventListener('keydown', (ev) => {
      if (ev.target.closest(INTERACTIVE)) return;
      if (ev.key === 'ArrowRight') goByDelta(1);
      else if (ev.key === 'ArrowLeft') goByDelta(-1);
    });
  }

  // init({ viewport, dots }): wire the controller to existing DOM. Safe no-op
  // if the elements are missing, so the dashboard still works standalone.
  function init(opts) {
    viewport = (opts && opts.viewport) || document.getElementById('dashboard-pager');
    dotsHost = (opts && opts.dots) || document.getElementById('pager-dots');
    if (!viewport) return;
    bindEvents();
    refreshSwipe();
    setCurrentIndex(0);
    renderDots();
  }

  // Replace the registered pages wholesale (used when the user adds/removes/
  // reorders pages). Keeps the current page if its id still exists.
  function setPages(descriptors) {
    const prevId = pages[currentIndex] ? pages[currentIndex].id : null;
    pages.length = 0;
    entered.clear();
    currentIndex = 0;
    (Array.isArray(descriptors) ? descriptors : []).forEach(d => registerPage(d));
    const idx = prevId ? pages.findIndex(p => p.id === prevId) : -1;
    currentIndex = idx >= 0 ? idx : 0;
    renderDots();
    if (viewport && pages[currentIndex] && pages[currentIndex].element) {
      viewport.scrollTo({ left: pages[currentIndex].element.offsetLeft });
    }
  }

  if (typeof window !== 'undefined') {
    window.DashboardPager = { init, registerPage, goToPage, getCurrentPage, isOnCurrentPage, setActivePages, setPages, renderDots, refreshSwipe };
    // Shared rule for the layout module so "which pages are active" lives in one
    // place. Caller supplies the current (dynamic) page-id list.
    window.computeActivePagesForLayout = (allPageIds, widgets, editing) => computeActivePages(allPageIds, widgets, editing);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { clampPageIndex, resolvePageId, shouldPageOnWheel, computeActivePages };
  }
})();
