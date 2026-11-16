// The keys of a decision card: armed after a short wait, held for an irreversible request, the
// question's options with the Other row, and the plan's modes. What a key sends is decide and
// pickOption, which stay in claude-widget.js.
'use strict';

window.ClaudeWidgetCardKeys = (wrapper) => {
  const { AK, paint, decide, pickOption } = wrapper;

  const { t, PLAN_CHOICE_LABEL } = window.ClaudeWidgetWords;
  const { el, optRow } = window.ClaudeWidgetLines;
  const {
    deciding, qsel, OTHER, typedFor, ARM_MS, HOLD_MS, armTimers, typedBox,
  } = window.ClaudeWidgetDecisionKeys;
  const { firstSeen } = window.ClaudeWidgetDecisionsShown;

  function isArmed(a) {
    if (!firstSeen.has(a.id)) firstSeen.set(a.id, Date.now());
    const left = firstSeen.get(a.id) + ARM_MS - Date.now();
    if (left <= 0) return true;
    if (!armTimers.has(a.id)) {
      armTimers.add(a.id);
      setTimeout(() => { armTimers.delete(a.id); paint(); }, left + 30);
    }
    return false;
  }

  function key(cls, label, onTap, a) {
    const b = el('button', 'cw-key ' + cls); b.type = 'button';
    b.appendChild(el('span', 'cw-key-label', label));
    b.dataset.keep = 'k-' + a.id + '-' + cls;
    b.disabled = deciding.has(a.id);
    b.addEventListener('click', () => { if (isArmed(a)) onTap(); });
    return b;
  }

  // Allow for an irreversible request: hold for HOLD_MS. A keyboard has no
  // "hold" the page can rely on, so there it is two presses within 3 seconds.
  function holdKey(a) {
    return AK.holdButton({
      className: 'cw-key is-allow is-hold', label: t('claude_hold_allow', 'Hold to allow'),
      pressAgain: t('claude_press_again', 'Press again to allow'), holdMs: HOLD_MS, keep: 'k-' + a.id + '-hold',
      disabled: deciding.has(a.id), isArmed: () => isArmed(a), onConfirm: () => decide(a.id, 'allow'),
    });
  }

  // On the sheet a lone question is already the title of the window.
  function questionKeys(a, onInput, big) {
    const wrap = el('div', 'cw-dec-qs');
    const cur = qsel.get(a.id) || a.questions.map(() => []);
    const busy = deciding.has(a.id);
    const ph = t('claude_q_other_ph', 'Type your answer');
    a.questions.forEach((q, qi) => {
      const box = el('div', 'cw-dec-q');
      if (q.header && !big) box.appendChild(el('div', 'cw-dec-qhead', q.header));
      if (!big || a.questions.length > 1) box.appendChild(el('div', 'cw-dec-qtext', q.question));
      if (q.kind === 'text' || q.kind === 'number') {
        box.appendChild(typedBox(a, qi, 'q-' + a.id + '-' + qi, {
          number: q.kind === 'number', min: q.min, max: q.max, step: q.step,
          placeholder: q.kind === 'number' && q.unit ? q.unit : (q.placeholder || ph), onInput,
        }));
        wrap.appendChild(box);
        return;
      }
      if (q.multiSelect) box.appendChild(el('div', 'cw-dec-qnote', t('claude_q_multi', 'Pick one or more')));
      // Options with a description stack like the terminal's list; side by side
      // they were cut to a few words each and the card scrolled.
      const stacked = (q.options || []).some((o) => o.description);
      const list = el('div', 'cw-opts' + (stacked ? ' is-col' : ''));
      const row = cur[qi] || [];
      (q.options || []).forEach((o, oi) => {
        list.appendChild(optRow(oi + 1, o.label, o.description, row.indexOf(o.label) !== -1, busy,
          () => { if (isArmed(a)) pickOption(a, qi, o.label, !!q.multiSelect); }, 'o-' + a.id + '-' + qi + '-' + oi));
      });
      // The terminal adds this row to every choice question; the card showed
      // the same question without it, so an answer that was none of the
      // options could only be given at the keyboard.
      const other = row.indexOf(OTHER) !== -1;
      list.appendChild(optRow((q.options || []).length + 1, t('claude_q_other', 'Other'), stacked ? ph : '', other, busy,
        () => { if (isArmed(a)) pickOption(a, qi, OTHER, !!q.multiSelect); }, 'o-' + a.id + '-' + qi + '-other'));
      box.appendChild(list);
      if (other) box.appendChild(typedBox(a, qi, 'q-' + a.id + '-' + qi, { placeholder: ph, onInput }));
      wrap.appendChild(box);
    });
    return wrap;
  }

  function planKeys(a) {
    const box = el('div', 'cw-dec-acts is-plan');
    const busy = deciding.has(a.id);
    const list = el('div', 'cw-opts is-col');
    const choices = Array.isArray(a.choices) && a.choices.length ? a.choices : ['default'];
    choices.forEach((mode, i) => {
      const label = PLAN_CHOICE_LABEL[mode] ? PLAN_CHOICE_LABEL[mode]() : mode;
      list.appendChild(optRow(i + 1, label, '', false, busy,
        () => { if (isArmed(a)) decide(a.id, 'allow', { mode }); }, 'p-' + a.id + '-' + mode));
    });
    box.appendChild(list);
    const back = el('div', 'cw-dec-back');
    back.appendChild(typedBox(a, 0, 'xp-' + a.id, { multiline: true, placeholder: t('claude_xp_feedback', 'Tell Claude what to change') }));
    back.appendChild(key('is-deny', t('claude_xp_keep', 'No, keep planning'),
      () => decide(a.id, 'deny', { feedback: String(typedFor(a)[0] || '') }), a));
    box.appendChild(back);
    return box;
  }

  return { isArmed, key, holdKey, questionKeys, planKeys };
};
