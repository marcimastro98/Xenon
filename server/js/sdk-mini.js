// SDK mini slot — host-side renderer for the Widget SDK `mini` capability.
//
// A small block of readout in the topbar's BUTTON row, next to Lock/Ambient/
// Search, rather than inside the clock. It exists because the buttons became
// hideable (Settings → Dynamic Island → Bottoni della barra) and the space a
// user frees should be able to hold something they chose to put there.
//
// Where it differs from its two neighbours:
//   - Island (js/sdk-island.js) is ONE shared slot, centred, and transient: an
//     activity that comes and goes. This is persistent and several packages can
//     hold a piece of it at once.
//   - Badges (js/sdk-badges.js) are text chips inside the clock, so they follow
//     the clock. This one follows the BUTTONS, and the user picks its side and
//     its position among them like any other button.
//
// It is host-rendered from the island's own block allowlist — SdkIslandSchema
// validates, SdkIsland.renderBlock draws — so no widget HTML, CSS or event
// handler ever reaches the chrome. That is the whole reason the chrome can stay
// a place where package code never runs: the CSP and sandbox of a widget frame
// (sdk-widgets.js WIDGET_CSP) are untouched by anything here.
//
// Auto-clear: the same sweep the island and the badges use — ask CustomWidget
// whether the owning package still has a live frame, drop its blocks when it
// does not. The timer runs only while there is at least one owner to watch
// (gate-periodic-work invariant).
(() => {
  'use strict';

  const SWEEP_MS = 5000;
  const MAX_OWNERS = 3;

  const owners = new Map();   // pkgId -> { view, onAction, node }
  let sweepTimer = null;

  function host() {
    return document.getElementById('topbar-mini-slot');
  }

  // The same per-package switch that governs the island and the badges
  // (Settings → Dynamic Island → App e widget). One list, one meaning: "I do not
  // want this package in my top bar", wherever in it the package draws.
  function sourceEnabled(pkgId) {
    return !window.SdkIsland || typeof SdkIsland.sourceEnabled !== 'function' || SdkIsland.sourceEnabled(pkgId);
  }

  // The slot is an entry in topbarClock.actions, so a change to what it holds can
  // change the width of the row it sits in. In Minimal that row is the rail
  // beside the island, so re-run the same layout pass the badges do — and only on
  // a STRUCTURAL change, never on a value tick, or a counting widget would reflow
  // the grid on every update for a few pixels.
  function syncLayout() {
    const tm = window.TopbarMinimal;
    if (!tm) return;
    if (typeof tm.applyIslandLayout === 'function') tm.applyIslandLayout();
    if (typeof tm.reflowIsland === 'function') tm.reflowIsland();
  }

  // Hidden while nothing is drawing in it: an empty container in the bar takes
  // room and draws a gap for no reason. This is separate from the user's own
  // show/hide of the slot (`topbar-item-hidden`, applied by topbar-minimal.js) —
  // one says "there is nothing to show", the other says "I do not want it".
  function syncHostVisibility(h) {
    if (h) h.hidden = !Array.from(owners.keys()).some(sourceEnabled);
  }

  function renderOwner(pkgId) {
    const h = host();
    if (!h) return false;
    const owner = owners.get(pkgId);
    if (!owner) return false;
    const wanted = sourceEnabled(pkgId);
    if (!wanted) {
      if (owner.node && owner.node.parentNode) owner.node.parentNode.removeChild(owner.node);
      owner.node = null;
      return true;
    }
    let structural = false;
    if (!owner.node || !owner.node.isConnected) {
      owner.node = document.createElement('span');
      owner.node.className = 'topbar-mini-item';
      h.appendChild(owner.node);
      structural = true;
    }
    // Rebuilt wholesale on every update: a block list is small (4 at most) and
    // diffing it would buy nothing but a way for the two surfaces' renderers to
    // disagree about what a block is.
    const blocks = [];
    (owner.view.blocks || []).forEach((block) => {
      const node = window.SdkIsland && typeof SdkIsland.renderBlock === 'function'
        ? SdkIsland.renderBlock(block, owner)
        : null;
      if (node) blocks.push(node);
    });
    owner.node.replaceChildren(...blocks);
    owner.node.title = owner.view.tooltip || '';
    // The package's own accent, already validated as plain hex by the schema. It
    // colours this item only — a mini slot never tints the dashboard (that is the
    // separate `accent` capability, which the user grants on its own).
    owner.node.style.setProperty('--island-accent', owner.view.accent || '');
    return structural;
  }

  function removeOwner(pkgId) {
    const owner = owners.get(pkgId);
    if (owner && owner.node && owner.node.parentNode) owner.node.parentNode.removeChild(owner.node);
    owners.delete(pkgId);
    syncHostVisibility(host());
    syncLayout();
  }

  function syncSweep() {
    const want = owners.size > 0;
    if (want && !sweepTimer) {
      sweepTimer = setInterval(() => {
        const cw = window.CustomWidget;
        if (!cw || typeof cw.pkgHasLiveFrame !== 'function') return;
        for (const pkgId of Array.from(owners.keys())) {
          if (!cw.pkgHasLiveFrame(pkgId)) removeOwner(pkgId);
        }
        syncSweep();
      }, SWEEP_MS);
    } else if (!want && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  // `view` arrives already normalized by SdkIslandSchema.normalizeMini and grant
  // -checked by custom-widget.js; nothing here trusts the package directly.
  function set(pkgId, view, onAction) {
    if (typeof pkgId !== 'string' || !pkgId || !view || !Array.isArray(view.blocks) || !view.blocks.length) return;
    if (!owners.has(pkgId) && owners.size >= MAX_OWNERS) return;   // cap reached: silent no-op
    const cur = owners.get(pkgId) || {};
    owners.set(pkgId, {
      view,
      onAction: typeof onAction === 'function' ? onAction : null,
      node: cur.node,
    });
    const structural = renderOwner(pkgId);
    syncHostVisibility(host());
    if (structural) syncLayout();
    syncSweep();
  }

  function clear(pkgId) {
    if (!owners.has(pkgId)) return;
    removeOwner(pkgId);
    syncSweep();
  }

  // A per-package switch changed, or safe mode / a suspend flipped. Keep the
  // latest view in memory so re-enabling restores it instantly, and reconcile
  // what is actually on screen.
  function apply() {
    for (const pkgId of owners.keys()) renderOwner(pkgId);
    syncHostVisibility(host());
    syncLayout();
  }

  window.SdkMini = { set, clear, apply };
})();
