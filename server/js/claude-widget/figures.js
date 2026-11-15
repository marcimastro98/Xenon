// The figures of the Claude tile: the two quota gauges with the pace mark, and the Usage face with
// its ledger, the thirty days, the projects and the models.
'use strict';

window.ClaudeWidgetFigures = (wrapper) => {
  const { openBudget } = wrapper;

  const { t, until, fmtTokens, fmtMoney, fmtPct, fmtDay } = window.ClaudeWidgetWords;
  const { modelHue, prettyModel, clamp, level } = window.ClaudeWidgetModelWords;
  const { widgetState, limits, statusSeen } = window.ClaudeWidgetKnown;
  const { el, paceLine } = window.ClaudeWidgetLines;

  // ── quota: two instruments ─────────────────────────────────────────────────
  // Each window is a segmented gauge of what is USED (the number Claude's own
  // usage page shows), with a marker where an even pace would put you right
  // now: fill past the marker means burning faster than the window allows. The
  // sentence under it turns that into a time. Both come straight from the two
  // numbers Claude Code reports (used % and the reset instant) and the window's
  // known length, so nothing here is sampled, smoothed or guessed.
  const WINDOW_MS = Object.freeze({ fiveHour: 5 * 3600 * 1000, sevenDay: 7 * 86400 * 1000 });
  const SEGMENTS = 20;

  function gauge(key, label, win) {
    const L = WINDOW_MS[key];
    const reset = (Number(win.resetsAt) || 0) * 1000;
    const nowMs = Date.now();
    // Past its reset instant a window has started over: showing the old figure
    // until the next statusline post (it used to stay for minutes) is showing a
    // number that is no longer true.
    const renewed = !!reset && reset <= nowMs;
    const used = renewed ? 0 : clamp(Number(win.pct) || 0, 0, 100);
    const start = reset - L;
    const elapsed = reset && !renewed ? clamp((nowMs - start) / L, 0, 1) : null;

    const box = el('div', 'cw-gauge is-' + level(used));
    const head = el('div', 'cw-gauge-head');
    head.appendChild(el('span', 'cw-gauge-key', label));
    head.appendChild(el('span', 'cw-gauge-val', Math.round(used) + '%'));
    const reset$ = el('span', 'cw-gauge-reset');
    if (renewed) reset$.textContent = t('claude_new_window', 'new window');
    else if (reset) {
      reset$.appendChild(el('span', 'cw-gauge-reset-l', t('claude_resets_in', 'resets in') + ' '));
      const cd = el('span', 'cw-gauge-reset-t', until(win.resetsAt));
      cd.dataset.resetAt = String(win.resetsAt);
      reset$.appendChild(cd);
    }
    head.appendChild(reset$);
    box.appendChild(head);

    const track = el('div', 'cw-gauge-track');
    track.setAttribute('role', 'meter');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(Math.round(used)));
    track.setAttribute('aria-label', label);
    const lit = Math.round((used / 100) * SEGMENTS);
    for (let i = 0; i < SEGMENTS; i++) track.appendChild(el('span', 'cw-seg' + (i < lit ? ' is-on' : '')));
    if (elapsed !== null) {
      const mark = el('span', 'cw-gauge-pace');
      mark.style.left = (elapsed * 100).toFixed(2) + '%';
      mark.title = t('claude_pace_mark', 'An even pace would be here now');
      track.appendChild(mark);
    }
    box.appendChild(track);
    const pace = paceLine(used, elapsed, start, reset);
    if (pace) box.appendChild(pace);
    return box;
  }

  function quotaPanel() {
    const lim = limits();
    const panel = el('div', 'cw-quota');
    panel.appendChild(el('div', 'cw-sec-title', t('claude_quota', 'Quota')));

    if (lim && (lim.fiveHour || lim.sevenDay)) {
      if (lim.fiveHour) panel.appendChild(gauge('fiveHour', t('claude_5h', '5h'), lim.fiveHour));
      if (lim.sevenDay) panel.appendChild(gauge('sevenDay', t('claude_7d', '7d'), lim.sevenDay));
      return panel;
    }
    if (widgetState.linkState && widgetState.linkState.linked && !statusSeen()) {
      panel.appendChild(el('div', 'cw-quiet-note', t('claude_quota_waiting', "The quota appears with Claude's next reply.")));
      return panel;
    }

    // No real windows: an API-key account, or Claude Code not connected. The
    // user's own weekly budget stands in, and says what it counts.
    const u = widgetState.payload && widgetState.payload.usage;
    const b = widgetState.payload && widgetState.payload.budget;
    const week = u ? u.week.tokens : 0;
    const weekly = b ? b.weekly : 0;
    const box = el('div', 'cw-gauge is-' + (weekly > 0 ? level((week / weekly) * 100) : 'ok'));
    const head = el('div', 'cw-gauge-head');
    head.appendChild(el('span', 'cw-gauge-key', t('claude_budget_band', 'Weekly budget')));
    const used = weekly > 0 ? clamp((week / weekly) * 100, 0, 100) : 0;
    head.appendChild(el('span', 'cw-gauge-val', weekly > 0 ? Math.round(used) + '%' : fmtTokens(week)));
    const edit = el('button', 'cw-link-btn'); edit.type = 'button';
    edit.textContent = weekly > 0 ? t('claude_edit', 'edit') : t('claude_set_budget_short', 'set');
    edit.addEventListener('click', openBudget);
    head.appendChild(edit);
    box.appendChild(head);
    if (weekly > 0) {
      const track = el('div', 'cw-gauge-track');
      const lit = Math.round((used / 100) * SEGMENTS);
      for (let i = 0; i < SEGMENTS; i++) track.appendChild(el('span', 'cw-seg' + (i < lit ? ' is-on' : '')));
      box.appendChild(track);
      box.appendChild(el('div', 'cw-pace', fmtTokens(Math.max(0, weekly - week)) + ' ' + t('claude_left_short', 'left')
        + ' · ' + t('claude_budget_counts', 'counts every token, cache reads included')));
    }
    panel.appendChild(box);
    return panel;
  }

  // ── the Usage face ─────────────────────────────────────────────────────────
  // Everything here describes ONE window and says which: the last 30 days, and
  // the date the data really starts when Claude Code has already deleted older
  // transcripts (it does, so "30 days" can hold eight). Today and "since Monday"
  // are the two exceptions, and are named for exactly what they are. No figure
  // on this face is all-time next to a 30-day one.
  function usageFace(u) {
    const face = el('div', 'cw-usage');
    const w = u.window || { days: 30, startsAt: 0, dataFrom: 0, tokens: 0, cost: 0 };
    // It scrolls and holds nothing focusable, so it takes focus itself: a
    // keyboard can then scroll it too.
    face.tabIndex = 0;
    face.setAttribute('role', 'region');
    face.setAttribute('aria-label', t('claude_usage_window', 'Last {n} days').replace('{n}', String(w.days || 30)));

    const head = el('div', 'cw-sec-head');
    head.appendChild(el('span', 'cw-sec-title', t('claude_usage_window', 'Last {n} days').replace('{n}', String(w.days || 30))));
    if (w.dataFrom && w.startsAt && w.dataFrom > w.startsAt + 86400000) {
      head.appendChild(el('span', 'cw-sec-sum', t('claude_since', 'data since {date}').replace('{date}', fmtDay(w.dataFrom))));
    }
    face.appendChild(head);

    // A ledger, not a row of stat cards: label on the left, figure on the right,
    // one line each, so it reads like a statement.
    const ledger = el('dl', 'cw-ledger');
    const row = (label, value, note, cls) => {
      const r = el('div', 'cw-ledger-row' + (cls ? ' ' + cls : ''));
      r.appendChild(el('dt', null, label));
      const dd = el('dd');
      dd.appendChild(el('span', 'cw-ledger-v', value));
      if (note) dd.appendChild(el('span', 'cw-ledger-n', note));
      r.appendChild(dd);
      ledger.appendChild(r);
    };
    const tok = t('claude_tokens', 'tokens');
    row(t('claude_ledger_today', 'Today'), fmtTokens(u.today.tokens), tok);
    row(t('claude_since_monday', 'Since Monday'), fmtTokens(u.week.tokens), tok);
    row(t('claude_ledger_total', 'Total'), fmtTokens(w.tokens), tok);
    row(t('claude_cache_read', 'Read from cache'), fmtPct(u.cacheHitRate, 1),
      t('claude_cache_read_hint', 'of the input'));
    row(t('claude_ledger_value', 'API value'), fmtMoney(w.cost), t('claude_api_value_hint', 'at list prices'), 'is-value');
    face.appendChild(ledger);

    face.appendChild(daysChart(u));
    const split = el('div', 'cw-split');
    const p = projectList(u, w); if (p) split.appendChild(p);
    const m = modelList(u); if (m) split.appendChild(m);
    face.appendChild(split);
    return face;
  }

  // Thirty days on one axis, today on the right. Each column is that day's
  // tokens, the lower part what was read from cache. Mondays carry their date
  // so the week is findable; days with no work are an empty slot, not a gap in
  // the axis.
  function daysChart(u) {
    const wrap = el('div', 'cw-days');
    const chart = el('div', 'cw-days-bars');
    const max = u.daily.reduce((mx, d) => Math.max(mx, d.tokens), 0) || 1;
    const last = u.daily.length - 1;
    u.daily.forEach((d, i) => {
      const [y, mo, da] = d.day.split('-').map(Number);
      const date = new Date(y, mo - 1, da);
      const col = el('div', 'cw-day' + (i === last ? ' is-today' : '') + (date.getDay() === 1 ? ' is-monday' : ''));
      col.title = fmtDay(date.getTime()) + ' · ' + fmtTokens(d.tokens) + ' ' + t('claude_tokens', 'tokens');
      const h = d.tokens > 0 ? Math.max(2, Math.round((d.tokens / max) * 100)) : 0;
      // Two blocks, not an overlay: a translucent layer over the bar's own fill
      // came out LIGHTER than the rest, the opposite of what the legend said.
      const stack = el('div', 'cw-day-stack'); stack.style.height = h + '%';
      const cache = el('div', 'cw-day-cache');
      cache.style.height = (d.tokens > 0 ? Math.round(clamp(d.cacheRead / d.tokens, 0, 1) * 100) : 0) + '%';
      stack.appendChild(el('div', 'cw-day-fresh'));
      stack.appendChild(cache);
      col.appendChild(stack);
      if (date.getDay() === 1 || i === last) col.appendChild(el('span', 'cw-day-tick', String(date.getDate())));
      chart.appendChild(col);
    });
    wrap.appendChild(chart);
    const legend = el('div', 'cw-days-legend');
    const item = (cls, text) => { const s = el('span', 'cw-leg'); s.appendChild(el('i', cls)); s.appendChild(document.createTextNode(text)); return s; };
    legend.appendChild(item('is-cache', t('claude_leg_cache', 'read from cache')));
    legend.appendChild(item('is-fresh', t('claude_leg_fresh', 'everything else')));
    wrap.appendChild(legend);
    return wrap;
  }

  function projectList(u, w) {
    if (!u.projects || !u.projects.length) return null;
    const box = el('div', 'cw-projects');
    box.appendChild(el('div', 'cw-sec-title', t('claude_projects', 'Projects')));
    const total = w.tokens || u.projects.reduce((s, x) => s + x.tokens, 0) || 1;
    u.projects.slice(0, 6).forEach((x) => {
      const r = el('div', 'cw-bar-row');
      r.appendChild(el('span', 'cw-bar-name', x.name));
      const track = el('span', 'cw-bar-track');
      const fill = el('span', 'cw-bar-fill'); fill.style.width = clamp((x.tokens / total) * 100, 0.5, 100).toFixed(1) + '%';
      track.appendChild(fill);
      r.appendChild(track);
      // Share of the whole window, so the column adds up to 100 with the rest.
      const pct = (x.tokens / total) * 100;
      r.appendChild(el('span', 'cw-bar-val', fmtPct(pct / 100, pct >= 10 ? 0 : 1)));
      box.appendChild(r);
    });
    const more = (u.projectCount || u.projects.length) - Math.min(6, u.projects.length);
    if (more > 0) box.appendChild(el('div', 'cw-bar-more', t('claude_more_projects', '+{n} more').replace('{n}', String(more))));
    return box;
  }

  function modelList(u) {
    const models = (u.models || []).filter((m) => m.tokens > 0);
    if (!models.length) return null;
    const box = el('div', 'cw-models');
    box.appendChild(el('div', 'cw-sec-title', t('claude_models', 'Models')));
    const total = models.reduce((s, x) => s + x.tokens, 0) || 1;
    const bar = el('div', 'cw-model-bar');
    models.forEach((m) => {
      const seg = el('span', 'cw-model-seg');
      seg.style.width = ((m.tokens / total) * 100).toFixed(2) + '%';
      seg.style.background = modelHue(m.model);
      bar.appendChild(seg);
    });
    box.appendChild(bar);
    models.slice(0, 4).forEach((m) => {
      const r = el('div', 'cw-model-row');
      const dot = el('i', 'cw-model-dot'); dot.style.background = modelHue(m.model);
      r.appendChild(dot);
      r.appendChild(el('span', 'cw-model-name', prettyModel(m.model)));
      r.appendChild(el('span', 'cw-model-tok', fmtTokens(m.tokens)));
      r.appendChild(el('span', 'cw-model-cost', fmtMoney(m.cost)));
      box.appendChild(r);
    });
    return box;
  }

  return { quotaPanel, usageFace };
};
