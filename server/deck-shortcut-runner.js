'use strict';
// Runs a Deck key from its keyboard shortcut (js/deck-shortcuts.js): the press
// reaches the server (Xenon Helper, or the desktop's own shortcut on Linux) and
// the key's tap runs here, step by step, with its pauses, as a tap on the key
// would. It works with no dashboard open, which is the point on a single screen.
//
// A few steps only exist in a dashboard (a sound the browser plays, the AI
// chat, the mixer overlay). Those are offered to the dashboards over SSE
// `deck_shortcut` and the FIRST one on this PC to claim it runs it (POST
// /deck/shortcut-claim, refused to paired devices), so a phone never plays the
// sound and two open dashboards never run it twice. Nobody claims in time: the
// step fails and the failure is told like any other, except a sound, which the
// PC then plays itself (deck-sound-player.js).
//
// deps (injected):
//   readConfigs()            the stored Deck configs (deck.json `configs`)
//   steps(trigger)           DeckActions.triggerSteps — validated {action, delayMs}
//   run(action)              actions/registry.js run → {ok, error?}
//   broadcast(event, data)   SSE to every dashboard
//   claimMs                  how long a dashboard has to claim a step
//   soundPlayer              deck-sound-player.js (optional)
//   serverFirst()            true when this PC shows no dashboard: sounds skip the offer
const crypto = require('crypto');
const S = require('./js/deck-shortcuts.js');

const MAX_STEPS = 16;
const CLAIM_MS = 1500;
const PENDING_MAX = 32;
const SOUND_ACTIONS = ['playSound', 'soundStopAll'];
const HAND_OFF = ['ai', 'appMixer'];   // what a window that cannot run them hands on (handOff)

function createDeckShortcutRunner(deps) {
  const d = deps || {};
  const claimMs = Number.isFinite(d.claimMs) ? d.claimMs : CLAIM_MS;
  const running = new Set();
  const pending = new Map();   // nonce → settle(claimed)
  const timers = new Set();

  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => { timers.delete(t); resolve(); }, ms);
    timers.add(t);
    if (t.unref) t.unref();
  });

  function handToDashboard(action) {
    if (pending.size >= PENDING_MAX) return Promise.resolve(false);
    const nonce = crypto.randomBytes(12).toString('hex');
    return new Promise((resolve) => {
      const t = setTimeout(() => { timers.delete(t); pending.delete(nonce); resolve(false); }, claimMs);
      timers.add(t);
      if (t.unref) t.unref();
      pending.set(nonce, (claimed) => { clearTimeout(t); timers.delete(t); resolve(claimed); });
      d.broadcast('deck_shortcut', { nonce, action });
    });
  }

  // A dashboard asks to run a handed-out step. Only the first ask wins.
  function claim(nonce) {
    const settle = pending.get(String(nonce || ''));
    if (!settle) return false;
    pending.delete(String(nonce));
    settle(true);
    return true;
  }

  // A key pressed where its step cannot run (the Virtual Deck window, a Deck on
  // a widget layer): the AI chat or the mixer opens on the dashboard, or on the
  // screen in "widgets only" mode, whichever claims it first.
  async function handOff(action) {
    if (!action || !HAND_OFF.includes(action.type)) return { ok: false, error: 'unknown_action' };
    return (await handToDashboard(action)) ? { ok: true } : { ok: false, error: 'no_dashboard' };
  }

  // A soundboard clip: a dashboard on this PC plays it as a tap would; with
  // none ("widgets only", or nobody claims) the PC plays it itself. Stops go to
  // both, since either may be the one playing.
  async function runSound(action) {
    const player = d.soundPlayer;
    const serverOnly = !!(d.serverFirst && d.serverFirst());
    if (action.type === 'soundStopAll' || action.mode === 'stop') {
      if (action.type === 'soundStopAll') player.stopAll();
      else await player.play(action);
      if (!serverOnly) await handToDashboard(action);
      return { ok: true };
    }
    if (action.mode === 'toggle' && await player.playing(action.file)) return player.play(action);
    if (!serverOnly && await handToDashboard(action)) return { ok: true };
    return player.play(action);
  }

  async function runStep(action) {
    if (d.soundPlayer && SOUND_ACTIONS.includes(action.type)) {
      try { return await runSound(action); } catch { return { ok: false, error: 'failed' }; }
    }
    if (S.CLIENT_ACTIONS.includes(action.type)) {
      return (await handToDashboard(action)) ? { ok: true } : { ok: false, error: 'no_dashboard' };
    }
    // A widget's handler is told how its key was pressed, as deck.js does.
    const sent = action.type === 'sdkHandler' ? Object.assign({}, action, { gesture: { type: 'tap' } }) : action;
    try { return (await d.run(sent)) || { ok: false, error: 'failed' }; }
    catch { return { ok: false, error: 'failed' }; }
  }

  // The shortcut `combo` of key `keyId` was pressed. Re-read from the store, so
  // a key edited (or its shortcut changed) since the combo was registered does
  // what it says now, or nothing.
  async function press(keyId, combo) {
    if (running.has(keyId)) return { ok: false, error: 'busy' };   // a held repeat, or a slow macro
    running.add(keyId);
    try {
      const found = S.findKey(await d.readConfigs(), keyId);
      if (!found || S.normalizeShortcut(found.key.shortcut) !== combo) return { ok: false, error: 'gone' };
      const title = String(found.key.title || '');
      const list = d.steps(S.shortcutTrigger(found.key)).slice(0, MAX_STEPS);
      if (!list.length) {
        d.broadcast('deck_shortcut_failed', { title, error: 'no_action' });
        return { ok: false, error: 'no_action' };
      }
      let error = '';
      for (const step of list) {
        if (step.delayMs) await sleep(step.delayMs);
        const r = await runStep(step.action);
        if (r && r.ok === false && !error) error = r.error || 'failed';   // run every step, report the first failure
      }
      if (error) d.broadcast('deck_shortcut_failed', { title, error });
      return error ? { ok: false, error } : { ok: true };
    } catch {
      return { ok: false, error: 'failed' };
    } finally {
      running.delete(keyId);
    }
  }

  function stop() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const settle of pending.values()) settle(false);
    pending.clear();
    if (d.soundPlayer) d.soundPlayer.stop();
  }

  return { press, claim, handOff, stop };
}

module.exports = { createDeckShortcutRunner, MAX_STEPS, CLAIM_MS };
