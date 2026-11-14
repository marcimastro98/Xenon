'use strict';
// The live voice watch over the Discord link: who listens, the events subscribed to, the voice
// state read again after a burst of events, the speaking events of the channel the user is in,
// the wait before connecting again, and what is known about notifications.

const { normNotification } = require('./rpc-shapes.js');
const { RPC_DEBUG, logDispatch } = require('./rpc-debug.js');

function makeWatch({
  wantNotifications, watchState, speaking, close, rawSend, connect, voiceState,
}) {
  // ── Live voice watch (event subscription; see watchVoice) ──────────────────
  // When a consumer (the dashboard widget, via the server's SSE) is watching, we
  // SUBSCRIBE to Discord's voice events and push a fresh state on each change
  // instead of being polled. While watching the socket is kept alive (idle-close
  // disabled) and re-established with backoff if Discord drops it.
  const WATCH_EVENTS = ['VOICE_SETTINGS_UPDATE', 'VOICE_CHANNEL_SELECT'];
  const RECONNECT_MAX_MS = 30000;

  let watchCb = null;          // called with a client-safe voiceState() on any change
  let notifyCb = null;         // called with a client-safe normNotification() per notification
  let lastNotifSubError = '';  // de-dups the subscribe-rejection log line
  let lastVoice = null;        // last emitted state (for speaking merges + de-dup)
  let reconnectTimer = null;
  let recomputeTimer = null;
  let reconnectDelay = 0;

  // ── Live voice watch ──────────────────────────────────────────────────────
  // Subscribe to Discord's voice events and push a fresh state to `watchCb` on
  // each change, so the dashboard widget updates in real time (via SSE) instead
  // of polling. Speaking is tracked in-memory and merged onto the last snapshot
  // without an RPC round-trip (SPEAKING events fire rapidly). Settings/channel
  // changes trigger a debounced full recompute.
  //
  // Push an "offline" state (de-duplicated) when the socket is lost. `linked` tells
  // the widget whether the ACCOUNT is still linked: a dropped pipe (Discord app
  // closed) keeps the token → linked:true (show the account, just offline); a token
  // that failed to refresh → linked:false (show the "connect in Settings" notice).
  function emitOffline(linked) {
    const next = { ok: false, connected: !!linked };
    if (lastVoice && lastVoice.ok === false && lastVoice.connected === next.connected) return;  // same offline state
    lastVoice = next;
    if (watchCb) { try { watchCb(lastVoice); } catch { /* ignore consumer error */ } }
  }

  // Emit the last snapshot with current speaking flags applied to its members.
  function emitVoice() {
    if (!watchCb || !lastVoice) return;
    if (lastVoice.ok && Array.isArray(lastVoice.members)) {
      for (const m of lastVoice.members) m.speaking = speaking.has(m.id);
    }
    try { watchCb(lastVoice); } catch { /* ignore consumer error */ }
  }

  function handleDispatch(evt, payload) {
    if (RPC_DEBUG) logDispatch(evt, payload);
    if (!watchState.watching) return;
    if (evt === 'NOTIFICATION_CREATE') {
      // A Discord notification (DM / mention / watched channel). Project it to the
      // client-safe shape and hand it to the consumer — no voice recompute needed.
      if (!notifyCb) return;
      const n = normNotification(payload);
      if (n) { try { notifyCb(n); } catch { /* ignore consumer error */ } }
      return;
    }
    if (evt === 'SPEAKING_START' || evt === 'SPEAKING_STOP') {
      const uid = payload && payload.user_id ? String(payload.user_id) : '';
      if (!uid) return;
      if (evt === 'SPEAKING_START') speaking.add(uid); else speaking.delete(uid);
      emitVoice();                       // cheap: re-flag members, no RPC
      return;
    }
    if (evt === 'VOICE_STATE_CREATE' || evt === 'VOICE_STATE_UPDATE' || evt === 'VOICE_STATE_DELETE') {
      // Someone joined/left/(un)muted the current channel — refresh the member list.
      // Debounced a touch wider than a settings/channel change: membership latency is
      // forgiving, and VOICE_STATE_UPDATE can burst (per-member flag toggles), so the
      // wider window collapses the flurry into a single read. Speaking is handled
      // instantly above, so this never delays the "talking" indicator.
      scheduleRecompute(300);
      return;
    }
    if (evt === 'VOICE_CHANNEL_SELECT') {
      // Authoritative "current channel" signal — and the ONLY one that covers DM/
      // group calls, which GET_SELECTED_VOICE_CHANNEL does not report. null = left.
      watchState.currentVoiceChannelId = (payload && payload.channel_id) ? String(payload.channel_id) : null;
    }
    scheduleRecompute();                 // VOICE_SETTINGS_UPDATE / VOICE_CHANNEL_SELECT
  }

  function scheduleRecompute(delay = 150) {
    if (recomputeTimer) return;          // collapse a burst of events into one read
    recomputeTimer = setTimeout(() => { recomputeTimer = null; recompute().catch(() => {}); }, delay);
  }

  // Re-read the full voice state, re-point the SPEAKING subscription if the
  // channel changed, prune stale speakers, then emit.
  async function recompute() {
    if (!watchState.watching) return;
    const st = await voiceState();
    lastVoice = st;
    const chId = (st.ok && st.channel) ? st.channel.id : null;
    if (chId !== watchState.watchChannelId) await resubscribeSpeaking(chId);
    if (st.ok && Array.isArray(st.members)) {
      const present = new Set(st.members.map((m) => m.id));
      for (const id of Array.from(speaking)) if (!present.has(id)) speaking.delete(id);
    } else speaking.clear();
    emitVoice();
  }

  // SPEAKING_START/STOP and VOICE_STATE_* are per-channel subscriptions — swap them
  // when the user moves channels so the widget reflects who's talking AND who's in
  // the channel live (a member joining/leaving fires VOICE_STATE_*, not SPEAKING).
  // Best-effort: a failed (un)subscribe just loses live updates for that channel.
  const CHANNEL_EVENTS = ['SPEAKING_START', 'SPEAKING_STOP', 'VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE'];
  async function resubscribeSpeaking(newId) {
    const old = watchState.watchChannelId;
    watchState.watchChannelId = newId;
    speaking.clear();
    try {
      if (old) {
        for (const evt of CHANNEL_EVENTS) await rawSend('UNSUBSCRIBE', { channel_id: old }, evt).catch(() => {});
      }
      if (newId) {
        for (const evt of CHANNEL_EVENTS) await rawSend('SUBSCRIBE', { channel_id: newId }, evt);
      }
    } catch { /* live speaking / presence indicators are best-effort */ }
  }

  function scheduleReconnect() {
    if (!watchState.watching || reconnectTimer) return;
    reconnectDelay = Math.min(reconnectDelay ? reconnectDelay * 2 : 2000, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; startWatch(); }, reconnectDelay);
  }

  // Establish the socket, subscribe to the global voice events, and take an
  // initial snapshot. Retries with backoff on a transient failure; stops quietly
  // if there's no token (nothing to watch until the user links Discord again).
  async function startWatch() {
    if (!watchState.watching) return;
    // Reset up front, not after connect(): a transient connect failure must not
    // leave a STALE 'scope_missing' from a previous token showing "re-link
    // Discord" while the real state is just "reconnecting".
    watchState.notifState = 'off';
    try {
      await connect();
      for (const evt of WATCH_EVENTS) await rawSend('SUBSCRIBE', {}, evt);
      // Notification feed: best-effort, on the SAME socket/subscription set. The
      // one realistic failure is a token minted before the user opted in (no
      // NOTIF_SCOPE) — record it so the widget can say "re-link Discord" instead
      // of silently showing an empty feed. Re-attempted on every (re)connect.
      // The raw rejection is logged (once per distinct message) so a failure
      // that ISN'T scope-related is diagnosable instead of invisible.
      if (notifyCb && wantNotifications()) {
        try { await rawSend('SUBSCRIBE', {}, 'NOTIFICATION_CREATE'); watchState.notifState = 'ok'; }
        catch (e) {
          watchState.notifState = 'scope_missing';
          const msg = (e && e.message) || 'unknown';
          if (msg !== lastNotifSubError) {
            lastNotifSubError = msg;
            console.error('[discord] NOTIFICATION_CREATE subscribe rejected:', msg);
          }
        }
      }
      watchState.watchChannelId = null; speaking.clear();
      reconnectDelay = 0;
      await recompute();
    } catch (e) {
      const msg = (e && e.message) || '';
      if (msg === 'not_connected') {     // no/expired token — surface "not linked", don't spin
        emitOffline(false);
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        return;
      }
      emitOffline(true);                 // Discord unreachable but still linked → retry
      scheduleReconnect();               // close() may have scheduled already; idempotent
    }
  }

  // Attach a live watcher. Returns a stop() function. Only one watcher at a time
  // (the server registers a single one, fanned out to all SSE clients).
  // `onNotification` (optional) receives client-safe notifications while the
  // watch is live AND wantNotifications() is true at subscribe time.
  function watchVoice(cb, onNotification) {
    watchCb = cb;
    notifyCb = typeof onNotification === 'function' ? onNotification : null;
    watchState.watching = true;
    reconnectDelay = 0;
    lastVoice = null;
    watchState.currentVoiceChannelId = null;   // reset only on a fresh watch, not per reconnect
    startWatch();
    return stopWatch;
  }

  function stopWatch() {
    watchState.watching = false;                    // close() below won't reconnect
    watchCb = null;
    notifyCb = null; watchState.notifState = 'off';
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (recomputeTimer) { clearTimeout(recomputeTimer); recomputeTimer = null; }
    watchState.watchChannelId = null; speaking.clear(); lastVoice = null; reconnectDelay = 0;
    watchState.currentVoiceChannelId = null;
    close();
  }

  // Notification-feed health for the widget: 'off' | 'ok' | 'scope_missing'.
  function notifStatus() { return watchState.notifState; }

  return { emitOffline, handleDispatch, scheduleReconnect, watchVoice, notifStatus };
}

module.exports = { makeWatch };
