// The lines the Claude tile is drawn from: an age that keeps counting, the pace of a quota window,
// a numbered row, the head of a card that asks, what a session is doing now, and a run of tool
// calls. Every text goes in as text; nothing here answers Claude or asks the server.
'use strict';

(() => {
  const { t, dur, fmtWhen, endedLabel, toolIntent } = window.ClaudeWidgetWords;
  const { mmss, prettyModel } = window.ClaudeWidgetModelWords;
  const { aged } = window.ClaudeWidgetKnown;

  const el = makeEl;        // shared DOM factory (utils.js)

  function ageNode(cls, msAtSend, prefix) {
    const n = el('span', cls);
    n.dataset.ageBase = String(Number(msAtSend) || 0);
    n.dataset.agePrefix = prefix || '';
    n.textContent = (prefix || '') + dur(aged(msAtSend));
    return n;
  }

  // Below this share of the window elapsed, the pace is mostly noise.
  const PACE_MIN_ELAPSED = 0.15;

  function paceLine(used, elapsed, start, reset) {
    if (!reset || elapsed === null || elapsed < PACE_MIN_ELAPSED || used <= 0) return null;
    const projected = used / elapsed;
    if (projected >= 100) {
      const hitAt = start + (Date.now() - start) * (100 / used);
      return el('div', 'cw-pace is-warn',
        t('claude_pace_hit', 'At this pace you reach the limit at {time}').replace('{time}', fmtWhen(hitAt)));
    }
    return el('div', 'cw-pace',
      t('claude_pace_end', 'At this pace you end this window at {pct}%').replace('{pct}', String(Math.round(projected))));
  }

  // One numbered row, the shape the terminal's own lists have. `keep` names it
  // across rebuilds, so the keyboard stays on it.
  function optRow(n, label, desc, picked, disabled, onTap, keep) {
    const btn = el('button', 'cw-opt' + (picked ? ' is-picked' : ''));
    btn.type = 'button';
    btn.dataset.keep = keep;
    btn.setAttribute('aria-pressed', picked ? 'true' : 'false');
    btn.disabled = disabled;
    btn.appendChild(el('span', 'cw-opt-n', String(n)));
    const text = el('span', 'cw-opt-text');
    text.appendChild(el('span', 'cw-opt-label', label));
    if (desc) text.appendChild(el('span', 'cw-opt-desc', desc));
    btn.appendChild(text);
    btn.addEventListener('click', onTap);
    return btn;
  }

  function timerOf(a) {
    const left = el('span', 'cw-dec-timer');
    // "8:42" alone reads as a time of day; the template says it is what is left.
    left.dataset.expiresAt = String(Date.now() + (a.expiresInMs || 0));
    left.dataset.tpl = t('claude_dec_left', '{t} left');
    left.textContent = left.dataset.tpl.replace('{t}', mmss(a.expiresInMs));
    return left;
  }

  function tileHead(a) {
    const head = el('div', 'cw-dec-head');
    head.appendChild(el('span', 'cw-dec-kind', a.kind === 'question' ? t('claude_question', 'Question')
      : a.kind === 'plan' ? t('claude_xp_kind', 'Plan') : t('claude_permission', 'Permission')));
    const where = el('span', 'cw-dec-where');
    where.textContent = [a.project, prettyModel(a.model)].filter(Boolean).join(' · ');
    head.appendChild(where);
    const left = timerOf(a);
    left.title = t('claude_dec_expires', 'After this the terminal asks instead');
    head.appendChild(left);
    return head;
  }

  // The rail (js/claude-rail.js) and the console (js/claude-console.js) draw
  // them; the helpers they share live here, next to the words they use.
  const QUIET_MS = 2 * 60 * 1000;      // "working" with no event for this long says so

  // One line of what a session is doing, for its rail card.
  function nowLine(s, st) {
    const line = el('div', 'cw-lane-now');
    if (st === 'ended') { line.appendChild(el('span', 'cw-lane-state', endedLabel(s))); return line; }
    if (s.compacting) { line.appendChild(el('span', 'cw-lane-state', t('claude_compacting', 'compacting the conversation'))); return line; }
    if (st === 'needs') {
      const w = s.waitFor || {};
      line.appendChild(el('span', 'cw-lane-ask', w.kind === 'permission' ? t('claude_wait_perm', 'Waiting for your approval')
        : w.kind === 'question' ? t('claude_wait_q', 'Waiting for your answer')
          : w.kind === 'error' ? t('claude_wait_err', 'The turn ended on an error')
            : t('claude_state_waiting', 'waiting for you')));
      return line;
    }
    if (st === 'working' && s.tool) {
      line.appendChild(el('span', 'cw-spin is-on'));
      line.appendChild(el('span', 'cw-lane-intent', toolIntent(s.tool)));
      if (s.toolDetail) line.appendChild(el('span', 'cw-lane-detail', s.toolDetail));
      return line;
    }
    if (st === 'working' && s.ageMs > QUIET_MS) {
      line.appendChild(el('span', 'cw-lane-state', t('claude_thinking', 'Thinking')));
      line.appendChild(ageNode('cw-lane-for is-quiet', s.ageMs, t('claude_quiet_for', 'no activity for') + ' '));
      return line;
    }
    if (st === 'working') {
      line.appendChild(el('span', 'cw-spin is-on'));
      line.appendChild(el('span', 'cw-lane-state', t('claude_state_running', 'working')));
      return line;
    }
    if (s.lastSaid) { line.appendChild(el('span', 'cw-lane-said', s.lastSaid)); return line; }
    if (s.task) { line.appendChild(el('span', 'cw-lane-task', s.task)); return line; }
    line.appendChild(el('span', 'cw-lane-state', t('claude_state_idle', 'idle')));
    return line;
  }

  // A run of tool calls between Claude's sentences, as the terminal prints them:
  // a dot, the tool, the line it works on.
  function toolsRow(m) {
    const row = el('div', 'cw-msg-tools');
    m.tools.forEach((c) => {
      const line = el('div', 'cw-msg-tool');
      line.appendChild(el('span', 'cw-msg-tool-n', c.tool));
      if (c.detail) line.appendChild(el('span', 'cw-msg-tool-d', c.detail));
      row.appendChild(line);
    });
    return row;
  }

  window.ClaudeWidgetLines = { el, ageNode, paceLine, optRow, timerOf, tileHead, nowLine, toolsRow };
})();
