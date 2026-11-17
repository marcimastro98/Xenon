// SDK Badges — host-side renderer for the Widget SDK `badge` capability.
//
// Distinct from Island (js/widget-sdk/sdk-island.js): a granted widget's small
// always-on chip renders next to the clock, in BOTH topbar chromes — it lives
// inside #clock-sdkbadges, a sibling of #clock-vitals inside .clock, so it rides
// the same minimal-topbar reparenting for free (see topbar-minimal.js: the whole
// .clock element moves into the island pill, chips included).
//
// Unlike Island's single shared slot, several distinct granted packages may
// each hold a chip at once, up to MAX_BADGES — bounded so the clock row can't
// overflow; a package trying to claim a chip past the cap is a silent no-op
// (cosmetic layout limit, not a correctness issue).
//
// A chip is `icon` + `value` + optional `parts`. The leading icon (a glyph, a
// named icon from the app's library or the widget's own path) carries the
// widget's own colour (its identity — GitHub stars are gold); the value follows
// in the topbar's text colour. Parts are up to four independently styled pieces
// (text, icon, bar, Vitals-like meter) drawn by SdkBlockRender from the island's
// own block schema. `normalize` rebuilds every message before anything is drawn,
// and every string is rendered via textContent — never markup.
//
// Auto-clear: a sweep asks CustomWidget whether each owning package still
// has a live frame and drops its chip when the tile is gone — same shape as
// Island's sweep (gate-periodic-work invariant: the timer runs only while
// there's at least one chip to watch).
(function initSdkBadges(root) {
  'use strict';

  const SWEEP_MS = 5000;
  const MAX_BADGES = 4;
  const TEXT_MAX = 32;
  const TOOLTIP_MAX = 48;
  const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

  const owners = new Map();   // pkgId -> { view, onAction, chip, chipAction }
  let sweepTimer = null;

  function clean(value, max) {
    const source = String(value == null ? '' : value);
    let out = '';
    for (let i = 0; i < source.length; i++) {
      const code = source.charCodeAt(i);
      out += (code <= 31 || code === 127) ? ' ' : source[i];
    }
    return out.trim().slice(0, max);
  }

  // The badge message, rebuilt: bounded plain text, strict hex, the icon and the
  // parts through the island's block schema. Null means "nothing to show" (an
  // empty chip is a clear, as it always was).
  function normalize(msg) {
    const schema = root.SdkIslandSchema;
    if (!msg || typeof msg !== 'object' || !schema) return null;
    const text = clean(msg.text, TEXT_MAX);
    const blocks = schema.normalizeBadgeBlocks(msg.blocks);
    if (!text && !blocks.length) return null;
    const color = String(msg.color == null ? '' : msg.color).trim();
    const view = {
      text,
      tooltip: clean(msg.tooltip, TOOLTIP_MAX),
      icon: schema.normalizeIcon({ name: msg.iconName, path: msg.iconPath }, msg.icon),
      color: COLOR_RE.test(color) ? color : '',
      blocks,
    };
    if (schema.SIZES.includes(msg.size) && msg.size !== 'medium') view.size = msg.size;
    return view;
  }

  function host() {
    return document.getElementById('clock-sdkbadges');
  }

  function sourceEnabled(pkgId) {
    const island = root.SdkIsland;
    return !island || typeof island.sourceEnabled !== 'function' || island.sourceEnabled(pkgId);
  }

  // The chip row is an island segment ('badges' in topbar-minimal.js), so a
  // STRUCTURAL change (chips appearing/disappearing) must re-run the island
  // layout: applyIslandLayout keeps the first-visible segment's "lead" (no left
  // hairline) correct, and reflowIsland re-tucks tiles now sitting under a pill
  // that just grew or shrank. Deliberately NOT called on value-only updates — a
  // ticking count would reflow the grid on every tick for a few pixels.
  function syncIslandLayout() {
    const tm = root.TopbarMinimal;
    if (!tm) return;
    if (typeof tm.applyIslandLayout === 'function') tm.applyIslandLayout();
    if (typeof tm.reflowIsland === 'function') tm.reflowIsland();
  }

  function syncHostVisibility(h) {
    if (h) h.hidden = !Array.from(owners.keys()).some(sourceEnabled);
  }

  // A meter part that opens a card or answers a tap is its own button, so the
  // chip around it cannot be one too (a button inside a button is invalid and
  // the browser would split them). Without the badge's tap grant a meter keeps
  // its card but loses its id: it must never post an action the user did not
  // allow.
  function partsOf(owner) {
    return owner.view.blocks.map((block) => (block.type === 'meter' && block.id && !owner.onAction
      ? Object.assign({}, block, { id: '' }) : block));
  }

  function chipIsButton(owner, parts) {
    return typeof owner.onAction === 'function'
      && !parts.some((block) => block.type === 'meter' && (block.id || block.detail));
  }

  function newChip(pkgId, asButton) {
    const chip = document.createElement(asButton ? 'button' : 'span');
    chip.className = 'sdk-badge' + (asButton ? ' sdk-badge-btn' : '');
    if (asButton) {
      chip.type = 'button';
      // The handler reads owner.onAction at click time, never the value captured
      // now: a package that updates its badge replaces the callback, and a stale
      // one would post into a frame that has since been rebuilt.
      chip.addEventListener('click', () => {
        const fn = owners.get(pkgId)?.onAction;
        if (typeof fn === 'function') fn();
      });
    }
    return chip;
  }

  function fill(owner, parts) {
    const { view } = owner;
    const render = root.SdkBlockRender;
    const nodes = [];
    const icon = view.icon || {};
    if ((icon.text || icon.name || icon.path) && render) {
      const ico = render.iconNode(icon, 'sdk-badge-ico');
      if (view.color) ico.style.color = view.color;
      nodes.push(ico);
    }
    if (view.text) {
      const val = document.createElement('span');
      val.className = 'sdk-badge-val';
      val.textContent = view.text;
      nodes.push(val);
    }
    if (parts.length && render) {
      const box = document.createElement('span');
      box.className = 'sdk-badge-parts';
      const tap = (id) => { if (typeof owner.onAction === 'function') owner.onAction(id); };
      parts.forEach((block) => { const node = render.render(block, tap, owner.pkgId); if (node) box.appendChild(node); });
      nodes.push(box);
    }
    owner.chip.replaceChildren(...nodes);
    owner.chip.classList.toggle('is-small', view.size === 'small');
    owner.chip.classList.toggle('is-large', view.size === 'large');
    owner.chip.title = view.tooltip || '';
  }

  function render(pkgId) {
    const h = host();
    const owner = owners.get(pkgId);
    if (!h || !owner) return;
    if (!sourceEnabled(pkgId)) {
      if (owner.chip?.parentNode) owner.chip.parentNode.removeChild(owner.chip);
      owner.chip = null;
      syncHostVisibility(h);
      syncIslandLayout();
      return;
    }
    // A chip appearing changes the pill's structure; its VALUE changing does not
    // (see syncIslandLayout). A chip that gains or loses its tap is structural
    // too: it changes element type, so the old node is swapped in place (the
    // chips are in claim order and the user reads them by position).
    const parts = partsOf(owner);
    const asButton = chipIsButton(owner, parts);
    let structural = false;
    if (!owner.chip?.isConnected || owner.chipAction !== asButton) {
      const old = owner.chip?.isConnected ? owner.chip : null;
      owner.chip = newChip(pkgId, asButton);
      owner.chipAction = asButton;
      if (old) old.replaceWith(owner.chip); else h.appendChild(owner.chip);
      structural = true;
    }
    fill(owner, parts);
    syncHostVisibility(h);
    if (structural) syncIslandLayout();
  }

  function removeChip(pkgId) {
    const owner = owners.get(pkgId);
    if (owner?.chip?.parentNode) owner.chip.parentNode.removeChild(owner.chip);
    owners.delete(pkgId);
    syncHostVisibility(host());
    syncIslandLayout();
  }

  function syncSweep() {
    const want = owners.size > 0;
    if (want && !sweepTimer) {
      sweepTimer = setInterval(() => {
        const cw = root.CustomWidget;
        if (!cw || typeof cw.pkgHasLiveFrame !== 'function') return;
        for (const pkgId of Array.from(owners.keys())) {
          if (!cw.pkgHasLiveFrame(pkgId)) removeChip(pkgId);
        }
        syncSweep();
      }, SWEEP_MS);
    } else if (!want && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  // `view` comes from normalize(); `onAction` is supplied by custom-widget.js
  // only when the package declared `badge: { action: true }` AND holds that
  // grant — absent, the chip is read-only and its meters only open their cards.
  function set(pkgId, view, onAction) {
    if (typeof pkgId !== 'string' || !pkgId || !view || (!view.text && !view.blocks?.length)) return;
    if (!owners.has(pkgId) && owners.size >= MAX_BADGES) return;   // cap reached: silent no-op
    const cur = owners.get(pkgId) || {};
    owners.set(pkgId, {
      pkgId,
      view,
      onAction: typeof onAction === 'function' ? onAction : null,
      chip: cur.chip,
      chipAction: cur.chipAction,
    });
    render(pkgId);
    syncSweep();
  }

  function clear(pkgId) {
    if (!owners.has(pkgId)) return;
    removeChip(pkgId);
    syncSweep();
  }

  // A per-package Dynamic Island switch changed. Keep the latest value in
  // memory so re-enabling restores it immediately, but reconcile its host chip.
  function apply() {
    for (const pkgId of owners.keys()) render(pkgId);
    syncHostVisibility(host());
    syncIslandLayout();
  }

  const api = { set, clear, apply, normalize, MAX_BADGES, TEXT_MAX };
  if (typeof window !== 'undefined') window.SdkBadges = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
