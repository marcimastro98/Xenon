'use strict';
// js/claude-agents.js — the Agents view of the Claude tile's side panel: the
// subagents a session started, what each is doing, and one of them in full
// (model, effort, context, its last tool calls). Also the slim summary the
// panel folds into when it is hidden.
//
// The data half (order, merge, counts) is plain and tested in node; the DOM
// half takes the tile's helpers (`h`, see consoleHelpers in claude-widget.js)
// and only ever writes untrusted text through textContent, via h.el().
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ClaudeAgents = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const G = typeof self !== 'undefined' ? self : globalThis;
  const STRIP_MARKS = 4;
  const LADDER_MAX = 12;

  function isRunning(a) { return !!a && a.status === 'running'; }

  // Running agents first, oldest on top (the order they were started in), then
  // the finished ones, most recent first.
  function order(agents) {
    const list = Array.isArray(agents) ? agents.slice() : [];
    return list.sort((a, b) => {
      if (isRunning(a) !== isRunning(b)) return isRunning(a) ? -1 : 1;
      return isRunning(a) ? (b.ageMs || 0) - (a.ageMs || 0) : (a.endedMs || 0) - (b.endedMs || 0);
    });
  }

  function counts(agents) {
    const list = Array.isArray(agents) ? agents : [];
    const running = list.filter(isRunning).length;
    return { running, done: list.length - running, total: list.length };
  }

  // The live entry wins; what the agent's own file says fills the gaps (an
  // older mod reports no model, effort or context).
  function merge(a, extra) {
    const x = extra && extra.ok ? extra : {};
    return {
      id: a.id,
      type: a.type || x.type || '',
      desc: a.desc || x.description || '',
      model: a.model || x.model || '',
      effort: a.effort || x.effort || '',
      tokens: a.tokens || x.tokens || 0,
      tools: Math.max(a.tools || 0, Array.isArray(x.tools) ? x.tools.length : 0),
      recent: Array.isArray(x.tools) ? x.tools : [],
      running: isRunning(a),
      tool: a.tool || '',
      detail: a.detail || '',
      last: a.last || '',
      ageMs: a.ageMs || 0,
      endedMs: a.endedMs || 0,
    };
  }

  // ── DOM ────────────────────────────────────────────────────────────────────
  function mark(h, a) {
    const slot = G.ClaudeIdent ? G.ClaudeIdent.slot(a.id) : 0;
    const m = h.el('span', 'cw-ag-mark is-s' + slot + (isRunning(a) ? ' cw-breathing' : ' is-done'));
    m.setAttribute('aria-hidden', 'true');
    return m;
  }

  function toolText(tool, detail) {
    const name = G.ClaudeIdent ? G.ClaudeIdent.toolLabel(tool) : tool;
    return detail ? name + '(' + detail + ')' : name;
  }

  function timeNode(h, a) {
    if (isRunning(a)) return h.ageNode('cw-ag-time', a.ageMs);
    return h.el('span', 'cw-ag-time is-done', h.t('claude_agent_done', 'Done'));
  }

  /** Every agent, one tappable row each. */
  function list(h, agents, onOpen) {
    const box = h.el('ul', 'cw-agents');
    order(agents).forEach((a) => {
      const li = h.el('li', '');
      const row = h.el('button', 'cw-ag-row' + (isRunning(a) ? '' : ' is-done')); row.type = 'button';
      row.appendChild(mark(h, a));
      const main = h.el('span', 'cw-ag-main');
      main.appendChild(h.el('span', 'cw-ag-title', a.desc || a.type || h.t('claude_agent', 'Agent')));
      const sub = isRunning(a) && a.tool ? toolText(a.tool, a.detail) : (a.desc ? a.type : '');
      if (sub) main.appendChild(h.el('span', 'cw-ag-sub', sub));
      row.appendChild(main);
      row.appendChild(timeNode(h, a));
      row.addEventListener('click', () => onOpen(a.id));
      li.appendChild(row);
      box.appendChild(li);
    });
    return box;
  }

  function field(h, grid, label, value, cls) {
    if (!value && value !== 0) return;
    grid.appendChild(h.el('dt', '', label));
    const dd = typeof value === 'string' || typeof value === 'number' ? h.el('dd', cls || '', String(value)) : h.el('dd', cls || '');
    if (typeof value === 'object') dd.appendChild(value);
    grid.appendChild(dd);
  }

  /** One agent in full. `a` is the live entry, `extra` what its file says (or null). */
  function detail(h, a, extra, onBack) {
    const m = merge(a, extra);
    const box = h.el('div', 'cw-agent');
    const head = h.el('div', 'cw-ag-head');
    const back = h.el('button', 'cw-ag-back', '‹'); back.type = 'button';
    const backLabel = h.t('claude_agent_back', 'All agents');
    back.title = backLabel;
    back.setAttribute('aria-label', backLabel);
    back.addEventListener('click', onBack);
    head.appendChild(back);
    head.appendChild(mark(h, a));
    const names = h.el('div', 'cw-ag-names');
    names.appendChild(h.el('div', 'cw-ag-title', m.desc || m.type || h.t('claude_agent', 'Agent')));
    if (m.desc && m.type) names.appendChild(h.el('div', 'cw-ag-sub', m.type));
    head.appendChild(names);
    box.appendChild(head);

    const grid = h.el('dl', 'cw-ag-facts');
    if (m.model) {
      const model = h.el('span', 'cw-ag-model', h.prettyModel(m.model));
      model.style.setProperty('--cw-chip-hue', h.modelHue(m.model));
      field(h, grid, h.t('claude_agent_model', 'Model'), model);
    }
    field(h, grid, h.t('claude_agent_effort', 'Effort'), m.effort);
    field(h, grid, h.t('claude_agent_status', 'Status'), m.running
      ? h.t('claude_agent_running', 'Running') : h.t('claude_agent_done', 'Done'), m.running ? 'is-run' : 'is-done');
    field(h, grid, h.t('claude_agent_time', 'Time'), m.running
      ? h.ageNode('', m.ageMs) : h.dur(Math.max(0, m.ageMs - m.endedMs)));
    field(h, grid, h.t('claude_agent_tools', 'Tool calls'), m.tools || 0);
    if (m.tokens) field(h, grid, h.t('claude_agent_context', 'Context'), h.hTok(m.tokens) + ' ' + h.t('claude_tokens', 'tokens'));
    box.appendChild(grid);

    // The newest calls from its own file; with no file yet, at least the live one.
    const recent = m.recent.length ? m.recent : (m.tool ? [{ tool: m.tool, detail: m.detail }] : []);
    if (recent.length) {
      box.appendChild(h.el('div', 'cw-cs-label', h.t('claude_agent_recent', 'Last tool calls')));
      const log = h.el('div', 'cw-cs-acts');
      recent.slice().reverse().forEach((r, i) => {
        const call = h.el('div', 'cw-act-call');
        call.appendChild(h.el('span', 'cw-act-dot' + (i === 0 && m.running ? ' cw-breathing' : ''), '⏺'));
        call.appendChild(h.el('span', 'cw-act-tool', G.ClaudeIdent ? G.ClaudeIdent.toolLabel(r.tool) : r.tool));
        if (r.detail) call.appendChild(h.el('span', 'cw-act-arg', '(' + r.detail + ')'));
        const row = h.el('div', 'cw-act');
        row.appendChild(call);
        log.appendChild(row);
      });
      box.appendChild(log);
    }
    if (!m.running && m.last) {
      box.appendChild(h.el('div', 'cw-cs-label', h.t('claude_agent_last', 'Its last word')));
      box.appendChild(h.el('div', 'cw-ag-last', m.last));
    }
    return box;
  }

  // One segment per plan step, or null when there are too many to tell apart
  // (the strip then draws one continuous bar).
  function ladder(steps) {
    const list = Array.isArray(steps) ? steps : [];
    if (!list.length || list.length > LADDER_MAX) return null;
    return list.map((st) => (st === 'done' || st === 'doing' ? st : 'todo'));
  }

  // A small Clawd in the agent's colour: walking while it works, asleep once done.
  function stripAgent(h, a) {
    const slot = G.ClaudeIdent ? G.ClaudeIdent.slot(a.id) : 0;
    const box = h.el('span', 'cw-strip-agent');
    const sprite = h.el('span', 'cw-strip-clawd cw-clawd is-s' + slot + (isRunning(a) ? ' is-working' : ' is-ended'));
    sprite.appendChild(G.ClaudeClawd.make('cw-clawd-svg'));
    box.appendChild(sprite);
    if (isRunning(a)) box.appendChild(h.ageNode('cw-strip-time', a.ageMs));
    return box;
  }

  function stripPlan(h, plan) {
    const p = h.el('span', 'cw-strip-plan');
    p.appendChild(h.el('span', 'cw-strip-v', plan.done + '/' + plan.total));
    const steps = ladder(plan.steps);
    const rail = h.el('span', 'cw-strip-ladder' + (steps ? '' : ' is-bar'));
    if (steps) {
      steps.forEach((st) => rail.appendChild(h.el('span', 'cw-strip-step is-' + st + (st === 'doing' ? ' cw-breathing' : ''))));
    } else {
      const fill = h.el('span', 'cw-strip-fill');
      fill.style.setProperty('--cw-plan', Math.round(plan.done * 100 / plan.total) + '%');
      rail.appendChild(fill);
    }
    p.appendChild(rail);
    return p;
  }

  /**
   * The hidden panel, folded to what is worth a glance: one small Clawd per
   * agent and the plan's steps, when there are any. A tap opens the panel again.
   * @param {{done:number,total:number,steps?:string[]}|null} plan
   */
  function strip(h, plan, agents, onOpen) {
    const list = order(agents);
    const b = h.el('button', 'cw-aside-strip'); b.type = 'button';
    // The narrow strip has room for figures only, so the words go in the label.
    const said = [];
    b.appendChild(h.el('span', 'cw-strip-open', '‹'));
    if (list.length && G.ClaudeClawd) {
      const g = h.el('span', 'cw-strip-agents');
      list.slice(0, STRIP_MARKS).forEach((a) => g.appendChild(stripAgent(h, a)));
      if (list.length > STRIP_MARKS) g.appendChild(h.el('span', 'cw-strip-more', '+' + (list.length - STRIP_MARKS)));
      b.appendChild(g);
      const c = counts(list);
      said.push(c.running ? h.t('claude_agents_running', '{n} agents running').replace('{n}', String(c.running))
        : h.t('claude_agents_n', '{n} agents').replace('{n}', String(c.total)));
    }
    if (plan && plan.total) {
      b.appendChild(stripPlan(h, plan));
      said.push(h.t('claude_cs_plan', 'Plan') + ' ' + plan.done + '/' + plan.total);
    }
    const label = h.t('claude_aside_show', 'Show the side panel') + (said.length ? ': ' + said.join(', ') : '');
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', () => onOpen(list.some(isRunning) ? 'agents' : ''));
    return b;
  }

  return { order, counts, merge, isRunning, ladder, list, detail, strip, STRIP_MARKS };
});
