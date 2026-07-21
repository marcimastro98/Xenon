// Dynamic Island host runtime.
//
// Legacy Widget SDK packages may still project the v4.6 plain-text line. New
// packages that separately request `islandDynamic` can compose a host-rendered
// Live Activity from a bounded set of blocks (text, icon, progress, bars,
// selected Xenon readouts and buttons). The guest never supplies HTML/CSS and
// never receives DOM access: custom-widget.js validates the manifest + grant,
// sdk-island-schema.js rebuilds the message, and this file creates every node.
//
// Two lanes coexist:
//   - live: long-running content such as now playing; last update wins;
//   - takeover: a bounded 1.2–30s event such as a goal; newest event temporarily
//     replaces the live lane and the normal clock, then the previous state
//     returns automatically.
// System notifications remain above both lanes. Full and Minimal topbars share
// the same runtime; style None has no island surface and renders nothing.
(() => {
  'use strict';

  const SWEEP_MS = 5000;
  const EXIT_MS = 220;
  const ROW_GAP = 2;

  const live = new Map();       // pkgId -> record
  let takeovers = [];           // at most one global event; a newer event supersedes it
  let current = null;           // record currently painted
  let ui = null;
  let seq = 0;
  let sweepTimer = null;
  let expiryTimer = null;
  let exitTimer = null;
  let transitionToken = 0;
  let builtinObserver = null;

  function settings() {
    try { return (typeof hubSettings === 'object' && hubSettings && hubSettings.topbarClock) || {}; }
    catch { return {}; }
  }

  function sourceEnabled(pkgId) {
    const hidden = settings().hiddenSources;
    return !(Array.isArray(hidden) && hidden.includes(pkgId));
  }

  function takeoversEnabled() {
    return settings().takeovers !== false;
  }

  function surfaceAvailable() {
    const body = document.body;
    if (!body || body.dataset.panel || body.classList.contains('topbar-noisland') || body.classList.contains('topbar-hidden')) return false;
    if (body.classList.contains('topbar-minimal')) return true;
    const topbar = document.querySelector('.topbar');
    return !!(topbar && topbar.getClientRects().length);
  }

  function reducedMotion() {
    return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function ensureUi() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('div');
    host.id = 'sdk-island';
    host.className = 'sdk-island';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');

    const flow = document.createElement('div');
    flow.className = 'sdk-island-flow';
    const meta = document.createElement('div');
    meta.className = 'sdk-island-meta';
    const m1 = document.createElement('span');
    m1.className = 'sdk-island-m1';
    const m2 = document.createElement('span');
    m2.className = 'sdk-island-m2';
    meta.append(m1, m2);

    const blocks = document.createElement('div');
    blocks.className = 'sdk-island-blocks';
    host.append(flow, meta, blocks);
    document.body.appendChild(host);
    ui = { host, flow, m1, m2, blocks };
    return ui;
  }

  function stopBuiltinObserver() {
    if (builtinObserver) builtinObserver.disconnect();
    builtinObserver = null;
  }

  function syncBuiltin(node, value) {
    if (!node) return;
    if (value === 'time') {
      const h = document.getElementById('clock-h');
      const m = document.getElementById('clock-m');
      const ap = document.getElementById('clock-ampm');
      node.textContent = `${h ? h.textContent : '--'}:${m ? m.textContent : '--'}${ap && ap.textContent ? ` ${ap.textContent}` : ''}`;
    } else if (value === 'date') {
      const date = document.getElementById('clock-date');
      node.textContent = date ? date.textContent : '';
    } else if (value === 'weather') {
      const temp = document.getElementById('weather-temp');
      const place = document.getElementById('weather-place');
      node.textContent = [temp && temp.textContent, place && place.textContent].filter(Boolean).join(' ');
    }
  }

  function syncBuiltins() {
    if (!ui) return;
    ui.blocks.querySelectorAll('[data-island-builtin]').forEach((node) => syncBuiltin(node, node.dataset.islandBuiltin));
  }

  function observeBuiltins() {
    stopBuiltinObserver();
    if (!ui || !ui.blocks.querySelector('[data-island-builtin]') || typeof MutationObserver === 'undefined') return;
    builtinObserver = new MutationObserver(syncBuiltins);
    ['clock-h', 'clock-m', 'clock-ampm', 'clock-date', 'weather-temp', 'weather-place'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) builtinObserver.observe(el, { childList: true, characterData: true, subtree: true });
    });
  }

  function mkRow(text, cls) {
    const row = document.createElement('div');
    row.className = cls ? `sdk-island-row ${cls}` : 'sdk-island-row';
    row.textContent = text;
    return row;
  }

  function tweenHeight(from) {
    if (!ui || !from || reducedMotion()) return;
    const host = ui.host;
    const to = host.offsetHeight;
    if (from === to) return;
    host.style.transition = 'none';
    host.style.height = `${from}px`;
    void host.offsetHeight;
    host.style.transition = 'height 0.35s cubic-bezier(0.22, 1, 0.36, 1)';
    host.style.height = `${to}px`;
    setTimeout(() => {
      if (!ui) return;
      ui.host.style.transition = '';
      ui.host.style.height = '';
    }, 380);
  }

  function syncLegacyBadge(record) {
    const raw = record && record.badge ? record.badge : '';
    const parts = raw.split('·').map((part) => part.trim()).filter(Boolean).slice(0, 2);
    ui.m1.textContent = parts[0] || '';
    ui.m2.textContent = parts[1] || '';
    ui.host.classList.toggle('has-badge', parts.length > 0);
  }

  function renderLegacy(record, previous) {
    stopBuiltinObserver();
    ui.host.classList.remove('is-structured', 'is-expanded');
    ui.host.classList.toggle('is-flow', !!record.next);
    ui.blocks.replaceChildren();
    const from = ui.host.offsetHeight;
    const canAdvance = previous && previous.id === record.id && previous.next && previous.next === record.text
      && ui.flow.childElementCount;
    if (!canAdvance) {
      ui.flow.replaceChildren(mkRow(record.text, 'is-cur'));
      if (record.next) ui.flow.appendChild(mkRow(record.next, ''));
    } else {
      const flow = ui.flow;
      const past = flow.querySelector('.is-past');
      const cur = flow.querySelector('.is-cur');
      let nextRow = cur ? cur.nextElementSibling : null;
      let slide = 0;
      if (past) { slide = past.offsetHeight + ROW_GAP; past.remove(); }
      if (cur) { cur.classList.remove('is-cur'); cur.classList.add('is-past'); }
      if (!nextRow) nextRow = flow.appendChild(mkRow('', ''));
      nextRow.classList.add('is-cur');
      nextRow.textContent = record.text;
      if (record.next) flow.appendChild(mkRow(record.next, ''));
      if (slide && !reducedMotion()) {
        flow.style.transition = 'none';
        flow.style.transform = `translate3d(0,${slide}px,0)`;
        void flow.offsetHeight;
        flow.style.transition = '';
        flow.style.transform = 'translate3d(0,0,0)';
      }
    }
    syncLegacyBadge(record);
    tweenHeight(from);
  }

  function toneClass(tone) {
    return ['muted', 'accent', 'success', 'warning', 'danger'].includes(tone) ? ` tone-${tone}` : '';
  }

  function renderBlock(block, record) {
    let node;
    if (block.type === 'text') {
      node = document.createElement('span');
      node.className = `sdk-island-text${toneClass(block.tone)}${block.weight === 'strong' ? ' is-strong' : ''}${block.maxLines === 2 ? ' two-lines' : ''}`;
      node.textContent = block.text;
    } else if (block.type === 'icon') {
      node = document.createElement('span');
      node.className = 'sdk-island-icon';
      node.textContent = block.text;
      if (block.color) node.style.color = block.color;
    } else if (block.type === 'progress') {
      node = document.createElement('span');
      node.className = 'sdk-island-progress';
      const fill = document.createElement('span');
      fill.style.transform = `scaleX(${block.value})`;
      node.appendChild(fill);
    } else if (block.type === 'bars') {
      node = document.createElement('span');
      node.className = `sdk-island-bars${block.animated ? ' is-animated' : ''}`;
      block.values.forEach((value, index) => {
        const bar = document.createElement('i');
        bar.style.setProperty('--bar-level', String(Math.max(0.08, value)));
        bar.style.setProperty('--bar-i', String(index));
        node.appendChild(bar);
      });
    } else if (block.type === 'builtin') {
      node = document.createElement('span');
      node.className = `sdk-island-builtin sdk-island-builtin-${block.value}`;
      node.dataset.islandBuiltin = block.value;
      syncBuiltin(node, block.value);
    } else if (block.type === 'button') {
      node = document.createElement('button');
      node.type = 'button';
      node.className = `sdk-island-action${block.emphasis ? ' is-emphasis' : ''}`;
      node.textContent = block.label;
      node.addEventListener('click', () => {
        if (record && typeof record.onAction === 'function') record.onAction(block.id);
      });
    } else {
      node = document.createElement('span');
      node.className = `sdk-island-spacer is-${block.size}`;
    }
    return node;
  }

  function renderStructured(record) {
    stopBuiltinObserver();
    const from = ui.host.offsetHeight;
    ui.flow.replaceChildren();
    ui.m1.textContent = '';
    ui.m2.textContent = '';
    ui.host.classList.remove('is-flow', 'has-badge');
    ui.host.classList.add('is-structured');
    ui.host.classList.toggle('is-expanded', record.view.layout === 'expanded');
    ui.blocks.replaceChildren(...record.view.blocks.map((block) => renderBlock(block, record)));
    observeBuiltins();
    tweenHeight(from);
  }

  function clearUi() {
    stopBuiltinObserver();
    if (!ui) return;
    ui.flow.replaceChildren();
    ui.blocks.replaceChildren();
    ui.m1.textContent = '';
    ui.m2.textContent = '';
    ui.host.className = 'sdk-island';
    ui.host.style.removeProperty('--island-accent');
  }

  function paint(previous) {
    const active = !!current && surfaceAvailable() && sourceEnabled(current.pkgId);
    document.body.classList.toggle('xisland-live', active);
    if (!active) { clearUi(); return; }
    ensureUi();
    const host = ui.host;
    host.className = `sdk-island enter-${current.enter || 'morph'}`;
    host.dataset.islandMode = current.mode;
    if (current.view && current.view.accent) host.style.setProperty('--island-accent', current.view.accent);
    else host.style.removeProperty('--island-accent');
    if (current.view) renderStructured(current);
    else renderLegacy(current, previous);
  }

  function pruneExpired() {
    const now = Date.now();
    takeovers = takeovers.filter((record) => record.expiresAt > now);
  }

  function selected() {
    pruneExpired();
    if (takeoversEnabled()) {
      for (let i = takeovers.length - 1; i >= 0; i--) {
        if (sourceEnabled(takeovers[i].pkgId)) return takeovers[i];
      }
    }
    let winner = null;
    for (const record of live.values()) {
      if (sourceEnabled(record.pkgId) && (!winner || record.seq > winner.seq)) winner = record;
    }
    return winner;
  }

  function scheduleExpiry() {
    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
    pruneExpired();
    if (!takeovers.length) return;
    const at = Math.min(...takeovers.map((record) => record.expiresAt));
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      reconcile(true);
      scheduleExpiry();
      syncSweep();
    }, Math.max(0, at - Date.now()) + 8);
  }

  function reconcile(animateExit) {
    const next = selected();
    const same = !!(current && next && current.id === next.id);
    if (same) {
      const previous = current;
      current = next;
      paint(previous);
      return;
    }
    const canExit = animateExit && current && ui && document.body.classList.contains('xisland-live') && !reducedMotion();
    if (!canExit) {
      const previous = current;
      current = next;
      paint(previous);
      return;
    }
    const token = ++transitionToken;
    if (exitTimer) clearTimeout(exitTimer);
    ui.host.classList.add('is-leaving', `exit-${current.exit || 'morph'}`);
    exitTimer = setTimeout(() => {
      exitTimer = null;
      if (token !== transitionToken) return;
      const previous = current;
      current = selected();
      paint(previous);
    }, EXIT_MS);
  }

  function syncSweep() {
    const want = live.size > 0 || takeovers.length > 0;
    if (want && !sweepTimer) {
      sweepTimer = setInterval(() => {
        const cw = window.CustomWidget;
        if (!cw || typeof cw.pkgHasLiveFrame !== 'function') return;
        let changed = false;
        for (const pkgId of Array.from(live.keys())) {
          if (!cw.pkgHasLiveFrame(pkgId)) { live.delete(pkgId); changed = true; }
        }
        const before = takeovers.length;
        takeovers = takeovers.filter((record) => cw.pkgHasLiveFrame(record.pkgId));
        if (takeovers.length !== before) changed = true;
        if (changed) reconcile(true);
        scheduleExpiry();
        syncSweep();
      }, SWEEP_MS);
    } else if (!want && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  // v4.6 compatibility: plain text + next line + tiny meta chip.
  function show(pkgId, text, next, badge) {
    if (typeof pkgId !== 'string' || !pkgId || typeof text !== 'string' || !text) return;
    const record = {
      id: `live:${pkgId}`,
      pkgId, mode: 'live', seq: ++seq,
      text, next: typeof next === 'string' ? next : '', badge: typeof badge === 'string' ? badge : '',
      enter: 'morph', exit: 'morph',
    };
    live.set(pkgId, record);
    reconcile(false);
    syncSweep();
  }

  function present(pkgId, view, onAction) {
    if (typeof pkgId !== 'string' || !pkgId || !view || view.op !== 'present') return;
    const nextSeq = ++seq;
    const record = {
      id: view.mode === 'takeover' ? `takeover:${pkgId}:${nextSeq}` : `live:${pkgId}`,
      pkgId, mode: view.mode, seq: nextSeq, view,
      enter: view.enter, exit: view.exit,
      onAction: typeof onAction === 'function' ? onAction : null,
    };
    if (view.mode === 'takeover') {
      record.expiresAt = Date.now() + view.duration;
      // A takeover always restores the live/default lane when it leaves. Replacing
      // the pending event globally prevents an older goal or alert resurfacing late.
      takeovers = [record];
      scheduleExpiry();
    } else {
      live.set(pkgId, record);
    }
    reconcile(false);
    syncSweep();
  }

  function clear(pkgId, scope) {
    if (typeof pkgId !== 'string' || !pkgId) return;
    const which = ['live', 'takeover', 'all'].includes(scope) ? scope : 'all';
    if (which !== 'takeover') live.delete(pkgId);
    if (which !== 'live') takeovers = takeovers.filter((record) => record.pkgId !== pkgId);
    scheduleExpiry();
    reconcile(true);
    syncSweep();
  }

  function apply() {
    scheduleExpiry();
    reconcile(true);
  }

  window.SdkIsland = { show, present, clear, apply, sourceEnabled };
})();
