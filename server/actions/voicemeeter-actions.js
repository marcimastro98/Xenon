'use strict';
// What a Deck action does to Voicemeeter: a strip or a bus muted, soloed or routed, a gain set
// or nudged, a macro button pressed, each through a parameter name the client has checked.

const {
  busIndex, clampGain, isSafeParam, paramName, nextFlag, nextGain,
} = require('./voicemeeter-params.js');

function makeActions({ vmSession, edition, getParam, setParam, macroButton }) {
  // ── The Deck actions ──────────────────────────────────────────────────────
  async function runAction(action) {
    const a = action || {};
    // validateAction (js/deck-actions.js) returns the params FLAT on the action,
    // the same shape every other provider here reads. Reaching for a .params
    // bag that never exists made every key answer bad_strip.
    const p = a;
    const ed = edition();
    if (!ed) return { ok: false, error: vmSession.lastError || 'voicemeeter_not_running' };

    const stripIdx = () => {
      const i = Number(p.strip);
      if (!Number.isInteger(i) || i < 0 || i >= ed.strips) return -1;
      return i;
    };

    switch (a.type) {
      case 'vmStripMute': {
        const i = stripIdx();
        if (i < 0) return { ok: false, error: 'voicemeeter_bad_strip' };
        return flip(paramName('strip', i, 'Mute'), p.mode);
      }
      case 'vmStripGain': {
        const i = stripIdx();
        if (i < 0) return { ok: false, error: 'voicemeeter_bad_strip' };
        return nudge(paramName('strip', i, 'Gain'), p.mode, p.value);
      }
      case 'vmStripBus': {
        const i = stripIdx();
        if (i < 0) return { ok: false, error: 'voicemeeter_bad_strip' };
        // The bus is stored as its LABEL (A1, B2) because that is what the
        // buttons say and what survives a move between editions.
        if (busIndex(p.bus, ed.id) < 0) return { ok: false, error: 'voicemeeter_bad_bus' };
        return flip(paramName('strip', i, String(p.bus).toUpperCase()), p.mode);
      }
      case 'vmBusMute': {
        const b = busIndex(p.bus, ed.id);
        if (b < 0) return { ok: false, error: 'voicemeeter_bad_bus' };
        return flip(paramName('bus', b, 'Mute'), p.mode);
      }
      case 'vmBusGain': {
        const b = busIndex(p.bus, ed.id);
        if (b < 0) return { ok: false, error: 'voicemeeter_bad_bus' };
        return nudge(paramName('bus', b, 'Gain'), p.mode, p.value);
      }
      case 'vmMacro':
        return macroButton(p.index, p.mode);
      case 'vmParam': {
        // The escape hatch, and the reason this integration is one file: every
        // control in Voicemeeter is a named parameter, so anything the named
        // actions above do not cover can still be bound without new code.
        const name = String(p.param || '').trim();
        if (!isSafeParam(name)) return { ok: false, error: 'voicemeeter_bad_param' };
        if (p.mode === 'toggle') return flip(name, 'toggle');
        if (p.mode === 'up' || p.mode === 'down') return nudge(name, p.mode, p.value);
        return setParam(name, p.value);
      }
      default:
        return { ok: false, error: 'voicemeeter_unknown_action' };
    }
  }

  function flip(name, mode) {
    if (!name) return { ok: false, error: 'voicemeeter_bad_param' };
    if (mode === 'on' || mode === 'off') return setParam(name, nextFlag(mode, 0));
    const cur = getParam(name);
    if (!cur.ok) return cur;
    return setParam(name, nextFlag('toggle', cur.value));
  }

  function nudge(name, mode, value) {
    if (!name) return { ok: false, error: 'voicemeeter_bad_param' };
    if (mode === 'set') {
      const v = clampGain(value);
      if (v == null) return { ok: false, error: 'voicemeeter_bad_value' };
      return setParam(name, v);
    }
    const cur = getParam(name);
    if (!cur.ok) return cur;
    const v = nextGain(mode === 'down' ? 'down' : 'up', cur.value, value);
    if (v == null) return { ok: false, error: 'voicemeeter_bad_value' };
    return setParam(name, v);
  }

  return { runAction };
}

module.exports = { makeActions };
