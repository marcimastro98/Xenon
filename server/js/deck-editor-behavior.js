'use strict';
// Key editor: the Behaviour card (What it does tab) and a cycle key's further
// faces (Look tab). How a key answers a press — a button, a switch, momentary,
// repeat while held, or a cycle through states — and the timings that go with
// it. The editor owns the key; this builds the controls and writes the fields
// back into the raw key it collects. window.DeckEditorBehavior.
(function () {
  const MODES = ['button', 'switch', 'momentary', 'repeat', 'cycle'];
  const CYCLE_MIN = 2;

  function modeOf(key) {
    if (!key) return 'button';
    if (MODES.includes(key.mode)) return key.mode;
    return key.toggle ? 'switch' : 'button';
  }

  // The trigger slots a behaviour runs, in the order the editor shows them. A
  // cycle key runs tap in its first state and cycle1.. in the ones after it.
  function triggersFor(mode, cycleCount) {
    if (mode === 'momentary') return ['press', 'release'];
    if (mode === 'repeat') return ['tap'];
    if (mode === 'switch') return ['tap', 'tapOff', 'double', 'hold'];
    if (mode === 'cycle') {
      const states = [];
      for (let i = 1; i < cycleCount; i++) states.push('cycle' + i);
      return ['tap'].concat(states, ['double', 'hold']);
    }
    return ['tap', 'double', 'hold'];
  }

  // A number field in a labelled row; reads back clamped to [min, max].
  function numberRow(ui, labelKey, value, min, max, unitKey) {
    const inp = ui.input('number', value);
    inp.min = String(min); inp.max = String(max); inp.inputMode = 'numeric';
    inp.classList.add('deck-ed-num');
    const wrap = document.createElement('div'); wrap.className = 'deck-ed-numwrap';
    const unit = document.createElement('span'); unit.className = 'deck-ed-unit';
    unit.setAttribute('data-i18n', unitKey); unit.textContent = ui.t(unitKey);
    wrap.appendChild(inp); wrap.appendChild(unit);
    const read = () => {
      const n = Math.round(Number(inp.value));
      return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
    };
    return { el: ui.subRow(labelKey, wrap), input: inp, read };
  }

  // ui: the editor's own helpers { t, section, subRow, input }. onChange(mode)
  // after the behaviour or the number of states changes.
  function buildCard(ui, existing, onChange) {
    const M = window.DeckModel;
    let mode = modeOf(existing);
    let cycleCount = Math.max(CYCLE_MIN, Math.min(M.CYCLE_MAX, (existing && Array.isArray(existing.cycle) ? existing.cycle.length : 1) + 1));
    const card = ui.section('deck_behavior_title');
    const seg = document.createElement('div'); seg.className = 'deck-ed-seg deck-ed-seg-text deck-ed-modeseg';
    seg.setAttribute('role', 'radiogroup');
    seg.dataset.fitLevels = '2';   // one row, then 3 + 2, then 2 + 2 + 1 (DeckPanel.css)
    const btns = {};
    MODES.forEach((m) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'deck-ed-segbtn';
      b.setAttribute('role', 'radio');
      b.setAttribute('data-i18n', 'deck_behavior_' + m); b.textContent = ui.t('deck_behavior_' + m);
      b.addEventListener('click', () => setMode(m));
      seg.appendChild(b); btns[m] = b;
    });
    card.appendChild(seg);
    const hint = document.createElement('div'); hint.className = 'deck-ed-hint';
    card.appendChild(hint);

    const timing = M.keyTiming(existing);
    const holdRow = numberRow(ui, 'deck_behavior_hold_ms', timing.hold, M.KEY_TIMING.hold[0], M.KEY_TIMING.hold[1], 'deck_unit_ms');
    const doubleRow = numberRow(ui, 'deck_behavior_double_ms', timing.double, M.KEY_TIMING.double[0], M.KEY_TIMING.double[1], 'deck_unit_ms');
    const autoOffRow = numberRow(ui, 'deck_behavior_auto_off', (existing && existing.autoOff) || 0, 0, M.AUTO_OFF_MAX_S, 'deck_unit_s');
    const autoOffHint = document.createElement('div'); autoOffHint.className = 'deck-ed-hint';
    autoOffHint.setAttribute('data-i18n', 'deck_behavior_auto_off_hint'); autoOffHint.textContent = ui.t('deck_behavior_auto_off_hint');
    autoOffRow.el.appendChild(autoOffHint);
    const repeat = M.keyRepeat(existing);
    const delayRow = numberRow(ui, 'deck_behavior_repeat_delay', repeat.delay, M.KEY_REPEAT.delay[0], M.KEY_REPEAT.delay[1], 'deck_unit_ms');
    const everyRow = numberRow(ui, 'deck_behavior_repeat_every', repeat.every, M.KEY_REPEAT.every[0], M.KEY_REPEAT.every[1], 'deck_unit_ms');

    // How many states a cycle key steps through: − n +.
    const stepper = document.createElement('div'); stepper.className = 'deck-ed-stepper';
    const minus = document.createElement('button'); minus.type = 'button'; minus.className = 'deck-ed-stepbtn'; minus.textContent = '−';
    const count = document.createElement('span'); count.className = 'deck-ed-stepcount';
    const plus = document.createElement('button'); plus.type = 'button'; plus.className = 'deck-ed-stepbtn'; plus.textContent = '+';
    minus.setAttribute('aria-label', ui.t('deck_behavior_states_less'));
    plus.setAttribute('aria-label', ui.t('deck_behavior_states_more'));
    stepper.appendChild(minus); stepper.appendChild(count); stepper.appendChild(plus);
    const statesRow = ui.subRow('deck_behavior_states', stepper);
    const setCount = (n) => {
      cycleCount = Math.max(CYCLE_MIN, Math.min(M.CYCLE_MAX, n));
      paintCount();
      onChange(mode);
    };
    minus.addEventListener('click', () => setCount(cycleCount - 1));
    plus.addEventListener('click', () => setCount(cycleCount + 1));
    function paintCount() {
      count.textContent = String(cycleCount);
      minus.disabled = cycleCount <= CYCLE_MIN;
      plus.disabled = cycleCount >= M.CYCLE_MAX;
    }

    // The two timings of a kind sit side by side: one short row, not two.
    const pair = (a, b) => { const p = document.createElement('div'); p.className = 'deck-ed-numpair'; p.appendChild(a.el); p.appendChild(b.el); return p; };
    const tapPair = pair(holdRow, doubleRow);
    const repeatPair = pair(delayRow, everyRow);
    [statesRow, tapPair, autoOffRow.el, repeatPair].forEach((n) => card.appendChild(n));
    function paint() {
      MODES.forEach((m) => {
        btns[m].classList.toggle('active', m === mode);
        btns[m].setAttribute('aria-checked', m === mode ? 'true' : 'false');
      });
      // A switch keeps the hint it always had: what its two taps run.
      const hintKey = mode === 'switch' ? 'deck_toggle_hint' : 'deck_behavior_hint_' + mode;
      hint.setAttribute('data-i18n', hintKey);
      hint.textContent = ui.t(hintKey);
      const tapKind = mode === 'button' || mode === 'switch' || mode === 'cycle';
      const show = (n, on) => { n.style.display = on ? '' : 'none'; };
      show(tapPair, tapKind);
      show(autoOffRow.el, mode === 'switch');
      show(repeatPair, mode === 'repeat');
      show(statesRow, mode === 'cycle');
      paintCount();
    }
    function setMode(m) {
      if (!MODES.includes(m) || m === mode) return;
      mode = m;
      paint();
      onChange(mode);
    }
    paint();

    return {
      el: card,
      mode: () => mode,
      setMode,
      cycleCount: () => cycleCount,
      triggers: () => triggersFor(mode, cycleCount),
      // Write the behaviour into a raw key; normalizeKey keeps only what fits it.
      collect(key) {
        if (mode === 'switch') key.toggle = true;
        else if (mode !== 'button') key.mode = mode;
        if (mode === 'button' || mode === 'switch' || mode === 'cycle') key.timing = { hold: holdRow.read(), double: doubleRow.read() };
        if (mode === 'switch') { const s = autoOffRow.read(); if (s) key.autoOff = s; }
        if (mode === 'repeat') key.repeat = { delay: delayRow.read(), every: everyRow.read() };
      },
    };
  }

  // One further face of a cycle key, in the Look tab: its label colour, icon and
  // background. Its title is typed in the editor's Title field (label/setLabel).
  // ui: { t, section, subRow, input, swatchRow, buildIconPicker }.
  function buildCycleFace(ui, face) {
    const f = face || {};
    let label = f.label || '';
    let labelColor = f.labelColor || '', iconColor = f.iconColor || '', color = f.color || '', color2 = f.color2 || '';
    const wrap = document.createElement('div'); wrap.className = 'deck-ed-cycleface';
    const fLabel = ui.section('deck_cycle_sec_label');
    fLabel.appendChild(ui.subRow('deck_ss_labelcolor', ui.swatchRow(() => labelColor, (v) => { labelColor = v; }).el));
    const fIcon = ui.section('deck_cycle_sec_icon');
    const picker = ui.buildIconPicker(f.icon ? { icon: f.icon } : null, null, { glyphOnly: true });
    fIcon.appendChild(picker.element);
    fIcon.appendChild(ui.subRow('deck_ss_iconcolor', ui.swatchRow(() => iconColor, (v) => { iconColor = v; }).el));
    const fBg = ui.section('deck_cycle_sec_bg');
    fBg.appendChild(ui.subRow('deck_cycle_color', ui.swatchRow(() => color, (v) => { color = v; }).el));
    fBg.appendChild(ui.subRow('deck_cycle_color2', ui.swatchRow(() => color2, (v) => { color2 = v; }).el));
    [fLabel, fIcon, fBg].forEach((n) => wrap.appendChild(n));
    return {
      el: wrap,
      read() {
        const out = {};
        if (label) out.label = label;
        // An untouched picker still answers with an empty emoji: not a choice.
        const icon = picker.read();
        if (icon && icon.value) out.icon = icon;
        if (labelColor) out.labelColor = labelColor;
        if (iconColor) out.iconColor = iconColor;
        if (color) out.color = color;
        if (color2) out.color2 = color2;
        return out;
      },
      label: () => label,
      setLabel(v) { label = String(v || '').slice(0, 40); },
    };
  }

  const API = { MODES, modeOf, triggersFor, buildCard, buildCycleFace };
  if (typeof window !== 'undefined') window.DeckEditorBehavior = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = { MODES, modeOf, triggersFor };
})();
