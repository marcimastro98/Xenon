// The two faces made of readings (pump-face.html): Sensors (on the drop, as bars or as plain
// numbers, up to four readings) and Game (the frame rate large on the drop, two readings under
// it, then the song). Joins window.PumpFaceKit; no global.
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;

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
        // The value's length, which the CSS shrinks a long one ("4.8", "100") by.
        line.style.setProperty('--len', String(Math.max(2, next.text.length)));
      },
    };
  }

  // A reading under the large one: its name, then its value, on one line.
  function restCell(cls) {
    const node = Kit.el('div', cls);
    const name = Kit.el('span', 'pf-drop-name');
    const v = valueLine(null, 'pf-rest-value');
    node.append(name, v.node);
    return { node, set(r) { name.textContent = r.label; v.set(r); } };
  }

  // On the drop (face-drop.js): the first reading large with its name over it, the others under
  // it one to a line. The drop takes the colour of the hottest and the pace of the busiest.
  function dropped(root, readings) {
    const drop = Kit.get('part', 'drop')(root);
    const mid = Kit.el('div', `pf-drop-mid pf-drop-ink pf-drop-n${readings.length}`);
    const label = Kit.el('div', 'pf-drop-label');
    const main = valueLine(null, 'pf-main pf-drop-value');
    const rest = readings.slice(1).map(() => restCell('pf-drop-cell'));
    mid.append(label, main.node, ...rest.map((c) => c.node));
    root.append(mid);
    return {
      update(system) {
        const all = readings.map((name) => Kit.reading(name, system));
        label.textContent = all[0].label;
        main.set(all[0]);
        rest.forEach((c, i) => { c.set(all[i + 1]); });
        drop.set(all);
      },
    };
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
    // 'rings' is the drop: the name stays from the rings it drew before, so a saved line keeps it.
    const face = opts.style === 'rings' ? dropped(root, readings) : rows(root, readings, opts.style === 'bars');
    return { update: (data) => face.update(data.system) };
  });

  // Game: the frame rate is the one number that matters while playing, large on the drop.
  Kit.add('face', 'game', (root, opts) => {
    root.classList.add('pf-face-game');
    const [first, ...more] = opts.readings.length ? opts.readings : ['fps'];
    const side = more.slice(0, 2);
    const drop = Kit.get('part', 'drop')(root);
    const mid = Kit.el('div', 'pf-game-mid pf-drop-mid pf-drop-ink');
    const main = valueLine(null, 'pf-main pf-drop-value pf-game-value');
    const label = Kit.el('div', 'pf-label');
    const sides = side.map(() => restCell('pf-drop-cell pf-game-side'));
    mid.append(main.node, label, ...sides.map((c) => c.node));
    // The song is the last line on the drop, in its ink: under it, the drop's edge would cut it.
    const track = Kit.el('div', 'pf-game-track');
    mid.append(track);
    root.append(mid);
    return {
      update(data) {
        const r = Kit.reading(first, data.system);
        main.set(r);
        label.textContent = r.label;
        const shown = side.map((name) => Kit.reading(name, data.system));
        shown.forEach((s, i) => { sides[i].set(s); });
        drop.set([r, ...shown]);
        const m = data.media;
        // An app heard with no song of its own (media-read.js stand-in) is not a song to show.
        const playing = opts.track && m && m.playbackStatus === 'Playing' && m.title && !(m.fallback === true && m.title === m.app);
        track.textContent = playing ? [m.title, m.artist].filter(Boolean).join('  /  ') : '';
        track.hidden = !playing;
      },
    };
  });
})();
