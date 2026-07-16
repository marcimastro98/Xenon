'use strict';
// Fans widget — read-only RPM of every fan the sensors expose: CPU/chassis
// headers via LibreHardwareMonitor and the GPU fan (RPM from LHM, or a percent
// from nvidia-smi — rendered unit-aware). Rides the SSE 'system' event and
// seeds once from GET /system. Fan names come from hardware — textContent only.
(function () {
  const el = makeEl;        // shared DOM factory (utils.js)
  const api = apiJson;      // fetch → JSON, null on failure (utils.js)
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  let fans = null;          // null = not seeded yet; [] = seeded, nothing reported
  let seeded = false, seedInflight = false;
  let lastSig = '';         // skip repaints when the readings didn't change

  // Bar scale: typical case/CPU fans cruise at 600–1600 RPM, so a soft max
  // keeps the bars readable; anything faster simply pegs the bar.
  const SOFT_MAX_RPM = 2200;

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="fans"]')).filter(n => n.closest('.pager-page'));
  }

  function fanRow(f) {
    const rpm = Number(f.rpm);
    const pct = Number(f.pct);
    const hasRpm = Number.isFinite(rpm);
    const hasPct = !hasRpm && Number.isFinite(pct);
    const row = el('div', 'fw-row');

    const head = el('div', 'fw-row-head');
    head.appendChild(el('span', 'fw-name', f.name || 'Fan'));
    const val = el('span', 'fw-val');
    if (hasRpm) { val.append(el('b', null, String(Math.round(rpm))), el('span', 'fw-unit', 'RPM')); }
    else if (hasPct) { val.append(el('b', null, String(Math.round(pct))), el('span', 'fw-unit', '%')); }
    else { val.append(el('b', null, '—')); }
    head.appendChild(val);
    row.appendChild(head);

    const ratio = hasPct ? Math.min(1, Math.max(0, pct / 100)) : Math.min(1, Math.max(0, (hasRpm ? rpm : 0) / SOFT_MAX_RPM));
    const bar = el('div', 'fw-bar');
    const fill = el('div', 'fw-bar-fill');
    fill.style.width = Math.round(ratio * 100) + '%';
    bar.appendChild(fill);
    row.appendChild(bar);
    if ((hasRpm && rpm === 0) || (hasPct && pct === 0)) row.classList.add('is-idle');
    return row;
  }

  function view(mount) {
    const wrap = el('div', 'fw-wrap');
    const head = el('div', 'fw-head');
    head.appendChild(el('span', 'fw-title', t('layout_widget_fans', 'Fans')));
    if (Array.isArray(fans) && fans.length) head.appendChild(el('span', 'fw-count', String(fans.length)));
    wrap.appendChild(head);

    const list = el('div', 'fw-list');
    if (fans === null) {
      list.appendChild(el('div', 'fw-state', t('fans_loading', 'Reading sensors…')));
    } else if (!fans.length) {
      const empty = el('div', 'fw-state');
      empty.append(el('div', null, t('fans_empty', 'No fan sensors detected')));
      empty.append(el('div', 'fw-state-hint', t('fans_hint_lhm', 'Fan RPM needs LibreHardwareMonitor (installed by the Xenon installer).')));
      list.appendChild(empty);
    } else {
      fans.forEach(f => list.appendChild(fanRow(f)));
      // Only the GPU reports its own fan: the CPU/chassis headers need LHM. Say
      // why they're missing instead of leaving a near-empty tile unexplained.
      if (!fans.some(f => f && f.kind !== 'gpu')) {
        list.appendChild(el('div', 'fw-foot-hint', t('fans_hint_lhm', 'Fan RPM needs LibreHardwareMonitor (installed by the Xenon installer).')));
      }
    }
    wrap.appendChild(list);
    mount.replaceChildren(wrap);
  }

  function paint() {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.fans-widget-mount');
      if (mount) view(mount);
    });
  }

  async function seed() {
    if (!tiles().length || seedInflight) return;
    seedInflight = true;
    try {
      const d = await api('/system');
      if (d && Array.isArray(d.fans)) fans = d.fans;
      else if (fans === null) fans = [];
    } finally { seedInflight = false; }
    paint();
  }

  function renderWidgets() {
    if (!tiles().length) { seeded = false; return; }
    paint();
    if (!seeded) { seeded = true; seed(); }
  }

  // The 'system' event fires every 7s — skip the DOM rebuild when the RPM
  // readings didn't actually change (fans at steady speed, or none at all).
  function onSSE(d) {
    if (!d || !Array.isArray(d.fans)) return;
    const sig = JSON.stringify(d.fans);
    if (sig === lastSig && fans !== null) return;
    lastSig = sig;
    fans = d.fans;
    paint();
  }

  window.FansWidget = { renderWidgets, onSSE };
})();
