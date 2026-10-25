// The outputs of a board Xenon drives itself (source 'native'), drawn as groups
// of the lighting map. Plain ARGB lights send nothing back, so each output is
// set up once, in one question: "press + until everything is white". The output
// then shows one dot per LED, to colour one by one. Lights chained one after the
// other can be split into pieces (one per fan or strip) as an optional step;
// lights on a splitter all show the same LEDs and need nothing more.
(function () {
  'use strict';
  const UI = () => window.LightingUI;
  const KEEPALIVE_MS = 8000;   // the server ends a preview 15 s after the last one
  const DEFAULT_LEDS = 8;      // the most common ARGB fan ring
  const MAX_OUTPUT_LEDS = 256;
  const BIG_STEP = 10;
  const MAX_NAME = 32;         // the server keeps the same length

  // One setup at a time; kept here so a re-render of the page does not lose it.
  // { id, output, step: 'count' | 'split' | 'name', total, lit, pieces: [count], layout }
  let active = null;
  let activeNode = null;
  let keepalive = null;

  function preview(body) { return UI().post('/api/lighting/native/preview', body); }

  // White = the LEDs being counted (count) or the piece being measured (split);
  // pieces already made alternate blue and orange.
  // While naming, the whole output is white: that is the light being named.
  function sendPreview() {
    if (!active) return;
    const done = active.step === 'split' ? active.pieces : [];
    const lit = active.step === 'name' ? active.total : active.lit;
    preview({ device: active.id, output: active.output, done, lit });
  }

  function startKeepalive() {
    clearInterval(keepalive);
    keepalive = setInterval(() => {
      // The page went away (Settings closed, tab changed): end the preview.
      if (!activeNode || !document.body.contains(activeNode)) { close(); return; }
      sendPreview();
    }, KEEPALIVE_MS);
  }

  function close() {
    clearInterval(keepalive);
    keepalive = null;
    active = null;
    activeNode = null;
    preview({ stop: true });
  }

  function open(dev, output, step, layout, rerender) {
    const total = layoutTotal(layout);
    active = { id: dev.id, output, step, total, lit: step === 'count' ? (total || DEFAULT_LEDS) : Math.min(DEFAULT_LEDS, total), pieces: [], layout };
    sendPreview();
    startKeepalive();
    rerender();
  }

  // A recount or a new split keeps the name the output already has.
  async function save(layout, rerender) {
    const { id, output } = active;
    const name = active.layout && active.layout.name;
    if (name && layout.parts && layout.name === undefined) layout = { ...layout, name };
    close();
    await UI().post('/api/lighting/native/layout', { device: id, output, layout });
    rerender();
  }

  const sum = (list) => list.reduce((s, n) => s + n, 0);
  const layoutTotal = (layout) => (layout && layout.parts ? sum(layout.parts.map(p => p.count)) : 0);

  // "40 LED", "3 pezzi · 40 LED", "Niente collegato", "Da configurare".
  function stateText(layout) {
    if (!layout) return UI().tr('lighting_output_unset', 'Da configurare');
    if (layout.empty) return UI().tr('lighting_output_empty', 'Niente collegato');
    const n = String(layoutTotal(layout));
    if (layout.parts.length > 1) {
      return UI().tr('lighting_output_pieces', '{p} pezzi · {n} LED').replace('{p}', String(layout.parts.length)).replace('{n}', n);
    }
    return UI().tr('lighting_output_leds', '{n} LED').replace('{n}', n);
  }

  // − and + (and ±10 for long strips); max() is read on every tap.
  function stepper(value, max, onChange) {
    const wrap = UI().el('div', 'lighting-stepper');
    const out = UI().el('output', 'lighting-stepper-value', '', String(value));
    const set = (v) => {
      const next = Math.max(1, Math.min(max(), v));
      out.textContent = String(next);
      onChange(next);
    };
    const btn = (label, delta) => {
      const b = UI().button('settings-btn', '', label, () => set(Number(out.textContent) + delta));
      b.setAttribute('aria-label', (delta > 0 ? '+' : '') + delta);
      return b;
    };
    wrap.append(btn('−10', -BIG_STEP), btn('−', -1), out, btn('+', 1), btn('+10', BIG_STEP));
    return wrap;
  }

  // The only question an output needs: how many LEDs light up.
  function countPanel(rerender) {
    const box = UI().el('div', 'lighting-setup');
    box.append(UI().hintP('', 'lighting_count_hint'),
      stepper(active.lit, () => MAX_OUTPUT_LEDS, (v) => { active.lit = v; sendPreview(); }));
    const row = UI().el('div', 'lighting-inline');
    row.append(
      UI().button('settings-btn primary', 'lighting_setup_save', 'Salva',
        () => save({ parts: [{ kind: 'piece', count: active.lit }] }, rerender)),
      UI().button('settings-btn', 'lighting_setup_nothing', 'Niente collegato', () => save({ empty: true }, rerender)),
      UI().button('settings-btn', 'lighting_setup_cancel', 'Annulla', () => { close(); rerender(); }),
    );
    box.append(row);
    return box;
  }

  // Optional: split the counted LEDs into pieces, one fan or strip at a time.
  function splitPanel(rerender) {
    const box = UI().el('div', 'lighting-setup');
    const left = () => active.total - sum(active.pieces);
    const hint = UI().hintP(UI().tr('lighting_split_hint', 'Il bianco è il pezzo {n}.').replace('{n}', String(active.pieces.length + 1)));
    const progress = UI().el('p', 'settings-hint lighting-setup-done', '', `${sum(active.pieces)} / ${active.total} LED`);
    box.append(hint, stepper(active.lit, left, (v) => { active.lit = v; sendPreview(); }), progress);
    const finish = (pieces) => save({ parts: pieces.map(count => ({ kind: 'piece', count })) }, rerender);
    const row = UI().el('div', 'lighting-inline');
    const undo = UI().button('settings-btn', 'lighting_split_undo', "Togli l'ultimo", () => {
      active.pieces.pop();
      sendPreview();
      rerender();
    });
    undo.disabled = !active.pieces.length;
    row.append(
      UI().button('settings-btn primary', 'lighting_split_next', 'Pezzo successivo', () => {
        active.pieces.push(active.lit);
        if (!left()) { finish(active.pieces); return; }
        active.lit = Math.min(active.lit, left());
        sendPreview();
        rerender();
      }),
      // The rest are the same size as this one (the last takes what is left).
      UI().button('settings-btn', 'lighting_split_equal', 'Tutti uguali', () => {
        const pieces = active.pieces.slice();
        for (let rest = left(); rest > 0; rest -= Math.min(active.lit, rest)) pieces.push(Math.min(active.lit, rest));
        finish(pieces);
      }),
      undo,
      // This piece, and whatever is left as the last one.
      UI().button('settings-btn', 'lighting_setup_save', 'Salva', () => {
        const pieces = active.pieces.concat(active.lit);
        const rest = active.total - sum(pieces);
        finish(rest > 0 ? pieces.concat(rest) : pieces);
      }),
      UI().button('settings-btn', 'lighting_setup_cancel', 'Annulla', () => { close(); rerender(); }),
    );
    box.append(row);
    return box;
  }

  // Its name, so the map and the Deck say "Ventole", not "Uscita 1".
  function namePanel(rerender) {
    const box = UI().el('div', 'lighting-setup');
    const field = UI().el('input', 'settings-text-input');
    field.type = 'text';
    field.maxLength = MAX_NAME;
    field.value = active.layout.name || '';
    field.setAttribute('data-i18n-placeholder', 'lighting_name_ph');
    field.placeholder = UI().tr('lighting_name_ph', 'Es. Ventole, Striscia');
    field.setAttribute('aria-label', UI().tr('lighting_output_rename', 'Rinomina'));
    const done = () => save({ ...active.layout, name: field.value.trim() }, rerender);
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
    const row = UI().el('div', 'lighting-inline');
    row.append(
      UI().button('settings-btn primary', 'lighting_setup_save', 'Salva', done),
      UI().button('settings-btn', 'lighting_setup_cancel', 'Annulla', () => { close(); rerender(); }),
    );
    box.append(UI().hintP('', 'lighting_name_hint'), field, row);
    setTimeout(() => field.focus(), 0);
    return box;
  }

  function head(dev, output, layout, isOpen, rerender) {
    const h = UI().el('div', 'lighting-output-head');
    const name = UI().el('span', 'lighting-output-name');
    const number = UI().tr('lighting_output_n', 'Uscita {n}').replace('{n}', String(output + 1));
    const named = layout && layout.name;
    name.textContent = named || number;
    h.append(name, UI().el('span', 'settings-hint', '', (named ? number + ' · ' : '') + stateText(layout)));
    if (isOpen) return h;
    const tools = UI().el('div', 'lighting-output-tools');
    if (!layout) {
      tools.appendChild(UI().button('settings-btn primary', 'lighting_output_count', 'Conta i LED',
        () => open(dev, output, 'count', null, rerender)));
    } else {
      if (!layout.empty) {
        tools.appendChild(UI().button('settings-btn', 'lighting_output_rename', 'Rinomina',
          () => open(dev, output, 'name', layout, rerender)));
      }
      tools.appendChild(UI().button('settings-btn', 'lighting_output_recount', 'Conta di nuovo',
        () => open(dev, output, 'count', layout, rerender)));
      if (layout.parts && layout.parts.length === 1 && layoutTotal(layout) > 1) {
        tools.appendChild(UI().button('settings-btn', 'lighting_output_split', 'Dividi in pezzi',
          () => open(dev, output, 'split', layout, rerender)));
      }
    }
    h.appendChild(tools);
    return h;
  }

  // What a part is called inside its output's group: the whole output, a piece,
  // or (older layouts) what it is.
  function labelsFor(segs) {
    const legacy = window.LightingMap.partLabels(segs);
    return segs.map((s, i) => {
      if (s.kind !== 'piece' && s.kind !== 'header') return legacy[i];
      return s.piece ? `${UI().tr('lighting_map_piece', 'Pezzo')} ${s.piece}` : UI().tr('lighting_map_all', 'Tutti i LED');
    });
  }

  // One group per output for LightingMap.build: header, its parts, the open panel.
  function groups(dev, status, rerender) {
    const layouts = (status.native && status.native.layouts && status.native.layouts[dev.id]) || {};
    const segments = Array.isArray(dev.segments) ? dev.segments : [];
    const out = [];
    for (let o = 0; o < (dev.outputs || 0); o++) {
      const layout = layouts['h' + o];
      const isOpen = !!active && active.id === dev.id && active.output === o;
      const segs = segments.filter(s => s.output === o + 1 && s.ledIds && s.ledIds.length);
      let body = null;
      if (isOpen) {
        const panels = { count: countPanel, split: splitPanel, name: namePanel };
        body = panels[active.step](rerender);
        activeNode = body;
      }
      out.push({ head: head(dev, o, layout, isOpen, rerender), segments: segs, labels: labelsFor(segs), body });
    }
    const board = segments.filter(s => s.kind === 'board' && s.ledIds && s.ledIds.length);
    if (board.length) out.push(boardGroup(board));
    return out;
  }

  // The board's own lights: nothing to count, one dot per light. Which dot is
  // which light differs from board to board, so the hint says how to find out.
  function boardGroup(segs) {
    const h = UI().el('div', 'lighting-output-head');
    h.appendChild(UI().el('span', 'lighting-output-name', 'lighting_board_title', 'Luci della scheda madre'));
    return { head: h, intro: UI().hintP('', 'lighting_board_hint'), segments: segs, labels: segs.map(() => UI().tr('lighting_board_all', 'Tutte le luci')), body: null };
  }

  window.LightingSetup = { groups };
})();
