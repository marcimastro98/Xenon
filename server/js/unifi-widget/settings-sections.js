// The Layout and Notifications sections of the camera settings card, and the row of buttons they
// are made of.
'use strict';

(() => {
  const { ASPECT_CSS, DEFAULT_REFRESH_MS } = window.UnifiWidgetCameraLayout;

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   // user-visible text → textContent
    return n;
  }

  // Push the just-saved layout to any live tile without waiting for a settings poll.
  function notifyLayout() {
    try { if (window.UnifiProtect && window.UnifiProtect.applyLayout) window.UnifiProtect.applyLayout(); } catch (e) { /* ignore */ }
  }

  // A labelled segmented control: [ Auto | 1 | 2 | … ]. onPick gets the raw value.
  function buildSegment(labelText, options, current, onPick) {
    const row = el('div', 'sh-set-row');
    row.appendChild(el('span', 'sh-set-label', labelText));
    const seg = el('div', 'settings-segmented');
    const btns = [];
    options.forEach((o) => {
      const b = el('button', 'settings-segment-btn', o.label);
      b.type = 'button';
      if (String(o.value) === String(current)) b.classList.add('active');
      b.addEventListener('click', () => {
        btns.forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        onPick(o.value);
      });
      btns.push(b);
      seg.appendChild(b);
    });
    row.appendChild(seg);
    return row;
  }

  function buildLayoutSection(u) {
    const wrap = el('section', 'settings-section');
    wrap.appendChild(el('div', 'settings-section-title', t('unifi_layout', 'Layout')));
    wrap.appendChild(buildSegment(
      t('unifi_columns', 'Columns'),
      [{ value: 0, label: t('unifi_auto', 'Auto') }, { value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' }, { value: 4, label: '4' }],
      Number(u.columns) || 0,
      (v) => { if (window.setUnifiSettings) window.setUnifiSettings({ columns: v }); notifyLayout(); }
    ));
    wrap.appendChild(buildSegment(
      t('unifi_fit', 'Image'),
      [{ value: 'cover', label: t('unifi_fit_fill', 'Fill') }, { value: 'contain', label: t('unifi_fit_fit', 'Fit') }],
      u.fit === 'contain' ? 'contain' : 'cover',
      (v) => { if (window.setUnifiSettings) window.setUnifiSettings({ fit: v }); notifyLayout(); }
    ));
    wrap.appendChild(buildSegment(
      t('unifi_aspect', 'Aspect'),
      [{ value: '16:9', label: '16:9' }, { value: '4:3', label: '4:3' }, { value: '1:1', label: '1:1' }],
      ASPECT_CSS[u.aspect] ? u.aspect : '16:9',
      (v) => { if (window.setUnifiSettings) window.setUnifiSettings({ aspect: v }); notifyLayout(); }
    ));
    wrap.appendChild(buildSegment(
      t('unifi_refresh', 'Update rate'),
      [{ value: 1500, label: '1.5s' }, { value: 3000, label: '3s' }, { value: 5000, label: '5s' }, { value: 10000, label: '10s' }],
      Number(u.refreshMs) || DEFAULT_REFRESH_MS,
      (v) => { if (window.setUnifiSettings) window.setUnifiSettings({ refreshMs: v }); notifyLayout(); }
    ));
    const hint = el('div', 'sh-set-hint', t('unifi_angle_hint', 'Tip: tap a camera to enlarge it, then rotate or mirror the view.'));
    wrap.appendChild(hint);
    return wrap;
  }

  // Camera notifications: a master toggle + per-kind checkboxes + a cooldown. All
  // persisted in settings.unifi.notify; the server opens its updates WebSocket only
  // while a tile is on screen AND this is enabled. Toasts additionally follow the
  // global Notifiche switch (noted in the hint).
  const NOTIFY_KINDS = [
    ['person', 'unifi_kind_person', 'Person'], ['vehicle', 'unifi_kind_vehicle', 'Vehicle'],
    ['package', 'unifi_kind_package', 'Package'], ['animal', 'unifi_kind_animal', 'Animal'],
    ['motion', 'unifi_kind_motion', 'Motion'], ['ring', 'unifi_kind_ring', 'Doorbell'],
  ];

  function buildNotifySection(u) {
    const src = (u.notify && typeof u.notify === 'object') ? u.notify : {};
    const srcTypes = (src.types && typeof src.types === 'object') ? src.types : {};
    const cur = { enabled: src.enabled === true, types: {}, cooldownSec: Number(src.cooldownSec) || 45 };
    NOTIFY_KINDS.forEach(([k]) => { cur.types[k] = srcTypes[k] === true; });
    const save = () => { if (window.setUnifiSettings) window.setUnifiSettings({ notify: { enabled: cur.enabled, types: { ...cur.types }, cooldownSec: cur.cooldownSec } }); };

    const wrap = el('section', 'settings-section');
    wrap.appendChild(el('div', 'settings-section-title', t('unifi_notify', 'Notifications')));

    // What to tell about shows only while telling is on.
    const body = el('div', 'settings-toggle-grid');
    const toggle = (text, hint, checked, onChange) => {
      const row = el('label', 'settings-toggle-row');
      const cb = el('input', 'settings-check'); cb.type = 'checkbox'; cb.checked = checked;
      const line = el('span', 'settings-label-line');
      line.appendChild(el('span', '', text));
      if (hint) line.appendChild(el('span', 'settings-hint', hint));
      row.append(cb, line);
      cb.addEventListener('change', () => onChange(cb.checked));
      return row;
    };

    wrap.appendChild(toggle(t('unifi_notify_enable', 'Notify me on camera activity'), t('unifi_notify_hint', 'Needs a camera with smart detections. Pop-ups also follow the global Notifications switch.'), cur.enabled, (on) => {
      cur.enabled = on;
      body.hidden = !on;
      save();
    }));

    NOTIFY_KINDS.forEach(([k, key, fb]) => {
      body.appendChild(toggle(t(key, fb), '', cur.types[k], (on) => { cur.types[k] = on; save(); }));
    });
    body.appendChild(buildSegment(
      t('unifi_notify_cooldown', 'Min. gap'),
      [{ value: 15, label: '15s' }, { value: 30, label: '30s' }, { value: 45, label: '45s' }, { value: 60, label: '1m' }, { value: 120, label: '2m' }],
      cur.cooldownSec,
      (v) => { cur.cooldownSec = Number(v) || 45; save(); }
    ));
    body.hidden = !cur.enabled;
    wrap.appendChild(body);
    return wrap;
  }

  window.UnifiWidgetSettingsSections = {
    t, el, notifyLayout, buildLayoutSection, NOTIFY_KINDS, buildNotifySection,
  };
})();
