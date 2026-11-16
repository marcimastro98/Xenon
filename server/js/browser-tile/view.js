// How a Browser tile sits on the screen: a new size is sent once per frame, it streams only while
// it is in view, its tab strip and address bar can be hidden, and it can grow to fill the whole
// window.
'use strict';

window.BrowserTileView = (wrapper) => {
  const { ICONS, applyGroupState, pushResize } = wrapper;

  const { t } = window.BrowserTileSays;
  const { saveTabs } = window.BrowserTileStore;

  // Resize → tell the server to re-render the active tab at the new size (rAF-debounced).
  function wireResize(group) {
    let roQueued = false;
    const ro = new ResizeObserver(() => {
      if (roQueued) return; roQueued = true;
      requestAnimationFrame(() => {
        roQueued = false;
        pushResize(group, false);
      });
    });
    ro.observe(group.stage);
    group._ro = ro;
  }

  // Visibility = section not explicitly hidden AND actually occupying screen space.
  // Primary signal is an IntersectionObserver, because a Browser tile's visibility is
  // very often controlled by an ancestor (a tab group's inactive container is
  // display:none; the pager transforms off-screen pages away) that never mutates the
  // section's own attributes — a MutationObserver on the section alone would miss it.
  function observeVisibility(group, mount) {
    const section = mount.closest('.dashboard-widget') || mount.parentElement;
    if (!section) return;
    group.section = section;
    const evaluate = () => {
      const hidden = section.getAttribute('data-dashboard-hidden') === 'true';
      const onScreen = group._io
        ? group._intersecting
        : (section.offsetParent !== null && section.clientWidth > 0);
      group.onScreen = !hidden && onScreen;
      applyGroupState(group);
    };
    group._evaluate = evaluate;
    if (typeof IntersectionObserver === 'function') {
      group._intersecting = section.offsetParent !== null && section.clientWidth > 0;
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) group._intersecting = e.isIntersecting;
        evaluate();
      }, { threshold: 0.01 });
      io.observe(section);
      group._io = io;
    }
    const mo = new MutationObserver(evaluate);
    mo.observe(section, { attributes: true, attributeFilter: ['data-dashboard-hidden', 'style', 'class'] });
    group._mo = mo;
    evaluate();
  }

  // ── Hide/show the chrome (tab strip + address bar + favorites) ─────────────────
  // Lets a maximized video fill the tile. The stage grows into the freed space and
  // its ResizeObserver re-renders the page at the larger size automatically.
  function applyChromeHidden(group) {
    group.wrap.classList.toggle('is-chrome-hidden', !!group.chromeHidden);
    if (group.floatBar) group.floatBar.hidden = !group.chromeHidden;
  }
  function setChromeHidden(group, hidden) {
    if (!group) return;
    group.chromeHidden = !!hidden;
    applyChromeHidden(group);
    // Push the new stage size ourselves instead of waiting on the ResizeObserver.
    // Its callback runs inside a requestAnimationFrame, which does not run while the
    // document is hidden — and this is the exact change that leaves a tile stuck at
    // the wrong size when the frame it produces is missed (#116). Measuring here
    // costs one synchronous layout on a button tap, and the observer's own push a
    // frame later is a harmless no-op.
    pushResize(group, false);
    saveTabs(group);
  }

  // ── Expand to a true full-viewport overlay ────────────────────────────────────
  // Portal the wrap to <body> pinned at inset:0 (same approach the lock screen uses);
  // the GridStack item's stacking context + the Xeneon Edge's root zoom would trap a
  // position:fixed child otherwise. Native OS fullscreen is layered on as a bonus.
  function toggleExpand(group) {
    if (!group) return;
    if (group.expanded) collapse(group); else expand(group);
  }
  // The toolbar's button and the floating one say the same thing.
  function setExpandIcon(group, expanded) {
    for (const b of [group.expandBtn, group.floatExpandBtn]) {
      if (!b) continue;
      b.innerHTML = expanded ? ICONS.collapse : ICONS.expand;
      b.title = expanded ? t('browser_collapse', 'Collapse') : t('browser_expand', 'Expand');
    }
  }
  function expand(group) {
    if (group.expanded) return;
    group.expanded = true;
    document.body.appendChild(group.wrap);
    group.wrap.classList.add('browser-overlay');
    setExpandIcon(group, true);
    if (group.wrap.requestFullscreen) {
      group.wrap.requestFullscreen().catch(() => {});
      if (!group._fsHandler) {
        group._fsHandler = () => { if (!document.fullscreenElement && group.expanded) collapse(group); };
        document.addEventListener('fullscreenchange', group._fsHandler);
      }
    }
  }
  function collapse(group) {
    if (!group.expanded) return;
    group.expanded = false;
    group.wrap.classList.remove('browser-overlay');
    setExpandIcon(group, false);
    if (group._fsHandler) { document.removeEventListener('fullscreenchange', group._fsHandler); group._fsHandler = null; }
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) { /* ignore */ } }
    if (group.mount) group.mount.appendChild(group.wrap);
  }

  return { wireResize, observeVisibility, applyChromeHidden, setChromeHidden, toggleExpand, expand };
};
