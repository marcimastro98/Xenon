// Which decisions the tile shows, on which surface (tile, sheet, topbar), and since when each one
// was first seen.
'use strict';

(() => {
  const { live } = window.ClaudeWidgetKnown;

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="claude"]')).filter(n => n.closest('.pager-page, .layer-slot'));
  }

  // A page the pager has parked (.is-parked → content-visibility: hidden,
  // DashboardPager.css) is not rendered, but it KEEPS its box — so a rects-only
  // test reads a tile sitting there as visible. Same test the slideshow tile
  // uses, including the layout-editing exception: editing un-parks those pages,
  // matching the CSS, so it must not count as parked there.
  function isParked(tile) {
    const page = tile.closest('.pager-page');
    return !!(page && page.classList.contains('is-parked')
      && !document.body.classList.contains('layout-editing'));
  }

  // Both surfaces below appear OUTSIDE the tile — the approval cards escalate to
  // a fullscreen overlay and the topbar marker sits in the clock island — so they
  // show up even when the widget isn't on the current page. That is deliberate
  // (a blocked tool call must stay answerable), but it has to be the user's
  // choice, so each is a switch in Settings → Claude Code. Defaults stay on.
  function cfg() {
    return (typeof hubSettings === 'object' && hubSettings && hubSettings.claudeWidget) || null;
  }

  function approvalsOn() { const c = cfg(); return !c || c.approvals !== false; }

  function questionsOn() { const c = cfg(); return !c || c.questions !== false; }

  function topbarOn() {
    const c = cfg();
    try {
      const items = hubSettings && hubSettings.topbarClock && hubSettings.topbarClock.items;
      const item = Array.isArray(items) ? items.find((entry) => entry && entry.id === 'claude') : null;
      if (item) return item.hidden !== true;
    } catch { /* legacy settings fallback below */ }
    return !c || c.topbar !== false;
  }

  // With a surface switched off there is nothing to show, nothing to escalate
  // and nothing for the topbar to call urgent. The server also answers the hook
  // immediately in that case, so the prompt is already back in the terminal by
  // the time this runs — the two halves have to agree or the tile would draw a
  // card for something nobody is waiting on any more.
  //
  // The two switches are separate because the bargains are: a permission decides
  // whether something RUNS on this PC, a question only picks how Claude
  // proceeds. Filtering both on the permission switch would have hidden every
  // question from anyone who only wanted approvals at the keyboard.
  function approvals() {
    const l = live();
    const all = (l && l.approvals) || [];
    return all.filter((a) => (a.kind === 'question' ? questionsOn() : approvalsOn()));
  }

  const firstSeen = new Map();   // approval id → when this surface first drew it

  function forgetSeen() {
    const alive = new Set(approvals().map((a) => a.id));
    for (const id of firstSeen.keys()) if (!alive.has(id)) firstSeen.delete(id);
  }

  function decisionsFor(id) {
    const pend = approvals().filter((a) => !a.urgent);
    // A request with no session id cannot be placed; it shows wherever you are.
    return {
      mine: pend.filter((a) => !a.sessionId || a.sessionId === id),
      others: pend.filter((a) => a.sessionId && a.sessionId !== id),
    };
  }

  window.ClaudeWidgetDecisionsShown = {
    tiles, isParked, approvalsOn, topbarOn, approvals, firstSeen, forgetSeen, decisionsFor,
  };
})();
