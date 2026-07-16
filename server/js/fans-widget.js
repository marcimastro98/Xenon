'use strict';
// Fans widget — read-only RPM of every fan the sensors expose: CPU/chassis
// headers and AIO/hub controllers via LibreHardwareMonitor, the GPU's own fans,
// and a digital PSU's fan. Rides the SSE 'system' event and seeds once from
// GET /system. Fan names come from hardware — textContent only.
//
// One row per fan, in the same visual language as the Battery widget: a small
// impeller that actually spins at a rate tracking its reading, the name, a thin
// speed bar and the RPM. Rows are grouped by where the fan physically is
// (motherboard headers / hub-AIO / graphics card / PSU) because "Fan #3" alone
// identifies nothing — and since only the user knows what's plugged into which
// header, tapping a name renames it (persisted via fanLabels in settings).
//
// The spin is a `transform: rotate` @keyframes — compositable, so it costs the
// GPU compositor and not the main thread — and being an INFINITE animation it
// is paused automatically by js/ambient-idle.js when the user walks away, and
// completed-and-stopped by body.perf-mode. Nothing to wire up here.
(function () {
  const el = makeEl;        // shared DOM factory (utils.js)
  const api = apiJson;      // fetch → JSON, null on failure (utils.js)
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  let fans = null;          // null = not seeded yet; [] = seeded, nothing reported
  let access = null;        // 'ok' | 'needs_admin' | 'missing' — why fans are absent
  let seeded = false, seedInflight = false;
  let lastSig = '';         // skip repaints when the readings didn't change
  let editingKey = null;    // fan being renamed — repaints hold off so the input survives

  // The one hint that matches reality. LHM is installed by the Xenon installer,
  // so "install it" is the wrong advice for the common case: unelevated, its
  // kernel driver never loads and the fan headers stay invisible.
  // 'needs_admin' is repairable in place, so the hint carries the button that
  // repairs it (SensorAccess). 'missing' is not — LHM genuinely isn't there.
  function hintNode(cls) {
    if (access === 'needs_admin') {
      return SensorAccess.hintNode(t('fans_hint_admin', 'Fan speeds can’t be read: Windows protects your PC’s sensors, and Xenon needs your permission.'), cls);
    }
    return el('div', cls, t('fans_hint_lhm', 'Reading fan speeds needs LibreHardwareMonitor, which the Xenon installer sets up. Re-run INSTALL.bat.'));
  }

  // Reference speeds the colour bands, bar and spin rate are scaled against:
  // case/CPU fans cruise at 600–1600 RPM, so 2200 puts a normal system in the
  // calm-to-warm range and reserves the top bands for a fan really working.
  // Pumps are different machines: 2000–3000 RPM is their idle, so anything the
  // hardware (or the user's rename) calls a pump scales against 4800 — without
  // this, a healthy AIO pump reads permanently red.
  const SOFT_MAX_RPM = 2200;
  const SOFT_MAX_PUMP_RPM = 4800;
  const PUMP_RE = /pump|pompa/i;

  // Visual speed is NOT real speed: 2400 RPM is 40 revolutions per second, which
  // renders as a strobing blur (and reads as noise, not speed). The reading is
  // mapped onto a legible seconds-per-revolution range instead, so "faster" stays
  // perceptible at a glance across the whole scale.
  const SPIN_SLOWEST_S = 2.6;
  const SPIN_FASTEST_S = 0.32;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BLADE_COUNT = 7;
  // One blade: a broad, swept petal from the hub to the rim, leaning into its
  // direction of travel. Rotated BLADE_COUNT times around (50,50) to form the
  // impeller. Seven broad petals keep real gaps between them, which is what
  // makes the spin legible at the ~24px this glyph renders at in a row.
  const BLADE_PATH = 'M50 50 C 47 34, 48 20, 55 12 A38 38 0 0 1 71 18.5 C 66 32, 58 43, 50 50 Z';

  function svgEl(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="fans"]')).filter(n => n.closest('.pager-page'));
  }

  // Colour band by how hard the fan is working — the scale users already read on
  // thermometers and RPM gauges: calm green → yellow → orange → red — violet for
  // a fan at full tilt. A stopped fan is deliberately colourless.
  function bandClass(ratio, stopped) {
    if (stopped) return 'is-off';
    if (ratio < 0.35) return 'is-calm';
    if (ratio < 0.55) return 'is-mid';
    if (ratio < 0.70) return 'is-warm';
    if (ratio < 0.86) return 'is-hot';
    return 'is-max';
  }

  function fanGlyph() {
    const svg = svgEl('svg', { viewBox: '0 0 100 100', class: 'fanw-glyph', 'aria-hidden': 'true' });
    svg.appendChild(svgEl('circle', { cx: '50', cy: '50', r: '45', class: 'fanw-ring' }));
    const blades = svgEl('g', { class: 'fanw-blades' });
    for (let i = 0; i < BLADE_COUNT; i++) {
      blades.appendChild(svgEl('path', { d: BLADE_PATH, transform: `rotate(${(360 / BLADE_COUNT) * i} 50 50)` }));
    }
    svg.appendChild(blades);
    svg.appendChild(svgEl('circle', { cx: '50', cy: '50', r: '10', class: 'fanw-hub' }));
    return svg;
  }

  // Stable identity for renames: kind + the sensor's own (pre-rename) name.
  function fanKey(f) {
    return (f.kind || 'mb') + '|' + String(f.name || 'Fan');
  }

  function labelFor(f, labels) {
    const custom = labels[fanKey(f)];
    return (typeof custom === 'string' && custom) ? custom : (f.name || 'Fan');
  }

  // Swap the name into an input, in place. Enter/blur commits, Escape cancels;
  // an emptied field deletes the custom label (back to the sensor name).
  function startRename(row, f, labels) {
    if (editingKey) return;
    editingKey = fanKey(f);
    const nameLine = row.querySelector('.fanw-name-line');
    const input = el('input', 'fanw-rename');
    input.type = 'text';
    input.maxLength = 32;
    input.value = labels[editingKey] || '';
    input.placeholder = f.name || 'Fan';
    input.setAttribute('aria-label', t('fans_rename', 'Rename fan'));
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit && typeof window.setFanLabel === 'function') window.setFanLabel(editingKey, input.value);
      editingKey = null;
      paint();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    nameLine.replaceChildren(input);
    // The name is not only a label: a fan called "pump"/"pompa" is scaled against
    // a pump's own range (see SOFT_MAX_PUMP_RPM), which is the ONLY signal we
    // have — a board that names its header "Fan #1" never says it drives a pump.
    // That coupling is invisible unless we say it, exactly where it applies.
    if (!row.querySelector('.fanw-rename-hint')) {
      row.appendChild(el('div', 'fanw-rename-hint', t('fans_rename_hint', 'Name it “pump” if it drives the AIO pump — it is then read on a pump’s speed range.')));
    }
    input.focus();
    input.select();
  }

  function fanRow(f, labels) {
    // A fan reports rpm OR pct, never both: LHM gives real RPM, nvidia-smi only
    // a percentage. Keep the unit honest.
    const rpm = (f.rpm == null || f.rpm === '') ? null : Number(f.rpm);
    const pct = (f.pct == null || f.pct === '') ? null : Number(f.pct);
    const hasRpm = Number.isFinite(rpm);
    const hasPct = !hasRpm && Number.isFinite(pct);
    const shownName = labelFor(f, labels);
    const isPump = PUMP_RE.test(shownName) || PUMP_RE.test(String(f.name || ''));
    const maxRpm = isPump ? SOFT_MAX_PUMP_RPM : SOFT_MAX_RPM;
    const ratio = hasPct ? pct / 100 : (hasRpm ? rpm / maxRpm : 0);
    const clamped = Math.min(1, Math.max(0, ratio));
    const stopped = (hasRpm && rpm === 0) || (hasPct && pct === 0) || (!hasRpm && !hasPct);

    const row = el('div', 'fanw-row ' + bandClass(clamped, stopped));
    if (!stopped) {
      const secs = SPIN_SLOWEST_S - (SPIN_SLOWEST_S - SPIN_FASTEST_S) * clamped;
      row.style.setProperty('--fanw-dur', (Math.round(secs * 100) / 100) + 's');
    }

    row.appendChild(fanGlyph());

    const body = el('div', 'fanw-body');
    const nameLine = el('div', 'fanw-name-line');
    const nameBtn = el('button', 'fanw-name');
    nameBtn.type = 'button';
    nameBtn.title = t('fans_rename', 'Rename fan');
    nameBtn.appendChild(el('span', 'fanw-name-text', shownName));
    // Pencil = the visible "you can rename this" affordance (touch has no hover).
    nameBtn.appendChild(el('span', 'fanw-pencil', '✎'));
    nameBtn.addEventListener('click', () => startRename(row, f, labels));
    nameLine.appendChild(nameBtn);
    body.appendChild(nameLine);

    const bar = el('div', 'fanw-bar');
    const fill = el('div', 'fanw-bar-fill');
    fill.style.width = Math.round(clamped * 100) + '%';
    bar.appendChild(fill);
    body.appendChild(bar);
    row.appendChild(body);

    const val = el('div', 'fanw-val');
    if (hasRpm) val.append(el('b', null, String(Math.round(rpm))), el('span', 'fanw-unit', 'RPM'));
    else if (hasPct) val.append(el('b', null, String(Math.round(pct))), el('span', 'fanw-unit', '%'));
    else val.append(el('b', null, '—'));
    row.appendChild(val);
    return row;
  }

  // A motherboard header reporting 0 RPM is AMBIGUOUS. The board enumerates every
  // header it physically has — plugged or not — so 0 means "no tachometer signal":
  // an EMPTY socket, or a fan that stopped. Drawing it as a fan named "Fan #2"
  // invents hardware the user may not own, which is what made a 6-header board
  // read as "6 fans, 3 broken" to someone who owns 9 fans on an iCUE Link hub.
  // These collapse into one quiet line instead.
  //
  // GPU and PSU fans are NOT ambiguous — their sensor exists because the fan
  // exists — so a 0 there is a genuinely stopped fan (idle zero-RPM mode) and
  // stays a full row. Same for a hub/AIO channel, which reports what it drives.
  function isDeadHeader(f) {
    return f && f.rpm != null && Number(f.rpm) === 0;
  }

  function view(mount) {
    const wrap = el('div', 'fanw-wrap');
    const head = el('div', 'fanw-head');
    head.appendChild(el('span', 'fanw-title', t('layout_widget_fans', 'Fans')));
    const countSlot = el('span', 'fanw-count');
    head.appendChild(countSlot);
    wrap.appendChild(head);

    if (fans === null) {
      countSlot.remove();
      wrap.appendChild(el('div', 'fanw-state', t('fans_loading', 'Reading sensors…')));
    } else if (!fans.length) {
      countSlot.remove();
      const empty = el('div', 'fanw-state');
      empty.append(el('div', null, t('fans_empty', 'No fan sensors detected')));
      empty.appendChild(hintNode('fanw-state-hint'));
      wrap.appendChild(empty);
    } else {
      const labels = (typeof window.getFanLabels === 'function') ? window.getFanLabels() : {};
      // Grouped by where the fan physically is, because "Fan #3" alone tells the
      // user nothing about which fan it is. The board names its headers by
      // number and cannot know what is plugged into them, so the origin is the
      // most honest default label — and the rename fills in the rest.
      const gpu = fans.filter(f => f && f.kind === 'gpu');
      const psu = fans.filter(f => f && f.kind === 'psu');
      const ctrl = fans.filter(f => f && f.kind === 'ctrl');
      // Anything the server didn't tag is a motherboard header — the collector's
      // default — so unknown kinds land here rather than vanishing from the tile.
      const mbAll = fans.filter(f => f && f.kind !== 'gpu' && f.kind !== 'psu' && f.kind !== 'ctrl');
      const mb = mbAll.filter(f => !isDeadHeader(f));
      const silent = mbAll.filter(isDeadHeader);
      const groups = [
        { key: 'mb', titleKey: 'fans_group_mb', fallback: 'Motherboard', list: mb },
        { key: 'ctrl', titleKey: 'fans_group_ctrl', fallback: 'Hub / AIO', list: ctrl },
        { key: 'gpu', titleKey: 'fans_group_gpu', fallback: 'Graphics card', list: gpu },
        { key: 'psu', titleKey: 'fans_group_psu', fallback: 'Power supply', list: psu },
      ].filter(g => g.list.length);

      // Count what is actually shown as a fan — counting silent headers is what
      // made the badge claim 9 next to 6 visible readings.
      const shown = groups.reduce((n, g) => n + g.list.length, 0);
      if (shown) countSlot.textContent = String(shown); else countSlot.remove();

      const body = el('div', 'fanw-scroll');
      groups.forEach(g => {
        const sect = el('div', 'fanw-group');
        // With one source the heading is just a label for the obvious — the tile
        // title already says "Fans". It earns its space only when it separates.
        if (groups.length > 1) sect.appendChild(el('div', 'fanw-group-title', t(g.titleKey, g.fallback)));
        const grid = el('div', 'fanw-grid');
        g.list.forEach(f => grid.appendChild(fanRow(f, labels)));
        sect.appendChild(grid);
        body.appendChild(sect);
      });
      if (!shown) {
        body.appendChild(el('div', 'fanw-state', t('fans_empty', 'No fan sensors detected')));
      }
      wrap.appendChild(body);

      if (silent.length) {
        const names = silent.map(f => labelFor(f, labels)).join(', ');
        const line = el('div', 'fanw-silent');
        line.append(
          el('span', 'fanw-silent-label', t('fans_silent', 'No signal')),
          el('span', 'fanw-silent-names', names),
        );
        line.title = t('fans_silent_why', 'The board lists every fan header it has, connected or not — these report nothing: an empty socket, or a fan that is stopped.');
        wrap.appendChild(line);
      }

      // The sensors only see fans wired to a header or a supported hub: fans on
      // an unsupported controller (e.g. iCUE Link) or doubled on a splitter
      // can't report. Users count the fans in their case and come up short —
      // say why once, quietly, instead of leaving them to guess.
      if (mbAll.length) wrap.appendChild(el('div', 'fanw-note', t('fans_note_headers', 'Fans on an unsupported hub or sharing a splitter don’t report a speed of their own, so they can’t be shown.')));
      // Only the GPU reports its own fan: the CPU/chassis headers need LHM. Say
      // why they're missing instead of leaving a near-empty tile unexplained.
      if (!mbAll.length) wrap.appendChild(hintNode('fanw-foot-hint'));
    }
    mount.replaceChildren(wrap);
  }

  function paint() {
    // A rename is open — don't yank the input away. But if the input is gone
    // from the DOM (the tile was torn down by a layout rebuild, which fires no
    // blur), the guard must self-heal or it would block repaints forever.
    if (editingKey) {
      if (document.querySelector('.fanw-rename')) return;
      editingKey = null;
    }
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
      if (d) access = d.sensorAccess || null;
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
  // Rebuilding would also restart every spin animation from 0°.
  function onSSE(d) {
    if (!d || !Array.isArray(d.fans)) return;
    const sig = JSON.stringify([d.fans, d.sensorAccess || null]);
    if (sig === lastSig && fans !== null) return;
    lastSig = sig;
    access = d.sensorAccess || null;
    fans = d.fans;
    paint();
  }

  window.FansWidget = { renderWidgets, onSSE };
})();
