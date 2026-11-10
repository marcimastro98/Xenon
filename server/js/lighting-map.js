// Lighting map: one device drawn as its real parts (each fan a ring of its LEDs,
// the pump, RAM sticks, strips, a keyboard from its LED positions), where the
// user picks LEDs — a tap, a drag across several, or a part's name for all of
// it — and gives them a colour, an effect, or back to Xenon. The editor for the
// chosen LEDs appears only while something is chosen. The layout comes from the
// server (`segments`, see server/lighting-topology.js); looks go out as a
// { luid: '#hex' | { style, color, speed } | null } patch.
(function () {
  'use strict';
  const UI = () => window.LightingUI;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PART_LABEL = {
    fan: ['lighting_map_fan', 'Ventola'], pump: ['lighting_map_pump', 'Pompa'], block: ['lighting_map_block', 'Blocco'],
    strip: ['lighting_map_strip', 'Striscia'], dram: ['lighting_map_dram', 'RAM'], zone: ['lighting_map_zone', 'Zona'],
    pos: ['lighting_map_keys', 'LED'], header: ['lighting_map_output', 'Uscita'], piece: ['lighting_map_output', 'Uscita'],
    board: ['lighting_board_title', 'Luci della scheda madre'],
  };
  const RING_KINDS = ['fan', 'pump', 'block'];
  // An output's LEDs (whole or a piece of it) wrap in rows, so a 120-LED strip
  // stays large enough to tap; so do the board's own lights, one dot per light.
  const ROW_KINDS = ['header', 'piece', 'board'];
  const ROW_LEDS = 20;
  const LED_PITCH = 14;

  // Selection survives the page's full re-renders (mode change, master toggle).
  const selections = new Map();   // deviceId → Set(luid)
  function selectionOf(id) {
    if (!selections.has(id)) selections.set(id, new Set());
    return selections.get(id);
  }

  // The colour a LED shows on the map, so the map looks like the PC. `live` is
  // what 'follow' shows (the manual colour or the dashboard accent). Colours that
  // keep changing (album, temperature, rainbow) are drawn neutral.
  const STEADY_ANIMS = ['solid', 'breathing', 'candle'];
  // Every dot under root shows what its LED shows now; the device card calls it
  // too when the whole device changes colour, without rebuilding the map.
  function paintColors(root, dev, live) {
    root.querySelectorAll('.lighting-led').forEach((c) => {
      const col = ledColor(dev, Number(c.dataset.luid), live);
      c.classList.toggle('is-neutral', !col);
      c.style.fill = col || '';
    });
  }

  function ledColor(dev, luid, live) {
    const mode = dev.mode || 'follow';
    if (mode === 'custom') {
      const v = dev.modeLeds && dev.modeLeds[luid];
      if (!v) return live || null;
      if (typeof v === 'string') return v;
      return STEADY_ANIMS.includes(v.style) ? v.color : null;
    }
    if (mode === 'color') return dev.modeColor || null;
    if (mode === 'off') return '#000000';
    if (mode === 'follow') return live || null;
    if (mode === 'animation' && dev.modeAnim && STEADY_ANIMS.includes(dev.modeAnim.style)) return dev.modeAnim.color || null;
    return null;
  }

  // LED centres in a 0..100 box (rings, rows, columns) or from the SDK positions.
  function ledPoints(seg) {
    const n = seg.ledIds.length;
    if (RING_KINDS.includes(seg.kind)) {
      return seg.ledIds.map((_, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        return [50 + 38 * Math.cos(a), 50 + 38 * Math.sin(a)];
      });
    }
    if (seg.kind === 'dram') return seg.ledIds.map((_, i) => [15, 6 + (88 * (i + 0.5)) / n]);
    if (seg.kind === 'pos' && Array.isArray(seg.pos) && seg.pos.length === n) return normalizePositions(seg.pos);
    if (ROW_KINDS.includes(seg.kind)) {
      return seg.ledIds.map((_, i) => [7 + LED_PITCH * (i % ROW_LEDS), 10 + LED_PITCH * Math.floor(i / ROW_LEDS)]);
    }
    return seg.ledIds.map((_, i) => [7 + 14 * i, 10]);
  }

  function normalizePositions(pos) {
    const xs = pos.map(p => p[0]), ys = pos.map(p => p[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY, 1);
    return pos.map(([x, y]) => [6 + ((x - minX) / span) * 88, 6 + ((y - minY) / span) * 88]);
  }

  function viewBoxFor(seg, points) {
    if (RING_KINDS.includes(seg.kind)) return '0 0 100 100';
    if (seg.kind === 'dram') return '0 0 30 100';
    if (seg.kind === 'pos') return `0 0 100 ${Math.ceil(Math.max(...points.map(p => p[1])) + 6)}`;
    if (ROW_KINDS.includes(seg.kind)) {
      const n = seg.ledIds.length;
      return `0 0 ${Math.min(n, ROW_LEDS) * LED_PITCH} ${Math.ceil(n / ROW_LEDS) * LED_PITCH + 6}`;
    }
    return `0 0 ${seg.ledIds.length * 14} 20`;
  }

  // Dot radius: as large as the spacing allows, so sparse rings stay easy to hit.
  function dotRadius(points) {
    if (points.length < 2) return 6;
    let min = Infinity;
    for (let i = 1; i < points.length; i++) {
      min = Math.min(min, Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    }
    return Math.max(1.6, Math.min(7, min * 0.42));
  }

  function partFigure(seg, label, sel, refresh) {
    const fig = UI().el('figure', 'lighting-part lighting-part-' + seg.kind);
    if (seg.ledIds.length === 1) fig.classList.add('is-single');
    const points = ledPoints(seg);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', viewBoxFor(seg, points));
    svg.setAttribute('class', 'lighting-part-leds');
    svg.setAttribute('aria-hidden', 'true');
    // A row of LEDs keeps one dot size whatever its length (CSS caps it at 100%).
    if (ROW_KINDS.includes(seg.kind) && seg.ledIds.length > 1) {
      svg.setAttribute('width', String(Math.min(seg.ledIds.length, ROW_LEDS) * 18));
    }
    const r = dotRadius(points);
    if (RING_KINDS.includes(seg.kind)) {
      // The fan frame behind its LEDs, so a ring of dots reads as a fan.
      const track = document.createElementNS(SVG_NS, 'circle');
      track.setAttribute('cx', '50'); track.setAttribute('cy', '50'); track.setAttribute('r', '38');
      track.setAttribute('class', 'lighting-part-track');
      svg.appendChild(track);
    }
    seg.ledIds.forEach((luid, i) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', points[i][0].toFixed(2));
      c.setAttribute('cy', points[i][1].toFixed(2));
      c.setAttribute('r', r.toFixed(2));
      c.setAttribute('class', 'lighting-led');
      c.dataset.luid = String(luid);
      svg.appendChild(c);
    });
    // The part's name is the keyboard-reachable way to take the whole part.
    const name = UI().button('lighting-part-name', '', label, () => {
      const all = seg.ledIds.every(id => sel.has(id));
      seg.ledIds.forEach(id => (all ? sel.delete(id) : sel.add(id)));
      refresh();
    });
    if (seg.model) name.appendChild(UI().el('span', 'lighting-part-model', '', seg.model));
    fig.append(svg, name);
    return fig;
  }

  // Tap toggles one LED; dragging paints the same choice across every LED the
  // finger passes over (dense rings like a 40-LED pump are too fine to tap).
  function bindDragSelect(root, sel, refresh) {
    let adding = null;
    const hit = (x, y) => {
      const node = document.elementFromPoint(x, y);
      return node && node.classList && node.classList.contains('lighting-led') && root.contains(node) ? node : null;
    };
    const apply = (node) => {
      const id = Number(node.dataset.luid);
      if (adding) sel.add(id); else sel.delete(id);
      node.classList.toggle('is-selected', adding);
    };
    root.addEventListener('pointerdown', (e) => {
      const node = hit(e.clientX, e.clientY);
      if (!node) return;
      e.preventDefault();
      adding = !sel.has(Number(node.dataset.luid));
      apply(node);
    });
    root.addEventListener('pointermove', (e) => {
      if (adding === null) return;
      const node = hit(e.clientX, e.clientY);
      if (node) apply(node);
    });
    const end = () => { if (adding !== null) { adding = null; refresh(); } };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    root.addEventListener('pointerleave', end);
  }

  function partLabels(segments) {
    const counters = {};
    const totals = {};
    segments.forEach(s => { totals[s.kind] = (totals[s.kind] || 0) + 1; });
    return segments.map((s) => {
      if (s.name) return s.name;
      const [key, fb] = PART_LABEL[s.kind] || PART_LABEL.zone;
      // An output's own LEDs are named after it: Uscita 2, or Uscita 2 · 3 for a piece.
      if (ROW_KINDS.includes(s.kind) && s.output) return `${UI().tr(key, fb)} ${s.output}${s.piece ? ' · ' + s.piece : ''}`;
      const base = UI().tr(key, fb);
      counters[s.kind] = (counters[s.kind] || 0) + 1;
      return totals[s.kind] > 1 ? `${base} ${counters[s.kind]}` : base;
    });
  }

  // What the chosen LEDs show now, for the editor: 'follow', 'color' or 'effect'
  // plus the value of the first chosen LED.
  function selectionLook(dev, sel) {
    const first = dev.mode === 'custom' && dev.modeLeds ? dev.modeLeds[Array.from(sel)[0]] : null;
    if (!first) return { kind: 'follow', value: null };
    return typeof first === 'string' ? { kind: 'color', value: first } : { kind: 'effect', value: first };
  }

  // The editor of the chosen LEDs: what they show (colour, effect, Xenon), then
  // the controls of that choice. `paint(value)` sends it to every chosen LED.
  function selectionEditor(dev, sel, paint, clearSel) {
    const box = UI().el('div', 'lighting-sel');
    const look = selectionLook(dev, sel);
    const head = UI().el('div', 'settings-label-line lighting-sel-head');
    head.append(
      UI().el('span', '', '', UI().tr('lighting_map_selected', '{n} LED scelti').replace('{n}', String(sel.size))),
      UI().button('settings-btn', 'lighting_map_deselect', 'Deseleziona', clearSel),
    );
    const body = UI().el('div', 'lighting-sel-body');
    const lastColor = look.kind === 'color' ? look.value : '#ff0000';
    const lastEffect = look.kind === 'effect' ? look.value : { style: 'breathing', color: lastColor, speed: 50 };
    const showKind = (kind) => {
      body.textContent = '';
      if (kind === 'color') body.appendChild(UI().colorChoice(lastColor, paint));
      if (kind === 'effect') effectPicker(lastEffect, paint).forEach(n => body.appendChild(n));
      UI().localizeSubtree(body);
    };
    const kinds = UI().segmented([
      ['color', 'lighting_show_color', 'Colore'], ['effect', 'lighting_show_effect', 'Effetto'],
      ['follow', 'lighting_show_follow', 'Segue Xenon'],
    ], look.kind, (kind) => {
      if (kind === 'follow') paint(null);
      else if (kind === 'color') paint(lastColor);
      else paint({ ...lastEffect });
      showKind(kind);
    }, 3);
    box.append(head, kinds, body);
    showKind(look.kind);
    return box;
  }

  function effectPicker(initial, paint) {
    const value = { ...initial };
    const extras = UI().el('div', 'lighting-sel-extras');
    const fill = () => {
      extras.textContent = '';
      UI().effectExtras(value, (patch) => { Object.assign(value, patch); paint({ ...value }); })
        .forEach(n => extras.appendChild(n));
      UI().localizeSubtree(extras);
    };
    const styles = UI().segmented(UI().EFFECTS, value.style, (style) => {
      value.style = style;
      paint({ ...value });
      fill();
    }, 4);
    fill();
    return [styles, extras];
  }

  // opts.onPaint(patch): { luid: value | null } for the chosen LEDs.
  // opts.liveColor: what the device shows in 'follow' (a CSS colour).
  // opts.groups (optional): [{ head, intro?, segments, labels, body }] draws the parts in
  // titled groups (a board's outputs); one selection and editor span them all.
  function build(dev, opts) {
    const segments = Array.isArray(dev.segments) ? dev.segments.filter(s => s.ledIds && s.ledIds.length) : [];
    if (!segments.length && !opts.groups) return null;
    const sel = selectionOf(dev.id);
    const box = UI().el('div', 'lighting-map');
    const parts = UI().el('div', opts.groups ? 'lighting-map-groups' : 'lighting-map-parts');
    const labels = partLabels(segments);
    const editorSlot = UI().el('div', 'lighting-sel-slot');
    editorSlot.setAttribute('aria-live', 'polite');
    let shownFor = '';

    const paint = (value) => {
      const patch = {};
      sel.forEach((id) => { patch[id] = value; });
      opts.onPaint(patch);
      paintDots();
    };
    const clearSel = () => { sel.clear(); refresh(); };
    // The editor is rebuilt only when the selection changes, so a colour being
    // typed or a slider being dragged keeps its focus.
    const showEditor = () => {
      const key = Array.from(sel).sort((a, b) => a - b).join(',');
      if (key === shownFor) return;
      shownFor = key;
      editorSlot.textContent = '';
      placeEditor();
      if (sel.size) {
        editorSlot.appendChild(selectionEditor(dev, sel, paint, clearSel));
        UI().localizeSubtree(editorSlot);
      }
    };
    function paintDots() {
      paintColors(parts, dev, opts.liveColor);
      parts.querySelectorAll('.lighting-led').forEach((c) => {
        c.classList.toggle('is-selected', sel.has(Number(c.dataset.luid)));
      });
      parts.querySelectorAll('.lighting-part').forEach((fig) => {
        const ids = Array.from(fig.querySelectorAll('.lighting-led'), c => Number(c.dataset.luid));
        fig.classList.toggle('is-selected', ids.length > 0 && ids.every(id => sel.has(id)));
      });
    }
    // With groups the editor sits right under the LEDs being chosen, not below
    // the last output, where it would be off screen.
    function placeEditor() {
      const first = sel.size ? parts.querySelector('.lighting-led.is-selected') : null;
      const row = first && opts.groups ? first.closest('.lighting-map-parts') : null;
      if (row) row.after(editorSlot);
      else box.appendChild(editorSlot);
    }
    function refresh() { paintDots(); showEditor(); }

    if (opts.groups) {
      opts.groups.forEach((g) => {
        const group = UI().el('div', 'lighting-map-group');
        group.appendChild(g.head);
        if (g.intro) group.appendChild(g.intro);
        if (g.segments.length) {
          const row = UI().el('div', 'lighting-map-parts');
          g.segments.forEach((seg, i) => row.appendChild(partFigure(seg, g.labels[i], sel, refresh)));
          group.appendChild(row);
        }
        if (g.body) group.appendChild(g.body);
        parts.appendChild(group);
      });
    } else {
      segments.forEach((seg, i) => parts.appendChild(partFigure(seg, labels[i], sel, refresh)));
    }
    bindDragSelect(parts, sel, refresh);
    box.append(parts, editorSlot);
    refresh();
    return box;
  }

  window.LightingMap = { build, partLabels, paintColors };
})();
