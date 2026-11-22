// The two faces made of readings (pump-face.html): Sensors (rings, bars or plain
// numbers, up to four readings) and Game (the frame rate large, two readings on
// side arcs, the song along the bottom). Joins window.PumpFaceKit; no global.
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;
  const RING_WIDTH = 4.2;
  // One or two rings keep a wide band; three or four share a thinner one near
  // the bezel, so the middle still holds every reading.
  const RING_SETS = {
    wide: { radii: [46, 39], width: RING_WIDTH },
    thin: { radii: [47, 42.6, 38.2, 33.8], width: 3.2 },
  };

  // The longest name of a face, which its CSS shrinks every name by alike ("Relógio da CPU").
  function fitNames(parent, names) {
    parent.style.setProperty('--llen', String(Math.max(8, ...names.map((n) => n.length))));
  }

  function valueLine(r, cls) {
    const line = Kit.el('div', cls);
    const num = Kit.el('span', 'pf-num', r ? r.text : '');
    const unit = Kit.el('span', 'pf-unit', r ? r.unit : '');
    line.append(num, unit);
    return {
      node: line,
      set(next) {
        num.textContent = next.text;
        unit.textContent = next.unit;
        line.dataset.tone = next.tone;
        line.classList.toggle('pf-none', next.value == null);
        // The value's length, which the rings' CSS shrinks a long one ("4.8", "100") by.
        line.style.setProperty('--len', String(Math.max(2, next.text.length)));
      },
    };
  }

  // On a screen under this size, or with big numbers (the line's look), three or four readings
  // do not fit side by side: the middle shows them one at a time and the ring it reads stands out.
  const SMALL_SCREEN = 360;
  const TURN_SECONDS = 4;

  // One reading in the middle of the rings: its name in its ring's colour over its value.
  function ringCell(cls) {
    const node = Kit.el('div', 'pf-ring-cell');
    const label = Kit.el('div', 'pf-ring-label');
    const v = valueLine(null, cls);
    node.append(label, v.node);
    let shown = 0;
    return {
      node,
      set(r, at) {
        if (at !== shown) { node.classList.remove('pf-slot-' + shown); node.classList.add('pf-slot-' + at); shown = at; }
        label.textContent = r.label;
        v.set(r);
      },
    };
  }

  // Rings: one arc per reading from the bezel inwards, and in the middle every reading the
  // same size with its name in its arc's colour, so the name, never the size, says which is
  // which. One alone is large, two stand side by side, three or four share a grid that keeps
  // clear of the innermost ring.
  function rings(root, readings) {
    const set = readings.length > 2 ? RING_SETS.thin : RING_SETS.wide;
    const turns = readings.length > 2 && (Math.min(innerWidth, innerHeight) < SMALL_SCREEN || root.classList.contains('pf-big'));
    root.classList.toggle('pf-rings-thin', set === RING_SETS.thin);
    root.classList.toggle('pf-rings-turns', turns);
    const box = Kit.svg('svg', { viewBox: '0 0 100 100', class: 'pf-rings', 'aria-hidden': 'true' });
    const arcs = readings.map((_, i) => Kit.gauge(box, { r: set.radii[i], width: set.width, slot: i + 1 }));
    const shown = turns ? 1 : readings.length;
    const mid = Kit.el('div', `pf-rings-mid pf-rings-n${shown}`);
    const cells = Array.from({ length: shown }, () => ringCell(shown === 1 ? 'pf-main pf-ring-value' : 'pf-ring-value'));
    mid.append(...cells.map((c) => c.node));
    root.append(box, mid);
    let turn = 0;
    let seconds = 0;
    let last = null;
    const paint = (system) => {
      last = system;
      const all = readings.map((name) => Kit.reading(name, system));
      fitNames(mid, all.map((r) => r.label));
      all.forEach((r, i) => {
        arcs[i].set(r.fraction, r.tone);
        arcs[i].mark(turns && i === turn);
        if (!turns) cells[i].set(r, i + 1);
        else if (i === turn) cells[0].set(r, i + 1);
      });
    };
    const tick = () => {
      if (!turns || !last) return;
      seconds = (seconds + 1) % TURN_SECONDS;
      if (seconds) return;
      turn = (turn + 1) % readings.length;
      paint(last);
    };
    return { update: paint, tick };
  }

  // Bars and numbers: the readings as rows (bars) or a grid (numbers), inside
  // the square that fits the round screen.
  function rows(root, readings, withBars) {
    const list = Kit.el('div', withBars ? 'pf-bars' : 'pf-grid');
    list.dataset.count = String(readings.length);
    const cells = readings.map((_, i) => {
      const cell = Kit.el('div', `pf-cell pf-slot-${i + 1}`);
      const label = Kit.el('div', 'pf-label');
      const v = valueLine(null, 'pf-cell-value');
      cell.append(label, v.node);
      let bar = null;
      if (withBars) {
        const track = Kit.el('div', 'pf-bar');
        bar = Kit.el('div', 'pf-bar-fill');
        track.append(bar);
        cell.append(track);
      }
      list.append(cell);
      return { label, v, bar };
    });
    root.append(list);
    const update = (system) => {
      readings.forEach((name, i) => {
        const r = Kit.reading(name, system);
        cells[i].label.textContent = r.label;
        cells[i].v.set(r);
        if (cells[i].bar) {
          cells[i].bar.style.transform = `scaleX(${r.fraction.toFixed(3)})`;
          cells[i].bar.dataset.tone = r.tone;
        }
      });
    };
    return { update };
  }

  Kit.add('face', 'sensors', (root, opts) => {
    root.classList.add('pf-face-sensors', `pf-style-${opts.style}`);
    const readings = opts.readings.length ? opts.readings : ['cpuTemp'];
    const face = opts.style === 'rings' ? rings(root, readings) : rows(root, readings, opts.style === 'bars');
    return { update: (data) => face.update(data.system), tick: face.tick };
  });

  // Game: the frame rate is the one number that matters while playing.
  Kit.add('face', 'game', (root, opts) => {
    root.classList.add('pf-face-game');
    const [first, ...side] = opts.readings.length ? opts.readings : ['fps'];
    const box = Kit.svg('svg', { viewBox: '0 0 100 100', class: 'pf-rings', 'aria-hidden': 'true' });
    const arcs = side.slice(0, 2).map((_, i) => Kit.gauge(box, {
      r: 46, width: RING_WIDTH, start: i === 0 ? 200 : 40, sweep: 120, slot: i + 2,
    }));
    const mid = Kit.el('div', 'pf-game-mid');
    const main = valueLine(null, 'pf-main pf-main-xl');
    const label = Kit.el('div', 'pf-label');
    const sides = Kit.el('div', 'pf-game-sides');
    const sideCells = side.slice(0, 2).map((_, i) => {
      const cell = Kit.el('div', `pf-game-side pf-slot-${i + 2}`);
      const l = Kit.el('div', 'pf-ring-label');
      const v = valueLine(null, 'pf-rest-value');
      cell.append(l, v.node);
      sides.append(cell);
      return { v, l };
    });
    const track = Kit.el('div', 'pf-game-track');
    mid.append(main.node, label, sides);
    root.append(box, mid, track);
    return {
      update(data) {
        const r = Kit.reading(first, data.system);
        main.set(r);
        label.textContent = r.label;
        const shown = side.slice(0, 2).map((name) => Kit.reading(name, data.system));
        fitNames(sides, shown.map((s) => s.label));
        shown.forEach((s, i) => {
          arcs[i].set(s.fraction, s.tone);
          sideCells[i].v.set(s);
          sideCells[i].l.textContent = s.label;
        });
        const m = data.media;
        const playing = opts.track && m && m.playbackStatus === 'Playing' && m.title;
        track.textContent = playing ? [m.title, m.artist].filter(Boolean).join('  /  ') : '';
        track.hidden = !playing;
      },
    };
  });
})();
