'use strict';

// ── Xenon AI — on Xenon credits ───────────────────────────────────────────
// The supporter's own AI, paid in credits instead of a key of their own. Same
// Claude chat loop as ai-anthropic.js; only the transport differs: each round
// goes to the supporter hub (POST /ai/messages), which adds the creative
// instructions, calls Anthropic and charges the round's real usage. The tools
// still run HERE, on the user's PC, exactly as with every other provider.
//
// The pass never leaves this server: the remembered XS code (supporter-redeem.js),
// or the XC Sparks code of a buyer who is not a supporter (sparks-wallet.js),
// is traded for a signed session token once, and the token is what travels.
// Neither the code nor the token is ever sent to the browser.

const redeem = require('./supporter-redeem.js');
const sparksWallet = require('./sparks-wallet.js');
const aiAnthropic = require('./ai-anthropic.js');
const aiTurns = require('./ai-turns');
const startupLog = require('./startup-log');

const MODELS = Object.freeze(['haiku', 'sonnet', 'opus']);
const DEFAULT_MODEL = 'sonnet';
// How hard the creation model reasons, picked in Settings: more reasoning costs
// more credits and time. Every level has to deliver the creation.
const EFFORTS = Object.freeze(['low', 'medium', 'high']);
const DEFAULT_EFFORT = 'medium';

// A whole widget is a long answer with adaptive thinking in front of it: room
// for it, and the time Opus needs to write it. The hub caps both again, and
// trims the length to what the balance can pay for.
const MAX_TOKENS = 16000;
// A widget's files and the thinking before them can pass 16000 on Sonnet and
// Opus, and an answer cut inside a tool call installs nothing. On high, Sonnet
// thought through all of 32000 before writing a line (measured 26 Oct 2026), so
// that level gets twice the room. Only what is written is paid; the hub holds
// the worst case and trims it to the balance.
const CREATION_MAX_TOKENS = Object.freeze({ low: 32000, medium: 32000, high: 64000 });
// A Haiku round while another model makes the creations: an answer or a tool
// call is far shorter. A round that runs into this was writing a creation
// itself, and is handed over after seconds instead of a minute of throwaway text.
const CHAT_MAX_TOKENS = 4096;
const TURN_TIMEOUT_MS = 300000;
const MAX_TURN_BYTES = 2 * 1024 * 1024;
const SMALL_TIMEOUT_MS = 15000;
// A token this close to its end is replaced before it is used.
const TOKEN_MARGIN_SEC = 120;
// Anthropic overloaded or rate limited ('busy'): the round is asked again after
// these waits, because a creation that stops halfway loses the rounds already
// paid for. The hub charges nothing for a busy round. Only a refusal that came
// fast is asked again: a busy answer after a long wait broke off while Anthropic
// was writing, and asking again would pay for that writing a second time.
const BUSY_WAITS_MS = Object.freeze([3000, 8000]);
const BUSY_RETRY_WITHIN_MS = 20000;
const MAX_RETRY_AFTER_MS = 30000;

// What the hub can answer, passed on as the error code. Anything else is 'network'.
const KNOWN_ERRORS = new Set(['no_credits', 'busy', 'rate_limited', 'not_configured', 'bad_request', 'bad_model', 'bad_code', 'expired', 'upstream_error', 'upstream_unreachable']);

const sanitizeModel = (v) => (MODELS.includes(v) ? v : DEFAULT_MODEL);
const sanitizeEffort = (v) => (EFFORTS.includes(v) ? v : DEFAULT_EFFORT);

let _session = null; // { token, exp } in memory only
let _lastBalance = null;
let _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let _now = () => Date.now();

// `detail` is the hub's reason (Anthropic's message on a refused request): it
// goes to the server log, never to the user.
function fail(code, balance, detail) {
  const err = new Error('Xenon credits: ' + code);
  err.code = code;
  if (Number.isFinite(balance)) err.balance = balance;
  if (typeof detail === 'string' && detail) err.detail = detail.slice(0, 300);
  return err;
}

function rememberBalance(n) {
  if (Number.isFinite(n)) _lastBalance = n;
}

// The pass first; without one, the Sparks code of someone who bought Sparks
// without being a supporter (sparks-wallet.js). The hub tells them apart.
async function savedCode(dataDir) {
  return await redeem.readSavedCode(dataDir) || await sparksWallet.readWalletCode(dataDir);
}

