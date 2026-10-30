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
// Performance: one self-pausing 1 s timer drives the dynamic components, updating a
// node's DOM only when its data signature actually changes (per reference/
// ambient.md), and the loop stops entirely on document.hidden and on unmount.
//
// Touch: a scene is for looking at. Only a few components can be touched, each
// while its `controls` prop is on (AmbientScene.TOUCH_TYPES): their buttons carry
// data-ac-act and one delegated click listener on the stage runs them, so a
// preview built from these same items is inert. ambient-mode.js lets a tap on a
// [data-ac-touch] element through instead of treating it as the wake gesture.
//
// Time windows and pages (AmbientScene.visibleAt/pageAt) are applied on the same
// tick; the drawing parts (background, per-element effects, analog clock,
// gauges) live in js/ambient-canvas-parts.js, the editor in
// js/ambient-canvas-editor.js.

(function () {
  if (typeof window === 'undefined') return;

  const stageEl = () => document.getElementById('ambient-canvas-stage');
  const overlayEl = () => document.getElementById('ambient-canvas-overlay');

  // current = { scene, items:[{ comp, el, body, sig, dynamic }], onClose }
  let current = null;
  let timer = null;

  function tt(key, fb) {
    const v = (typeof window.t === 'function') ? window.t(key) : key;
    return (v === key && fb != null) ? fb : v;
  }
  function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
  const fn = (name) => (typeof window[name] === 'function' ? window[name] : null);

  // Static, trusted icon markup (never built from data).
  const S = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  const ICON = {
    prev: S('<path d="M19 20 9 12l10-8v16Z"/><path d="M5 19V5"/>'),
    next: S('<path d="m5 4 10 8-10 8V4Z"/><path d="M19 5v14"/>'),
    play: S('<path d="M7 4v16l13-8L7 4Z"/>'),
    pause: S('<path d="M8 4v16M16 4v16"/>'),
    minus: S('<path d="M5 12h14"/>'),
    plus: S('<path d="M5 12h14M12 5v14"/>'),
    speaker: S('<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
    speakerOff: S('<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="m22 9-6 6M16 9l6 6"/>'),
    bell: S('<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
  };
  function iconSpan(cls, svg) { const n = el('span', cls); n.innerHTML = svg; return n; }   // static SVG only
  // A touchable control: a real button (focusable, labelled) the stage listener runs.
  function touchBtn(cls, act, label, svg) {
    const b = el('button', 'ac-touch ' + cls);
    b.type = 'button';
    b.dataset.acTouch = '';
    b.dataset.acAct = act;
    b.setAttribute('aria-label', label);
    b.title = label;
    if (svg) b.innerHTML = svg;   // static SVG only
    return b;
  }
  const taskDone = (x) => !!(x && (x.completed || x.done));
  // Notifications cleared from the scene (tapped away). This screen only: the
  // feed and the tile keep them. Bounded so a long session cannot grow it.
  const clearedNotifs = new Set();
  const CLEARED_MAX = 200;
  function clearNotif(id) {
    clearedNotifs.add(id);
    if (clearedNotifs.size > CLEARED_MAX) clearedNotifs.delete(clearedNotifs.values().next().value);
  }
  function notifAge(at) {
    const s = Math.max(0, Math.floor((Date.now() - (Number(at) || 0)) / 1000));
    if (s < 10) return tt('sbw_now', 'now');
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }
  function speakerState() {
    const sp = (typeof audioData !== 'undefined' && audioData && audioData.speaker) ? audioData.speaker : null;
    const vol = sp && Number.isFinite(Number(sp.volume)) ? Math.round(Number(sp.volume)) : null;
    const muted = (typeof speakerMuted !== 'undefined') ? !!speakerMuted : !!(sp && sp.muted);
    return { sp, vol, muted };
  }
  function isOpen() { const o = overlayEl(); return !!(o && !o.hidden); }
  function sdkEnabled() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.sdkWidgets : null;
    // Safe mode pauses third-party code everywhere, canvas scenes included —
    // this mirrors ambient-mode.js's gate so a refresh under safe mode swaps
    // SDK components for placeholders instead of remounting live frames.
    if (typeof hubSettings === 'object' && hubSettings && hubSettings.safeMode === true) return false;
    return !!(hs && hs.enabled);
  }
  // Per-package pause (Store → Installed → Sospendi) covers canvas-embedded
  // frames too; without this a suspended package kept running fullscreen.
  function pkgSuspended(pkgId) {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.sdkWidgets : null;
    const s = (hs && Array.isArray(hs.suspended)) ? hs.suspended : [];
    return typeof pkgId === 'string' && s.includes(pkgId);
  }

  // The drawing parts (js/ambient-canvas-parts.js, loaded first).
  const P = window.AmbientCanvasParts;
  // The preview's background never plays a video (it has no owner to stop it).
  function buildBg(bg) { return P.buildBg(bg, { still: true }).layer; }

  // ── component renderers ─────────────────────────────────────────────────
  // Each entry: build(body, comp) once; update(item) on the update loop returns a
  // signature string — the loop rewrites the DOM only when it changes. Static
  // types (text/image/shape/sdk) declare no update.
  const R = {
    clock: {
      dynamic: true,
      build(body, comp) {
        const p = comp.props || {};
        P.flag(body, 'align', p.align, 'center');
        if (p.style === 'analog') { body.dataset.style = 'analog'; P.buildAnalog(body, p); return; }
        P.flag(body, 'style', p.style, 'digital');
        if (p.blink) body.dataset.blink = '';
        const time = body.appendChild(el('div', 'ac-clock-time'));
        if (p.weight && p.weight !== 200) time.style.fontWeight = String(p.weight);
        body.appendChild(el('div', 'ac-clock-ampm'));
      },
      update(item) {
        const now = new Date();
        const p = item.comp.props || {};
        if (p.style === 'analog') return P.updateAnalog(item, now);
        const secs = !!p.seconds;
        const fmt = p.format || 'auto';
        const is12 = fmt === '12' || (fmt === 'auto' && typeof clockUses12h === 'function' && clockUses12h());
        const h24 = now.getHours();
        const h = is12 ? (h24 % 12 || 12) : h24;
        const parts = [String(h).padStart(2, '0'), String(now.getMinutes()).padStart(2, '0')];
        if (secs) parts.push(String(now.getSeconds()).padStart(2, '0'));
        const ampm = is12 && p.ampm !== false ? (h24 < 12 ? 'AM' : 'PM') : '';
        const sig = parts.join(':') + ampm;
        if (sig === item.sig) return sig;
        // Digits and separators as separate spans: a stacked clock puts each
        // part on its own line, a blinking one fades only the colons.
        const nodes = [];
        parts.forEach((part, i) => {
          if (i) nodes.push(Object.assign(el('span', 'ac-clock-sep'), { textContent: ':' }));
          nodes.push(Object.assign(el('span', 'ac-clock-part'), { textContent: part }));
        });
        item.body.querySelector('.ac-clock-time').replaceChildren(...nodes);
        item.body.querySelector('.ac-clock-ampm').textContent = ampm;
        return sig;
      },
    },
    date: {
      dynamic: true,
      build(body, comp) {
        const p = comp.props || {};
        P.flag(body, 'align', p.align, 'center');
        const text = body.appendChild(el('div', 'ac-date-text'));
        if (p.uppercase) text.classList.add('is-upper');
      },
      update(item) {
        const now = new Date();
        const variant = (item.comp.props && item.comp.props.variant) || 'full';
        const locale = (typeof t === 'function') ? t('locale') : undefined;
        const opts = variant === 'weekday' ? { weekday: 'long' }
          : variant === 'short' ? { weekday: 'short', day: '2-digit', month: 'short' }
            : variant === 'numeric' ? { day: '2-digit', month: '2-digit', year: 'numeric' }
              : variant === 'long' ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
                : variant === 'day' ? { day: 'numeric', month: 'long' }
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
      build(body, comp) {
        const p = comp.props || {};
        P.flag(body, 'align', p.align, 'center');
        P.flag(body, 'layout', p.layout, 'stack');
        const head = body.appendChild(el('div', 'ac-w-head'));
        if (p.icon) head.appendChild(el('span', 'ac-w-ico'));
        head.appendChild(el('div', 'ac-w-temp'));
        if (p.cond !== false) body.appendChild(el('div', 'ac-w-cond'));
        if (p.place !== false) body.appendChild(el('div', 'ac-w-place'));
      },
      update(item) {
        const d = (typeof weatherData !== 'undefined') ? weatherData : null;
        const ok = !!(d && d.ok);
        const temp = ok && typeof toDisplayTemp === 'function' ? toDisplayTemp(d.tempC) : null;
        const tstr = ok && typeof weatherDisplayValue === 'function' ? weatherDisplayValue(temp, '°') : '--°';
        const cond = ok ? String(d.condition || '') : tt('weather_unavailable', 'Weather unavailable');
        const place = ok ? String(d.location || '') : '';
        const ico = item.body.querySelector('.ac-w-ico');
        const glyph = ico ? P.weatherGlyph(d) : '';
        const sig = tstr + '|' + cond + '|' + place + '|' + glyph.length;
        if (sig === item.sig) return sig;
        const set = (sel, v) => { const n = item.body.querySelector(sel); if (n) n.textContent = v; };
        set('.ac-w-temp', tstr);
        set('.ac-w-cond', cond);
        set('.ac-w-place', place);
        if (ico) ico.innerHTML = glyph;   // static, trusted SVG (js/weather-glyphs.js)
        return sig;
      },
    },
    media: {
      dynamic: true,
      build(body, comp) {
        const p = comp.props || {};
        P.flag(body, 'layout', p.layout, 'row');
        if (p.art) body.appendChild(el('div', 'ac-m-art'));
        const meta = body.appendChild(el('div', 'ac-m-meta'));
        meta.appendChild(el('div', 'ac-m-title'));
        if (p.artist !== false) meta.appendChild(el('div', 'ac-m-artist'));
        if (comp.props && comp.props.controls) {
          const ctl = meta.appendChild(el('div', 'ac-m-ctl'));
          ctl.append(
            touchBtn('ac-m-btn', 'media-previous', tt('tip_prev', 'Previous'), ICON.prev),
            touchBtn('ac-m-btn ac-m-play', 'media-playpause', tt('tip_play', 'Play/Pause'), ICON.play),
            touchBtn('ac-m-btn', 'media-next', tt('tip_next', 'Next'), ICON.next),
          );
        }
      },
      update(item) {
        const d = (typeof mediaData !== 'undefined') ? mediaData : null;
        const active = !!(d && typeof hasActiveMedia === 'function' ? hasActiveMedia() : (d && d.title));
        const title = active ? ((typeof cleanTitle === 'function' ? cleanTitle(d.title) : d.title) || '') : '';
        const artist = active ? String(d.artist || d.album || '') : '';
        const thumb = active ? String(d.thumbnail || '') : '';
        const playing = !!(active && d.playbackStatus === 'Playing');
        const sig = title + '|' + artist + '|' + thumb + '|' + active + '|' + playing;
        if (sig === item.sig) return sig;
        item.el.classList.toggle('ac-empty', !active);
        const play = item.body.querySelector('.ac-m-play');
        if (play) play.innerHTML = playing ? ICON.pause : ICON.play;   // static SVG only
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
      build(body, comp) {
        if (comp.props && comp.props.time === false) body.dataset.time = 'off';
        body.appendChild(el('div', 'ac-list'));
      },
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
        try { fmt = new Intl.DateTimeFormat(t('locale'), timeParts({ weekday: 'short', day: '2-digit', month: 'short' })); } catch { /* fall back below */ }
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
        const touch = !!(item.comp.props && item.comp.props.controls);
        const all = (typeof tasksData !== 'undefined' && Array.isArray(tasksData)) ? tasksData : [];
        // The task store marks a finished task `completed`; `done` is kept for old data.
        const rows = all.filter(x => x && (showDone || !taskDone(x))).slice(0, limit);
        const sig = rows.map(x => (taskDone(x) ? '1' : '0') + (x.id || '') + (x.text || '')).join('§');
        if (sig === item.sig) return sig;
        const list = item.body.querySelector('.ac-list');
        list.replaceChildren(...rows.map(x => {
          const done = taskDone(x);
          const cls = 'ac-list-row ac-task' + (done ? ' done' : '');
          // Touchable: the whole row ticks the task (or brings a finished one back).
          const row = touch && x.id != null
            ? touchBtn(cls, 'task', done ? tt('task_undo', 'Undo') : tt('task_tick', 'Done'), '')
            : el('div', cls);
          if (row.dataset.acAct) row.dataset.acId = String(x.id);
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
      build(body, comp) {
        P.flag(body, 'align', comp.props && comp.props.align, 'left');
        body.appendChild(el('div', 'ac-notes-text'));
      },
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
        const p = comp.props || {};
        const metric = p.metric || 'all';
        P.flag(body, 'style', p.style, 'text');
        (metric === 'all' ? ['cpu', 'gpu', 'ram'] : [metric]).forEach(m => {
          const row = body.appendChild(el('div', 'ac-stat ac-stat-' + m));
          row.appendChild(el('span', 'ac-stat-label')).textContent = m.toUpperCase();
          row.appendChild(el('span', 'ac-stat-val'));
          P.buildGauge(row, p.style);
        });
      },
      update(item) {
        const d = (typeof lastSystemData !== 'undefined') ? lastSystemData : null;
        const pct = (m) => {
          if (!d) return null;
          const v = m === 'cpu' ? d.cpu : m === 'gpu' ? d.gpu : m === 'ram' ? (d.memory && d.memory.percent) : null;
          return Number.isFinite(v) ? v : null;
        };
        const rows = Array.from(item.body.querySelectorAll('.ac-stat'));
        const metricOf = (r) => (r.className.match(/ac-stat-(\w+)/) || [])[1];
        const sig = rows.map(r => metricOf(r) + pct(metricOf(r))).join('|');
        if (sig === item.sig) return sig;
        rows.forEach(r => {
          const n = pct(metricOf(r));
          const v = r.querySelector('.ac-stat-val');
          if (v) v.textContent = n == null ? '--' : n + '%';
          P.setGauge(r, n);
        });
        return sig;
      },
    },
    network: {
      dynamic: true,
      build(body, comp) {
        const p = comp.props || {};
        P.flag(body, 'align', p.align, 'center');
        const row = (cls, arrow) => {
          const r = body.appendChild(el('div', 'ac-net-row ' + cls));
          r.appendChild(el('span', 'ac-net-label')).textContent = arrow;
          r.appendChild(el('span', 'ac-net-val'));
        };
        if (p.show !== 'up') row('ac-net-dn', '↓');
        if (p.show !== 'down') row('ac-net-up', '↑');
      },
      update(item) {
        const d = (typeof lastNetworkData !== 'undefined') ? lastNetworkData : null;
        // formatBandwidth (utils.js) gives { value, unit }, as on the System tile.
        const fmt = (bps) => {
          if (typeof formatBandwidth !== 'function' || !Number.isFinite(bps)) return '--';
          const b = formatBandwidth(bps);
          return b.value + ' ' + b.unit;
        };
        const dn = d ? fmt(d.downloadBps) : '--';
        const up = d ? fmt(d.uploadBps) : '--';
        const sig = dn + '|' + up;
        if (sig !== item.sig) {
          const set = (sel, v) => { const n = item.body.querySelector(sel); if (n) n.textContent = v; };
          set('.ac-net-dn .ac-net-val', dn);
          set('.ac-net-up .ac-net-val', up);
        }
        return sig;
      },
    },
    notifications: {
      dynamic: true,
      build(body) {
        body.appendChild(el('div', 'ac-list ac-notif-list'));
        // Seeds the feed when no Notifications tile is on the page.
        const NW = window.NotificationsWidget;
        if (NW && typeof NW.ensureSeeded === 'function') { try { NW.ensureSeeded(); } catch { /* feed optional */ } }
      },
      update(item) {
        const p = item.comp.props || {};
        const NW = window.NotificationsWidget;
        const snap = NW && typeof NW.snapshot === 'function' ? NW.snapshot() : null;
        const list = item.body.querySelector('.ac-notif-list');
        let state = '';
        if (!snap || !snap.enabled) state = tt('ambient_notif_off', 'Turn on notifications in the Notifications tile');
        else if (snap.state === 'denied') state = tt('wn_denied', 'Windows is blocking notification access');
        else if (snap.state === 'unavailable') state = snap.supported === false ? tt('wn_unsupported_os', 'Notification mirroring is not available on this system') : tt('wn_unavailable', 'Not available on this Windows version');
        else if (snap.items === null || snap.state === 'starting' || snap.state === 'off') state = tt('wn_loading', 'Connecting…');
        const touch = !!p.controls;
        const rows = state ? [] : snap.items.filter(n => n && !clearedNotifs.has(n.id)).slice(0, p.count || 3);
        if (!state && !rows.length) state = tt('wn_empty', 'No notifications: all caught up');
        const masked = (n) => !!(snap && snap.hide) && !(NW.isRevealed && NW.isRevealed(n.id));
        const sig = state + '§' + touch + '§' + rows.map(n => n.id + (masked(n) ? 'm' : '') + notifAge(n.at)).join('§');
        if (sig === item.sig) return sig;
        item.el.classList.toggle('ac-empty', !!state);
        if (state) {
          const line = el('div', 'ac-empty-line');
          line.textContent = state;
          list.replaceChildren(line);
          return sig;
        }
        list.replaceChildren(...rows.map(n => {
          const hidden = masked(n);
          // Touchable: a tap shows hidden text, the next one clears it from the scene.
          const row = touch && n.id != null
            ? touchBtn('ac-notif', 'notif', hidden ? tt('wn_hidden', 'Tap to show') : tt('ambient_notif_clear', 'Clear from this screen'), '')
            : el('div', 'ac-notif');
          if (row.dataset.acAct) { row.dataset.acId = String(n.id); row.dataset.acMasked = hidden ? '1' : ''; }
          // Toast text is untrusted: textContent only, and the app icon only as data:image/.
          if (typeof n.icon === 'string' && n.icon.startsWith('data:image/')) {
            const img = el('img', 'ac-notif-ico');
            img.alt = '';
            img.src = n.icon;
            row.appendChild(img);
          } else row.appendChild(iconSpan('ac-notif-ico is-ph', ICON.bell));
          const txt = row.appendChild(el('span', 'ac-notif-txt'));
          const head = txt.appendChild(el('span', 'ac-notif-head'));
          head.appendChild(el('span', 'ac-notif-app')).textContent = String(n.app || tt('wn_title', 'Notifications'));
          head.appendChild(el('span', 'ac-notif-age')).textContent = notifAge(n.at);
          if (hidden) txt.appendChild(el('span', 'ac-notif-body is-masked')).textContent = touch ? tt('wn_hidden', 'Tap to show') : tt('ambient_notif_hidden', 'Content hidden');
          else {
            if (n.title) txt.appendChild(el('span', 'ac-notif-title')).textContent = String(n.title);
            if (p.body && n.body) txt.appendChild(el('span', 'ac-notif-body')).textContent = String(n.body);
          }
          return row;
        }));
        return sig;
      },
    },
    volume: {
      dynamic: true,
      build(body, comp) {
        const touch = !!(comp.props && comp.props.controls);
        const row = body.appendChild(el('div', 'ac-vol'));
        if (touch) row.appendChild(touchBtn('ac-vol-btn', 'vol-down', tt('ambient_vol_down', 'Volume down'), ICON.minus));
        const mid = touch
          ? touchBtn('ac-vol-mid', 'vol-mute', tt('ambient_vol_mute', 'Mute or unmute'), '')
          : el('div', 'ac-vol-mid');
        mid.appendChild(el('span', 'ac-vol-ico'));
        mid.appendChild(el('span', 'ac-vol-val'));
        row.appendChild(mid);
        if (touch) row.appendChild(touchBtn('ac-vol-btn', 'vol-up', tt('ambient_vol_up', 'Volume up'), ICON.plus));
        body.appendChild(el('div', 'ac-vol-bar')).appendChild(el('div', 'ac-vol-fill'));
      },
      update(item) {
        const { vol, muted } = speakerState();
        const sig = vol + '|' + muted;
        if (sig === item.sig) return sig;
        item.el.classList.toggle('ac-empty', vol == null);
        item.el.classList.toggle('is-muted', muted);
        item.body.querySelector('.ac-vol-ico').innerHTML = muted ? ICON.speakerOff : ICON.speaker;   // static SVG only
        item.body.querySelector('.ac-vol-val').textContent = vol == null ? '--' : vol + '%';
        item.body.querySelector('.ac-vol-fill').style.width = (vol == null || muted ? 0 : vol) + '%';
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
        if (p.spacing) box.style.letterSpacing = (p.spacing / 100) + 'em';
        if (p.lineHeight && p.lineHeight !== 115) box.style.lineHeight = String(p.lineHeight / 100);
        if (p.glow) box.style.textShadow = `0 0 ${p.glow}px ${p.color || '#e8ecf4'}`;
        if (p.valign === 'top') body.style.justifyContent = 'flex-start';
        else if (p.valign === 'bottom') body.style.justifyContent = 'flex-end';
      },
    },
    image: {
      build(body, comp) {
        const p = comp.props || {};
        const img = body.appendChild(el('div', 'ac-image'));
        if (p.url) img.style.backgroundImage = `url("${p.url}")`;   // url already allowlisted by the normalizer
        img.style.backgroundSize = p.fit === 'contain' ? 'contain' : p.fit === 'fill' ? '100% 100%' : 'cover';
        if (p.radius) img.style.borderRadius = p.radius + 'px';
        if (p.grayscale) img.style.filter = 'grayscale(1)';
        if (p.focusX != null && (p.focusX !== 50 || p.focusY !== 50)) img.style.backgroundPosition = `${p.focusX}% ${p.focusY}%`;
      },
    },
    shape: {
      build(body, comp) {
        const p = comp.props || {};
        P.shapeCss(body.appendChild(el('div', 'ac-shape ac-shape-' + (p.kind || 'rect'))), p);
        // A soft shape is a glow: its blur spreads past the box instead of being cut at it.
        if (p.blur && body.parentElement) body.parentElement.classList.add('ac-soft');
      },
    },
    sdk: {
      build(body, comp, opts) {
        const pkgs = (window.CustomWidget && CustomWidget.cachedPackages) ? CustomWidget.cachedPackages() : [];
        const pkg = pkgs.find(p => p && p.id === (comp.props && comp.props.pkgId));
        const granted = pkg && CustomWidget.packageGranted && CustomWidget.packageGranted(pkg);
        // A static preview (import thumbnail) never mounts a live frame — it would
        // register a canvas frame the throwaway preview DOM can't clean up.
        if ((opts && opts.noSdkFrame) || !sdkEnabled() || !pkg || !granted || pkgSuspended(pkg.id)) {
          const ph = body.appendChild(el('div', 'ac-sdk-missing'));
          ph.textContent = (opts && opts.named && pkg) ? (pkg.name || pkg.id) : !sdkEnabled()
            ? tt('ambient_sdk_off', 'Community widgets are turned off')
            : (pkg && pkgSuspended(pkg.id))
              ? tt('cw_suspended', 'Widget paused')
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
        frame.src = (window.CustomWidget && window.CustomWidget.assetBase ? window.CustomWidget.assetBase(pkg.id) : '/sdk/widget/' + encodeURIComponent(pkg.id) + '/') + (pkg.entry || 'index.html');
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
    wrap.dataset.acId = comp.id;
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
    P.decorate(wrap, content, body, comp);
    if (typeof applyTileStyle === 'function') { try { applyTileStyle(wrap, comp.style); } catch { /* style optional */ } }
    return { comp, el: wrap, body, sig: '', dynamic: !!def.dynamic, off: false };
  }

  // ── time windows and pages ──────────────────────────────────────────────
  // An element outside its time window, or on another page, steps out of view
  // (CSS fades it, per the scene's page transition). Checked on the 1 s tick.
  // opts.page: the editor pins one page and ignores the time windows.
  function syncVisibility(now) {
    const AS = window.AmbientScene;
    const edit = current.edit;
    const page = edit ? edit.page : AS.pageAt(current.scene, now - current.startedAt);
    const pageTurned = page !== current.page;
    current.page = page;
    for (const item of current.items) {
      const shown = AS.onPage(item.comp, page) && (edit || AS.visibleAt(item.comp, new Date(now)));
      if (shown === !item.off) continue;
      item.off = !shown;
      item.el.classList.toggle('ac-off', item.off);
      if (shown && pageTurned) P.replayIn(item);
    }
  }

  // ── touch ───────────────────────────────────────────────────────────────
  // Each action reuses the dashboard's own handler, so a tap here does exactly
  // what the same control does on its tile.
  function runTouch(act, id, btn) {
    if (act === 'media-previous' || act === 'media-playpause' || act === 'media-next') {
      const run = fn('mediaAction');
      if (run) run(act.slice('media-'.length));
    } else if (act === 'task') {
      const all = (typeof tasksData !== 'undefined' && Array.isArray(tasksData)) ? tasksData : [];
      const task = all.find(x => x && String(x.id) === id);
      const run = task && fn(taskDone(task) ? 'undoTask' : 'tickTask');
      if (run) run(task.id);
    } else if (act === 'notif') {
      const NW = window.NotificationsWidget;
      if (btn.dataset.acMasked === '1' && NW && NW.reveal) NW.reveal(id);
      else clearNotif(id);
    } else if (act === 'vol-mute') {
      const run = fn('toggleSpeakerMute');
      if (run) run();
    } else if (act === 'vol-down' || act === 'vol-up') {
      const { sp, vol } = speakerState();
      const item = current && current.items.find(i => i.el.contains(btn));
      const step = (item && item.comp.props && item.comp.props.step) || 5;
      const run = fn('onSliderInput');   // the tile slider's path: label, fill, debounced send
      if (!sp || vol == null || !run) return;
      const level = Math.max(0, Math.min(100, vol + (act === 'vol-up' ? step : -step)));
      sp.volume = level;   // optimistic; the next audio sample confirms it
      run(level);
    }
  }
  function onStageTap(e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-ac-act]') : null;
    if (!btn || !current || current.edit) return;   // while editing, a tap selects
    const item = current.items.find(i => i.el.contains(btn));
    if (!item) return;
    try { runTouch(btn.dataset.acAct, btn.dataset.acId || '', btn); } catch { /* a failed action leaves the scene up */ }
    // Repaint the touched element now instead of on the next tick.
    item.sig = '';
    previewUpdate(item);
  }
  let tapWired = false;
  function wireTouch(stage) {
    if (tapWired) return;
    tapWired = true;
    stage.addEventListener('click', onStageTap);
  }

  // The server reads the speaker volume only for two minutes after something
  // asked for it (audioPollWanted). A Volume element is a reader the server
  // cannot see, so while one is mounted it asks once a minute.
  const AUDIO_WATCH_MS = 60000;
  let audioWatchAt = 0;
  function keepAudioFresh() {
    if (!current || !current.items.some(i => i.comp.type === 'volume')) return;
    const now = Date.now();
    if (now - audioWatchAt < AUDIO_WATCH_MS) return;
    const first = audioWatchAt === 0;
    audioWatchAt = now;
    const fetchNow = fn('fetchAudio');
    if (first && fetchNow) fetchNow();
    else if (typeof SERVER === 'string') fetch(SERVER + '/audio/watch').catch(() => {});
  }

  // ── self-pausing update loop ────────────────────────────────────────────
  // Nothing here moves per frame: the finest-grained value is the clock's
  // seconds, and the data globals change at SSE pace. So one timer aimed just
  // past the next second boundary replaces a rAF loop that rebuilt every
  // signature (an Intl formatter, the agenda sort) 60-240 times a second for a
  // screensaver whose whole job is to sit there for hours.
  const TICK_SLACK_MS = 5;
  function tick() {
    timer = null;
    if (!current) return;
    syncVisibility(Date.now());
    P.syncVideo(current.video);
    for (const item of current.items) {
      if (!item.dynamic || item.off) continue;
      const def = R[item.comp.type];
      if (def && def.update) { try { item.sig = def.update(item); } catch { /* keep going */ } }
    }
    keepAudioFresh();
    if (!document.hidden) timer = setTimeout(tick, 1000 - (Date.now() % 1000) + TICK_SLACK_MS);
  }
  function startLoop() { if (!timer && !document.hidden) tick(); }
  function stopLoop() { if (timer) { clearTimeout(timer); timer = null; } }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLoop(); else if (current) startLoop();
  });

  // ── mount / unmount / refresh ───────────────────────────────────────────
  // Build the stage for `current.scene`: background, then the elements in
  // layer order. The first tick (startLoop) sets what is in view.
  function buildStage(stage) {
    const scene = current.scene;
    const frag = document.createDocumentFragment();
    const bg = P.buildBg(scene.bg);
    current.video = bg.video;
    frag.appendChild(bg.layer);
    scene.components.slice().sort((a, b) => (a.z || 0) - (b.z || 0)).forEach(comp => {
      // While editing, an SDK widget is a named placeholder: a live frame would
      // reload on every change and catch the drags meant for the element.
      const item = buildItem(comp, current.edit ? { noSdkFrame: true, named: true } : undefined);
      if (item) { frag.appendChild(item.el); current.items.push(item); }
    });
    stage.dataset.transition = (scene.pages && scene.pages.transition) || 'fade';
    stage.replaceChildren(frag);
  }
  function dropFrames() {
    if (window.CustomWidget && CustomWidget.unregisterCanvasFrames) CustomWidget.unregisterCanvasFrames();
  }

  // opts.edit = { page }: the in-app editor (js/ambient-canvas-editor.js) shows
  // one page with every element in view and no entrance or loop playing.
  // opts.onUnmount runs once the overlay is gone, whoever closed it.
  function mount(scene, opts) {
    if (isOpen()) return true;
    const stage = stageEl(); const overlay = overlayEl();
    if (!stage || !overlay) return false;
    const norm = (window.AmbientScene && AmbientScene.normalizeScene) ? AmbientScene.normalizeScene(scene) : scene;
    if (!norm || !Array.isArray(norm.components)) return false;
    const edit = opts && opts.edit ? { page: Number(opts.edit.page) || 0 } : null;
    const fn = (k) => (opts && typeof opts[k] === 'function' ? opts[k] : null);
    current = { scene: norm, items: [], onClose: fn('onClose'), onUnmount: fn('onUnmount'), edit, startedAt: Date.now(), page: -1, video: null };
    buildStage(stage);
    overlay.classList.toggle('is-editing', !!edit);
    wireTouch(stage);
    audioWatchAt = 0;
    overlay.hidden = false;
    document.body.classList.add('ambient-canvas-open');
    startLoop();
    return true;
  }

  function unmount() {
    stopLoop();
    dropFrames();
    if (current && current.video) current.video.pause();
    const stage = stageEl(); const overlay = overlayEl();
    if (stage) stage.replaceChildren();
    if (overlay) { overlay.hidden = true; overlay.classList.remove('is-editing'); }
    document.body.classList.remove('ambient-canvas-open');
    const after = current && current.onUnmount;
    current = null;
    if (after) after();
  }

  // Rebuild the open scene in place — used when the SDK master toggles (embedded
  // frames must die when community widgets are switched off) and by the editor
  // after a change (`scene` = the edited copy), without disturbing AmbientMode's
  // open/close bookkeeping. The overlay stays up throughout (no flash of the
  // builtin scene).
  function refresh(scene, opts) {
    if (!isOpen() || !current) return;
    const next = scene ? AmbientScene.normalizeScene(scene) : current.scene;
    stopLoop();
    dropFrames();
    if (current.video) current.video.pause();
    const edit = opts && opts.edit ? { page: Number(opts.edit.page) || 0 } : current.edit;
    current = { scene: next, items: [], onClose: current.onClose, onUnmount: current.onUnmount, edit, startedAt: current.startedAt, page: -1, video: null };
    buildStage(stageEl());
    startLoop();
  }
  // The positioned items of the open scene, for the editor (read-only use).
  function openItems() { return current ? current.items.slice() : []; }

  // Preview reuse (js/preset-share.js import thumbnail): build a single item / the
  // bg layer with the EXACT same DOM + style pipeline as a live scene, and run one
  // update pass for a dynamic component — so the import preview can never drift from
  // what the screensaver renders. The caller owns the lifecycle (no loop here).
  function previewUpdate(item) {
    const def = item && R[item.comp.type];
    if (def && def.update) { try { item.sig = def.update(item); } catch { /* keep going */ } }
    return item;
  }

  window.AmbientCanvas = {
    mount, unmount, isOpen, refresh, openItems,
    preview: { buildItem, buildBg, update: previewUpdate },
  };
})();
