// How the Claude tile writes things: how long, how long ago and until when, the name of a session's
// state, what a tool is about to do, the texts of its errors, and tokens, money, percentages and
// days.
'use strict';

(() => {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  function hTok(n) {
    n = Math.max(0, Math.round(n || 0));
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e11 ? 0 : 2).replace(/\.0+$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  function hCost(n) {
    n = Math.max(0, n || 0);
    if (n >= 1000) return '$' + Math.round(n).toLocaleString();
    if (n >= 10) return '$' + n.toFixed(0);
    return '$' + n.toFixed(n >= 1 ? 1 : 2);
  }

  // A compact duration in the reader's language: "4h07", "3 min", "2g5h" in
  // Italian, "4時間7分" in Japanese. The units used to be hard-coded, so every
  // language read Italian days ("4g23h").
  const CJK = /^(ja|ko|zh)$/;

  function dur(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    const U = (k, fb) => t('claude_unit_' + k, fb);
    const cjk = CJK.test(String(document.documentElement.lang || '').slice(0, 2));
    if (s < 60) return s + U('s', 's');
    const m = Math.floor(s / 60);
    if (m < 60) return m + U('m', 'm');
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 24) return h + U('h', 'h') + (mm ? (cjk ? mm + U('m', 'm') : String(mm).padStart(2, '0')) : '');
    const d = Math.floor(h / 24), hh = h % 24;
    return d + U('d', 'd') + (hh ? hh + U('h', 'h') : '');
  }

  function ago(ms) { return dur(ms); }

  // Countdown to an absolute epoch-seconds instant.
  function until(epochSec) {
    const ms = (Number(epochSec) || 0) * 1000 - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return '';
    return dur(ms);
  }

  // Counts, money and clock times go through Intl in the UI language, so an
  // Italian dashboard reads "4,36 Mrd" and "1.991 US$", and a Japanese one
  // "43.6億". The old hand-rolled "B"/"$" formatting was English everywhere.
  function uiLang() { return String(document.documentElement.lang || 'en').slice(0, 2) || 'en'; }

  function fmtTokens(n) {
    const v = Math.max(0, Math.round(n || 0));
    try { return new Intl.NumberFormat(uiLang(), { notation: 'compact', maximumFractionDigits: v >= 1e9 ? 2 : 1 }).format(v); }
    catch { return hTok(v); }
  }

  function fmtMoney(n) {
    const v = Math.max(0, n || 0);
    try { return new Intl.NumberFormat(uiLang(), { style: 'currency', currency: 'USD', maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v); }
    catch { return hCost(v); }
  }

  // A share with a decimal, written the reader's way ("96,1 %" in French).
  function fmtPct(fraction, digits) {
    const v = Math.max(0, Number(fraction) || 0);
    try { return new Intl.NumberFormat(uiLang(), { style: 'percent', maximumFractionDigits: digits }).format(v); }
    catch { return (Math.round(v * 100 * Math.pow(10, digits)) / Math.pow(10, digits)) + '%'; }
  }

  function sameLocalDay(a, b) {
    const x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }

  // A clock time, with the weekday in front when it is not today.
  function fmtWhen(ms) {
    try {
      // timeParts() carries Settings → Time format (12h/24h), not the locale's.
      const opts = sameLocalDay(ms, Date.now()) ? timeParts() : timeParts({ weekday: 'short' });
      return new Intl.DateTimeFormat(uiLang(), opts).format(new Date(ms));
    } catch { return new Date(ms).toLocaleTimeString(); }
  }

  function fmtDay(ms) {
    try { return new Intl.DateTimeFormat(uiLang(), { day: 'numeric', month: 'short' }).format(new Date(ms)); }
    catch { return new Date(ms).toLocaleDateString(); }
  }

  const STATE_LABEL = {
    running: () => t('claude_state_running', 'working'),
    waiting: () => t('claude_state_waiting', 'waiting for you'),
    idle: () => t('claude_state_idle', 'idle'),
  };

  // "Did it finish, or did I kill it?" is the question the user asks about a
  // session that is no longer there, and the old widget answered neither: the
  // record was deleted the moment it ended.
  function endedLabel(s) {
    if (s.endedReason === 'gone') return t('claude_ended_gone', 'closed');
    if (s.endedReason === 'clear') return t('claude_ended_clear', 'cleared');
    if (s.endedReason === 'logout') return t('claude_ended_logout', 'signed out');
    return t('claude_ended', 'finished');
  }

  // What Claude is about to do, in the words the user needs: the plain-language
  // intent as the headline, the literal argument underneath as evidence. The
  // tool NAME alone ("Bash") tells a non-developer nothing.
  const TOOL_INTENT = {
    Bash: () => t('claude_intent_bash', 'Run a command'),
    Write: () => t('claude_intent_write', 'Create a file'),
    Edit: () => t('claude_intent_edit', 'Change a file'),
    NotebookEdit: () => t('claude_intent_edit', 'Change a file'),
    Read: () => t('claude_intent_read', 'Read a file'),
    Glob: () => t('claude_intent_search', 'Search the project'),
    Grep: () => t('claude_intent_search', 'Search the project'),
    WebFetch: () => t('claude_intent_web', 'Open a web page'),
    WebSearch: () => t('claude_intent_websearch', 'Search the web'),
    Agent: () => t('claude_intent_agent', 'Start a sub-agent'),
    Task: () => t('claude_intent_agent', 'Start a sub-agent'),
    KillShell: () => t('claude_intent_kill', 'Stop a running command'),
    AskUserQuestion: () => t('claude_intent_ask', 'Ask you a question'),
  };

  function toolIntent(tool) {
    const f = TOOL_INTENT[tool];
    return f ? f() : (window.ClaudeIdent.toolLabel(tool) || 'tool');
  }

  const RISK_LABEL = {
    irreversible: () => t('claude_risk_irreversible', 'Cannot be undone'),
    publish: () => t('claude_risk_publish', 'Publishes your work'),
    network: () => t('claude_risk_network', 'Reaches the network'),
    outside: () => t('claude_risk_outside', 'Outside the project folder'),
    readonly: () => t('claude_risk_readonly', 'Only reads'),
  };

  // The rows of Claude Code's plan dialog, with its wording: approve into a
  // mode, or keep planning with what to change. "Allow" over a plan said
  // nothing about what happens next, and did nothing in the terminal either.
  const PLAN_CHOICE_LABEL = {
    auto: () => t('claude_xp_auto', 'Yes, and use auto mode'),
    acceptEdits: () => t('claude_xp_accept', 'Yes, auto-accept edits'),
    default: () => t('claude_xp_manual', 'Yes, manually approve edits'),
  };

  function askedBy(a) {
    if (!a.project) return t('claude_asking', 'Claude is asking');
    return t('claude_asking_in', 'Claude is asking in {project}').replace('{project}', () => a.project);
  }

  function sheetTitle(a) {
    if (a.kind === 'plan') return t('claude_xp_what', 'Ready to code?');
    if (a.kind !== 'question') return toolIntent(a.tool);
    return a.questions.length === 1 ? a.questions[0].question : t('claude_question', 'Question');
  }

  function stateLabel(s, st) {
    if (st === 'ended') return endedLabel(s);
    return STATE_LABEL[st === 'needs' ? 'waiting' : st === 'working' ? 'running' : 'idle']();
  }

  function attachErrorText(code, name) {
    const who = name ? String(name) + ': ' : '';
    switch (code) {
      case 'too_big': return who + t('claude_attach_e_big', 'that file is too large (12 MB max).');
      case 'bad_type': return who + t('claude_attach_e_type', 'that kind of file cannot be attached.');
      case 'empty': return who + t('claude_attach_e_empty', 'that file is empty.');
      default: return who + t('claude_attach_e_generic', 'could not be attached.');
    }
  }

  function replyErrorText(code) {
    if (code === 'already_queued') return t('claude_reply_e_queued', 'There is already a message waiting to be delivered');
    if (code === 'session_ended') return t('claude_reply_e_ended', 'That session has closed');
    if (code === 'unknown_session') return t('claude_reply_e_unknown', 'Xenon has lost track of that session');
    if (code === 'session_idle') return t('claude_reply_e_idle', 'This session has finished its turn. Send again to continue it.');
    if (code === 'mod_old') return t('claude_cmd_modold', 'The Xenon mod in that terminal is older than 0.4.0. Update it and restart Claude Code to run commands from here.');
    if (code === 'busy_command') return t('claude_cmd_noterm', 'The session is working and no terminal with the Xenon mod is listening, so nothing could run it');
    if (code === 'needs_value') return t('claude_cmd_needs_value', 'Add a value, e.g. /model opus or /effort high');
    if (code === 'slash_command') return t('claude_terminal_e_slash', 'Commands that start with / have to be typed in the session itself.');
    return t('claude_reply_e_failed', 'Could not queue that message');
  }

  // Every refusal the runner can return, said in words. A bare error code on a
  // touchscreen is a dead end — the user cannot open a log to find out more.
  function runErrorText(code) {
    switch (code) {
      case 'remote_denied': return t('claude_run_at_pc', 'A new session starts from the PC. From here you can answer the ones already running.');
      case 'claude_not_found': return t('claude_run_e_notfound', 'Claude Code was not found on this PC.');
      case 'too_many_runs': return t('claude_run_e_busy', 'Another run is already going. Wait for it or stop it.');
      case 'unknown_project': return t('claude_run_e_project', 'That project is no longer available.');
      case 'empty_prompt': return t('claude_run_e_empty', 'Write what you want done first.');
      case 'bad_session': return t('claude_run_e_session', 'That session cannot be continued.');
      case 'bad_model': return t('claude_run_e_model', 'That model name was refused.');
      case 'spawn_failed': return t('claude_run_e_spawn', 'Claude Code would not start.');
      case 'bad_folder': case 'folder_missing': return t('claude_run_e_folder', 'That folder was not found. Type the full path of an existing folder.');
      default: return t('claude_run_e_generic', 'The run could not be started.');
    }
  }

  function runStateText(r) {
    if (r.state === 'running') return t('claude_run_working', 'working') + ' · ' + ago(r.elapsedMs);
    if (r.state === 'done') return t('claude_run_done', 'done');
    if (r.state === 'stopped') return t('claude_run_stopped', 'stopped');
    return t('claude_run_failed', 'failed');
  }

  window.ClaudeWidgetWords = {
    t, hTok, dur, ago, until, fmtTokens, fmtMoney, fmtPct, fmtWhen, fmtDay, endedLabel, toolIntent,
    RISK_LABEL, PLAN_CHOICE_LABEL, askedBy, sheetTitle, stateLabel, attachErrorText, replyErrorText,
    runErrorText, runStateText,
  };
})();
