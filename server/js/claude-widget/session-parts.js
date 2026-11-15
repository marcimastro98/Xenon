// Small parts of a session in the Claude tile: how full its context is, a reply on its way, the
// requests waiting, the bar for one waiting elsewhere, and the card of a run.
'use strict';

window.ClaudeWidgetSessionParts = (wrapper) => {
  const { cancelReply, decisionCard, select, runChips, consoleHelpers, stopRun } = wrapper;

  const { t, runStateText } = window.ClaudeWidgetWords;
  const { clamp } = window.ClaudeWidgetModelWords;
  const { sessionById, titles } = window.ClaudeWidgetKnown;
  const { el } = window.ClaudeWidgetLines;

  function ctxGauge(pct) {
    const p = clamp(Math.round(pct), 0, 100);
    const g = el('span', 'cw-ctx' + (p >= 90 ? ' is-crit' : p >= 75 ? ' is-warn' : ''));
    g.title = t('claude_ctx_hint', 'How full the context window is');
    const bar = el('span', 'cw-ctx-bar');
    const fill = el('span', 'cw-ctx-fill'); fill.style.width = p + '%';
    bar.appendChild(fill);
    g.appendChild(bar);
    g.appendChild(el('span', 'cw-ctx-val', t('claude_ctx', 'ctx') + ' ' + p + '%'));
    return g;
  }

  // A follow-up already on its way: queued until the turn ends, or on its way
  // to the open session. Cancellable until the mod has taken it.
  function queuedRow(s) {
    const q = el('div', 'cw-queued');
    const waiting = s.state === 'running' || s.state === 'waiting';
    const label = s.queued.via === 'terminal' && !waiting
      ? t('claude_queued_terminal', 'Sending to the open session…')
      : t('claude_queued', 'Queued for the end of this turn');
    q.appendChild(el('span', 'cw-queued-label', label));
    q.appendChild(el('span', 'cw-queued-text', s.queued.text));
    if (s.queued.handed) return q;
    const undo = el('button', 'cw-link-btn'); undo.type = 'button';
    undo.textContent = t('claude_queued_cancel', 'Cancel');
    undo.addEventListener('click', () => cancelReply(s.id));
    q.appendChild(undo);
    return q;
  }

  function decisionStack(list) {
    if (!list.length) return null;
    const box = el('div', 'cw-decs');
    if (list.length > 1) box.classList.add('is-pair');
    list.slice(0, 2).forEach((a) => box.appendChild(decisionCard(a, false)));
    const more = (n) => t('claude_more_waiting', '{n} more waiting').replace('{n}', String(n));
    if (list.length > 2) box.appendChild(el('div', 'cw-decs-more', more(list.length - 2)));
    // Stacked, the tile holds only the first card (CSS), so its count starts one earlier.
    if (list.length > 1) box.appendChild(el('div', 'cw-decs-more cw-decs-stacked', more(list.length - 1)));
    return box;
  }

  function othersBar(others) {
    const a = others[0];
    const s = sessionById(a.sessionId);
    const who = window.ClaudeIdent.describe(s || { id: a.sessionId, project: a.project }, titles());
    const bar = el('button', 'cw-elsewhere is-s' + who.slot); bar.type = 'button';
    const mascot = el('span', 'cw-clawd is-needs');
    mascot.appendChild(window.ClaudeClawd.make('cw-clawd-svg'));
    bar.appendChild(mascot);
    const txt = el('span', 'cw-elsewhere-t');
    txt.appendChild(el('strong', '', who.title || '?'));
    txt.appendChild(document.createTextNode(' ' + (a.kind === 'question'
      ? t('claude_wait_q', 'Waiting for your answer') : t('claude_wait_perm', 'Waiting for your approval'))));
    bar.appendChild(txt);
    if (others.length > 1) bar.appendChild(el('span', 'cw-elsewhere-more', '+' + (others.length - 1)));
    bar.appendChild(el('span', 'cw-elsewhere-go', t('claude_notice_go', 'open')));
    bar.addEventListener('click', () => select(a.sessionId, a.project || ''));
    return bar;
  }

  // A run in progress, or its result. Deliberately plain: the interesting part
  // is the text Claude produced, so it gets the room.
  function runCard(r) {
    const card = el('div', 'cw-run is-' + r.state);
    const head = el('div', 'cw-run-head');
    head.appendChild(el('span', 'cw-run-badge', t('claude_run_badge', 'Xenon run')));
    head.appendChild(el('span', 'cw-run-proj', r.project || ''));
    head.appendChild(el('span', 'cw-run-state', runStateText(r)));
    card.appendChild(head);

    const chips = runChips(r);
    if (chips) card.appendChild(chips);
    card.appendChild(el('div', 'cw-run-prompt', r.prompt));
    // What the run is doing now and its last tool calls, as the console shows
    // them for a session open in a terminal.
    if (r.state === 'running') {
      card.appendChild(window.ClaudeConsole.status(consoleHelpers(),
        { id: r.id, tool: r.tool, toolDetail: r.toolDetail, runForMs: r.elapsedMs }, 'working'));
    }
    const acts = window.ClaudeConsole.activity(consoleHelpers(), r);
    if (acts) card.appendChild(acts);
    if (r.output) card.appendChild(el('div', 'cw-run-out', r.output));
    if (r.state === 'failed' && r.error) card.appendChild(el('div', 'cw-run-err', r.error));

    if (r.state === 'running') {
      const stop = el('button', 'cw-run-stop'); stop.type = 'button';
      stop.textContent = t('claude_run_stop', 'Stop');
      stop.addEventListener('click', () => stopRun(r.id));
      card.appendChild(stop);
    }
    return card;
  }

  return { ctxGauge, queuedRow, decisionStack, othersBar, runCard };
};