// Whether this install holds a code that can spend Sparks: what a feature on
// the user's AI checks before it asks, so a missing code never costs a round trip.
async function hasCode(dataDir) {
  return !!(await savedCode(dataDir));
}

async function sessionToken(dataDir) {
  const now = Math.floor(Date.now() / 1000);
  if (_session && _session.exp - TOKEN_MARGIN_SEC > now) return _session.token;
  _session = null;
  const code = await savedCode(dataDir);
  if (!code) throw fail('no_code');
  const out = await redeem.hubPost('/ai/session', { code }, undefined, SMALL_TIMEOUT_MS);
  if (out && out.ok === true && typeof out.token === 'string' && Number.isInteger(out.exp)) {
    _session = { token: out.token, exp: out.exp };
    return out.token;
  }
  throw fail(out && KNOWN_ERRORS.has(out.error) ? out.error : 'network');
}

// One hub call with the session; a token the hub stopped accepting (a new
// secret, a revoked code) is dropped and asked for again, once.
async function withSession(dataDir, pathname, body, maxBytes, timeoutMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await sessionToken(dataDir);
    const out = await redeem.hubPost(pathname, { ...body, token }, maxBytes, timeoutMs);
    if (out && out.error === 'bad_token') { _session = null; continue; }
    return out;
  }
  throw fail('bad_code');
}

// One line per paid round, so a turn that costs more than it should can be read
// back: never the conversation, only how the round ended and what it cost.
function logRound(model, out, ms) {
  const usage = out.usage || {};
  const paid = out.xenon && Number.isFinite(out.xenon.credits) ? out.xenon.credits : '?';
  const n = (k) => usage[k] || 0;
  // In server.log (the scheduled task has no console): what each round cost,
  // so an expensive creation can be traced to the round that made it so.
  startupLog.write(`[ai] Xenon AI round: ${model}, ${out.stop_reason || '?'}, in ${n('input_tokens')} + cache read ${n('cache_read_input_tokens')} + cache write ${n('cache_creation_input_tokens')}, out ${n('output_tokens')}, ${paid} credits, ${Math.round(ms / 1000)} s`);
}

// The longer of our own wait and the one Anthropic asked for, within a bound.
function busyWait(wait, retryAfterSec) {
  const asked = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
  return Math.min(Math.max(wait, asked), MAX_RETRY_AFTER_MS);
}

// The transport ai-anthropic.chat calls for each round: the Anthropic request in,
// the Anthropic response out. The hub sets the model id, the thinking and the
// cache breakpoints; only what it accepts is sent.
function roundTrip(dataDir, model) {
  return async (body) => {
    const request = {
      model,
      system: body.system,
      messages: body.messages,
      tools: body.tools,
      max_tokens: body.max_tokens,
      ...(body.effort ? { effort: body.effort } : {}),
    };
    aiTurns.checkpoint(); // stopped: no new round, so nothing more is paid
    let started = _now();
    let out = await withSession(dataDir, '/ai/messages', request, MAX_TURN_BYTES, TURN_TIMEOUT_MS);
    for (const wait of BUSY_WAITS_MS) {
      if (!out || out.error !== 'busy' || _now() - started > BUSY_RETRY_WITHIN_MS) break;
      await _sleep(busyWait(wait, out.retryAfter));
      aiTurns.checkpoint();
      started = _now();
      out = await withSession(dataDir, '/ai/messages', request, MAX_TURN_BYTES, TURN_TIMEOUT_MS);
    }
    if (out && Array.isArray(out.content)) {
      rememberBalance(out.xenon && out.xenon.balance);
      logRound(model, out, _now() - started);
      return out;
    }
    if (out && out.error === 'no_credits') rememberBalance(out.balance);
    throw fail(out && KNOWN_ERRORS.has(out.error) ? out.error : 'network', out && out.balance, out && out.detail);
  };
}

