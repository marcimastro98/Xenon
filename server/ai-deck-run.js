'use strict';

// Bit presses a Deck action (the run_deck_action tool). The action goes through
// the same validator and the same registry as a key press (js/deck-actions.js,
// actions/registry.js), so Bit can never do more than a key can. What it adds is
// one rule a key does not need: an action that runs code, types or presses keys
// for the user, speaks to other people, unlocks something or cannot be taken
// back waits for a confirmation card first. A key is a choice the user made;
// a model's reading of a sentence is not.

const { ACTION_CATALOG, validateAction } = require('./js/deck-actions.js');
const { CAPABILITIES } = require('./js/capability-catalog.js');
const { CLIENT_ACTIONS } = require('./js/deck-shortcuts.js');

const CONFIRM_TYPES = new Set([
  // Code, keystrokes and files the user did not pick by hand.
  'runScript', 'typeText', 'hotkey', 'openFile', 'sdkMacro', 'sdkHandler', 'claudeAsk',
  // The PC, the phone and the remote session.
  'lockWorkstation', 'phoneCall', 'phoneMessage', 'remoteDisconnect', 'remoteBlock',
  // Sent to other people or to the internet.
  'webhook', 'twitchChat', 'twitchTitle', 'twitchGame', 'twitchAd', 'twitchShoutout', 'twitchChatMode',
  'ytBroadcast', 'obsStream', 'sbDoAction', 'sbSendMessage', 'sbCodeTrigger',
  // The house: doors, the alarm, and anything a script or service call can do.
  'haLock', 'haAlarm', 'haScript', 'haCallService',
]);

// 'ai' would be Bit asking itself. A capability decides for itself whether Bit
// may use it, by having an AI tool of its own (capabilities/index.js aiFunctions).
const CAPABILITY_TYPES = new Set(CAPABILITIES.map((c) => c.type));
const HIDDEN_TYPES = new Set(ACTION_CATALOG.filter((a) => a.hidden).map((a) => a.type));
// The steps only a dashboard can play (a sound, the mixer): they run in the
// chat's own page, through the same DeckClientRun a keyboard shortcut uses.
const CLIENT_TYPES = new Set(CLIENT_ACTIONS.filter((t) => t !== 'ai'));

const CONFIRM_TTL_MS = 5 * 60 * 1000;
const CONFIRM_MAX = 16;
const PURPOSE_MAX = 300;
const VALUE_MAX = 200;

// What to do with what the model sent: { mode: 'run' | 'client' | 'confirm', action }
// or { ok: false, error, hint }.
function plan(raw) {
  const type = raw && typeof raw === 'object' ? String(raw.type || '') : '';
  if (type === 'ai') return { ok: false, error: 'not_for_bit', hint: 'This is the key that opens you: answer the user directly.' };
  if (CAPABILITY_TYPES.has(type)) return { ok: false, error: 'use_dedicated_tool', hint: 'Use this action\'s own tool if you have one; if you do not, it is not something you can run.' };
  const action = HIDDEN_TYPES.has(type) ? null : validateAction(raw);
  if (!action) return { ok: false, error: 'unknown_action', hint: 'Call deck_action_catalog for the exact action types and their params.' };
  if (CONFIRM_TYPES.has(action.type)) return { mode: 'confirm', action };
  if (CLIENT_TYPES.has(action.type)) return { mode: 'client', action };
  return { mode: 'run', action };
}

// The action's settings as the card lists them: name and value, empty ones
// left out, each value cut so a long text cannot push the buttons off screen.
function describe(action) {
  return Object.keys(action || {})
    .filter((k) => k !== 'type' && String(action[k]).trim())
    .map((k) => ({ name: k, value: String(action[k]).slice(0, VALUE_MAX) }));
}

function purposeOf(args) {
  return String((args && (args.description || args.purpose)) || '').trim().slice(0, PURPOSE_MAX);
}

// Proposals waiting on the card, by an unguessable single-use nonce. The action
// is stored here, already validated, and the browser only ever sends the nonce
// back: what runs is what the card showed.
function createConfirmStore(deps) {
  const d = deps || {};
  const now = d.now || (() => Date.now());
  const randomId = d.randomId || (() => require('node:crypto').randomBytes(18).toString('hex'));
  const ttl = d.ttlMs || CONFIRM_TTL_MS;
  const pending = new Map();
  function sweep() {
    const t = now();
    for (const [k, v] of pending) if (t - v.ts > ttl) pending.delete(k);
    while (pending.size >= CONFIRM_MAX) pending.delete(pending.keys().next().value);
  }
  function issue(action) {
    sweep();
    const nonce = randomId();
    pending.set(nonce, { action, ts: now() });
    return nonce;
  }
  // The action once, or null when the nonce is unknown, used or too old.
  function take(nonce) {
    const key = String(nonce || '');
    const entry = pending.get(key);
    if (!entry) return null;
    pending.delete(key);
    return now() - entry.ts > ttl ? null : entry.action;
  }
  function cancel(nonce) { pending.delete(String(nonce || '')); }
  return { issue, take, cancel };
}

module.exports = { plan, describe, purposeOf, createConfirmStore, CONFIRM_TYPES, CLIENT_TYPES };
