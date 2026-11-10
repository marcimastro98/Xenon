'use strict';
// Settings → Performance → Sensor history → "One sample every": how often the
// history takes a sample (sensorHistory.everyMin, js/sensor-history.js). Shown
// only while history is being collected. A shorter interval shows short spikes
// in the 6h chart; the disk is still written at most every 5 minutes.
(function () {
  const el = makeEl;
  const t = (k, fb) => {
    const v = typeof window.t === 'function' ? window.t(k) : '';
    return v && v !== k ? v : fb;
  };

  let seg = null;

  function historyOn() {
    return typeof window.systemHistoryAvailable === 'function'
      ? !!window.systemHistoryAvailable()
      : !!(hubSettings && hubSettings.sensorHistory && hubSettings.sensorHistory.enabled === true);
  }

  function every() {
    return window.SensorHistory.normalizeSensorHistory(hubSettings && hubSettings.sensorHistory).everyMin;
  }

  function choose(n) {
    const cur = window.SensorHistory.normalizeSensorHistory(hubSettings.sensorHistory);
    if (cur.everyMin === n) return;
    hubSettings = normalizeSettings({ ...hubSettings, sensorHistory: { ...cur, everyMin: n } });
    saveHubSettings();
    sync();
    if (typeof setSettingsStatus === 'function') setSettingsStatus('settings_saved', 'ok');
  }

  function build(host) {
    const label = el('span', 'settings-label-line');
    label.append(el('span', '', t('settings_senshist_every', 'One sample every')));
    seg = el('div', 'settings-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', t('settings_senshist_every', 'One sample every'));
    for (const n of window.SensorHistory.EVERY_MIN_CHOICES) {
      const b = el('button', 'settings-seg-btn', t('settings_senshist_every_n', '{n} min').replace('{n}', String(n)));
      b.type = 'button';
      b.dataset.every = String(n);
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => choose(n));
      seg.appendChild(b);
    }
    host.replaceChildren(label, seg);
  }

  // Called from syncSensorHistoryControls (js/settings.js) on every Settings render.
  function sync() {
    const host = document.getElementById('settings-senshist-every');
    if (!host || !window.SensorHistory) return;
    host.hidden = !historyOn();
    if (host.hidden) return;
    if (!seg || !host.contains(seg)) build(host);
    const n = every();
    seg.querySelectorAll('.settings-seg-btn').forEach((b) => {
      const on = Number(b.dataset.every) === n;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  window.SensorHistoryEvery = { sync };
})();
