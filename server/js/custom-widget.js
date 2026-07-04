'use strict';
// Custom widget tile — host side of the third-party widget SDK.
//
// Each "custom" tile hosts ONE community widget package inside a sandboxed
// <iframe sandbox="allow-scripts"> served from /sdk/widget/<id>/ with a strict
// CSP (opaque origin, zero network — see server/sdk-widgets.js). The widget
// talks to the dashboard ONLY through the versioned postMessage bridge below:
//   widget → host:  hello, action {id, action}
//   host → widget:  init {api, theme, lang, streams, actions}, data {stream,…},
//                   theme {theme}, action_result {id, ok, error}
// The user grants each package its data streams and action categories in an
// explicit permission dialog before it ever renders; the host forwards only
// granted streams and dispatches only granted actions — every action is then
// re-validated server-side by /actions/run like any Deck key.
(function () {
  const S = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const ICONS = {
    puzzle: S('<path d="M14 7h4a1 1 0 0 1 1 1v3.5a1.5 1.5 0 0 0 0 3V18a1 1 0 0 1-1 1h-3.5a1.5 1.5 0 0 1-3 0H8a1 1 0 0 1-1-1v-3.5a1.5 1.5 0 0 1 0-3V8a1 1 0 0 1 1-1h3.5a1.5 1.5 0 0 1 3 0Z"/>'),
    swap: S('<path d="M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7"/>'),
  };
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;   // shared DOM factory from utils.js
  const api = apiJson; // shared fetch-JSON helper from utils.js

  // Client copy of the category → deck-action-type map (server/sdk-widgets.js
  // is the authority; keep in sync). Used to gate bridge action dispatch.
  const ACTION_CATEGORIES = {
    media: ['media'],
    volume: ['volume', 'appVolume', 'appMute'],
    mic: ['micMute'],
    lighting: ['lighting'],
    url: ['openUrl'],
  };
  const STREAM_LABELS = {
    status: ['cw_stream_status', 'System status (mic, game mode)'],
    system: ['cw_stream_system', 'System sensors (CPU, GPU, RAM)'],
    media: ['cw_stream_media', 'Now playing'],
    audio: ['cw_stream_audio', 'Volume & audio devices'],
  };
  const ACTION_LABELS = {
    media: ['cw_act_media', 'Control media playback'],
    volume: ['cw_act_volume', 'Change the volume'],
    mic: ['cw_act_mic', 'Mute/unmute the microphone'],
    lighting: ['cw_act_lighting', 'Control the RGB lighting'],
    url: ['cw_act_url', 'Open web links on this PC'],
  };
  const ACTION_MIN_INTERVAL_MS = 250;   // per-instance action rate limit

  let pkgCache = null;        // last /sdk/widgets result ({packages, invalid})
  let pkgFetching = false;
  const frames = new Map();   // instanceId → { frame, pkgId, ready, lastAction }
  const lastData = {};        // stream → last payload (seed for late frames)

  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="custom"]')).filter(n => n.closest('.pager-page')); }

  function instanceIdOf(tile) {
    const item = tile.closest('.grid-stack-item');
    return (item && item.getAttribute('gs-id')) || 'custom';
  }

  function sdk() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.sdkWidgets : null;
    return (hs && typeof hs === 'object') ? hs : { enabled: false, assign: {}, grants: {} };
  }
  function persist(patch) {
    if (typeof updateSdkWidgets === 'function') updateSdkWidgets(patch);
  }

  function packageById(id) {
    const list = (pkgCache && Array.isArray(pkgCache.packages)) ? pkgCache.packages : [];
    return list.find(p => p && p.id === id) || null;
  }

  async function fetchPackages(force) {
    if (pkgFetching) return;
    if (pkgCache && !force) return;
    pkgFetching = true;
    try {
      const d = await api('/sdk/widgets');
      if (d && d.ok) pkgCache = { packages: d.packages || [], invalid: d.invalid || [] };
      else if (!pkgCache) pkgCache = { packages: [], invalid: [] };
    } finally { pkgFetching = false; }
    paint();
  }

  // ── Theme payload (host → widget) ────────────────────────────────
  function themePayload() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings : {};
    return {
      appearance: document.documentElement.getAttribute('data-appearance') || 'dark',
      accent: typeof hs.accent === 'string' ? hs.accent : '#1ed760',
      background: typeof hs.background === 'string' ? hs.background : '#070808',
      text: typeof hs.text === 'string' ? hs.text : '#f0f3f1',
    };
  }
  function langCode() {
    return (typeof t === 'function' && t('locale')) || 'en';
  }

  // ── postMessage bridge ───────────────────────────────────────────
  // The iframe origin is opaque ('null'), so identity is established by
  // matching event.source against our own iframes — never by origin — and the
  // targetOrigin must be '*'. Nothing sent over the bridge is secret: theme
  // colours plus the data streams the user explicitly granted.
  function entryBySource(source) {
    for (const [instId, entry] of frames) {
      if (entry.frame && entry.frame.contentWindow === source) return { instId, entry };
    }
    return null;
  }
  function post(entry, msg) {
    try {
      if (entry.frame && entry.frame.contentWindow) entry.frame.contentWindow.postMessage({ xenonSdk: 1, ...msg }, '*');
    } catch { /* frame mid-teardown */ }
  }
  function grantsFor(pkgId) {
    const g = sdk().grants;
    const grant = (g && typeof g === 'object') ? g[pkgId] : null;
    return {
      streams: (grant && Array.isArray(grant.streams)) ? grant.streams : [],
      actions: (grant && Array.isArray(grant.actions)) ? grant.actions : [],
    };
  }
  function actionAllowed(grant, action) {
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') return false;
    return grant.actions.some(cat => (ACTION_CATEGORIES[cat] || []).includes(action.type));
  }

  async function onBridgeAction(entry, grant, msg) {
    const reqId = (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
    const now = Date.now();
    if (now - (entry.lastAction || 0) < ACTION_MIN_INTERVAL_MS) {
      post(entry, { type: 'action_result', id: reqId, ok: false, error: 'rate_limited' });
      return;
    }
    entry.lastAction = now;
    if (!actionAllowed(grant, msg.action)) {
      post(entry, { type: 'action_result', id: reqId, ok: false, error: 'not_allowed' });
      return;
    }
    const d = await api('/actions/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.action),
    });
    post(entry, { type: 'action_result', id: reqId, ok: !!(d && d.ok), error: (d && d.error) || (d ? undefined : 'offline') });
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || d.xenonSdk !== 1 || typeof d.type !== 'string') return;
    const hit = entryBySource(e.source);
    if (!hit) return;
    const { entry } = hit;
    const grant = grantsFor(entry.pkgId);
    if (d.type === 'hello') {
      entry.ready = true;
      post(entry, {
        type: 'init',
        api: 1,
        theme: themePayload(),
        lang: langCode(),
        streams: grant.streams.slice(),
        actions: grant.actions.slice(),
      });
      grant.streams.forEach(stream => {
        if (lastData[stream] !== undefined) post(entry, { type: 'data', stream, data: lastData[stream] });
      });
    } else if (d.type === 'action') {
      if (entry.ready) onBridgeAction(entry, grant, d);
    }
  });

  // SSE relay (called from main.js): cache + fan out to granted, ready frames.
  // Always cache lastData so a frame returning to view gets fresh data on the next
  // tick, but don't post to a hidden tab or to a frame parked on a non-current pager
  // page — a sandboxed widget shouldn't re-render (or wake its timers) off-screen.
  function onData(stream, payload) {
    lastData[stream] = payload;
    if (document.hidden) return;
    for (const [, entry] of frames) {
      if (entry.ready && onVisiblePage(entry.frame) && grantsFor(entry.pkgId).streams.includes(stream)) {
        post(entry, { type: 'data', stream, data: payload });
      }
    }
  }

  // Theme changed (called from settings.js after applyHubSettings).
  function refreshTheme() {
    for (const [, entry] of frames) {
      if (entry.ready) post(entry, { type: 'theme', theme: themePayload() });
    }
  }

  // ── Permission dialog ────────────────────────────────────────────
  function closePermDialog() {
    const bd = document.querySelector('.cw-perm-backdrop');
    if (bd) bd.remove();
  }
  function openPermDialog(pkg, instId) {
    closePermDialog();
    const bd = el('div', 'cw-perm-backdrop');
    const panel = el('div', 'cw-perm');
    panel.appendChild(el('div', 'cw-perm-title', t('cw_perm_title', 'Allow this widget?')));
    const who = el('div', 'cw-perm-pkg');
    who.appendChild(el('span', 'cw-perm-name', pkg.name));
    const meta = [pkg.author ? t('cw_by', 'by').replace('{a}', pkg.author) : '', pkg.version ? 'v' + pkg.version : ''].filter(Boolean).join(' · ');
    if (meta) who.appendChild(el('span', 'cw-perm-meta', meta));
    panel.appendChild(who);
    if (pkg.description) panel.appendChild(el('div', 'cw-perm-desc', pkg.description));

    const addSection = (labelKey, labelFb, ids, labels) => {
      panel.appendChild(el('div', 'cw-perm-sec', t(labelKey, labelFb)));
      const box = el('div', 'cw-perm-chips');
      ids.forEach(id => {
        const lb = labels[id];
        box.appendChild(el('span', 'cw-perm-chip', lb ? t(lb[0], lb[1]) : id));
      });
      panel.appendChild(box);
    };
    if (pkg.streams.length) addSection('cw_perm_streams', 'It can see:', pkg.streams, STREAM_LABELS);
    if (pkg.actions.length) addSection('cw_perm_actions', 'It can do:', pkg.actions, ACTION_LABELS);
    if (!pkg.streams.length && !pkg.actions.length) {
      panel.appendChild(el('div', 'cw-perm-sec cw-perm-nothing', t('cw_perm_none', 'Nothing — it only draws its own content')));
    }
    panel.appendChild(el('div', 'cw-perm-note', t('cw_perm_note', 'Widgets run isolated from the dashboard, with no network access, and can only use what you allow here. Only install widgets from people you trust.')));

    const row = el('div', 'cw-perm-actions-row');
    const cancel = el('button', 'cw-btn', t('cw_cancel', 'Cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', closePermDialog);
    const allow = el('button', 'cw-btn cw-btn--primary', t('cw_allow', 'Allow'));
    allow.type = 'button';
    allow.addEventListener('click', () => {
      const cur = sdk();
      persist({
        assign: { ...(cur.assign || {}), [instId]: pkg.id },
        grants: { ...(cur.grants || {}), [pkg.id]: { streams: pkg.streams.slice(), actions: pkg.actions.slice() } },
      });
      closePermDialog();
      paint();
    });
    row.append(cancel, allow);
    panel.appendChild(row);
    bd.appendChild(panel);
    bd.addEventListener('click', (ev) => { if (ev.target === bd) closePermDialog(); });
    document.body.appendChild(bd);
  }

  // ── Tile rendering ───────────────────────────────────────────────
  function ensure(mount) {
    if (mount.dataset.cwBuilt === '1' && mount.firstChild) return;
    mount.dataset.cwBuilt = '1';
    const wrap = el('div', 'cw-wrap');
    const head = el('div', 'cw-head');
    const brand = el('div', 'cw-brand');
    const logo = el('span', 'cw-logo'); logo.innerHTML = ICONS.puzzle;   // static, trusted SVG
    brand.append(logo, el('span', 'cw-title', t('cw_title', 'Custom widget')));
    head.appendChild(brand);
    const ctl = el('div', 'cw-ctl');
    const swapBtn = el('button', 'cw-hbtn cw-swap-btn');
    swapBtn.type = 'button'; swapBtn.title = t('cw_unassign', 'Choose another widget');
    swapBtn.innerHTML = ICONS.swap;   // static, trusted SVG
    ctl.appendChild(swapBtn);
    head.appendChild(ctl);
    wrap.appendChild(head);
    wrap.appendChild(el('div', 'cw-body'));
    mount.replaceChildren(wrap);
  }

  function showState(body, msgKey, msgFb, opts) {
    const box = el('div', 'cw-state');
    const ico = el('span', 'cw-state-ico'); ico.innerHTML = ICONS.puzzle;   // static SVG
    box.append(ico, el('span', 'cw-state-txt', t(msgKey, msgFb)));
    if (opts && opts.hint) box.appendChild(el('span', 'cw-state-hint', t(opts.hint[0], opts.hint[1])));
    if (opts && opts.buttons) {
      const row = el('div', 'cw-state-btns');
      opts.buttons.forEach(b => {
        const btn = el('button', 'cw-btn' + (b.primary ? ' cw-btn--primary' : ''), t(b.key, b.fb));
        btn.type = 'button';
        btn.addEventListener('click', b.onClick);
        row.appendChild(btn);
      });
      box.appendChild(row);
    }
    body.replaceChildren(box);
  }

  // Untrusted manifest text (name/author/description) → textContent only.
  function paintPicker(body, instId) {
    const frag = document.createDocumentFragment();
    frag.appendChild(el('div', 'cw-pick-title', t('cw_pick', 'Choose a widget for this tile')));
    const list = el('div', 'cw-pick-list');
    (pkgCache.packages || []).forEach(pkg => {
      const row = el('div', 'cw-pick-row');
      const txt = el('div', 'cw-pick-txt');
      const head = el('div', 'cw-pick-name', pkg.name);
      const meta = [pkg.author, pkg.version ? 'v' + pkg.version : ''].filter(Boolean).join(' · ');
      txt.appendChild(head);
      if (meta) txt.appendChild(el('div', 'cw-pick-meta', meta));
      if (pkg.description) txt.appendChild(el('div', 'cw-pick-desc', pkg.description));
      row.appendChild(txt);
      const add = el('button', 'cw-btn cw-btn--primary', t('cw_add', 'Add'));
      add.type = 'button';
      add.addEventListener('click', () => openPermDialog(pkg, instId));
      row.appendChild(add);
      list.appendChild(row);
    });
    frag.appendChild(list);
    body.replaceChildren(frag);
  }

  function mountFrame(body, instId, pkg) {
    const existing = frames.get(instId);
    if (existing && existing.pkgId === pkg.id && existing.frame.isConnected) return;
    if (existing) { try { existing.frame.remove(); } catch {} frames.delete(instId); }
    const frame = document.createElement('iframe');
    frame.className = 'cw-frame';
    // Sandbox: scripts only. NO allow-same-origin (opaque origin) and the served
    // CSP additionally re-sandboxes + blocks all network (see server/sdk-widgets.js).
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = pkg.name;
    frame.src = '/sdk/widget/' + encodeURIComponent(pkg.id) + '/' + pkg.entry;
    frames.set(instId, { frame, pkgId: pkg.id, ready: false, lastAction: 0 });
    body.replaceChildren(frame);
  }

  function paint() {
    const seen = new Set();
    tiles().forEach(tile => {
      const mount = tile.querySelector('.custom-widget-mount');
      if (!mount) return;
      ensure(mount);
      const instId = instanceIdOf(tile);
      seen.add(instId);
      const body = mount.querySelector('.cw-body');
      const titleEl = mount.querySelector('.cw-title');
      const swapBtn = mount.querySelector('.cw-swap-btn');
      const cfg = sdk();
      const assignedId = (cfg.assign && typeof cfg.assign === 'object') ? cfg.assign[instId] : null;
      const pkg = assignedId ? packageById(assignedId) : null;
      if (titleEl) titleEl.textContent = pkg ? pkg.name : t('cw_title', 'Custom widget');
      if (swapBtn) {
        swapBtn.hidden = !assignedId;
        swapBtn.title = t('cw_unassign', 'Choose another widget');
        swapBtn.onclick = () => {
          const cur = sdk();
          const assign = { ...(cur.assign || {}) };
          delete assign[instId];
          persist({ assign });
          const entry = frames.get(instId);
          if (entry) { try { entry.frame.remove(); } catch {} frames.delete(instId); }
          paint();
        };
      }
      if (!cfg.enabled) {
        const entry = frames.get(instId);
        if (entry) { try { entry.frame.remove(); } catch {} frames.delete(instId); }
        showState(body, 'cw_off', 'Third-party widgets are off', {
          hint: ['cw_off_hint', 'Sandboxed mini-widgets made by the community. They run isolated, with no network access, and only see what you allow.'],
          buttons: [{ key: 'cw_enable', fb: 'Turn on', primary: true, onClick: () => { persist({ enabled: true }); fetchPackages(true); paint(); } }],
        });
        return;
      }
      if (pkgCache === null) {
        showState(body, 'cw_loading', 'Looking for installed widgets…');
        fetchPackages(false);
        return;
      }
      if (!assignedId) {
        if (!(pkgCache.packages || []).length) {
          showState(body, 'cw_none', 'No widget packages installed', {
            hint: ['cw_none_hint', 'Put a widget folder in server/data/widgets and rescan — or try the built-in example.'],
            buttons: [
              { key: 'cw_example', fb: 'Install example', primary: true, onClick: async () => { await api('/sdk/widgets/example', { method: 'POST' }); fetchPackages(true); } },
              { key: 'cw_rescan', fb: 'Rescan', onClick: () => fetchPackages(true) },
            ],
          });
        } else {
          paintPicker(body, instId);
        }
        return;
      }
      if (!pkg) {
        showState(body, 'cw_missing', 'This widget package was removed', {
          buttons: [
            { key: 'cw_unassign', fb: 'Choose another', primary: true, onClick: () => { if (swapBtn) swapBtn.onclick(); } },
            { key: 'cw_rescan', fb: 'Rescan', onClick: () => fetchPackages(true) },
          ],
        });
        return;
      }
      mountFrame(body, instId, pkg);
    });
    // Drop bridge entries whose tile no longer exists (widget removed / page
    // deleted) so a dead iframe can't keep receiving data.
    for (const [instId, entry] of frames) {
      if (!seen.has(instId) || !entry.frame.isConnected) {
        try { entry.frame.remove(); } catch {}
        frames.delete(instId);
      }
    }
  }

  function renderWidgets() {
    if (!tiles().length) {
      for (const [instId, entry] of frames) { try { entry.frame.remove(); } catch {} frames.delete(instId); }
      return;
    }
    paint();
  }

  window.CustomWidget = { renderWidgets, onData, refreshTheme };
})();
