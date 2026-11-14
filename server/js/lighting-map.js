// Lighting map: one device drawn as its real parts (each fan a ring of its LEDs,
// the pump, RAM sticks, strips, a keyboard from its LED positions), where the
// user picks LEDs — a tap, a drag across several, or a part's name for all of
// it — and gives them a colour, an effect, or back to Xenon. The editor for the
// chosen LEDs appears only while something is chosen. The layout comes from the
// server (`segments`, see server/lighting-topology.js); looks go out as a
// { luid: '#hex' | { style, color, speed } | null } patch.
(function () {
  'use strict';
  const {
    UI, RING_KINDS, ROW_KINDS, ROW_LEDS, ledPoints, viewBoxFor, dotRadius, bindDragSelect, partLabels,
    selectionLook,
  } = window.LightingMapGeometry;
  const SVG_NS = 'http://www.w3.org/2000/svg';

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
