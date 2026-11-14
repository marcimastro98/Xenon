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

require('./supporter-redeem.js');
require('./sparks-wallet.js');
const welcomeSparks = require('./welcome-sparks.js');
const aiAnthropic = require('./ai-anthropic.js');
const aiTurns = require('./ai-turns');
const startupLog = require('./startup-log');

const {
  MODELS, DEFAULT_MODEL, EFFORTS, DEFAULT_EFFORT, MAX_TOKENS, CREATION_MAX_TOKENS, CHAT_MAX_TOKENS,
  TURN_TIMEOUT_MS, MAX_TURN_BYTES, SMALL_TIMEOUT_MS, BUSY_WAITS_MS, BUSY_RETRY_WITHIN_MS,
  MAX_RETRY_AFTER_MS, KNOWN_ERRORS, sanitizeModel, sanitizeEffort,
} = require('./store-supporters/credits-limits.js');



const { creditsState } = require('./store-supporters/credits-state.js');
let _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let _now = () => Date.now();

const {
  fail, rememberBalance, hasCode, withSession,
} = require('./store-supporters/credits-session.js');

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
      ...(body.helper === true ? { helper: true } : {}),
      // What the request is for, so the hub can say where Sparks go (0039).
      ...(typeof body.use === 'string' && body.use ? { use: body.use } : {}),
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

const {
  CHAT_MODEL, CREATION_TOOLS, reachesForCreation, forCreation,
} = require('./store-supporters/credits-creation.js');


// Haiku chosen for creations runs the whole turn at the user's level: its
// rounds are both the chat and the creation, and are booked as chat. `pick` is read again on every
// chat round and at the hand-over, so "use Opus and make…" switches mid-turn.
function routedTrip(dataDir, pick) {
  let model = CHAT_MODEL;
  let effort = DEFAULT_EFFORT;
  return async (body) => {
    if (model !== CHAT_MODEL) return roundTrip(dataDir, model)(forCreation(body, effort));
    const chosen = pick();
    if (chosen.model === CHAT_MODEL) return roundTrip(dataDir, CHAT_MODEL)({ ...body, use: 'chat', effort: chosen.effort, max_tokens: Math.max(body.max_tokens, CREATION_MAX_TOKENS[chosen.effort]) });
    const out = await roundTrip(dataDir, CHAT_MODEL)({ ...body, use: 'chat', max_tokens: Math.min(body.max_tokens, CHAT_MAX_TOKENS) });
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
  // Only here, never in the background features: the trial's days start when
  // somebody writes to Bit. Once they have, the helpers on this AI spend from the
  // same Sparks, as they do from bought ones.
  if (!await hasCode(dataDir)) await welcomeSparks.claim(dataDir);
  try {
    const result = await aiAnthropic.chat({
      model: sanitizeModel(model), geminiTools, history, systemText, turnNote, executeTool,
      maxTokens: MAX_TOKENS, post: routedTrip(dataDir, pick),
    });
    return { ...result, balance: creditsState.lastBalance };
  } catch (e) {
    // A stopped turn still says what is left after the rounds it did pay for.
    if (e && e.code === 'turn_stopped') e.balance = creditsState.lastBalance;
    throw e;
  }
}

// One completion with no tools → plain text, for the small helpers (a summary,
// a search phrase, a lyrics translation). Always on Haiku: they are short and a
// helper should never cost what a conversation does. Haiku thinks before it
// writes and the thinking spends from the same length: a lyrics translation
// sized for its answer alone came back cut inside its JSON (10 Nov 2026, a
// 19-line song used all of its 1206 tokens). So a helper runs at low effort and
// gets the thinking room on top of its answer; only what is written is paid.
const HELPER_MODEL = 'haiku';
const HELPER_EFFORT = 'low';
const HELPER_THINKING_ROOM = 2048;
// What a helper costs, for estimates the app shows (Lyrics' "per 100 songs"):
// the hub's model id for `haiku` and its Sparks per US dollar, mirrored from
// the hub's ai-pricing.js (MODELS.haiku.id, CREDITS_PER_USD). Display only:
// the hub alone decides what a call is charged.
const HELPER_MODEL_ID = 'claude-haiku-5-5';
const SPARKS_PER_USD = 200;
const HELPER_MIN_TOKENS = 1024;

async function oneShot({ dataDir, systemText, userText, maxTokens, onUsage, image, use }) {
  const resp = await roundTrip(dataDir, HELPER_MODEL)({
    system: systemText || undefined,
    messages: [{ role: 'user', content: aiAnthropic.userContent(userText, image) }],
    max_tokens: Math.max(maxTokens || 0, HELPER_MIN_TOKENS) + HELPER_THINKING_ROOM,
    effort: HELPER_EFFORT,
    // Sent without Bit's creative brain, which a hub before 10 Nov 2026 adds
    // anyway: it ignores fields it does not know.
    helper: true,
    use,
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

// {ok, balance, included, topup, monthly, wallet, email?, welcomeUntil?} in whole
// credits, or {ok:false, error, welcome?}. `welcome`: no code yet, but the first
// message to Bit will bring the trial Sparks, so the chat stays open for it.
async function balance(dataDir) {
  try {
    const out = await withSession(dataDir, '/ai/balance', {}, undefined, SMALL_TIMEOUT_MS);
    if (out && out.ok === true && Number.isFinite(out.balance)) {
      rememberBalance(out.balance);
      const email = typeof out.email === 'string' && MASKED_EMAIL.test(out.email) ? { email: out.email } : {};
      // `wallet`: a Sparks code with no pass behind it, so no monthly Sparks to show.
      const welcome = Number.isInteger(out.welcomeUntil) ? { welcomeUntil: out.welcomeUntil } : {};
      return { ...welcome, ok: true, balance: out.balance, included: out.included, topup: out.topup, monthly: out.monthly, wallet: out.wallet === true, ...email };
    }
    return { ok: false, error: out && KNOWN_ERRORS.has(out.error) ? out.error : 'network' };
  } catch (e) {
    const error = (e && e.code) || 'network';
    if (error === 'no_code' && await welcomeSparks.available(dataDir)) return { ok: false, error, welcome: true };
    return { ok: false, error };
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
  _reset() { creditsState.session = null; creditsState.lastBalance = null; },
  _setSleep(fn) { _sleep = typeof fn === 'function' ? fn : (ms) => new Promise((resolve) => setTimeout(resolve, ms)); },
  _setNow(fn) { _now = typeof fn === 'function' ? fn : () => Date.now(); },
};
