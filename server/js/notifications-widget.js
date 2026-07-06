'use strict';
// Windows Notifications widget — mirrors the PC's Action Center toasts
// (WhatsApp, mail, Teams, …) as a live feed on the dashboard.
//
// EVENT-DRIVEN: the server runs the notification reader ONLY while the feature
// is on and a dashboard is open, pushing each new toast over SSE
// (event: 'windows_notification') and state/feed replacements over
// 'windows_notifications'. The widget fetches a seed once on mount
// (GET /notifications/windows) and then idles — near-zero cost at rest.
//
// The tile hosts its own controls (no separate Settings page): enable/disable,
// "hide content until tapped", and a per-app mute with a muted-apps manager —
// all persisted in hubSettings.windowsNotifications. Notification text is
// private, untrusted input → textContent everywhere, and icons render only
// when they are data:image/ URIs.
(function () {
  const S = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const ICONS = {
    bell: S('<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    bellOff: S('<path d="M8.7 3a6 6 0 0 1 9.3 5c0 3.5.7 5.7 1.5 7.1M6.3 6.3C6.1 6.8 6 7.4 6 8c0 7-3 9-3 9h14"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/><path d="m2 2 20 20"/>'),
    eye: S('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: S('<path d="M10.7 5.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.6 3.5M6.6 6.6C4 8.3 2 12 2 12s3.5 7 10 7c1.4 0 2.7-.3 3.8-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/>'),
    power: S('<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>'),
    back: S('<path d="m15 18-6-6 6-6"/>'),
  };
  const FEED_MAX = 30;

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;   // shared DOM factory from utils.js
  const api = apiJson; // shared fetch-JSON helper from utils.js

  // Server-side reader state ('off'|'starting'|'allowed'|'denied'|'unavailable')
  // plus the seeded flags; `items === null` means "seed not loaded yet".
  let srvState = 'off';
  let seedFlags = { enabled: false, hide: false, toast: true, excluded: [] };
  let items = null;
  let seeded = false;
  const revealed = new Set();   // ids tapped open while "hide content" is on
  let view = 'feed';            // 'feed' | 'muted' (the muted-apps manager)

  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="notifications"]')).filter(n => n.closest('.pager-page')); }

  // Live settings win over the seed snapshot (the user may toggle mid-session).
  function wn() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.windowsNotifications : null;
    return (hs && typeof hs === 'object') ? hs : seedFlags;
  }

  function persist(field, value) {
    if (typeof updateWindowsNotifications === 'function') updateWindowsNotifications(field, value);
    seedFlags = { ...seedFlags, [field]: value };   // keep the fallback in step
  }

  function fmtAge(at) {
    const s = Math.max(0, Math.floor((Date.now() - (at || 0)) / 1000));
    if (s < 10) return t('sbw_now', 'now');
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  // Per-app accent for the pop-up toast: pull a vivid colour out of the app's own
  // icon (reusing the album-art extractor), cached by icon so we decode each logo
  // once. Returns an "r,g,b" triple or null (→ the toast falls back to --accent).
  const iconAccentCache = new Map();
  function hexToRgbTriple(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)].join(',') : null;
  }
  async function iconAccent(iconUrl) {
    if (typeof iconUrl !== 'string' || !iconUrl.startsWith('data:image/')) return null;
    if (iconAccentCache.has(iconUrl)) return iconAccentCache.get(iconUrl);
    let rgb = null;
    try {
      if (typeof window.extractAlbumAccent === 'function') {
        const r = await window.extractAlbumAccent(iconUrl);
        if (r && r.accent) rgb = hexToRgbTriple(r.accent);
      }
    } catch { /* fall back to the dashboard accent */ }
    if (iconAccentCache.size > 200) iconAccentCache.clear();   // bounded
    iconAccentCache.set(iconUrl, rgb);
    return rgb;
  }

  // Pop a transient toast for a freshly arrived notification (never for the seed).
  // Presentation only: gated on the Settings → Notifiche pop-up switch, honours
  // "hide content", and skipped while the dashboard is backgrounded (nothing to see).
  function maybeToast(item) {
    const master = (typeof hubSettings === 'object' && hubSettings && hubSettings.notifications) || null;
    if (master && (master.enabled === false || master.popups === false)) return;
    if (document.hidden || !window.XenonToast) return;
    const iconUrl = (typeof item.icon === 'string' && item.icon.startsWith('data:image/')) ? item.icon : null;
    const opts = {
      type: 'notification',
      kicker: item.app || t('wn_title', 'Notifications'),
      title: item.title || item.app || '',
      message: wn().hide ? t('wn_toast_hidden', 'New notification') : (item.body || ''),
      iconUrl,
      duration: 6000,
    };
    if (iconUrl) {
      iconAccent(iconUrl).then(rgb => { if (rgb) opts.rgb = rgb; window.XenonToast.show(opts); });
    } else {
      window.XenonToast.show(opts);
    }
  }

  // Head icon-button factory (eye / muted / power).
  function headBtn(cls, title, onClick) {
    const b = el('button', 'wn-hbtn ' + cls);
    b.type = 'button'; b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function ensure(mount) {
    if (mount.dataset.wnBuilt === '1' && mount.firstChild) return;
    mount.dataset.wnBuilt = '1';
    const wrap = el('div', 'wn-wrap');

    const head = el('div', 'wn-head');
    const brand = el('div', 'wn-brand');
    const logo = el('span', 'wn-logo'); logo.innerHTML = ICONS.bell;   // static, trusted SVG
    brand.append(logo, el('span', 'wn-title', t('wn_title', 'Notifications')));
    head.appendChild(brand);
    const ctl = el('div', 'wn-ctl');
    // Pop-up toasts are controlled globally from Settings → Notifiche (not here),
    // so the widget header only carries hide-content, muted-apps and turn-off.
    const hideBtn = headBtn('wn-hide-btn', t('wn_hide', 'Hide content until tapped'), () => {
      persist('hide', !wn().hide); paint();
    });
    const mutedBtn = headBtn('wn-muted-btn', t('wn_muted', 'Muted apps'), () => {
      view = view === 'muted' ? 'feed' : 'muted'; paint();
    });
    mutedBtn.appendChild(el('span', 'wn-muted-count'));
    const offBtn = headBtn('wn-off-btn', t('wn_disable', 'Turn off'), () => {
      persist('enabled', false); paint();
    });
    offBtn.innerHTML = ICONS.power;   // static, trusted SVG
    ctl.append(hideBtn, mutedBtn, offBtn);
    head.appendChild(ctl);
    wrap.appendChild(head);

    const body = el('div', 'wn-body');
    body.appendChild(el('div', 'wn-list'));
    wrap.appendChild(body);

    mount.replaceChildren(wrap);
  }

  function applyLabels(mount) {
    const title = mount.querySelector('.wn-title');
    if (title) title.textContent = t('wn_title', 'Notifications');
    const hideBtn = mount.querySelector('.wn-hide-btn');
    if (hideBtn) hideBtn.title = t('wn_hide', 'Hide content until tapped');
    const mutedBtn = mount.querySelector('.wn-muted-btn');
    if (mutedBtn) mutedBtn.title = t('wn_muted', 'Muted apps');
    const offBtn = mount.querySelector('.wn-off-btn');
    if (offBtn) offBtn.title = t('wn_disable', 'Turn off');
  }

  // One feed row. Everything is untrusted toast text → textContent; the app icon
  // renders ONLY when it is a data:image/ URI (scheme allowlist — no remote loads).
  function notifRow(n) {
    const row = el('div', 'wn-item');
    if (typeof n.icon === 'string' && n.icon.startsWith('data:image/')) {
      const img = document.createElement('img');
      img.className = 'wn-item-ico'; img.alt = '';
      img.src = n.icon;
      row.appendChild(img);
    } else {
      const ph = el('span', 'wn-item-ico wn-item-ico--ph'); ph.innerHTML = ICONS.bell;   // static SVG
      row.appendChild(ph);
    }
    const txt = el('div', 'wn-item-txt');
    const head = el('div', 'wn-item-head');
    head.append(
      el('span', 'wn-item-app', n.app || t('wn_title', 'Notifications')),
      el('span', 'wn-item-time', fmtAge(n.at)),
    );
    txt.appendChild(head);
    const masked = wn().hide && !revealed.has(n.id);
    if (masked) {
      const b = el('div', 'wn-item-body is-masked', t('wn_hidden', 'Tap to show'));
      txt.appendChild(b);
      row.classList.add('is-tappable');
      row.addEventListener('click', () => { revealed.add(n.id); paint(); });
    } else {
      if (n.title) txt.appendChild(el('div', 'wn-item-title', n.title));
      if (n.body) txt.appendChild(el('div', 'wn-item-body', n.body));
    }
    row.appendChild(txt);
    // Per-app mute: one tap adds the app to the excluded list (the server prunes
    // and stops forwarding it); manageable from the muted-apps view.
    const muteKey = n.aumid || n.app;
    if (muteKey) {
      const mute = el('button', 'wn-item-mute');
      mute.type = 'button'; mute.title = t('wn_mute', 'Mute this app');
      mute.innerHTML = ICONS.bellOff;   // static, trusted SVG
      mute.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const cur = Array.isArray(wn().excluded) ? wn().excluded : [];
        if (!cur.some(e => e && e.id === muteKey)) {
          persist('excluded', cur.concat([{ id: muteKey, name: n.app || muteKey }]));
        }
        items = (items || []).filter(it => (it.aumid || it.app) !== muteKey);
        paint();
      });
      row.appendChild(mute);
    }
    return row;
  }

  // The muted-apps manager: excluded list with one-tap unmute.
  function paintMuted(list) {
    const backRow = el('button', 'wn-back');
    backRow.type = 'button';
    const bIco = el('span', 'wn-back-ico'); bIco.innerHTML = ICONS.back;   // static SVG
    backRow.append(bIco, el('span', '', t('wn_muted', 'Muted apps')));
    backRow.addEventListener('click', () => { view = 'feed'; paint(); });
    const frag = document.createDocumentFragment();
    frag.appendChild(backRow);
    const excluded = Array.isArray(wn().excluded) ? wn().excluded : [];
    if (!excluded.length) {
      frag.appendChild(el('div', 'wn-empty', t('wn_no_muted', 'No muted apps')));
    } else {
      excluded.forEach(e => {
        if (!e || !e.id) return;
        const row = el('div', 'wn-muted-row');
        row.appendChild(el('span', 'wn-muted-name', e.name || e.id));
        const un = el('button', 'wn-unmute', t('wn_unmute', 'Unmute'));
        un.type = 'button';
        un.addEventListener('click', () => {
          persist('excluded', excluded.filter(x => x && x.id !== e.id));
          paint();
        });
        row.appendChild(un);
        frag.appendChild(row);
      });
    }
    list.replaceChildren(frag);
  }

  function showState(list, msgKey, msgFb, opts) {
    const box = el('div', 'wn-state');
    const ico = el('span', 'wn-state-ico'); ico.innerHTML = ICONS.bell;   // static SVG
    box.append(ico, el('span', 'wn-state-txt', t(msgKey, msgFb)));
    if (opts && opts.hint) box.appendChild(el('span', 'wn-state-hint', t(opts.hint[0], opts.hint[1])));
    if (opts && opts.cta) {
      const b = el('button', 'wn-cta', t(opts.cta[0], opts.cta[1]));
      b.type = 'button';
      b.addEventListener('click', opts.onCta);
      box.appendChild(b);
    }
    list.replaceChildren(box);
  }

  function paintList(mount) {
    const list = mount.querySelector('.wn-list');
    if (!list) return;
    if (view === 'muted') { paintMuted(list); return; }
    const flags = wn();
    if (!flags.enabled) {
      showState(list, 'wn_off', 'Mirror your PC\'s notifications here', {
        hint: ['wn_off_hint', 'Read locally from Windows — nothing ever leaves this PC. Off by default.'],
        cta: ['wn_enable', 'Turn on'],
        onCta: () => { persist('enabled', true); items = null; paint(); },
      });
      return;
    }
    if (srvState === 'denied') {
      showState(list, 'wn_denied', 'Windows is blocking notification access', {
        hint: ['wn_denied_hint', 'Allow it in Windows Settings → Privacy & security → Notifications, then it reconnects on its own.'],
      });
      return;
    }
    if (srvState === 'unavailable') {
      showState(list, 'wn_unavailable', 'Not available on this Windows version');
      return;
    }
    if (items === null || srvState === 'starting' || srvState === 'off') {
      showState(list, 'wn_loading', 'Connecting…');
      return;
    }
    if (!items.length) {
      showState(list, 'wn_empty', 'No notifications — all caught up');
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach(n => frag.appendChild(notifRow(n)));
    list.replaceChildren(frag);
  }

  function paint() {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.notifications-widget-mount');
      if (!mount) return;
      ensure(mount);
      applyLabels(mount);
      const flags = wn();
      const on = !!flags.enabled;
      // Head controls only make sense while the feature is on.
      const ctl = mount.querySelector('.wn-ctl');
      if (ctl) ctl.hidden = !on;
      const hideBtn = mount.querySelector('.wn-hide-btn');
      if (hideBtn) {
        hideBtn.innerHTML = flags.hide ? ICONS.eyeOff : ICONS.eye;   // static, trusted SVG
        hideBtn.classList.toggle('is-on', !!flags.hide);
        hideBtn.title = t('wn_hide', 'Hide content until tapped');
      }
      const mutedBtn = mount.querySelector('.wn-muted-btn');
      if (mutedBtn) {
        const count = Array.isArray(flags.excluded) ? flags.excluded.length : 0;
        // innerHTML would wipe the count span → rebuild icon + count explicitly.
        mutedBtn.replaceChildren();
        const ic = el('span', 'wn-hbtn-ico'); ic.innerHTML = ICONS.bellOff;   // static SVG
        mutedBtn.appendChild(ic);
        if (count > 0) mutedBtn.appendChild(el('span', 'wn-muted-count', String(count)));
        mutedBtn.classList.toggle('is-on', view === 'muted');
      }
      paintList(mount);
    });
  }

  let seedInflight = false;
  async function seed() {
    if (!tiles().length || seedInflight) return;
    seedInflight = true;
    try {
      const d = await api('/notifications/windows');
      if (d && d.ok) {
        seedFlags = {
          enabled: !!d.enabled,
          hide: !!d.hide,
          toast: d.toast !== false,
          excluded: Array.isArray(d.excluded) ? d.excluded : [],
        };
        srvState = typeof d.state === 'string' ? d.state : 'off';
        items = Array.isArray(d.items) ? d.items.slice(0, FEED_MAX) : [];
        // Reconcile a client/server split. The enable flag is client-owned and
        // round-tripped, but a toggle saved against an OLDER server build (one
        // that didn't yet know windowsNotifications) never reached settings.json.
        // The client keeps the higher save-rev, so it never re-pushes on its own
        // and the tile hangs on "Connecting…" forever: the client wants it on, the
        // server has it off, so the reader is never started. Re-push once to make
        // the server persist it and start the reader, then let SSE take over.
        // Re-push on EVERY seed/self-heal until the server confirms — a one-shot
        // latch here left the tile stuck on "Connecting…" forever whenever the first
        // push missed (fired before hydration, dropped, or saved against an older
        // server build). It stops on its own once seedFlags.enabled comes back true.
        if (wn().enabled && !seedFlags.enabled
            && typeof updateWindowsNotifications === 'function') {
          updateWindowsNotifications('enabled', true);
        }
      } else if (items === null) items = [];
    } finally { seedInflight = false; }
    paint();
  }

  // SSE 'windows_notifications' — state change or full feed replacement (start,
  // stop, seed after a reader restart, exclusion prune).
  function onState(data) {
    if (!data || typeof data !== 'object') return;
    if (typeof data.state === 'string') srvState = data.state;
    if (Array.isArray(data.items)) items = data.items.slice(0, FEED_MAX);
    seedFlags = { ...seedFlags, enabled: !!data.enabled };
    paint();
  }

  // SSE 'windows_notification' — a single new toast; prepend + cap.
  function onItem(item) {
    if (!item || typeof item !== 'object') return;
    maybeToast(item);          // pop a transient toast (gated on the user's pref)
    if (items === null) items = [];
    items.unshift(item);
    if (items.length > FEED_MAX) items.length = FEED_MAX;
    srvState = 'allowed';   // an arriving item proves the reader is live
    paint();
  }

  function renderWidgets() {
    if (!tiles().length) { seeded = false; return; }
    paint();                                 // instant paint from cache
    if (!seeded) { seeded = true; seed(); }  // deduped across the multi-pass layout init
  }

  // Refresh just the relative-age labels of the existing rows — no full rebuild
  // (which would recreate every icon <img> + button + listener just to change "5m").
  // Rows are appended in `items` order, so index alignment holds.
  function refreshAges() {
    tiles().forEach(tile => {
      const rows = tile.querySelectorAll('.wn-item');
      rows.forEach((row, i) => {
        const at = items && items[i] && items[i].at;
        const timeEl = row.querySelector('.wn-item-time');
        if (timeEl && at) timeEl.textContent = fmtAge(at);
      });
    });
  }

  // Keep the relative ages fresh without re-fetching (visible tiles only).
  setInterval(() => {
    if (document.hidden || !tiles().length) return;
    if (items && items.length && view === 'feed') refreshAges();
  }, 30000);

  // Self-heal while stuck "connecting": if the feature is on but the reader never
  // reported in (server restarting, seed fetch failed, an old server without the
  // endpoint), re-seed. Backs off from 10s to once a minute so a permanently
  // endpoint-less server isn't polled every 10s forever. Resets once it answers.
  let _selfHealTries = 0;
  setInterval(() => {
    if (document.hidden || !tiles().length) return;
    if (wn().enabled && (srvState === 'off' || srvState === 'starting')) {
      _selfHealTries++;
      if (_selfHealTries <= 6 || _selfHealTries % 6 === 0) seed();   // 10s ×6, then every 60s
    } else {
      _selfHealTries = 0;
    }
  }, 10000);

  window.NotificationsWidget = { renderWidgets, onState, onItem };
})();
