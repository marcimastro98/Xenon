'use strict';
// Picks the paired phone and its modem out of what D-Bus lists on Linux, and reads the calls
// and their state.

const PBAP_UUID = '0000112f-0000-1000-8000-00805f9b34fb';
const MAP_UUID = '00001132-0000-1000-8000-00805f9b34fb';

function hasUuid(device, uuid) {
  return (device.uuids || []).some(u => String(u).toLowerCase() === uuid);
}

// Connected first: a phone that is paired but out of range publishes the same
// UUIDs and would be picked while being unreachable.
function pickPhone(devices, uuid) {
  const able = (devices || []).filter(d => d.address && hasUuid(d, uuid));
  return able.find(d => d.connected) || able[0] || null;
}

// The modem ofono creates for a Bluetooth handsfree connection. `Online` and
// `Powered` both matter: a modem object outlives the phone walking away, and
// dialling through a dead one fails in a way that reads as a Xenon fault.
function parseModems(json) {
  const out = [];
  let tree;
  try { tree = typeof json === 'string' ? JSON.parse(json) : json; } catch { return out; }
  const rows = (tree && tree.data && Array.isArray(tree.data) ? tree.data[0] : tree) || [];
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const objPath = Array.isArray(row) ? row[0] : (row && row.path);
    const props = (Array.isArray(row) ? row[1] : (row && row.properties)) || {};
    if (typeof objPath !== 'string') continue;
    const val = (k) => (props[k] && 'data' in props[k] ? props[k].data : props[k]);
    out.push({
      path: objPath,
      name: String(val('Name') || ''),
      type: String(val('Type') || ''),
      online: val('Online') === true,
      powered: val('Powered') === true,
      interfaces: Array.isArray(val('Interfaces')) ? val('Interfaces').map(String) : [],
    });
  }
  return out;
}

function pickModem(modems) {
  const usable = (modems || []).filter(m => m.powered && m.interfaces.includes('org.ofono.VoiceCallManager'));
  // A handsfree modem IS the paired phone; anything else would be a real cellular
  // modem in the machine, which is not what this feature is about.
  return usable.find(m => m.type === 'hfp') || usable.find(m => m.online) || usable[0] || null;
}

// ofono's call states, reduced to the two booleans every surface here speaks.
// `incoming` and `waiting` both ring; `dialing`/`alerting` are ours going out
// and are ACTIVE rather than incoming, or the card would ring at the user for a
// call they just placed themselves.
const RINGING_STATES = new Set(['incoming', 'waiting']);
const ACTIVE_STATES = new Set(['active', 'held', 'dialing', 'alerting']);

function parseCalls(json) {
  const out = [];
  let tree;
  try { tree = typeof json === 'string' ? JSON.parse(json) : json; } catch { return out; }
  const rows = (tree && tree.data && Array.isArray(tree.data) ? tree.data[0] : tree) || [];
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const objPath = Array.isArray(row) ? row[0] : (row && row.path);
    const props = (Array.isArray(row) ? row[1] : (row && row.properties)) || {};
    if (typeof objPath !== 'string') continue;
    const val = (k) => (props[k] && 'data' in props[k] ? props[k].data : props[k]);
    out.push({
      path: objPath,
      state: String(val('State') || '').toLowerCase(),
      number: String(val('LineIdentification') || ''),
      name: String(val('Name') || ''),
    });
  }
  return out;
}

function callState(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const ringing = list.find(c => RINGING_STATES.has(c.state)) || null;
  return {
    incoming: !!ringing,
    active: list.some(c => ACTIVE_STATES.has(c.state)),
    ringingPath: ringing ? ringing.path : '',
    // ofono knows WHO is calling, which the Windows path does not — the caller
    // there has to come from a mirrored toast. Passing it up costs nothing and
    // makes the card correct on its own here.
    caller: ringing ? (ringing.name || ringing.number || '') : '',
  };
}

module.exports = {
  PBAP_UUID, MAP_UUID, hasUuid, pickPhone, parseModems, pickModem, RINGING_STATES, ACTIVE_STATES,
  parseCalls, callState,
};
