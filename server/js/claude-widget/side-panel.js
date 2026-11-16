// The panel beside the conversation: its Activity, Plan and Agents views, the plan as a roadmap,
// the agents announced once, and the strip shown when the panel is hidden.
'use strict';

window.ClaudeWidgetSidePanel = (wrapper) => {
  const { api, paint, toggleCollapsed, asideHide } = wrapper;

  const { t } = window.ClaudeWidgetWords;
  const { isCollapsed } = window.ClaudeWidgetKnown;
  const { el } = window.ClaudeWidgetLines;
  const { ui } = window.ClaudeWidgetConsoleState;

  // The panel beside the conversation: the tool log, and the plan when the
  // session has one. Null when there is nothing to show.
  // `proposal` is the plan Claude wrote and is waiting to have approved.
  // The plan each session last showed on the Plan tab: a newer one opens the tab once.
  const planSeen = new Map();   // session id → planAt
  const roadmapAt = new Map();  // session id + plan → the phase the work has reached
  // A plan written before Xenon started is not in the live feed: read it back
  // from the transcript once per session, then keep the answer (even an empty one).
  const planRecovered = new Map();   // session id → { plan, at } | 'pending'
  function recoveredPlan(s) {
    const got = planRecovered.get(s.id);
    if (got === 'pending') return null;
    if (got) return got;
    planRecovered.set(s.id, 'pending');
    api('/api/claude/plan?session=' + encodeURIComponent(s.id)).then((d) => {
      planRecovered.set(s.id, { plan: d && d.ok ? d.plan : '', at: d && d.ok ? d.at : 0 });
      if (d && d.ok && d.plan) paint();
    });
    return null;
  }

  // The plan's phases as a roadmap: done ones filled, the one being worked lit,
  // the rest waiting. Null when the plan has no clear steps.
  function roadmapRows(s, planText, running) {
    const R = window.ClaudeRoadmap;
    const phases = R && planText ? R.parsePhases(planText) : [];
    if (phases.length < 2) return null;
    const key = s.id + ':' + (s.planAt || 0);
    const at = R.advance(roadmapAt.get(key) || 0, phases, s.activity, s.planAt);
    roadmapAt.set(key, at);
    return R.roadmap(phases, s.todos, at, running);
  }
  function roadmapList(s, planText, running) {
    const rows = roadmapRows(s, planText, running);
    if (!rows) return null;
    const list = el('ol', 'cw-roadmap');
    rows.forEach((r, i) => {
      const li = el('li', 'cw-rm-step is-' + r.state);
      li.appendChild(el('span', 'cw-rm-dot' + (r.state === 'doing' ? ' cw-breathing' : ''), r.state === 'done' ? '✓' : String(i + 1)));
      li.appendChild(el('span', 'cw-rm-title', r.title));
      list.appendChild(li);
    });
    return list;
  }
  // ── agents ──
  const agentsSeen = new Map();   // session id → Set of agent ids already announced
  // What an agent's own file says, read when it is opened and again whenever
  // its tool count or status moves: model, effort and context from an older mod.
  const agentExtra = new Map();   // session id:agent id → { key, data }
  function agentFile(sid, a) {
    const k = sid + ':' + a.id;
    const key = a.status + ':' + (a.tools || 0);
    const got = agentExtra.get(k);
    if (got && got.key === key) return got.data;
    agentExtra.set(k, { key, data: got ? got.data : null });
    if (agentExtra.size > 64) agentExtra.delete(agentExtra.keys().next().value);
    api('/api/claude/agent?session=' + encodeURIComponent(sid) + '&id=' + encodeURIComponent(a.id)).then((d) => {
      const cur = agentExtra.get(k);
      if (!cur || cur.key !== key || !d || !d.ok) return;
      cur.data = d;
      paint();
    });
    return got ? got.data : null;
  }
  function noteNewAgents(s, pending) {
    const list = Array.isArray(s.subagents) ? s.subagents : [];
    let seen = agentsSeen.get(s.id);
    if (!seen) { seen = new Set(); agentsSeen.set(s.id, seen); }
    const fresh = list.some((a) => a.status === 'running' && !seen.has(a.id));
    list.forEach((a) => seen.add(a.id));
    if (fresh && !pending) { ui.asideView = 'agents'; ui.agentSel = ''; }
  }
  function openAgents() {
    ui.asideView = 'agents'; ui.agentSel = '';
    if (isCollapsed('aside')) toggleCollapsed('aside'); else paint();
  }
  function agentsView(h, s) {
    const list = s.subagents;
    const sel = ui.agentSel && list.find((a) => a.id === ui.agentSel);
    if (!sel) {
      ui.agentSel = '';
      return window.ClaudeAgents.list(h, list, (id) => { ui.agentSel = id; paint(); });
    }
    return window.ClaudeAgents.detail(h, sel, agentFile(s.id, sel), () => { ui.agentSel = ''; paint(); });
  }
  // The hidden panel's summary: plan progress and the agents, when there are any.
  // The plan's steps are the ones the Plan view shows: the written plan's
  // phases when it has them, else the todo list.
  function asideStrip(h, s, proposal) {
    const rows = roadmapRows(s, proposal, s.state === 'running');
    const steps = rows ? rows.map((r) => r.state) : (Array.isArray(s.todos) ? s.todos.map((x) => x.status) : []);
    const plan = steps.length ? { done: steps.filter((st) => st === 'done').length, total: steps.length, steps } : null;
    return window.ClaudeAgents.strip(h, plan, s.subagents || [], (view) => {
      if (view) { ui.asideView = view; ui.agentSel = ''; }
      toggleCollapsed('aside');
    });
  }

  function sidePanel(h, s, proposal, pending) {
    const todos = window.ClaudeConsole.todos(h, s, true);
    const acts = window.ClaudeConsole.activity(h, s);
    const agents = Array.isArray(s.subagents) && s.subagents.length > 0;
    if (!todos && !acts && !proposal && !agents) return null;
    const plan = todos || proposal ? true : null;
    // A plan waiting for approval, or one just written, opens on the Plan view.
    if (s.planAt && planSeen.get(s.id) !== s.planAt) { planSeen.set(s.id, s.planAt); ui.asideView = 'plan'; }
    const views = [];
    if (acts) views.push(['activity', t('claude_aside_tools', 'Activity')]);
    if (plan) views.push(['plan', t('claude_cs_plan', 'Plan')]);
    if (agents) views.push(['agents', t('claude_aside_agents', 'Agents')]);
    let view = views.some(([key]) => key === ui.asideView) ? ui.asideView : '';
    if (!view) view = plan && (pending || !acts) ? 'plan' : views[0][0];
    const aside = el('div', 'cw-cs-aside');
    const bar = el('div', 'cw-aside-bar');
    if (views.length > 1) {
      const tabs = el('div', 'cw-aside-tabs'); tabs.setAttribute('role', 'tablist');
      views.forEach(([key, label]) => {
        const tab = el('button', 'cw-aside-tab' + (key === view ? ' is-on' : ''), label); tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', key === view ? 'true' : 'false');
        tab.addEventListener('click', () => { ui.asideView = key; if (key === 'agents') ui.agentSel = ''; paint(); });
        tabs.appendChild(tab);
      });
      bar.appendChild(tabs);
    }
    bar.appendChild(asideHide());
    aside.appendChild(bar);
    if (view === 'agents') {
      aside.appendChild(agentsView(h, s));
    } else if (view === 'plan') {
      const road = proposal ? roadmapList(s, proposal, s.state === 'running') : null;
      if (road) aside.appendChild(road);
      // The roadmap replaces the wall of text; the full plan stays one tap away,
      // and while it waits for approval it is shown open (it is what you approve).
      if (proposal && road) {
        const full = document.createElement('details');
        full.className = 'cw-aside-full';
        full.open = !!pending;
        full.appendChild(el('summary', '', t('claude_plan_full', 'Full plan')));
        full.appendChild(el('div', 'cw-aside-proposal', proposal));
        aside.appendChild(full);
      } else if (proposal) aside.appendChild(el('div', 'cw-aside-proposal', proposal));
      // The todo list is the roadmap itself when it has one entry per phase.
      if (todos && !(road && Array.isArray(s.todos) && road.children.length === s.todos.length)) aside.appendChild(todos);
    } else {
      const compact = window.ClaudeConsole.todos(h, s);
      if (compact) aside.appendChild(compact);
      aside.appendChild(acts);
    }
    return aside;
  }

  return { sidePanel, asideStrip, noteNewAgents, recoveredPlan, openAgents };
};
