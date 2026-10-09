'use strict';
// The Claude tile's console: the selected session, drawn the way Claude Code
// draws itself in a terminal. The pieces here are the ones that come straight
// from the session's live record — the header, the status line with its ✻
// spinner, the todo checklist (☐ ◼ ☒) and the tool log (⏺ Tool(arg) / ⎿).
// The thread, the prompt box and the decision cards own state and stay in
// claude-widget.js, which assembles the console from these and those.
//
// Untrusted text (titles, tool details, todo text) only ever reaches the page
// through textContent, via the el() factory.
(function () {
  const MAX_TODOS = 8;
  const MAX_ACTS = 4;
  const VERBS = 6;           // claude_verb_1..6, the spinner's words while thinking

  // Claude Code's permission modes, as its own footer names them. `default`
  // says nothing; every other one changes what reaches you, so it is shown.
  const MODES = {
    acceptEdits: { glyph: '⏵⏵', key: 'claude_mode_accept', fb: 'accept edits on' },
    plan: { glyph: '⏸', key: 'claude_mode_plan', fb: 'plan mode on' },
    bypassPermissions: { glyph: '⏵⏵', key: 'claude_mode_bypass', fb: 'bypass permissions on', warn: true },
    auto: { glyph: '⏵⏵', key: 'claude_mode_auto', fb: 'auto mode on' },
    dontAsk: { glyph: '⏵⏵', key: 'claude_mode_dontask', fb: 'don’t ask on', warn: true },
  };

  function modeChip(h, mode) {
    const m = MODES[mode];
    if (!m) return null;
    const chip = h.el('span', 'cw-chip cw-chip-mode' + (m.warn ? ' is-warn' : ''));
    chip.appendChild(h.el('span', 'cw-chip-glyph', m.glyph));
    chip.appendChild(document.createTextNode(' ' + h.t(m.key, m.fb)));
    return chip;
  }

  // The same verb for a session for as long as it thinks, not a new one on
  // every repaint: a word that changes several times a second is noise.
  function verb(h, s) {
    const n = (window.ClaudeIdent.slot(String(s.id || '') + ':' + (s.startedAt || 0)) % VERBS) + 1;
    return h.t('claude_verb_' + n, 'Thinking');
  }

  function spinner(h, st) {
    const g = h.el('span', 'cw-spin' + (st === 'working' ? ' is-on' : ''));
    g.setAttribute('aria-hidden', 'true');
    return g;
  }

  /** The line under the header: what the session is doing, terminal-style. */
  function status(h, s, st) {
    const line = h.el('div', 'cw-cs-status is-' + st);
    if (st === 'ended') {
      line.appendChild(h.el('span', 'cw-cs-glyph', '◌'));
      line.appendChild(h.el('span', 'cw-cs-word', h.endedLabel(s)));
      return line;
    }
    if (st === 'needs') {
      const w = s.waitFor || {};
      line.appendChild(h.el('span', 'cw-cs-glyph is-needs', '◆'));
      line.appendChild(h.el('span', 'cw-cs-word', w.kind === 'question' ? h.t('claude_wait_q', 'Waiting for your answer')
        : w.kind === 'error' ? h.t('claude_wait_err', 'The turn ended on an error')
          : h.t('claude_wait_perm', 'Waiting for your approval')));
      if (w.text) line.appendChild(h.el('span', 'cw-cs-detail', w.text));
      if (w.forMs != null) line.appendChild(h.ageNode('cw-cs-for', w.forMs, ''));
      return line;
    }
    if (st === 'working') {
      line.appendChild(spinner(h, st));
      if (s.compacting) {
        line.appendChild(h.el('span', 'cw-cs-word', h.t('claude_compacting', 'compacting the conversation') + '…'));
      } else if (s.tool) {
        line.appendChild(h.el('span', 'cw-cs-word', h.toolIntent(s.tool) + '…'));
        if (s.toolDetail) line.appendChild(h.el('span', 'cw-cs-detail', s.toolDetail));
      } else {
        line.appendChild(h.el('span', 'cw-cs-word', verb(h, s) + '…'));
      }
      const since = s.tool ? s.toolForMs : s.runForMs;
      if (since != null) {
        const age = h.ageNode('cw-cs-for', since, '');
        line.appendChild(age);
      }
      return line;
    }
    line.appendChild(h.el('span', 'cw-cs-glyph is-idle', '⏺'));
    line.appendChild(h.el('span', 'cw-cs-word', h.t('claude_cs_ready', 'Ready for your next message')));
    if (s.ageMs != null) line.appendChild(h.ageNode('cw-cs-for', s.ageMs, ''));
    return line;
  }

  /** Title, where it lives, and the chips: model, mode, effort, context, cost. */
  function head(h, s, who, st) {
    const box = h.el('div', 'cw-cs-head is-s' + who.slot);
    const mascot = h.el('span', 'cw-cs-clawd cw-clawd is-' + st);
    mascot.appendChild(window.ClaudeClawd.make('cw-clawd-svg'));
    box.appendChild(mascot);
    const names = h.el('div', 'cw-cs-names');
    names.appendChild(h.el('div', 'cw-cs-title', who.title || '?'));
    if (who.sub.length) names.appendChild(h.el('div', 'cw-cs-sub', who.sub.join(' · ')));
    box.appendChild(names);

    const chips = h.el('div', 'cw-cs-chips');
    if (s.model) {
      const m = h.el('span', 'cw-chip cw-chip-model', h.prettyModel(s.model));
      m.style.setProperty('--cw-chip-hue', h.modelHue(s.model));
      chips.appendChild(m);
    }
    const mode = modeChip(h, s.permissionMode);
    if (mode) chips.appendChild(mode);
    if (s.effort) chips.appendChild(h.el('span', 'cw-chip', h.t('claude_effort', 'effort') + ' ' + s.effort));
    if (typeof s.contextPct === 'number') chips.appendChild(h.ctxGauge(s.contextPct));
    if ((s.linesAdded || 0) + (s.linesRemoved || 0) > 0) {
      const lines = h.el('span', 'cw-chip cw-chip-lines');
      lines.appendChild(h.el('span', 'is-add', '+' + (s.linesAdded || 0)));
      lines.appendChild(h.el('span', 'is-del', '−' + (s.linesRemoved || 0)));
      chips.appendChild(lines);
    }
    if (s.cost > 0) chips.appendChild(h.el('span', 'cw-chip', h.fmtMoney(s.cost)));
    if (s.subagents && s.subagents.length) {
      const n = s.subagents.length;
      chips.appendChild(h.el('span', 'cw-chip', n === 1 ? h.t('claude_agents_1', '1 agent')
        : h.t('claude_agents_n', '{n} agents').replace('{n}', String(n))));
    }
    if (chips.childNodes.length) box.appendChild(chips);
    return box;
  }

  /** Claude Code's todo list, as its checklist: ☒ done, ◼ doing, ☐ to do. */
  function todos(h, s) {
    const list = Array.isArray(s.todos) ? s.todos : [];
    if (!list.length) return null;
    const box = h.el('div', 'cw-cs-todos');
    const done = list.filter((x) => x.status === 'done').length;
    box.appendChild(h.el('div', 'cw-cs-label', h.t('claude_cs_plan', 'Plan') + ' ' + done + '/' + list.length));
    // A long plan shows the window around the step in progress.
    const at = Math.max(0, list.findIndex((x) => x.status === 'doing'));
    const start = Math.max(0, Math.min(at - 2, list.length - MAX_TODOS));
    list.slice(start, start + MAX_TODOS).forEach((x) => {
      const row = h.el('div', 'cw-todo is-' + x.status);
      row.appendChild(h.el('span', 'cw-todo-box', x.status === 'done' ? '☒' : x.status === 'doing' ? '◼' : '☐'));
      row.appendChild(h.el('span', 'cw-todo-text', x.text));
      box.appendChild(row);
    });
    const hidden = list.length - Math.min(MAX_TODOS, list.length);
    if (hidden > 0) box.appendChild(h.el('div', 'cw-cs-more', '+' + hidden));
    return box;
  }

  /** The last few tool calls, the way the terminal prints them. */
  function activity(h, s) {
    const acts = (Array.isArray(s.activity) ? s.activity : []).slice(-MAX_ACTS);
    if (!acts.length) return null;
    const box = h.el('div', 'cw-cs-acts');
    acts.forEach((a) => {
      const row = h.el('div', 'cw-act' + (a.ok === false ? ' is-fail' : ''));
      const call = h.el('div', 'cw-act-call');
      call.appendChild(h.el('span', 'cw-act-dot', '⏺'));
      call.appendChild(h.el('span', 'cw-act-tool', window.ClaudeIdent.toolLabel(a.tool) || 'tool'));
      if (a.detail) call.appendChild(h.el('span', 'cw-act-arg', '(' + a.detail + ')'));
      row.appendChild(call);
      const res = a.ok === false ? h.t('claude_act_failed', 'failed') : (a.ms ? h.dur(a.ms) : h.t('claude_act_ok', 'done'));
      row.appendChild(h.el('div', 'cw-act-res', '⎿  ' + res));
      box.appendChild(row);
    });
    return box;
  }

  window.ClaudeConsole = { head, status, todos, activity, modeChip, MODES };
})();
