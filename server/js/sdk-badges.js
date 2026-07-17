// SDK Badges — host-side renderer for the Widget SDK `badge` capability.
//
// Distinct from Island (js/sdk-island.js): a granted widget's small
// always-on text chip renders next to the clock, in BOTH topbar chromes —
// it lives inside #clock-sdkbadges, a sibling of #clock-vitals inside
// .clock, so it rides the same minimal-topbar reparenting for free (see
// topbar-minimal.js: the whole .clock element moves into the island pill,
// chips included — no minimal-mode-specific JS needed here).
//
// Unlike Island's single shared slot, several distinct granted packages may
// each hold a chip at once, up to MAX_BADGES — bounded so the clock row
// can't overflow; a package trying to claim a chip past the cap is a silent
// no-op (cosmetic layout limit, not a correctness issue). All strings arrive
// pre-coerced from custom-widget.js (onBridgeBadge: manifest + grant
// checked, control chars stripped, hard length cap, colour hex-validated) and
// are rendered ONLY via textContent — never markup. Nothing here ever reaches
// the server.
//
// A chip is `icon` + `value`: the optional leading glyph carries the widget's
// own colour (its identity — GitHub stars are gold), the value follows in the
// topbar's text colour. Same {icon, color} meta a deck key's live badge takes.
//
// Auto-clear: a sweep asks CustomWidget whether each owning package still
// has a live frame and drops its chip when the tile is gone — same shape as
// Island's sweep (gate-periodic-work invariant: the timer runs only while
// there's at least one chip to watch).
(() => {
  'use strict';

  const SWEEP_MS = 5000;
  const MAX_BADGES = 4;

  const owners = new Map();   // pkgId -> { text, tooltip, icon, color, chip }
  let sweepTimer = null;

  function host() {
    return document.getElementById('clock-sdkbadges');
  }

  // The chip row is an island segment ('badges' in topbar-minimal.js), so a
  // STRUCTURAL change (chips appearing/disappearing) must re-run the island
  // layout: applyIslandLayout keeps the first-visible segment's "lead" (no left
  // hairline) correct, and reflowIsland re-tucks tiles now sitting under a pill
  // that just grew or shrank. Deliberately NOT called on text-only updates — a
  // ticking count would reflow the grid on every tick for a few pixels.
  function syncIslandLayout() {
    const tm = window.TopbarMinimal;
    if (!tm) return;
    if (typeof tm.applyIslandLayout === 'function') tm.applyIslandLayout();
    if (typeof tm.reflowIsland === 'function') tm.reflowIsland();
  }

  function syncHostVisibility(h) {
    if (h) h.hidden = owners.size === 0;
  }

  function render(pkgId) {
    const h = host();
    if (!h) return;
    const owner = owners.get(pkgId);
    if (!owner) return;
    // A chip appearing changes the pill's structure; a chip's TEXT changing does
    // not (see syncIslandLayout).
    let structural = false;
    if (!owner.chip || !owner.chip.isConnected) {
      const chip = document.createElement('span');
      chip.className = 'sdk-badge';
      const ico = document.createElement('span');
      ico.className = 'sdk-badge-ico';
      const val = document.createElement('span');
      val.className = 'sdk-badge-val';
      chip.append(ico, val);
      owner.chip = chip;
      h.appendChild(chip);
      structural = true;
    }
    // Untrusted widget strings -> textContent ONLY, never markup. The colour
    // arrives pre-validated as plain hex (custom-widget.js onBridgeBadge); the
    // CSSOM drops anything it can't parse as a colour, so this can't become a
    // style injection either. Empty icon -> hidden, so a chip with no glyph
    // keeps no stray gap.
    const ico = owner.chip.firstChild;
    const val = owner.chip.lastChild;
    ico.textContent = owner.icon || '';
    ico.hidden = !owner.icon;
    ico.style.color = owner.color || '';
    val.textContent = owner.text;
    owner.chip.title = owner.tooltip || '';
    syncHostVisibility(h);
    if (structural) syncIslandLayout();
  }

  function removeChip(pkgId) {
    const owner = owners.get(pkgId);
    if (owner && owner.chip && owner.chip.parentNode) owner.chip.parentNode.removeChild(owner.chip);
    owners.delete(pkgId);
    syncHostVisibility(host());
    syncIslandLayout();
  }

  function syncSweep() {
    const want = owners.size > 0;
    if (want && !sweepTimer) {
      sweepTimer = setInterval(() => {
        const cw = window.CustomWidget;
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

  function set(pkgId, text, tooltip, icon, color) {
    if (typeof pkgId !== 'string' || !pkgId || typeof text !== 'string' || !text) return;
    if (!owners.has(pkgId) && owners.size >= MAX_BADGES) return;   // cap reached: silent no-op
    const cur = owners.get(pkgId) || {};
    owners.set(pkgId, {
      text,
      tooltip: typeof tooltip === 'string' ? tooltip : '',
      icon: typeof icon === 'string' ? icon : '',
      color: typeof color === 'string' ? color : '',
      chip: cur.chip,
    });
    render(pkgId);
    syncSweep();
  }

  function clear(pkgId) {
    if (!owners.has(pkgId)) return;
    removeChip(pkgId);
    syncSweep();
  }

  window.SdkBadges = { set, clear };
})();
