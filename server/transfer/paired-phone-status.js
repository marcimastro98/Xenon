'use strict';
// The paired phone's state as the dashboard sees it: whether a call is coming in or running,
// how old each pull is, and the status read from the phone.

const { STATUS_TTL_MS } = require('./paired-phone-limits.js');

function makeStatus({
  supported, broadcast, getSettings, onCallState, cache, state, enabled, helperPresent, request,
  resolve,
}) {
  // The structural signal. `incoming` here is the OS saying a call is ringing
  // right now, which is a fact rather than the notification-text guess the card
  // used to depend on — so this is what starts the ring, and the mirrored toast
  // is left to supply the one thing this cannot: who is calling.
  function applyCallState(env) {
    const incoming = env.incoming === true;
    const active = env.active === true;
    if (incoming === state.incoming && active === state.active) return;
    state.incoming = incoming;
    state.active = active;
    broadcast('phone', publicState());
    try { onCallState({ incoming, active, resolve }); } catch { /* a listener must never break the feed */ }
  }

  function publicState() {
    return {
      incoming: state.incoming,
      active: state.active,
      contacts: cache.contacts.list.length,
      calls: cache.calls.list.length,
      stale: staleness(),
    };
  }

  function staleness() {
    const now = Date.now();
    return {
      contacts: cache.contacts.at ? now - cache.contacts.at : -1,
      calls: cache.calls.at ? now - cache.calls.at : -1,
    };
  }

  async function status(force) {
    if (!enabled()) return { ok: false, enabled: false, reason: 'disabled', supported };
    if (!supported) return { ok: false, enabled: true, reason: 'platform_unsupported', supported: false };
    if (!helperPresent()) return { ok: false, enabled: true, reason: 'helper_missing', supported: true };
    const now = Date.now();
    if (!force && cache.status.value && now - cache.status.at < STATUS_TTL_MS) {
      return { ok: true, enabled: true, ...cache.status.value, state: publicState() };
    }
    try {
      const value = await request('status', {}, 15000);
      // `hide` is the user's own setting, not a capability, but the widget
      // needs both in one read and asking twice would just be a second request.
      value.hide = (getSettings() || {}).hide === true;
      cache.status = { at: now, value, error: '' };
      // The host answers with the live booleans too; adopting them keeps a
      // dashboard that opened mid-call correct without waiting for the next
      // change event, which may be a minute away.
      applyCallState(value);
      return { ok: true, enabled: true, ...value, state: publicState() };
    } catch (e) {
      cache.status.error = String((e && e.message) || 'phone_error');
      return { ok: false, enabled: true, reason: cache.status.error, state: publicState() };
    }
  }

  return { applyCallState, publicState, status };
}

module.exports = { makeStatus };
