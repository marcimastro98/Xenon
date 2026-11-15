// The weekly budget of the Claude tile: the plans to pick from and the box for a ceiling of one's
// own.
'use strict';

window.ClaudeWidgetBudgetEditor = (wrapper) => {
  const { closeBudget, postBudget, paint } = wrapper;

  const { t } = window.ClaudeWidgetWords;
  const { widgetState, currentPlanKey } = window.ClaudeWidgetKnown;
  const { el } = window.ClaudeWidgetLines;

  const PLAN_OPTIONS = [
    { key: 'auto',  plan: 'custom', labelKey: 'claude_plan_auto',  fb: 'Auto' },
    { key: 'pro',   plan: 'pro',    labelKey: 'claude_plan_pro',   fb: 'Pro' },
    { key: 'max5',  plan: 'max5',   labelKey: 'claude_plan_max5',  fb: 'Max 5×' },
    { key: 'max20', plan: 'max20',  labelKey: 'claude_plan_max20', fb: 'Max 20×' },
  ];

  function budgetEditor() {
    const wrap = el('div', 'cw-panel');
    const head = el('div', 'cw-panel-head');
    head.appendChild(el('div', 'cw-panel-title', t('claude_budget_title', 'Weekly budget')));
    const back = el('button', 'cw-panel-close'); back.type = 'button';
    back.setAttribute('aria-label', t('back', 'Back'));
    back.textContent = '✕';
    back.addEventListener('click', closeBudget);
    head.appendChild(back);
    wrap.appendChild(head);

    wrap.appendChild(el('div', 'cw-panel-body', t('claude_budget_hint2', 'Used when Claude Code is not connected, or on an API key, which has no subscription windows. Pick the weekly ceiling to measure against.')));

    const cur = currentPlanKey();
    const chips = el('div', 'cw-plan-chips');
    PLAN_OPTIONS.forEach(o => {
      const c = el('button', 'cw-plan' + (cur === o.key && !widgetState.customOpen ? ' is-sel' : '')); c.type = 'button';
      c.textContent = t(o.labelKey, o.fb);
      c.addEventListener('click', () => postBudget({ plan: o.plan, weeklyTokenBudget: 0 }));
      chips.appendChild(c);
    });
    const customChip = el('button', 'cw-plan' + (widgetState.customOpen ? ' is-sel' : '')); customChip.type = 'button';
    customChip.textContent = t('claude_plan_custom', 'Custom');
    customChip.addEventListener('click', () => { widgetState.customOpen = true; paint(); });
    chips.appendChild(customChip);
    wrap.appendChild(chips);

    if (widgetState.customOpen) {
      const row = el('div', 'cw-custom');
      const input = el('input', 'cw-custom-input'); input.type = 'number'; input.min = '1'; input.step = '1'; input.placeholder = '500';
      const b = widgetState.payload && widgetState.payload.budget;
      if (b && b.weeklyTokenBudget > 0) input.value = String(Math.round(b.weeklyTokenBudget / 1e6));
      row.appendChild(input);
      row.appendChild(el('span', 'cw-custom-unit', t('claude_custom_unit', 'M tokens / week')));
      const save = el('button', 'cw-custom-save'); save.type = 'button'; save.textContent = t('claude_budget_save', 'Save');
      const commit = () => {
        const m = parseInt(input.value, 10);
        if (!Number.isFinite(m) || m <= 0) { input.focus(); return; }
        postBudget({ plan: 'custom', weeklyTokenBudget: m * 1e6 });
      };
      save.addEventListener('click', commit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
      row.appendChild(save);
      wrap.appendChild(row);
      requestAnimationFrame(() => { try { input.focus(); } catch {} });
    }
    return wrap;
  }

  return { budgetEditor };
};
