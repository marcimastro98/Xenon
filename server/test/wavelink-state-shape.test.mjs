import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// GET /api/wavelink/state and the `wavelink` SSE event answer with one of two
// objects: the client's live snapshot, or the constant server.js returns when
// the integration is switched off. The widget reads BOTH through the same
// absorb(), so a key present in one and missing from the other is a tile that
// renders an error the moment someone unticks the box in Settings — which is
// invisible in review and only reproducible by turning the feature off.
//
// server.js cannot be imported (it starts a listener), so the constant is
// extracted from the shipped source, which is also what keeps this honest: a
// copy here would keep passing after the real one drifted.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
const require = createRequire(import.meta.url);
const wl = require('../actions/wavelink.js');

function offState() {
  const at = SRC.indexOf('const WL_OFF_STATE = Object.freeze(');
  assert.notEqual(at, -1, 'server.js must still declare WL_OFF_STATE');
  const open = SRC.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) {
      return new Function('return (' + SRC.slice(open, i + 1) + ');')();
    }
  }
  throw new Error('WL_OFF_STATE never closes');
}

// A client that has never connected: the shape a snapshot takes before, and
// after, Wave Link is reachable has to be the same one too.
function idleSnapshot() {
  return wl.createWaveLink(async () => ({ enabled: false })).snapshot();
}

test('the off state carries every key a live snapshot does', () => {
  const off = offState();
  const live = idleSnapshot();
  for (const k of Object.keys(live)) {
    assert.ok(k in off, 'WL_OFF_STATE is missing "' + k + '", which the widget reads');
  }
});

test('the collection keys are the right kind of empty, never undefined', () => {
  const off = offState();
  assert.ok(Array.isArray(off.channels), 'channels must be an array to map over');
  assert.ok(Array.isArray(off.mixes));
  assert.ok(off.outputs && Array.isArray(off.outputs.devices));
  assert.equal(off.enabled, false);
  assert.equal(off.connected, false);
});

// The widget hides the meter, the effect pills, the output picker and the
// monitor switch on `capabilities`. An absent object means every one of them
// reads as undefined, which is falsy and therefore accidentally correct — until
// someone writes `if (!caps.meters)` and it throws instead.
test('capabilities is always an object with the flags the widget reads', () => {
  const off = offState();
  const live = idleSnapshot();
  assert.equal(typeof off.capabilities, 'object');
  for (const k of Object.keys(live.capabilities)) {
    assert.equal(typeof off.capabilities[k], 'boolean', 'capability "' + k + '" must be a boolean when off');
    assert.equal(off.capabilities[k], false, 'nothing is available while the integration is off');
  }
});

// A snapshot taken before any connection must not claim a dialect: the tile
// shows that number as a badge, and "Wave Link 2" on a machine running 3 is
// worse than no badge at all.
test('an unconnected client reports no dialect rather than guessing one', () => {
  const live = idleSnapshot();
  assert.equal(live.dialect, 0);
  assert.equal(live.connected, false);
  assert.equal(live.monitor, null);
});
