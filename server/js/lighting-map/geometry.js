// Where the LEDs of a part stand on the lighting map and what a part is called: rings, rows,
// columns or the positions a device reports, the box they are drawn in, the size of a dot, the
// names of the parts, what the chosen LEDs show now, and choosing LEDs by dragging over them.

(() => {
  'use strict';

  const UI = () => window.LightingUI;

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

  window.LightingMapGeometry = {
    UI, RING_KINDS, ROW_KINDS, ROW_LEDS, ledPoints, viewBoxFor, dotRadius, bindDragSelect, partLabels,
    selectionLook,
  };
})();
