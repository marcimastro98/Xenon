'use strict';
// Reads the answer of a Claude Code or Codex turn out of what the program printed, and says so
// when the user is not signed in.

// ── one turn ────────────────────────────────────────────────────────────────
class CliError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}
const NOT_LOGGED_RE = /not logged in|please run \/login|log ?in (?:first|required)|invalid api key|unauthori[sz]ed|authentication/i;

function parseClaude(r) {
  let j = null;
  const lines = String(r.stdout || '').trim().split(/\r?\n/);
  // stream-json ends with housekeeping events after the result: prefer the result.
  for (let i = lines.length - 1; i >= 0 && !(j && j.type === 'result'); i--) {
    try { const e = JSON.parse(lines[i]); if (!j || (e && e.type === 'result')) j = e; } catch { /* not the result line */ }
  }
  if (j && j.type === 'result') {
    const text = typeof j.result === 'string' ? j.result.trim() : '';
    if (j.is_error || j.subtype !== 'success') throw new CliError(NOT_LOGGED_RE.test(text) ? 'cli_not_logged_in' : 'cli_failed', text || String(j.subtype || 'error'));
    const used = j.modelUsage && typeof j.modelUsage === 'object' ? Object.keys(j.modelUsage)[0] || '' : '';
    const u = j.usage || {};
    // Cache reads and writes are input too: they count toward the plan.
    const input = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((n, k) => n + (Number(u[k]) || 0), 0);
    return { text, model: used, usage: { input, output: Number(u.output_tokens) || 0 } };
  }
  const why = (String(r.stderr || '').trim() || String(r.stdout || '').trim()).slice(-400);
  throw new CliError(NOT_LOGGED_RE.test(why) ? 'cli_not_logged_in' : 'cli_failed', why || 'no answer');
}

function parseCodex(r) {
  const texts = [];
  let failed = '', lastError = '';
  const usage = { input: 0, output: 0 };
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'turn.completed' && e.usage) {
      // input_tokens already includes the cached part.
      usage.input += Number(e.usage.input_tokens) || 0;
      usage.output += Number(e.usage.output_tokens) || 0;
    }
    if (e.type === 'item.completed' && e.item && e.item.type === 'agent_message' && typeof e.item.text === 'string') texts.push(e.item.text);
    else if (e.type === 'turn.failed') failed = String((e.error && e.error.message) || 'turn failed');
    else if (e.type === 'error' && typeof e.message === 'string' && !/^Reconnecting/i.test(e.message)) lastError = e.message;
  }
  const text = texts.join('\n\n').trim();
  if (text && !failed) return { text, model: '', usage };
  const why = (failed || lastError || String(r.stderr || '').trim()).slice(-400);
  throw new CliError(NOT_LOGGED_RE.test(why) ? 'cli_not_logged_in' : 'cli_failed', why || 'no answer');
}

module.exports = { CliError, NOT_LOGGED_RE, parseClaude, parseCodex };
