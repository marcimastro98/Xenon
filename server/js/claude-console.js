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
    // Idle in a terminal with the mod listening: the model and effort chips are
    // menus and Compact is a button, each one a command typed into the session.
    // The mode stays a label: Claude Code has no command that sets it.
    const ctl = h.controls ? h.controls(s) : null;
    if (ctl) {
      chips.appendChild(ctl.modelSelect(s.model));
    } else if (s.model) {
      const m = h.el('span', 'cw-chip cw-chip-model', h.prettyModel(s.model));
      m.style.setProperty('--cw-chip-hue', h.modelHue(s.model));
      chips.appendChild(m);
    }
    const mode = modeChip(h, s.permissionMode);
    if (mode) chips.appendChild(mode);
    if (ctl) chips.appendChild(ctl.effortSelect(s.effort));
    else if (s.effort) chips.appendChild(h.el('span', 'cw-chip', h.t('claude_effort', 'effort') + ' ' + s.effort));
    if (ctl) chips.appendChild(ctl.compactButton());
    if (typeof s.contextPct === 'number') chips.appendChild(h.ctxGauge(s.contextPct));
    if ((s.linesAdded || 0) + (s.linesRemoved || 0) > 0) {
      const lines = h.el('span', 'cw-chip cw-chip-lines');
      lines.appendChild(h.el('span', 'is-add', '+' + (s.linesAdded || 0)));
      lines.appendChild(h.el('span', 'is-del', '−' + (s.linesRemoved || 0)));
      chips.appendChild(lines);
    }
    if (s.cost > 0) chips.appendChild(h.el('span', 'cw-chip', h.fmtMoney(s.cost)));
    // Finished agents stay in the panel a while; the chip counts the working ones
    // and opens the Agents view.
    const n = (s.subagents || []).filter((a) => a.status === 'running').length;
    if (n) {
      const chip = h.el('button', 'cw-chip cw-chip-btn', n === 1 ? h.t('claude_agents_1', '1 agent')
        : h.t('claude_agents_n', '{n} agents').replace('{n}', String(n)));
      chip.type = 'button';
      if (h.openAgents) chip.addEventListener('click', h.openAgents);
      chips.appendChild(chip);
    }
    if (chips.childNodes.length) box.appendChild(chips);
    return box;
  }

  /** Claude Code's todo list, as its checklist: ☒ done, ◼ doing, ☐ to do. */
  // `full` is the Plan view of the side panel: every step, each on as many
  // lines as it needs, with a progress bar. Without it, the compact window.
  function todos(h, s, full) {
    const list = Array.isArray(s.todos) ? s.todos : [];
    if (!list.length) return null;
    const box = h.el('div', 'cw-cs-todos' + (full ? ' is-full' : ''));
    const done = list.filter((x) => x.status === 'done').length;
    box.appendChild(h.el('div', 'cw-cs-label', h.t('claude_cs_plan', 'Plan') + ' ' + done + '/' + list.length));
    if (full) {
      const bar = h.el('div', 'cw-plan-bar');
      bar.setAttribute('aria-hidden', 'true');
      const fill = h.el('span', 'cw-plan-fill');
      fill.style.setProperty('--cw-plan', Math.round(done * 100 / list.length) + '%');
      bar.appendChild(fill);
      box.appendChild(bar);
    }
    // A long plan shows the window around the step in progress.
    const at = Math.max(0, list.findIndex((x) => x.status === 'doing'));
    const cap = full ? list.length : MAX_TODOS;
    const start = full ? 0 : Math.max(0, Math.min(at - 2, list.length - cap));
    list.slice(start, start + cap).forEach((x) => {
      const row = h.el('div', 'cw-todo is-' + x.status);
      row.appendChild(h.el('span', 'cw-todo-box', x.status === 'done' ? '☒' : x.status === 'doing' ? '◼' : '☐'));
      row.appendChild(h.el('span', 'cw-todo-text', x.text));
      box.appendChild(row);
    });
    const hidden = list.length - Math.min(cap, list.length);
    if (hidden > 0) box.appendChild(h.el('div', 'cw-cs-more', '+' + hidden));
    return box;
  }

  // Which edits the user opened. The tile is rebuilt on every push, so the open
  // state lives here and not on the node.
  const openChanges = new Set();

  /** "Added 3 lines, removed 1", and on a tap the lines themselves, + green and - red. */
  function change(h, a, key) {
    const c = a.change;
    const wrap = h.el('div', 'cw-chg');
    const plus = c.add ? h.t('claude_chg_added', 'added') + ' ' + c.add : '';
    const minus = c.del ? h.t('claude_chg_removed', 'removed') + ' ' + c.del : '';
    const sum = h.el('button', 'cw-chg-sum');
    sum.type = 'button';
    sum.appendChild(h.el('span', 'cw-chg-file', c.file));
    if (plus) sum.appendChild(h.el('span', 'is-add', plus));
    if (minus) sum.appendChild(h.el('span', 'is-del', minus));
    wrap.appendChild(sum);
    // Older edits (and files that may hold secrets) arrive without lines.
    if (!c.lines || !c.lines.length) { sum.disabled = true; return wrap; }
    const body = h.el('div', 'cw-chg-body');
    c.lines.forEach((l) => body.appendChild(h.el('div', 'cw-chg-l ' + (l.k === '+' ? 'is-add' : 'is-del'), l.k + ' ' + l.t)));
    const set = (open) => {
      body.hidden = !open;
      sum.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    set(openChanges.has(key));
    sum.addEventListener('click', () => {
      if (openChanges.has(key)) openChanges.delete(key); else openChanges.add(key);
      set(openChanges.has(key));
    });
    wrap.appendChild(body);
    return wrap;
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
      if (a.change) row.appendChild(change(h, a, (s.id || '') + ':' + a.at));
      box.appendChild(row);
    });
    return box;
  }

  window.ClaudeConsole = { head, status, todos, activity, modeChip, MODES };
})();
