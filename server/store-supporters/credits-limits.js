'use strict';
// The models and effort levels a turn paid with Sparks may use, how long and how large one
// round may be, when a busy round is asked again, and the errors of the hub that are passed on.

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

module.exports = {
  MODELS, DEFAULT_MODEL, EFFORTS, DEFAULT_EFFORT, MAX_TOKENS, CREATION_MAX_TOKENS, CHAT_MAX_TOKENS,
  TURN_TIMEOUT_MS, MAX_TURN_BYTES, SMALL_TIMEOUT_MS, TOKEN_MARGIN_SEC, BUSY_WAITS_MS,
  BUSY_RETRY_WITHIN_MS, MAX_RETRY_AFTER_MS, KNOWN_ERRORS, sanitizeModel, sanitizeEffort,
};
