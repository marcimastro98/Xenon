// How the fans tile reads a fan: the speeds its bands and spin are scaled against, the shape of a
// blade, the band a speed falls in, the name a fan goes by, and whether a header has no fan on it.
'use strict';

(() => {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

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

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="fans"]')).filter(n => n.closest('.pager-page, .layer-slot'));
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

  // Stable identity for renames: kind + the sensor's own (pre-rename) name.
  function fanKey(f) {
    return (f.kind || 'mb') + '|' + String(f.name || 'Fan');
  }

  function labelFor(f, labels) {
    const custom = labels[fanKey(f)];
    return (typeof custom === 'string' && custom) ? custom : (f.name || 'Fan');
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

  window.FansWidgetReadings = {
    t, SOFT_MAX_RPM, SOFT_MAX_PUMP_RPM, PUMP_RE, SPIN_SLOWEST_S, SPIN_FASTEST_S, SVG_NS, BLADE_COUNT,
    BLADE_PATH, tiles, bandClass, fanKey, labelFor, isDeadHeader,
  };
})();
