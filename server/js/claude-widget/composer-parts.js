// The small parts of the box a new run is typed in: a dropdown of the bar under it, the slash word
// being typed and the three slash words that set the bar.
'use strict';

(() => {
  const { t } = window.ClaudeWidgetWords;
  const { widgetState } = window.ClaudeWidgetKnown;

  // One of the composer's dropdowns. It uses the app's own select so a long
  // list stays on the display; a change never repaints, which would throw away
  // what is typed.
  function composerSelect(cls, label, options, value, onChange) {
    const sel = document.createElement('select');
    sel.className = cls;
    sel.setAttribute('data-cs-fixed', '');
    sel.setAttribute('aria-label', label);
    sel.title = label;
    options.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.label;
      if (o.note) opt.dataset.csNote = o.note;
      if (o.id === value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => onChange(sel.value));
    if (typeof window.initCustomSelect === 'function') {
      requestAnimationFrame(() => { try { window.initCustomSelect(sel); } catch {} });
    }
    return sel;
  }

  // In a new run the model, effort and mode belong to the bar under the box, so
  // these three set it instead of going to Claude Code as text (headless
  // Claude Code ignores them).
  function runBuiltins() {
    const list = [
      { name: 'model', desc: t('claude_slash_model', 'Change the model, e.g. /model opus') },
      { name: 'effort', desc: t('claude_slash_effort', 'Set the effort: low, medium, high, xhigh, max') },
    ];
    if (widgetState.askOptions.modes.includes('plan')) list.push({ name: 'plan', desc: t('claude_slash_plan', 'Start in plan mode: it plans first and changes nothing') });
    return list;
  }

  // The word being typed, when the box is exactly "/word" so far.
  function slashQuery(text) {
    const m = /^\/([^\s]*)$/.exec(text);
    return m ? m[1].toLowerCase() : null;
  }

  window.ClaudeWidgetComposerParts = { composerSelect, runBuiltins, slashQuery };
})();
