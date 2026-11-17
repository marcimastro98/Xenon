// What a proactive moment says in a pop-up, and what "Ask Bit" asks about it.
//
// server/briefing.js raises three moments (SSE 'briefing'): a game session that
// ended, a temperature high for a long time, one unusually high. The dashboard
// (ambient.js) and the alerts window of "widgets only" (screen-alerts.js) show
// them, so both build the card here and never say different things. Pure: the
// payload and a context { t, hwF } in, the words out; the caller says what
// "Ask Bit" opens, since the dashboard has Bit's chat and the alerts window has
// only the search window's.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BriefingToast = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const ASK_TOAST_MS = 12000;

  const tr = (ctx, key) => {
    const v = ctx && typeof ctx.t === 'function' ? ctx.t(key) : '';
    return v && v !== key ? v : '';
  };

  // A reading in the hardware unit the user chose: every {token} converted, {u} named.
  function fill(text, values, fahrenheit) {
    let out = String(text == null ? '' : text);
    for (const token of Object.keys(values || {})) {
      const c = Number(values[token]);
      const v = Number.isFinite(c) ? Math.round(fahrenheit ? c * 9 / 5 + 32 : c) : values[token];
      out = out.split('{' + token + '}').join(String(v));
    }
    return out.split('{u}').join(fahrenheit ? 'F' : 'C');
  }

  function fmtMinutes(m) {
    const mins = Math.max(1, Math.round(m || 0));
    const h = Math.floor(mins / 60);
    return h > 0 ? `${h}h ${String(mins % 60).padStart(2, '0')}min` : `${mins} min`;
  }

  // What "Ask Bit" puts in the chat box for this moment ('' = nothing to ask).
  function question(d, game, t) {
    if (d.type === 'recap') return game ? t('bit_ask_recap').replace('{game}', game) : t('bit_ask_recap_last');
    if (d.type === 'thermal' || d.type === 'anomaly') return t(d.metric === 'cpu' ? 'bit_ask_hot_cpu' : 'bit_ask_hot_gpu');
    return '';
  }

  // { title, text, question }, or null when the payload says nothing.
  function describe(d, ctx) {
    if (!d || typeof d !== 'object') return null;
    const t = (key) => tr(ctx, key);
    const fillTemps = (text, values) => fill(text, values, !!(ctx && ctx.hwF));
    let title = 'Xenon';
    let text = '';
    const game = String(d.game || '').replace(/\.exe$/i, '');
    const named = game ? game.charAt(0).toUpperCase() + game.slice(1) : '';
    if (d.type === 'recap') {
      const name = named || t('brief_recap_title');
      const parts = [`${name} · ${fmtMinutes(d.minutes)}`];
      if (typeof d.avgFps === 'number') {
        parts.push(t('brief_recap_fps')
          .replace('{avg}', String(d.avgFps))
          .replace('{max}', String(typeof d.maxFps === 'number' ? d.maxFps : d.avgFps)));
      }
      if (typeof d.gpuTempMax === 'number') parts.push(fillTemps(t('brief_recap_gpu'), { v: d.gpuTempMax }));
      else if (typeof d.cpuTempMax === 'number') parts.push(fillTemps(t('brief_recap_cpu'), { v: d.cpuTempMax }));
      title = t('brief_recap_title');
      text = parts.join(' · ');
    } else if (d.type === 'thermal') {
      const key = d.metric === 'cpu' ? 'brief_thermal_cpu' : 'brief_thermal_gpu';
      text = fillTemps(t(key), { v: d.value }).replace('{m}', String(d.minutes));
    } else if (d.type === 'anomaly') {
      const key = d.metric === 'cpu' ? 'brief_anomaly_cpu' : 'brief_anomaly_gpu';
      text = fillTemps(t(key), { v: d.value, b: d.baseline });
      title = t('brief_anomaly_title');
    }
    if (!text) return null;
    return { title, text, question: question(d, named, t) };
  }

  // The XenonToast options. With `onAsk` (the question in, nothing out) the card
  // carries "Ask Bit"; the card itself costs nothing, an answer is a choice.
  function toast(moment, ctx, onAsk) {
    const card = { type: 'info', kicker: moment.title, title: moment.text, message: '' };
    const label = tr(ctx, 'xmenu_bit');
    if (typeof onAsk !== 'function' || !moment.question || !label) return card;
    return {
      ...card,
      duration: ASK_TOAST_MS,
      actions: [{ label, primary: true, onClick: () => onAsk(moment.question) }],
    };
  }

  return { describe, toast, fill };
});