// Everyday turns (a question, a command, a voice turn) run on Haiku. Every
// round carries about 23K tokens of instructions and tools: caching them costs
// half a credit on Haiku and over ten on Sonnet, so the chosen model is kept
// for what it is chosen for, creations. A round that reaches for a creation
// tool is asked again of that model, which writes the rest of the turn; the
// Haiku round's tool calls are dropped unrun. A Haiku round cut at its length
// limit was writing something large itself (a whole widget, a long fix): it is
// handed over the same way, not answered with an empty reply.
const CHAT_MODEL = 'haiku';
const CREATION_TOOLS = new Set([
  'create_preset', 'preset_reference', 'create_widget', 'sdk_reference',
  'create_animated_background', 'create_dashboard_style', 'configure_deck', 'deck_action_catalog',
]);

function reachesForCreation(resp) {
  if (resp && resp.stop_reason === 'max_tokens') return true;
  return Array.isArray(resp && resp.content)
    && resp.content.some((b) => b && b.type === 'tool_use' && CREATION_TOOLS.has(b.name));
}

// The creation model gets the creation tools only (plus the Store search, for
// what it cannot write, my_widgets to change one the user has, and any tool
// this turn already called): the other seventy-odd tools are most of what its
// cache write costs, and a creation never plays music or sets a timer.
const CREATION_KIT = new Set([...CREATION_TOOLS, 'marketplace_search', 'my_widgets']);
function forCreation(body, effort) {
  const room = { effort, max_tokens: CREATION_MAX_TOKENS[effort] };
  if (!Array.isArray(body.tools)) return { ...body, ...room };
  const used = new Set();
  for (const m of body.messages || []) {
    for (const b of Array.isArray(m.content) ? m.content : []) if (b && b.type === 'tool_use') used.add(b.name);
  }
  return { ...body, ...room, tools: body.tools.filter((t) => CREATION_KIT.has(t.name) || used.has(t.name)) };
}

// Haiku chosen for creations runs the whole turn at the user's level: its
// rounds are both the chat and the creation. `pick` is read again on every
// chat round and at the hand-over, so "use Opus and make…" switches mid-turn.
function routedTrip(dataDir, pick) {
  let model = CHAT_MODEL;
  let effort = DEFAULT_EFFORT;
  return async (body) => {
    if (model !== CHAT_MODEL) return roundTrip(dataDir, model)(forCreation(body, effort));
    const chosen = pick();
    if (chosen.model === CHAT_MODEL) return roundTrip(dataDir, CHAT_MODEL)({ ...body, effort: chosen.effort, max_tokens: Math.max(body.max_tokens, CREATION_MAX_TOKENS[chosen.effort]) });
    const out = await roundTrip(dataDir, CHAT_MODEL)({ ...body, max_tokens: Math.min(body.max_tokens, CHAT_MAX_TOKENS) });
    if (!reachesForCreation(out)) return out;
    ({ model, effort } = pick());
    aiTurns.creating();
    return roundTrip(dataDir, model)(forCreation(body, effort));
  };
}

// Chat turn with function calling, same arguments and answer as ai-anthropic.chat
// minus the key. `model` is the one for creations and `effort` how hard it
// reasons (see routedTrip); `creation`, when given, returns the current
// { model, effort } instead, for a choice the user changes during the turn.
// `turnNote` rides on the latest user turn instead of the system text, so the
// system prefix stays the same from one turn to the next and the hub's cache holds.
async function chat({ dataDir, model, effort, creation, geminiTools, history, systemText, turnNote, executeTool }) {
  const pick = () => {
    const c = typeof creation === 'function' ? (creation() || {}) : { model, effort };
    return { model: sanitizeModel(c.model), effort: sanitizeEffort(c.effort) };
  };
  try {
    const result = await aiAnthropic.chat({
      model: sanitizeModel(model), geminiTools, history, systemText, turnNote, executeTool,
      maxTokens: MAX_TOKENS, post: routedTrip(dataDir, pick),
    });
    return { ...result, balance: _lastBalance };
  } catch (e) {
    // A stopped turn still says what is left after the rounds it did pay for.
    if (e && e.code === 'turn_stopped') e.balance = _lastBalance;
    throw e;
  }
}

