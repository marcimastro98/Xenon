'use strict';
// Native canvas Ambient scene — the host renderer.
//
// Builds a first-party, fullscreen screensaver from a scene JSON (see
// js/ambient-scene.js for the shape): every component is a freely-positioned
// node (position/size in PERCENT of the stage, so it scales from the 14.5"
// ultrawide down to a normal browser window). Live data comes from the same
// dashboard globals the tiles use (mediaData, weatherData, calendarEvents,
// lastSystemData, tasksData, notesState) — the canvas never opens its own
// pollers; it reflects whatever the dashboard already keeps fresh.
//
// Owned by js/ambient-mode.js (mount/unmount/isOpen through window.AmbientCanvas).
// Embedded SDK widgets ride the same sandbox + bridge as tiles, registered via
// CustomWidget.registerCanvasFrame; an ungranted package (or the SDK master off)
// renders a quiet placeholder — never an un-vetted frame.
//
// Performance: one self-pausing rAF drives the dynamic components, updating a
// node's DOM only when its data signature actually changes (per reference/
// ambient.md), and the loop stops entirely on document.hidden and on unmount.

(function () {
  if (typeof window === 'undefined') return;

  const stageEl = () => document.getElementById('ambient-canvas-stage');
  const overlayEl = () => document.getElementById('ambient-canvas-overlay');

  // current = { scene, items:[{ comp, el, body, sig, dynamic }], onClose }
  let current = null;
  let raf = null;

  function tt(key, fb) {
    const v = (typeof window.t === 'function') ? window.t(key) : key;
    return (v === key && fb != null) ? fb : v;
  }
  function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function isOpen() { const o = overlayEl(); return !!(o && !o.hidden); }
  function sdkEnabled() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.sdkWidgets : null;
    return !!(hs && hs.enabled);
  }

  // ── background ──────────────────────────────────────────────────────────
  function bgCss(bg) {
    if (!bg || typeof bg !== 'object') return '#05060a';
    if (bg.type === 'image' && bg.url) return `#000 url("${bg.url}") center/cover no-repeat`;
    if (bg.type === 'gradient' && bg.grad) {
      return `linear-gradient(${bg.grad.angle || 180}deg, ${bg.grad.from}, ${bg.grad.to})`;
    }
    return bg.color || '#05060a';
  }
  // Dedicated background layer so dim/blur affect only the backdrop, never the
  // components on top. Returned as the first child of the stage.
  function buildBg(bg) {
    const layer = el('div', 'ac-bg');
    layer.style.background = bgCss(bg);
    const dim = bg && Number(bg.dim) > 0 ? Number(bg.dim) : 0;
    const blur = bg && Number(bg.blur) > 0 ? Number(bg.blur) : 0;
    if (blur) layer.style.filter = `blur(${blur}px)`;
    if (dim) { layer.classList.add('has-dim'); layer.style.setProperty('--ac-bg-dim', (dim / 100).toFixed(2)); }
    return layer;
  }

  // ── component renderers ─────────────────────────────────────────────────
  // Each entry: build(body, comp) once; update(item) on the rAF loop returns a
  // signature string — the loop rewrites the DOM only when it changes. Static
  // types (text/image/shape/sdk) declare no update.
  const R = {
    clock: {
      dynamic: true,
      build(body) {
        body.appendChild(el('div', 'ac-clock-time')).id = '';
        body.appendChild(el('div', 'ac-clock-ampm'));
      },
      update(item) {
        const now = new Date();
        const secs = !!(item.comp.props && item.comp.props.seconds);
        const fmt = (item.comp.props && item.comp.props.format) || 'auto';
        const is12 = fmt === '12' || (fmt === 'auto' && typeof clockUses12h === 'function' && clockUses12h());
        const h24 = now.getHours();
        const h = is12 ? (h24 % 12 || 12) : h24;
        const parts = [String(h).padStart(2, '0'), String(now.getMinutes()).padStart(2, '0')];
        if (secs) parts.push(String(now.getSeconds()).padStart(2, '0'));
        const time = parts.join(':');
        const ampm = is12 ? (h24 < 12 ? 'AM' : 'PM') : '';
        const sig = time + ampm;
        if (sig === item.sig) return sig;
        item.body.querySelector('.ac-clock-time').textContent = time;
        item.body.querySelector('.ac-clock-ampm').textContent = ampm;
        return sig;
      },
    },
    date: {
      dynamic: true,
      build(body) { body.appendChild(el('div', 'ac-date-text')); },
      update(item) {
        const now = new Date();
        const variant = (item.comp.props && item.comp.props.variant) || 'full';
        const locale = (typeof t === 'function') ? t('locale') : undefined;
        const opts = variant === 'weekday' ? { weekday: 'long' }
          : variant === 'short' ? { weekday: 'short', day: '2-digit', month: 'short' }
            : variant === 'numeric' ? { day: '2-digit', month: '2-digit', year: 'numeric' }
              : { weekday: 'long', day: '2-digit', month: 'long' };
        let text = '';
        try { text = new Intl.DateTimeFormat(locale, opts).format(now); } catch { text = now.toDateString(); }
        const sig = text;
        if (sig !== item.sig) item.body.querySelector('.ac-date-text').textContent = text;
        return sig;
      },
    },
    weather: {
      dynamic: true,
      build(body) {
        body.appendChild(el('div', 'ac-w-temp'));
        body.appendChild(el('div', 'ac-w-cond'));
        body.appendChild(el('div', 'ac-w-place'));
      },
      update(item) {
        const d = (typeof weatherData !== 'undefined') ? weatherData : null;
        const ok = !!(d && d.ok);
        const temp = ok && typeof toDisplayTemp === 'function' ? toDisplayTemp(d.tempC) : null;
        const tstr = ok && typeof weatherDisplayValue === 'function' ? weatherDisplayValue(temp, '°') : '--°';
        const cond = ok ? String(d.condition || '') : tt('weather_unavailable', 'Weather unavailable');
        const place = ok ? String(d.location || '') : '';
        const sig = tstr + '|' + cond + '|' + place;
        if (sig === item.sig) return sig;
        item.body.querySelector('.ac-w-temp').textContent = tstr;
        item.body.querySelector('.ac-w-cond').textContent = cond;
        item.body.querySelector('.ac-w-place').textContent = place;
        return sig;
      },
    },
    media: {
      dynamic: true,
      build(body, comp) {
        if (comp.props && comp.props.art) body.appendChild(el('div', 'ac-m-art'));
        const meta = body.appendChild(el('div', 'ac-m-meta'));
        meta.appendChild(el('div', 'ac-m-title'));
        meta.appendChild(el('div', 'ac-m-artist'));
      },
      update(item) {
        const d = (typeof mediaData !== 'undefined') ? mediaData : null;
        const active = !!(d && typeof hasActiveMedia === 'function' ? hasActiveMedia() : (d && d.title));
        const title = active ? ((typeof cleanTitle === 'function' ? cleanTitle(d.title) : d.title) || '') : '';
        const artist = active ? String(d.artist || d.album || '') : '';
        const thumb = active ? String(d.thumbnail || '') : '';
        const sig = title + '|' + artist + '|' + thumb + '|' + active;
        if (sig === item.sig) return sig;
        item.el.classList.toggle('ac-empty', !active);
        const tEl = item.body.querySelector('.ac-m-title');
        const aEl = item.body.querySelector('.ac-m-artist');
        if (tEl) tEl.textContent = title || tt('media_unknown_title', 'Nothing playing');
        if (aEl) aEl.textContent = artist;
        const art = item.body.querySelector('.ac-m-art');
        if (art) { art.classList.toggle('has-image', !!thumb); art.style.backgroundImage = thumb ? `url("${thumb}")` : ''; }
        return sig;
      },
    },
    agenda: {
      dynamic: true,
      build(body) { body.appendChild(el('div', 'ac-list')); },
      update(item) {
        const limit = (item.comp.props && item.comp.props.count) || 3;
        const now = Date.now();
        const events = (typeof calendarEvents !== 'undefined' && Array.isArray(calendarEvents)) ? calendarEvents : [];
        const upcoming = events
          .filter(e => e && Number.isFinite(Date.parse(e.startsAt)) && Date.parse(e.startsAt) >= now - 60000)
          .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
          .slice(0, limit);
        const sig = upcoming.map(e => (e.title || '') + '@' + e.startsAt).join('§');
        if (sig === item.sig) return sig;
        const list = item.body.querySelector('.ac-list');
        let fmt = null;
        try { fmt = new Intl.DateTimeFormat(t('locale'), { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { /* fall back below */ }
        list.replaceChildren(...upcoming.map(e => {
          const row = el('div', 'ac-list-row');
          const title = el('span', 'ac-list-title');
          title.textContent = String(e.title || tt('ph_title', 'Event'));
          const when = el('span', 'ac-list-when');
          when.textContent = fmt ? fmt.format(new Date(e.startsAt)) : String(e.startsAt);
          row.append(title, when);
          return row;
        }));
        if (!upcoming.length) list.appendChild(el('div', 'ac-empty-line')).textContent = tt('lock_no_events', 'No upcoming events');
        return sig;
      },
    },
    tasks: {
      dynamic: true,
      build(body) { body.appendChild(el('div', 'ac-list')); },
      update(item) {
        const limit = (item.comp.props && item.comp.props.count) || 4;
        const showDone = !!(item.comp.props && item.comp.props.showDone);
        const all = (typeof tasksData !== 'undefined' && Array.isArray(tasksData)) ? tasksData : [];
        const rows = all.filter(x => x && (showDone || !x.done)).slice(0, limit);
        const sig = rows.map(x => (x.done ? '1' : '0') + (x.text || '')).join('§');
        if (sig === item.sig) return sig;
        const list = item.body.querySelector('.ac-list');
        list.replaceChildren(...rows.map(x => {
          const row = el('div', 'ac-list-row ac-task' + (x.done ? ' done' : ''));
          const dot = el('span', 'ac-task-dot');
          const label = el('span', 'ac-list-title');
          label.textContent = String(x.text || '');
          row.append(dot, label);
          return row;
        }));
        if (!rows.length) list.appendChild(el('div', 'ac-empty-line')).textContent = tt('tasks_empty', 'No tasks');
        return sig;
      },
    },
    notes: {
      dynamic: true,
      build(body) { body.appendChild(el('div', 'ac-notes-text')); },
      update(item) {
        const st = (typeof notesState !== 'undefined' && notesState) ? notesState : null;
        const active = st && Array.isArray(st.notes) ? st.notes.find(n => n && n.id === st.activeId) : null;
        const text = active ? String(active.body || active.text || '') : '';
        const sig = text;
        if (sig !== item.sig) {
          const box = item.body.querySelector('.ac-notes-text');
          box.textContent = text || tt('notes_empty', 'No notes yet');
          item.el.classList.toggle('ac-empty', !text);
        }
        return sig;
      },
    },
    system: {
      dynamic: true,
      build(body, comp) {
        const metric = (comp.props && comp.props.metric) || 'all';
        (metric === 'all' ? ['cpu', 'gpu', 'ram'] : [metric]).forEach(m => {
          const row = body.appendChild(el('div', 'ac-stat ac-stat-' + m));
          row.appendChild(el('span', 'ac-stat-label')).textContent = m.toUpperCase();
          row.appendChild(el('span', 'ac-stat-val'));
        });
      },
      update(item) {
        const d = (typeof lastSystemData !== 'undefined') ? lastSystemData : null;
        const val = (m) => {
          if (!d) return '--';
          if (m === 'cpu') return Number.isFinite(d.cpu) ? d.cpu + '%' : '--';
          if (m === 'gpu') return Number.isFinite(d.gpu) ? d.gpu + '%' : '--';
          if (m === 'ram') return (d.memory && Number.isFinite(d.memory.percent)) ? d.memory.percent + '%' : '--';
          return '--';
        };
        const rows = Array.from(item.body.querySelectorAll('.ac-stat'));
        const sig = rows.map(r => {
          const m = (r.className.match(/ac-stat-(\w+)/) || [])[1];
          return m + val(m);
        }).join('|');
        if (sig === item.sig) return sig;
        rows.forEach(r => {
          const m = (r.className.match(/ac-stat-(\w+)/) || [])[1];
          const v = r.querySelector('.ac-stat-val');
          if (v) v.textContent = val(m);
        });
        return sig;
      },
    },
    network: {
      dynamic: true,
      build(body) {
        const dn = body.appendChild(el('div', 'ac-net-row ac-net-dn'));
        dn.appendChild(el('span', 'ac-net-label')).textContent = '↓';
        dn.appendChild(el('span', 'ac-net-val'));
        const up = body.appendChild(el('div', 'ac-net-row ac-net-up'));
        up.appendChild(el('span', 'ac-net-label')).textContent = '↑';
        up.appendChild(el('span', 'ac-net-val'));
      },
      update(item) {
        const d = (typeof lastNetworkData !== 'undefined') ? lastNetworkData : null;
        const fmt = (bps) => (typeof formatBandwidth === 'function' && Number.isFinite(bps)) ? formatBandwidth(bps) : '--';
        const dn = d ? fmt(d.downloadBps) : '--';
        const up = d ? fmt(d.uploadBps) : '--';
        const sig = dn + '|' + up;
        if (sig !== item.sig) {
          item.body.querySelector('.ac-net-dn .ac-net-val').textContent = dn;
          item.body.querySelector('.ac-net-up .ac-net-val').textContent = up;
        }
        return sig;
      },
    },
    text: {
      build(body, comp) {
        const p = comp.props || {};
        const box = body.appendChild(el('div', 'ac-text'));
        box.textContent = String(p.text || '');   // untrusted → textContent
        box.style.fontSize = (p.size || 48) + 'px';
        box.style.fontWeight = String(p.weight || 400);
        box.style.textAlign = p.align || 'center';
        box.style.color = p.color || '#e8ecf4';
        if (p.italic) box.style.fontStyle = 'italic';
        if (p.uppercase) box.style.textTransform = 'uppercase';
      },
    },
    image: {
      build(body, comp) {
        const p = comp.props || {};
        const img = body.appendChild(el('div', 'ac-image'));
        if (p.url) img.style.backgroundImage = `url("${p.url}")`;   // url already allowlisted by the normalizer
        img.style.backgroundSize = p.fit === 'contain' ? 'contain' : p.fit === 'fill' ? '100% 100%' : 'cover';
        if (p.radius) img.style.borderRadius = p.radius + 'px';
      },
    },
    shape: {
      build(body, comp) {
        const p = comp.props || {};
        const box = body.appendChild(el('div', 'ac-shape ac-shape-' + (p.kind || 'rect')));
        if (p.grad) box.style.background = `linear-gradient(${p.grad.angle || 180}deg, ${p.grad.from}, ${p.grad.to})`;
        else box.style.background = p.color || '#1b2030';
        if (p.kind === 'ellipse') box.style.borderRadius = '50%';
        else if (p.kind !== 'line' && p.radius) box.style.borderRadius = p.radius + 'px';
        if (p.borderColor && p.borderWidth) box.style.border = `${p.borderWidth}px solid ${p.borderColor}`;
      },
    },
    sdk: {
      build(body, comp, opts) {
        const pkgs = (window.CustomWidget && CustomWidget.cachedPackages) ? CustomWidget.cachedPackages() : [];
        const pkg = pkgs.find(p => p && p.id === (comp.props && comp.props.pkgId));
        const granted = pkg && CustomWidget.packageGranted && CustomWidget.packageGranted(pkg);
        // A static preview (import thumbnail) never mounts a live frame — it would
        // register a canvas frame the throwaway preview DOM can't clean up.
        if ((opts && opts.noSdkFrame) || !sdkEnabled() || !pkg || !granted) {
          const ph = body.appendChild(el('div', 'ac-sdk-missing'));
          ph.textContent = !sdkEnabled()
            ? tt('ambient_sdk_off', 'Community widgets are turned off')
            : tt('ambient_sdk_widget_unavailable', 'Widget unavailable');
          return;
        }
        const frame = document.createElement('iframe');
        frame.className = 'ac-sdk-frame';
        // Same sandbox contract as tile/SDK-scene frames — scripts only, opaque
        // origin; the served CSP is the network kill-switch. Never allow-same-origin.
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.title = pkg.name || comp.props.pkgId;
        frame.src = '/sdk/widget/' + encodeURIComponent(pkg.id) + '/' + (pkg.entry || 'index.html');
        CustomWidget.registerCanvasFrame(comp.id, pkg.id, frame);
        body.appendChild(frame);
      },
    },
  };

  // ── build one positioned component ──────────────────────────────────────
  // opts.noSdkFrame → SDK components render a placeholder instead of a live iframe
  // (used by the throwaway import-preview thumbnail, which can't clean frames up).
  function buildItem(comp, opts) {
    const def = R[comp.type];
    if (!def) return null;
    const wrap = el('div', 'ac-item ac-item-' + comp.type);
    wrap.style.left = comp.x + '%';
    wrap.style.top = comp.y + '%';
    wrap.style.width = comp.w + '%';
    wrap.style.height = comp.h + '%';
    if (comp.rot) wrap.style.transform = `rotate(${comp.rot}deg)`;
    // Give the item the tile DOM shape applyTileStyle expects, so per-component
    // colour tokens + decor reuse the exact tile pipeline (no drift).
    const content = wrap.appendChild(el('div', 'grid-stack-item-content'));
    const body = content.appendChild(el('div', 'ac-body'));
    def.build(body, comp, opts || {});
    if (typeof applyTileStyle === 'function') { try { applyTileStyle(wrap, comp.style); } catch { /* style optional */ } }
    return { comp, el: wrap, body, sig: '', dynamic: !!def.dynamic };
  }

  // ── self-pausing rAF loop ───────────────────────────────────────────────
  function tick() {
    raf = null;
    if (!current) return;
    for (const item of current.items) {
      if (!item.dynamic) continue;
      const def = R[item.comp.type];
      if (def && def.update) { try { item.sig = def.update(item); } catch { /* keep going */ } }
    }
    if (!document.hidden) raf = requestAnimationFrame(tick);
  }
  function startLoop() { if (!raf && !document.hidden) tick(); }
  function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLoop(); else if (current) startLoop();
  });

  // ── mount / unmount / refresh ───────────────────────────────────────────
  function mount(scene, opts) {
    if (isOpen()) return true;
    const stage = stageEl(); const overlay = overlayEl();
    if (!stage || !overlay) return false;
    const norm = (window.AmbientScene && AmbientScene.normalizeScene) ? AmbientScene.normalizeScene(scene) : scene;
    if (!norm || !Array.isArray(norm.components)) return false;
    current = { scene: norm, items: [], onClose: opts && typeof opts.onClose === 'function' ? opts.onClose : null };
    const frag = document.createDocumentFragment();
    frag.appendChild(buildBg(norm.bg));
    norm.components.slice().sort((a, b) => (a.z || 0) - (b.z || 0)).forEach(comp => {
      const item = buildItem(comp);
      if (item) { frag.appendChild(item.el); current.items.push(item); }
    });
    stage.replaceChildren(frag);
    overlay.hidden = false;
    document.body.classList.add('ambient-canvas-open');
    startLoop();
    return true;
  }

  function unmount() {
    stopLoop();
    if (window.CustomWidget && CustomWidget.unregisterCanvasFrames) CustomWidget.unregisterCanvasFrames();
    const stage = stageEl(); const overlay = overlayEl();
    if (stage) stage.replaceChildren();
    if (overlay) overlay.hidden = true;
    document.body.classList.remove('ambient-canvas-open');
    current = null;
  }

  // Rebuild the open scene in place — used when the SDK master toggles (embedded
  // frames must die when community widgets are switched off) without disturbing
  // AmbientMode's open/close bookkeeping.
  function refresh() {
    if (!isOpen() || !current) return;
    const scene = current.scene;
    const onClose = current.onClose;
    // Tear down frames + DOM, then rebuild from the same scene, keeping the
    // overlay visible throughout (no flash of the builtin scene).
    stopLoop();
    if (window.CustomWidget && CustomWidget.unregisterCanvasFrames) CustomWidget.unregisterCanvasFrames();
    const stage = stageEl();
    current = { scene, items: [], onClose };
    const frag = document.createDocumentFragment();
    frag.appendChild(buildBg(scene.bg));
    scene.components.slice().sort((a, b) => (a.z || 0) - (b.z || 0)).forEach(comp => {
      const item = buildItem(comp);
      if (item) { frag.appendChild(item.el); current.items.push(item); }
    });
    stage.replaceChildren(frag);
    startLoop();
  }

  // Preview reuse (js/preset-share.js import thumbnail): build a single item / the
  // bg layer with the EXACT same DOM + style pipeline as a live scene, and run one
  // update pass for a dynamic component — so the import preview can never drift from
  // what the screensaver renders. The caller owns the lifecycle (no rAF here).
  function previewUpdate(item) {
    const def = item && R[item.comp.type];
    if (def && def.update) { try { item.sig = def.update(item); } catch { /* keep going */ } }
    return item;
  }

  window.AmbientCanvas = {
    mount, unmount, isOpen, refresh,
    preview: { buildItem, buildBg, update: previewUpdate },
  };
})();
