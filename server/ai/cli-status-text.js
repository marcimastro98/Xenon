'use strict';
// Reads what Claude Code and Codex print about themselves: the version, whether the user is
// signed in, and the models they offer.

const { MODEL_RE } = require('./cli-limits.js');

function versionOf(desc) {
  const head = String(desc || '').split(' · ')[0].trim();
  return /^[A-Za-z][A-Za-z-]*(?: [A-Za-z-]+)? \d+(?:\.\d+)*$/.test(head) ? head.slice(0, 40) : '';
}
// The `initialize` control_response: models [{ value, displayName,
// description: "Opus 5.5 · Best for …", resolvedModel }], account { … }.
function parseClaudeInit(out) {
  for (const line of String(out || '').split(/\r?\n/)) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || j.type !== 'control_response' || !j.response || j.response.subtype !== 'success') continue;
    const r = j.response.response || {};
    const models = (Array.isArray(r.models) ? r.models : [])
      .filter((m) => m && typeof m.value === 'string' && (m.value === 'default' || MODEL_RE.test(m.value)))
      .map((m) => {
        const desc = typeof m.description === 'string' ? m.description : '';
        return {
          id: m.value,
          label: String(m.displayName || m.value).slice(0, 60),
          // "Opus 5.5" out of "Opus 5.5 · Best for everyday, complex tasks".
          // Only when it has a model name's shape: on some plans the name
          // already carries the version and the description is just an English
          // sentence ("Most capable for ambitious work"), which is not one.
          version: versionOf(desc),
          resolved: typeof m.resolvedModel === 'string' ? m.resolvedModel.slice(0, 80) : '',
        };
      })
      .slice(0, 40);
    const acct = r.account && typeof r.account === 'object' ? r.account : null;
    const plan = acct && typeof acct.subscriptionType === 'string' ? acct.subscriptionType.slice(0, 40) : '';
    return { models, plan, hasAccount: !!acct && Object.keys(acct).length > 0 };
  }
  return null;
}

// Why a status came back unknown, in the program's own words where it gave
// any: shown under the status so a problem on someone's PC can be told apart
// from another (a timeout, an older program, an error it printed).
function why(r, label) {
  if (!r) return label + ': no answer';
  if (r.timedOut) return label + ': timed out';
  const tail = (String(r.stderr || '').trim() || String(r.stdout || '').trim()).split(/\r?\n/).slice(-2).join(' ').slice(0, 200);
  return label + ': exit ' + r.code + (tail ? ' · ' + tail : '');
}

// `claude auth status` prints JSON: { loggedIn, authMethod, ... }. Anything
// around it (an update notice, a warning) is tolerated: the object is taken
// from the first "{" to the last "}".
function parseClaudeAuth(out) {
  const text = String(out || '');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  try {
    if (a < 0 || b <= a) throw new Error('no json');
    const j = JSON.parse(text.slice(a, b + 1));
    if (typeof j.loggedIn !== 'boolean') throw new Error('no loggedIn');
    return { loggedIn: j.loggedIn, method: typeof j.authMethod === 'string' ? j.authMethod.slice(0, 40) : '' };
  } catch { return { loggedIn: null, method: '' }; }
}
// `codex login status` prints a sentence and exits 0 either way, so the words
// are the answer: "Logged in using ChatGPT", "... an API key", "Not logged in".
function parseCodexLogin(r) {
  const text = String((r && r.stdout) || '') + '\n' + String((r && r.stderr) || '');
  if (/not logged in/i.test(text)) return { loggedIn: false, method: '' };
  if (/logged in using chatgpt/i.test(text)) return { loggedIn: true, method: 'chatgpt' };
  if (/logged in using an api key/i.test(text)) return { loggedIn: true, method: 'apikey' };
  if (/logged in/i.test(text)) return { loggedIn: true, method: '' };
  return { loggedIn: null, method: '' };
}

// Codex names its models freely (luna, terra…) but describes the small one
// ("Fast and affordable model for easier tasks"). Claude Code has an alias.
const LIGHT_RE = /\b(affordable|efficient|mini|lite|small|cheap)\b/i;

function parseCodexModels(out) {
  let j;
  try { j = JSON.parse(String(out || '')); } catch { return []; }
  const arr = j && Array.isArray(j.models) ? j.models : [];
  return arr
    .filter((m) => m && typeof m.slug === 'string' && MODEL_RE.test(m.slug) && m.visibility === 'list')
    .map((m) => ({ id: m.slug, label: String(m.display_name || m.slug).slice(0, 60), light: LIGHT_RE.test(String(m.description || '')) }))
    .slice(0, 40);
}

module.exports = {
  versionOf, parseClaudeInit, why, parseClaudeAuth, parseCodexLogin, LIGHT_RE, parseCodexModels,
};
