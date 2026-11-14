'use strict';
// What can be done with a call on the paired phone, and whether the phone said it can: the name
// behind a number, the device's name, answering, hanging up and dialling.

const numbers = require('../phone-numbers.js');

function makeCalls({ supported, cache, enabled, request }) {
  // Public name resolution, for the incoming-call card and anything else that
  // holds a number and wants a person.
  function resolve(number) {
    return numbers.lookup(cache.contacts.index, number);
  }

  // The phone's own name, as the user sees it on the device. Read from the last
  // status rather than fetched, because the caller is a ringing call: a round
  // trip here would delay the card by exactly the seconds it exists for.
  function deviceName() {
    const v = cache.status.value;
    return (v && typeof v.device === 'string' && v.device) || '';
  }

  // What the platform actually allows, as the helper reported it. Both are
  // false everywhere today and the card renders from them anyway, so the day
  // one platform can answer a call, nothing above this line has to change.
  function canAnswer() {
    const v = cache.status.value;
    return !!(v && v.canAnswer === true);
  }

  function canHangUp() {
    const v = cache.status.value;
    return !!(v && v.canHangUp === true);
  }

  // Whether a Deck key or an AI tool that dials would work right now. Cached,
  // never probed: the action catalog is fetched while the Deck editor is open,
  // and a Bluetooth round trip there would stall the whole key list.
  function canDial() {
    const v = cache.status.value;
    return !!(supported && v && v.canDial === true);
  }

  // Answering and hanging up. Both exist for exactly one platform today, which
  // is why they are ops rather than assumptions: `canAnswer` comes back from
  // the transport, the card renders from it, and here the capability is checked
  // again before anything is attempted — a button the client should not have
  // drawn must still be refused by the server.
  async function answer() {
    if (!enabled()) return { ok: false, error: 'disabled' };
    if (!canAnswer()) return { ok: false, error: 'unavailable' };
    try { await request('answer', {}, 15000); return { ok: true }; }
    catch (e) { return { ok: false, error: String((e && e.message) || 'phone_error') }; }
  }

  async function hangUp() {
    if (!enabled()) return { ok: false, error: 'disabled' };
    if (!canHangUp()) return { ok: false, error: 'unavailable' };
    try { await request('hangup', {}, 15000); return { ok: true }; }
    catch (e) { return { ok: false, error: String((e && e.message) || 'phone_error') }; }
  }

  async function dial(rawNumber) {
    if (!enabled()) return { ok: false, error: 'disabled' };
    // Validated here as well as at the boundary: this is the one call in the
    // feature that reaches the outside world and costs the user money, so what
    // reaches the phone is a number and nothing else.
    const number = numbers.dialable(rawNumber);
    if (!number) return { ok: false, error: 'bad_number' };
    try {
      await request('dial', { number }, 15000);
      return { ok: true, number };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || 'phone_error') };
    }
  }

  return { resolve, deviceName, canAnswer, canHangUp, canDial, answer, hangUp, dial };
}

module.exports = { makeCalls };
