// SDK bar buttons — host-side renderer for the Widget SDK `topbarButton`
// capability: a button of the package's own among the bar's buttons.
//
// Where it differs from the mini slot (js/sdk-mini.js): the slot is ONE entry of
// the button list that several packages share, drawing blocks in it. This is a
// real button per package, `sdk:<id>` in topbarClock.actions, so the user moves
// it, hides it and restyles it (TopbarLook.buttons) exactly like Lock or Search.
// In Minimal it lands in a rail with the rest of its side.
//
// The face is plain text and the package's own manifest glyph, drawn by the
// host with textContent / createElementNS; a tap only posts a message to the
// package's frame. No widget HTML, CSS or handler reaches the bar.
//
// Auto-clear: the badges' and mini slot's sweep — a package without a live
// frame loses its button. The timer runs only while a button is shown.
(() => {
  'use strict';

  const SWEEP_MS = 5000;
  const MAX_OWNERS = 4;

  const owners = new Map();   // pkgId -> { face, onAction, node }
  let sweepTimer = null;

  const idOf = (pkgId) => 'sdk:' + pkgId;

  // The same per-package switch as the island, badges and mini slot
  // (Settings → Top bar → Apps and widgets).
  function sourceEnabled(pkgId) {
    return !window.SdkIsland || typeof SdkIsland.sourceEnabled !== 'function' || SdkIsland.sourceEnabled(pkgId);
  }

  // A new button or a gone one changes the rows it sits in: place it where the
  // user put it, give it its look, and re-measure the Minimal capsule.
  function syncLayout() {
    const tm = window.TopbarMinimal;
    if (tm && typeof tm.applyIslandLayout === 'function') tm.applyIslandLayout();
    if (window.TopbarLook && typeof hubSettings !== 'undefined') TopbarLook.apply(hubSettings.topbarLook);
    if (tm && typeof tm.reflowIsland === 'function') tm.reflowIsland();
    if (typeof renderTopbarActionsEditor === 'function') renderTopbarActionsEditor();
  }

  function build(pkgId, owner) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'topbtn topbtn-sdk';
    btn.setAttribute('data-tb-id', idOf(pkgId));
    btn.addEventListener('click', () => {
      const cur = owners.get(pkgId);
      if (cur && cur.onAction) cur.onAction();
    });
    const glyph = owner.face.icon ? null : (typeof owner.face.iconEl === 'function' ? owner.face.iconEl() : null);
    if (glyph) btn.append(glyph);
    else {
      const mark = document.createElement('i');
      mark.className = 'topbtn-sdk-glyph';
      mark.setAttribute('aria-hidden', 'true');
      btn.append(mark);
    }
    // The label span: first plain <span>, the one TopbarLook relabels.
    btn.append(document.createElement('span'));
    const host = document.getElementById('quickbar');
    if (host) host.append(btn);
    return btn;
  }

  // Text only; the user's own label (TopbarLook) wins over the package's.
  function paint(owner) {
    const { node, face } = owner;
    const mark = node.querySelector(':scope > .topbtn-sdk-glyph');
    if (mark) mark.textContent = face.icon || Array.from(face.label || '?')[0];
    const span = node.querySelector(':scope > span:not([class])');
    if (span && !span.hasAttribute('data-tb-key')) span.textContent = face.label;
    if (span && span.hasAttribute('data-tb-key')) span.setAttribute('data-tb-text', face.label);
    node.title = face.tooltip || face.label;
    node.setAttribute('aria-label', face.label);
  }

  function render(pkgId) {
    const owner = owners.get(pkgId);
    if (!owner) return false;
    if (!sourceEnabled(pkgId)) {
      if (owner.node) owner.node.remove();
      owner.node = null;
      return true;
    }
    let structural = false;
    if (!owner.node || !owner.node.isConnected) {
      owner.node = build(pkgId, owner);
      structural = true;
    }
    paint(owner);
    return structural;
  }

  function remove(pkgId) {
    const owner = owners.get(pkgId);
    if (owner && owner.node) owner.node.remove();
    owners.delete(pkgId);
    syncLayout();
  }

  function syncSweep() {
    const want = owners.size > 0;
    if (want && !sweepTimer) {
      sweepTimer = setInterval(() => {
        const cw = window.CustomWidget;
        if (!cw || typeof cw.pkgHasLiveFrame !== 'function') return;
        for (const pkgId of Array.from(owners.keys())) {
          if (!cw.pkgHasLiveFrame(pkgId)) remove(pkgId);
        }
        syncSweep();
      }, SWEEP_MS);
    } else if (!want && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  // `face` arrives cleaned and grant-checked by custom-widget.js:
  // { label, icon, tooltip, iconEl? }.
  function set(pkgId, face, onAction) {
    if (typeof pkgId !== 'string' || !pkgId || !face || !face.label) return;
    if (!owners.has(pkgId) && owners.size >= MAX_OWNERS) return;   // cap reached: silent no-op
    const cur = owners.get(pkgId);
    const iconChanged = cur && !!cur.face.icon !== !!face.icon;
    if (iconChanged && cur.node) { cur.node.remove(); cur.node = null; }
    owners.set(pkgId, { face, onAction: typeof onAction === 'function' ? onAction : null, node: cur ? cur.node : null });
    if (render(pkgId)) syncLayout();
    syncSweep();
  }

  function clear(pkgId) {
    if (!owners.has(pkgId)) return;
    remove(pkgId);
    syncSweep();
  }

  // A per-package switch changed: reconcile what is on screen.
  function apply() {
    let structural = false;
    for (const pkgId of owners.keys()) structural = render(pkgId) || structural;
    if (structural) syncLayout();
  }

  // The buttons on screen now, for the Settings list: [{ id, label }].
  function live() {
    return Array.from(owners.entries())
      .filter(([pkgId, o]) => o.node && sourceEnabled(pkgId))
      .map(([pkgId, o]) => ({ id: idOf(pkgId), label: o.face.label }));
  }

  window.SdkTopbarButton = { set, clear, apply, live, MAX_OWNERS };
})();
