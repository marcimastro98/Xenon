// The words and lines the Codex tile is drawn from: a time left, the name of a quota window, where
// a thread runs, what a tool call is for, the head of a card that asks, and the state of a thread.
// Every text goes in as text; nothing here answers Codex.
'use strict';

(() => {
  const el = makeEl;

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  function mmss(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // A usage window's name from its length, never assumed: Codex decides it.
  function windowLabel(mins) {
    if (mins === 300) return t('codex_win_5h', '5 hours');
    if (mins === 10080) return t('codex_win_week', 'Week');
    if (mins >= 43000 && mins <= 44700) return t('codex_win_month', '30 days');
    if (!Number.isFinite(mins) || mins <= 0) return t('codex_win_plan', 'Plan');
    if (mins < 1440) return t('codex_win_hours', '{n} hours').replace('{n}', String(Math.round(mins / 60)));
    return t('codex_win_days', '{n} days').replace('{n}', String(Math.round(mins / 1440)));
  }

  function sourceLabel(s) {
    return ({
      app: t('codex_src_app', 'ChatGPT app'), cli: t('codex_src_cli', 'Terminal'), ide: t('codex_src_ide', 'Editor'),
      exec: t('codex_src_exec', 'Script'), agent: t('codex_src_agent', 'Sub-agent'),
    })[s] || '';
  }

  function intentOf(a) {
    const d = a.detail || {};
    switch (d.kind) {
      case 'command': return t('codex_intent_command', 'Run a command');
      case 'patch': return t('codex_intent_patch', 'Change files');
      case 'stdin': return t('codex_intent_stdin', 'Type into a running command');
      case 'permissions': return t('codex_intent_widen', 'Get more access than this session has');
      case 'agent': return t('codex_intent_agent', 'Start a sub-agent');
      case 'mcp': return t('codex_intent_mcp', 'Use a tool from {s}').replace('{s}', d.server || 'MCP');
      default: return a.tool || t('codex_intent_other', 'Do something');
    }
  }

  function timerOf(a) {
    const left = el('span', 'cx-dec-timer');
    left.dataset.cxExpiresAt = String(Date.now() + (a.expiresInMs || 0));
    left.dataset.tpl = t('claude_dec_left', '{t} left');
    left.textContent = left.dataset.tpl.replace('{t}', mmss(a.expiresInMs));
    return left;
  }

  function tileHead(a) {
    const head = el('div', 'cx-dec-head');
    head.appendChild(el('span', 'cx-dec-kind', t('codex_permission', 'Codex is asking')));
    head.appendChild(el('span', 'cx-dec-where', [a.project, a.model].filter(Boolean).join(' · ')));
    const left = timerOf(a);
    left.title = t('codex_dec_expires', 'After this Codex asks you itself');
    head.appendChild(left);
    return head;
  }

  function askedBy(a) {
    if (!a.project) return t('codex_permission', 'Codex is asking');
    return t('codex_asking_in', 'Codex is asking in {project}').replace('{project}', () => a.project);
  }

  function stateLabel(s) {
    if (s.ended) return t('codex_state_ended', 'Closed');
    if (s.state === 'waiting') return t('codex_state_waiting', 'Waiting for you');
    if (s.state === 'running') return t('codex_state_running', 'Working');
    return t('codex_state_idle', 'Idle');
  }

  // Most conversations are history: one says a state only while it is doing something.
  function threadStateLabel(th) {
    if (th.status === 'waiting') return t('codex_state_waiting', 'Waiting for you');
    if (th.status === 'active') return t('codex_state_running', 'Working');
    return '';
  }

  window.CodexWidgetLines = {
    el, t, mmss, windowLabel, sourceLabel, intentOf, timerOf, tileHead, askedBy, stateLabel,
    threadStateLabel,
  };
})();