// One completion with no tools → plain text, for the small helpers (a summary,
// a search phrase, a lyrics translation). Always on Haiku: they are short and a
// helper should never cost what a conversation does. Adaptive thinking spends
// from the same length, so a tiny cap is raised; only what is written is paid.
const HELPER_MODEL = 'haiku';
// What a helper costs, for estimates the app shows (Lyrics' "per 100 songs"):
// the hub's model id for `haiku` and its Sparks per US dollar, mirrored from
// the hub's ai-pricing.js (MODELS.haiku.id, CREDITS_PER_USD). Display only:
// the hub alone decides what a call is charged.
const HELPER_MODEL_ID = 'claude-haiku-5-5';
const SPARKS_PER_USD = 200;
const HELPER_MIN_TOKENS = 1024;

async function oneShot({ dataDir, systemText, userText, maxTokens, onUsage, image }) {
  const resp = await roundTrip(dataDir, HELPER_MODEL)({
    system: systemText || undefined,
    messages: [{ role: 'user', content: aiAnthropic.userContent(userText, image) }],
    max_tokens: Math.max(maxTokens || 0, HELPER_MIN_TOKENS),
  });
  const u = resp.usage;
  const input = u ? Number(u.input_tokens) : NaN;
  const output = u ? Number(u.output_tokens) : NaN;
  // `credits` is what the hub charged for this request, in Sparks.
  const credits = Number(resp.xenon && resp.xenon.credits);
  if (typeof onUsage === 'function' && Number.isSafeInteger(input + output)) onUsage(input + output, { input, output, credits });
  return resp.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
}

// The hub's design check (POST /ai/audit) on a share code the assistant just
// made, as critique findings to consider. It is advice and it is free: when the
// hub cannot answer, the turn goes on with the app's own critique alone.
const AUDIT_ITEMS = 12;
const AUDIT_RESPONSE_BYTES = 64 * 1024;
const clip = (v, n) => String(v).slice(0, n);

async function designAdvice(dataDir, code) {
  let out = null;
  try {
    out = await withSession(dataDir, '/ai/audit', { code }, AUDIT_RESPONSE_BYTES, SMALL_TIMEOUT_MS);
  } catch { return []; }
  if (!out || out.ok !== true || !Array.isArray(out.design)) return [];
  return out.design
    .filter((d) => d && typeof d.message === 'string')
    .slice(0, AUDIT_ITEMS)
    .map((d) => ({
      severity: 'consider',
      where: 'design: ' + clip(d.file || 'package', 80),
      problem: clip(d.message, 300),
      ...(typeof d.fix === 'string' ? { hint: clip(d.fix, 300) } : {}),
    }));
}

// The hub sends the code's email already masked ("m•••@gmail.com"); anything
// else is dropped rather than shown.
const MASKED_EMAIL = /^[^\s@]{0,64}•••@[^\s@]{1,253}$/u;

// {ok, balance, included, topup, monthly, wallet, email?} in whole credits, or {ok:false, error}.
async function balance(dataDir) {
  try {
    const out = await withSession(dataDir, '/ai/balance', {}, undefined, SMALL_TIMEOUT_MS);
    if (out && out.ok === true && Number.isFinite(out.balance)) {
      rememberBalance(out.balance);
      const email = typeof out.email === 'string' && MASKED_EMAIL.test(out.email) ? { email: out.email } : {};
      // `wallet`: a Sparks code with no pass behind it, so no monthly Sparks to show.
      return { ok: true, balance: out.balance, included: out.included, topup: out.topup, monthly: out.monthly, wallet: out.wallet === true, ...email };
    }
    return { ok: false, error: out && KNOWN_ERRORS.has(out.error) ? out.error : 'network' };
  } catch (e) {
    return { ok: false, error: (e && e.code) || 'network' };
  }
}

module.exports = {
  MODELS,
  DEFAULT_MODEL,
  EFFORTS,
  DEFAULT_EFFORT,
  CREATION_MAX_TOKENS,
  MAX_TOKENS,
  CHAT_MAX_TOKENS,
  CHAT_MODEL,
  CREATION_TOOLS,
  sanitizeModel,
  sanitizeEffort,
  chat,
  oneShot,
  hasCode,
  HELPER_MODEL_ID,
  SPARKS_PER_USD,
  balance,
  designAdvice,
  BUSY_WAITS_MS,
  _reset() { _session = null; _lastBalance = null; },
  _setSleep(fn) { _sleep = typeof fn === 'function' ? fn : (ms) => new Promise((resolve) => setTimeout(resolve, ms)); },
  _setNow(fn) { _now = typeof fn === 'function' ? fn : () => Date.now(); },
};
