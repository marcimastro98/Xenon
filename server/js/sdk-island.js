// SDK Island — host-side renderer for the Widget SDK `island` capability.
//
// A granted widget projects one short plain-text line — plus an optional
// dimmed follow-up line — into the minimal-topbar dynamic island: the pill
// recedes (same morph the toast system uses via body.xtoast-island) and this
// capsule takes its spot, expanding into a small card. Text renders as
// stacked sentence rows, prompter-style: a dimmed past row, the bright
// current line (never clamped — it wraps in full), a dimmed upcoming line.
// When a `show` arrives whose text IS the previous `next` (the natural
// prompter advance), the SAME row elements are re-classed and the block
// slides up one row (transform) while the card height tweens — a karaoke
// glide instead of a snap. All strings arrive pre-coerced from
// custom-widget.js (onBridgeIsland: manifest + grant checked, control chars
// stripped, hard length cap) and are rendered ONLY via textContent — never
// markup. Nothing here ever reaches the server.
//
// Arbitration is deliberately simple (v1): ONE owner package at a time, the
// last granted `show` wins; `clear` is honored only from the current owner.
// System toasts always win visually (body.xtoast-island recedes this capsule
// exactly like the pill — pure CSS, see TopbarMinimal.css). While an owner is
// set, a 5s sweep asks CustomWidget whether the owner still has a live frame
// and auto-clears when its tile is gone — the timer exists ONLY while there is
// content to watch (gate-periodic-work invariant).
//
// In full (non-minimal) topbar chrome there is no pill: text is accepted and
// kept, simply not rendered; switching to minimal shows the current line.
(() => {
  'use strict';

  const SWEEP_MS = 5000;
  const ROW_GAP = 2;   // keep in sync with .sdk-island-flow gap

  let owner = null;        // { pkgId, text, next, badge } — the single island slot
  let ui = null;           // { host, flow, badge } — sentence rows live inside flow
  let sweepTimer = null;

  function minimalChrome() {
    return document.body.classList.contains('topbar-minimal') && !document.body.dataset.panel;
  }

  function reducedMotion() {
    return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function ensureUi() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('div');
    host.id = 'sdk-island';
    host.className = 'sdk-island';
    const flow = document.createElement('div');
    flow.className = 'sdk-island-flow';
    const meta = document.createElement('div');
    meta.className = 'sdk-island-meta';
    const m1 = document.createElement('span');
    m1.className = 'sdk-island-m1';
    const m2 = document.createElement('span');
    m2.className = 'sdk-island-m2';
    meta.append(m1, m2);
    host.append(flow, meta);
    document.body.appendChild(host);
    ui = { host, flow, m1, m2 };
    return ui;
  }

  // Live meta column (speed, time left…) — plain text, shown only when set.
  // A ' · ' in the badge splits it into two stacked right-aligned rows.
  function syncBadge() {
    const raw = owner && owner.badge ? owner.badge : '';
    const parts = raw.split('·').map((s) => s.trim()).filter(Boolean).slice(0, 2);
    ui.m1.textContent = parts[0] || '';
    ui.m2.textContent = parts[1] || '';
    ui.host.classList.toggle('has-badge', parts.length > 0);
  }

  function mkRow(text, cls) {
    const d = document.createElement('div');
    d.className = cls ? 'sdk-island-row ' + cls : 'sdk-island-row';
    d.textContent = text;   // untrusted widget text → textContent ONLY
    return d;
  }

  // height:auto can't transition natively, so tween it: the caller measures
  // the card BEFORE mutating, we measure after and animate between the two.
  // One bounded ~350ms burst per sentence change on a small fixed-position
  // element — not a loop (issue #99 class stays out).
  function tweenHeight(from) {
    const host = ui.host;
    const to = host.offsetHeight;
    if (!from || from === to || reducedMotion()) return;
    host.style.transition = 'none';
    host.style.height = from + 'px';
    void host.offsetHeight;
    host.style.transition = 'height 0.35s cubic-bezier(0.22, 1, 0.36, 1)';
    host.style.height = to + 'px';
    setTimeout(() => {
      if (!ui) return;
      ui.host.style.transition = '';
      ui.host.style.height = '';
    }, 380);
  }

  function syncFlowClass() {
    ui.host.classList.toggle('is-flow', ui.flow.childElementCount > 1);
  }

  // Full rebuild — first show, a jump to unrelated text, or a chrome change.
  function render() {
    const active = !!(owner && owner.text) && minimalChrome();
    document.body.classList.toggle('xisland-live', active);
    if (!active) {
      if (ui) {
        ui.flow.replaceChildren();
        ui.m1.textContent = '';
        ui.m2.textContent = '';
        ui.host.classList.remove('is-flow', 'has-badge');
      }
      return;
    }
    ensureUi();
    const from = ui.host.offsetHeight;
    ui.flow.replaceChildren(mkRow(owner.text, 'is-cur'));
    if (owner.next) ui.flow.appendChild(mkRow(owner.next, ''));
    syncFlowClass();
    syncBadge();
    tweenHeight(from);
  }

  // Karaoke advance: reuse the live rows so their opacity actually fades
  // (past dims, upcoming brightens) and slide the block up by the height of
  // the row that left — the text glides instead of snapping between slots.
  function advanceRows() {
    const flow = ui.flow;
    const from = ui.host.offsetHeight;
    const past = flow.querySelector('.is-past');
    const cur = flow.querySelector('.is-cur');
    let nextRow = cur ? cur.nextElementSibling : null;
    let slide = 0;
    if (past) { slide = past.offsetHeight + ROW_GAP; past.remove(); }
    if (cur) { cur.classList.remove('is-cur'); cur.classList.add('is-past'); }
    if (!nextRow) nextRow = flow.appendChild(mkRow('', ''));
    nextRow.classList.add('is-cur');
    nextRow.textContent = owner.text;
    if (owner.next) flow.appendChild(mkRow(owner.next, ''));
    syncFlowClass();
    syncBadge();
    if (slide && !reducedMotion()) {
      flow.style.transition = 'none';
      flow.style.transform = 'translate3d(0,' + slide + 'px,0)';
      void flow.offsetHeight;
      flow.style.transition = '';
      flow.style.transform = 'translate3d(0,0,0)';
    }
    tweenHeight(from);
  }

  // Auto-clear when the owning package no longer has a live frame (tile
  // removed, package uninstalled, SDK switched off). Runs only while owned.
  function syncSweep() {
    const want = !!owner;
    if (want && !sweepTimer) {
      sweepTimer = setInterval(() => {
        if (!owner) return;
        const cw = window.CustomWidget;
        if (!cw || typeof cw.pkgHasLiveFrame !== 'function' || !cw.pkgHasLiveFrame(owner.pkgId)) {
          owner = null;
          render();
          syncSweep();
        }
      }, SWEEP_MS);
    } else if (!want && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function show(pkgId, text, next, badge) {
    if (typeof pkgId !== 'string' || !pkgId || typeof text !== 'string' || !text) return;
    const prev = owner;
    owner = {
      pkgId,
      text,
      next: typeof next === 'string' ? next : '',
      badge: typeof badge === 'string' ? badge : '',
    };
    const live = !!(ui && ui.flow.childElementCount && document.body.classList.contains('xisland-live') && minimalChrome());
    // Badge-only refresh (a ticking countdown/speed chip): swap the chip in
    // place — a full rebuild would replay the row fade-in every second.
    if (live && prev && prev.pkgId === pkgId && prev.text === text && (prev.next || '') === owner.next) {
      syncBadge();
      syncSweep();
      return;
    }
    const isAdvance = !!(live && prev && prev.pkgId === pkgId && prev.next && prev.next === text);
    if (isAdvance) advanceRows();
    else render();
    syncSweep();
  }

  function clear(pkgId) {
    if (!owner || owner.pkgId !== pkgId) return;   // only the owner may clear
    owner = null;
    render();
    syncSweep();
  }

  // Re-evaluate on chrome changes (topbarStyle flips, settings apply).
  function apply() {
    render();
  }

  window.SdkIsland = { show, clear, apply };
})();
