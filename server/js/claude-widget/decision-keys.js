// What a decision card has been told so far (the option picked, the answer typed) and how long its
// keys wait before they can be pressed.
'use strict';

(() => {
  const deciding = new Set(); // approval ids with a decision in flight

  // What the user has picked so far, per card: approvalId → array (one entry per
  // question) of arrays of option labels. Held here rather than in the DOM
  // because every SSE push rebuilds the tile, and a half-made choice must
  // survive Claude finishing a tool call in the middle of it.
  const qsel = new Map();
  // What has been typed, per card: approvalId → array (one string per question:
  // the "Other" box or a text/number answer; for a plan card, index 0 is the
  // feedback). Mirrored on input and never repainted from, so the caret stays
  // where the user left it.
  const typedAns = new Map();
  // The terminal's "Other" row, as a pick. Never sent as a label: its text is.
  const OTHER = '\u0000other';

  function typedFor(a) {
    let cur = typedAns.get(a.id);
    if (!cur) { cur = []; typedAns.set(a.id, cur); }
    return cur;
  }

  function answerReady(a) {
    const cur = qsel.get(a.id) || [];
    const typed = typedAns.get(a.id) || [];
    return (a.questions || []).some((q, qi) => {
      const text = String(typed[qi] || '').trim();
      if (q.kind === 'text' || q.kind === 'number') return !!text;
      const row = cur[qi] || [];
      return row.some((l) => l !== OTHER) || (row.indexOf(OTHER) !== -1 && !!text);
    });
  }

  // With auto mode on (Claude Code's default since August 2026) routine calls
  // never reach a person, so a request that does is the unusual one. The card is
  // built for that: what it wants to do in words, the exact command as evidence,
  // what makes it unusual (the risk line), and two keys.
  //
  // Two guards against the wrong tap, both learned from how these cards fail:
  //   ARMING  a card ignores taps for its first moments on screen, so a finger
  //           already on its way to something else (or the tap that woke the
  //           screen) cannot land on Allow as the card appears under it.
  //   HOLD    an irreversible request (deletes, force-pushes, resets) is allowed
  //           by holding the key, not tapping it. Deny is always one tap.
  const ARM_MS = 450;
  const HOLD_MS = 900;

  const armTimers = new Set();

  // A text box whose value lives in typedAns rather than in the DOM, so a
  // repaint rebuilds it with the same text; `data-keep` lets paint() give it
  // its focus and caret back (keepFocus).
  function typedBox(a, qi, keep, opts) {
    const o = opts || {};
    const input = o.multiline ? document.createElement('textarea') : document.createElement('input');
    input.className = 'cw-dec-input';
    if (o.multiline) input.rows = 2;
    else input.type = o.number ? 'number' : 'text';
    if (o.number) {
      input.inputMode = 'decimal';
      if (Number.isFinite(o.min)) input.min = String(o.min);
      if (Number.isFinite(o.max)) input.max = String(o.max);
      if (Number.isFinite(o.step)) input.step = String(o.step);
    }
    input.maxLength = 2000;
    input.placeholder = o.placeholder || '';
    input.dataset.keep = keep;
    input.value = typedFor(a)[qi] || '';
    input.disabled = deciding.has(a.id);
    input.addEventListener('input', () => {
      typedFor(a)[qi] = input.value;
      if (typeof o.onInput === 'function') o.onInput();
    });
    return input;
  }

  window.ClaudeWidgetDecisionKeys = {
    deciding, qsel, typedAns, OTHER, typedFor, answerReady, ARM_MS, HOLD_MS, armTimers, typedBox,
  };
})();
