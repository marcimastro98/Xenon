// How the Claude tile writes a model and a length of time: the hue that says which model did the
// work, its short and its full name, minutes and seconds, and a number kept between two others.
'use strict';

(() => {
  const MODEL_COLORS = Object.freeze({ opus: '#D97757', fable: '#A98BE0', mythos: '#A98BE0', sonnet: '#3FB9C4', haiku: '#79C267' });

  function modelHue(model) {
    const m = String(model || '');
    for (const key in MODEL_COLORS) if (m.indexOf('claude-' + key) === 0 || m.indexOf(key) === 0) return MODEL_COLORS[key];
    return 'var(--accent)';
  }

  function shortModel(model) {
    return String(model || '').replace(/^claude-/, '').replace(/-\d{6,}$/, '') || 'unknown';
  }

  function mmss(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  // "claude-opus-5-5" → "Opus 5.5": the name Anthropic uses, not the API id.
  function prettyModel(model) {
    const id = String(model || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
    if (!id) return '';
    const parts = id.split('-');
    const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    const ver = parts.slice(1).filter((p) => /^\d+$/.test(p)).join('.');
    return ver ? name + ' ' + ver : name;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function level(used) { return used >= 90 ? 'crit' : used >= 70 ? 'warn' : 'ok'; }

  window.ClaudeWidgetModelWords = { modelHue, shortModel, mmss, prettyModel, clamp, level };
})();
