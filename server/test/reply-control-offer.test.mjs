// Which control Bit's reply keeps (server/ai/reply-control-offer.js), and the tools that offer
// one only after the PC did what was asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { offerControl, lightControl, MAX_PER_REPLY } = require('../ai/reply-control-offer.js');
const audio = require('../audio/tools.js').branches;
const media = require('../media/tools.js').branches;
const home = require('../smart-home/tools.js').branches;
const { audioCache } = require('../audio/device-cache.js');

const offers = (list) => list.filter((a) => a.action === 'reply_control').map((a) => a.args);

test('an offer is one of four kinds, a light only by its light entity, each once, at most four', () => {
  const list = [{ action: 'open_url', args: {} }];
  offerControl(list, { kind: 'lock' });
  offerControl(list, { kind: 'light', entity: 'lock.front_door' });
  offerControl(list, { kind: 'light', entity: 'switch.fan' });
  offerControl(list, { kind: 'volume' });
  offerControl(list, { kind: 'volume' });
  offerControl(list, lightControl('light.desk', null, true));
  offerControl(list, lightControl('light.hall', null, true));
  offerControl(list, lightControl('light.desk', null, false));
  offerControl(list, { kind: 'media' });
  offerControl(list, { kind: 'mic' });
  assert.deepEqual(offers(list).map((c) => c.entity || c.kind), ['volume', 'light.desk', 'light.hall', 'media']);
  assert.equal(offers(list).length, MAX_PER_REPLY);
  assert.equal(list[0].action, 'open_url', 'the other actions stay as they were');
  assert.doesNotThrow(() => offerControl(null, { kind: 'volume' }));
});

test('a light control says what HA knows: its name, whether it dims, how bright', () => {
  assert.deepEqual(lightControl('light.living_room', null, null),
    { kind: 'light', entity: 'light.living_room', name: 'living room', dimmable: false, on: null, pct: null });
  const lamp = lightControl('light.desk', { name: 'Desk lamp', colorModes: ['brightness'], brightness: 128 }, true);
  assert.equal(lamp.name, 'Desk lamp');
  assert.equal(lamp.dimmable, true);
  assert.equal(lamp.pct, 50);
  assert.equal(lightControl('light.a', { colorModes: ['onoff'] }, true).dimmable, false);
  assert.equal(lightControl('light.a', { brightness: 1 }, true).pct, 1, 'on is never 0%');
  assert.equal(lightControl('light.a', { name: 'x'.repeat(200) }, true).name.length, 80);
});

test('audio tools offer the volume or the microphone once the PC took it', async () => {
  const exec = { svvExec: async () => {}, setMicMute: () => {} };
  const prev = { ...audioCache };
  try {
    audioCache.speakerId = null;
    let list = [];
    await audio.set_volume({ fnArgs: { level: 30 }, clientActions: list }, exec);
    assert.deepEqual(offers(list), [], 'no speaker known: nothing was set');
    audioCache.speakerId = 'spk';
    await audio.set_volume({ fnArgs: { level: 30 }, clientActions: list }, exec);
    assert.deepEqual(offers(list), [{ kind: 'volume' }]);
    list = [];
    await audio.toggle_speaker_mute({ clientActions: list }, exec);
    assert.deepEqual(offers(list), [{ kind: 'volume' }]);
    for (const name of ['toggle_mic', 'mute_mic', 'unmute_mic']) {
      list = [];
      await audio[name]({ clientActions: list }, exec);
      assert.deepEqual(offers(list), [{ kind: 'mic' }], name);
    }
    audioCache.micId = 'mic';
    list = [];
    await audio.set_mic_volume({ fnArgs: { level: 40 }, clientActions: list }, exec);
    assert.deepEqual(offers(list), [], 'a mute switch is not the level that was set');
  } finally { Object.assign(audioCache, prev); }
});

test('media tools offer the music control only when the key worked', async () => {
  let list = [];
  await media.media_next({ clientActions: list }, { mediaAction: async () => ({ ok: true }) });
  assert.deepEqual(offers(list), [{ kind: 'media' }]);
  list = [];
  await media.media_playpause({ clientActions: list }, { mediaAction: async () => ({ error: 'no session' }) });
  assert.deepEqual(offers(list), []);
});

test('a light Bit switched gets its control with the state that was asked', async () => {
  const known = { 'light.desk': { id: 'light.desk', name: 'Desk lamp', state: 'off', colorModes: ['brightness'] } };
  const deckHa = { snapshot: (ids) => ids.map((id) => known[id]).filter(Boolean) };
  const run = async (fnArgs, result = { ok: true }) => {
    const list = [];
    await home.home_assistant({ fnArgs, clientActions: list, runAction: async () => result }, { deckHa });
    return offers(list);
  };
  assert.equal((await run({ action: 'turn_on', entity_id: 'light.desk' }))[0].on, true);
  assert.equal((await run({ action: 'toggle', entity_id: 'light.desk' }))[0].on, true, 'it was off');
  assert.equal((await run({ action: 'turn_off', entity_id: 'light.desk' }))[0].on, false);
  assert.equal((await run({ action: 'toggle', entity_id: 'light.porch' }))[0].on, null, 'unknown until HA says');
  assert.equal((await run({ action: 'turn_on', entity_id: 'light.porch' }))[0].name, 'porch');
  assert.deepEqual(await run({ action: 'turn_on', entity_id: 'switch.fan' }), [], 'lights only');
  assert.deepEqual(await run({ action: 'scene', entity_id: 'scene.movie' }), []);
  assert.deepEqual(await run({ action: 'turn_on', entity_id: 'light.desk' }, { error: 'ha offline' }), []);
  assert.deepEqual(await run({ action: 'turn_on', entity_id: 'lock.front_door' }), [], 'never a lock');
});
