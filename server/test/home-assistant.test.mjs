import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ha = require('../actions/home-assistant.js');
const { createRegistry } = require('../actions/registry.js');

// ── haWsUrl: build the WS endpoint, rejecting non-http(s) ─────────────────────
test('haWsUrl converts http/https and appends /api/websocket', () => {
  assert.equal(ha.haWsUrl('http://192.168.1.5:8123'), 'ws://192.168.1.5:8123/api/websocket');
  assert.equal(ha.haWsUrl('https://ha.example.com'), 'wss://ha.example.com/api/websocket');
  assert.equal(ha.haWsUrl('http://homeassistant.local:8123/'), 'ws://homeassistant.local:8123/api/websocket');
});
test('haWsUrl rejects non-http and junk (no token ever sent to a bad origin)', () => {
  assert.equal(ha.haWsUrl('file:///etc/passwd'), '');
  assert.equal(ha.haWsUrl('javascript:alert(1)'), '');
  assert.equal(ha.haWsUrl('ws://ha:8123'), '');
  assert.equal(ha.haWsUrl(''), '');
  assert.equal(ha.haWsUrl(null), '');
  assert.equal(ha.haWsUrl('not a url'), '');
});

// ── isEntityId: the only free-form string reaching call_service ───────────────
test('isEntityId accepts real ids, rejects injection', () => {
  assert.equal(ha.isEntityId('light.kitchen'), true);
  assert.equal(ha.isEntityId('binary_sensor.front_door_2'), true);
  assert.equal(ha.isEntityId('light'), false);
  assert.equal(ha.isEntityId('light.'), false);
  assert.equal(ha.isEntityId('Light.Kitchen'), false);        // must be lowercase
  assert.equal(ha.isEntityId('light.kitchen; drop'), false);
  assert.equal(ha.isEntityId(null), false);
});

// ── compactEntity: small, per-domain projection ──────────────────────────────
test('compactEntity projects domain, name, area and light extras', () => {
  const c = ha.compactEntity({
    entity_id: 'light.bed', state: 'on',
    attributes: { friendly_name: 'Bed', brightness: 180, rgb_color: [1, 2, 3], unit_of_measurement: '' },
  }, () => 'Bedroom');
  assert.equal(c.id, 'light.bed');
  assert.equal(c.domain, 'light');
  assert.equal(c.name, 'Bed');
  assert.equal(c.area, 'Bedroom');
  assert.equal(c.brightness, 180);
  assert.deepEqual(c.rgb, [1, 2, 3]);
});
test('compactEntity handles climate and media_player', () => {
  const cl = ha.compactEntity({ entity_id: 'climate.lr', state: 'heat', attributes: { current_temperature: 21.4, temperature: 22 } });
  assert.equal(cl.current, 21.4);
  assert.equal(cl.target, 22);
  const mp = ha.compactEntity({ entity_id: 'media_player.tv', state: 'playing', attributes: { media_title: 'Song', media_artist: 'Artist', volume_level: 0.4 } });
  assert.equal(mp.title, 'Song');
  assert.equal(mp.volume, 0.4);
  assert.equal(ha.compactEntity(null), null);
});

// ── compactEntity: per-device CAPABILITIES for the control panel ──────────────
test('compactEntity exposes media_player capabilities (features, sources, mute)', () => {
  const mp = ha.compactEntity({
    entity_id: 'media_player.tv', state: 'on',
    attributes: { supported_features: 152524, source: 'HDMI 1', source_list: ['HDMI 1', 'HDMI 2', 'Netflix'], is_volume_muted: true, sound_mode: 'Standard', sound_mode_list: ['Standard', 'Movie'] },
  });
  assert.equal(mp.features, 152524);
  assert.equal(mp.muted, true);
  assert.equal(mp.source, 'HDMI 1');
  assert.deepEqual(mp.sources, ['HDMI 1', 'HDMI 2', 'Netflix']);
  assert.deepEqual(mp.soundModes, ['Standard', 'Movie']);
});
test('compactEntity exposes climate modes + range and light colour caps', () => {
  const cl = ha.compactEntity({
    entity_id: 'climate.ac', state: 'cool',
    attributes: { current_temperature: 24, temperature: 21, hvac_modes: ['off', 'cool', 'heat'], hvac_action: 'cooling', min_temp: 16, max_temp: 30, target_temp_step: 0.5, fan_mode: 'auto', fan_modes: ['auto', 'high'] },
  });
  assert.deepEqual(cl.hvacModes, ['off', 'cool', 'heat']);
  assert.equal(cl.hvacAction, 'cooling');
  assert.equal(cl.min, 16); assert.equal(cl.max, 30); assert.equal(cl.step, 0.5);
  assert.deepEqual(cl.fanModes, ['auto', 'high']);
  const li = ha.compactEntity({
    entity_id: 'light.strip', state: 'on',
    attributes: { supported_color_modes: ['color_temp', 'rgb'], color_temp_kelvin: 4000, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 },
  });
  assert.deepEqual(li.colorModes, ['color_temp', 'rgb']);
  assert.equal(li.kelvin, 4000);
  assert.equal(li.minKelvin, 2000); assert.equal(li.maxKelvin, 6500);
});
test('compactEntity exposes cover/fan features and number/select ranges', () => {
  const cv = ha.compactEntity({ entity_id: 'cover.blind', state: 'open', attributes: { supported_features: 15, current_position: 60 } });
  assert.equal(cv.features, 15); assert.equal(cv.position, 60);
  const fn = ha.compactEntity({ entity_id: 'fan.desk', state: 'on', attributes: { supported_features: 1, percentage: 66, oscillating: true } });
  assert.equal(fn.features, 1); assert.equal(fn.pct, 66); assert.equal(fn.oscillating, true);
  const nb = ha.compactEntity({ entity_id: 'number.bright', state: '7', attributes: { min: 0, max: 10, step: 1 } });
  assert.equal(nb.min, 0); assert.equal(nb.max, 10); assert.equal(nb.step, 1);
  const sl = ha.compactEntity({ entity_id: 'select.mode', state: 'Eco', attributes: { options: ['Eco', 'Boost'] } });
  assert.deepEqual(sl.options, ['Eco', 'Boost']);
  const btn = ha.compactEntity({ entity_id: 'button.restart', state: 'unknown', attributes: { friendly_name: 'Restart' } });
  assert.equal(btn.domain, 'button');   // rendered as a press button, not a value tile
});
test('compactEntity exposes the full-hub extras (media/light/climate/new domains)', () => {
  const mp = ha.compactEntity({ entity_id: 'media_player.spk', state: 'playing', attributes: { supported_features: 32768 + 262144 + 2, shuffle: true, repeat: 'all', media_position: 30, media_duration: 180 } });
  assert.equal(mp.shuffle, true); assert.equal(mp.repeat, 'all');
  assert.equal(mp.mediaPos, 30); assert.equal(mp.mediaDur, 180);
  const li = ha.compactEntity({ entity_id: 'light.strip', state: 'on', attributes: { effect: 'Rainbow', effect_list: ['Rainbow', 'Solid'] } });
  assert.equal(li.effect, 'Rainbow'); assert.deepEqual(li.effects, ['Rainbow', 'Solid']);
  const cl = ha.compactEntity({ entity_id: 'climate.ac', state: 'cool', attributes: { swing_mode: 'both', swing_modes: ['off', 'both'], current_humidity: 55 } });
  assert.equal(cl.swingMode, 'both'); assert.deepEqual(cl.swingModes, ['off', 'both']); assert.equal(cl.currentHumidity, 55);
  const wh = ha.compactEntity({ entity_id: 'water_heater.tank', state: 'eco', attributes: { current_temperature: 48, temperature: 55, min_temp: 30, max_temp: 75, operation_mode: 'eco', operation_list: ['eco', 'performance'] } });
  assert.equal(wh.target, 55); assert.equal(wh.presetMode, 'eco'); assert.deepEqual(wh.presetModes, ['eco', 'performance']);
  const al = ha.compactEntity({ entity_id: 'alarm_control_panel.home', state: 'armed_away', attributes: { supported_features: 3, code_arm_required: true } });
  assert.equal(al.features, 3); assert.equal(al.codeArm, true);
  const vv = ha.compactEntity({ entity_id: 'valve.water', state: 'open', attributes: { supported_features: 15, current_position: 40 } });
  assert.equal(vv.features, 15); assert.equal(vv.position, 40);
  const lm = ha.compactEntity({ entity_id: 'lawn_mower.garden', state: 'mowing', attributes: { supported_features: 7, battery_level: 80 } });
  assert.equal(lm.features, 7); assert.equal(lm.battery, 80);
});
test('compactEntity attaches the physical device so the tile can merge entities', () => {
  const devFor = (id) => (id.includes('bravia') ? { id: 'dev_tv', name: 'BRAVIA XR-55A80J' } : null);
  const mp = ha.compactEntity({ entity_id: 'media_player.bravia_xr_55a80j', state: 'on', attributes: {} }, () => 'Living', devFor);
  assert.equal(mp.device, 'dev_tv');
  assert.equal(mp.deviceName, 'BRAVIA XR-55A80J');
  const btn = ha.compactEntity({ entity_id: 'button.bravia_xr_55a80j_riavvia', state: 'unknown', attributes: {} }, () => 'Living', devFor);
  assert.equal(btn.device, 'dev_tv');   // same device id → merged with the media_player
  const noDev = ha.compactEntity({ entity_id: 'sun.sun', state: 'below_horizon', attributes: {} }, () => null, devFor);
  assert.equal(noDev.device, undefined);
});

// ── actionToServiceCall: map Deck action → call_service ───────────────────────
test('actionToServiceCall maps haToggle modes', () => {
  assert.deepEqual(ha.actionToServiceCall({ type: 'haToggle', entity: 'light.k', mode: 'toggle' }),
    { domain: 'homeassistant', service: 'toggle', target: { entity_id: 'light.k' }, data: {} });
  assert.equal(ha.actionToServiceCall({ type: 'haToggle', entity: 'light.k', mode: 'on' }).service, 'turn_on');
  assert.equal(ha.actionToServiceCall({ type: 'haToggle', entity: 'light.k', mode: 'off' }).service, 'turn_off');
  assert.equal(ha.actionToServiceCall({ type: 'haToggle', entity: 'bad id', mode: 'toggle' }), null);
});
test('actionToServiceCall maps haScene and validates haCallService', () => {
  assert.deepEqual(ha.actionToServiceCall({ type: 'haScene', entity: 'scene.movie' }),
    { domain: 'scene', service: 'turn_on', target: { entity_id: 'scene.movie' }, data: {} });
  const svc = ha.actionToServiceCall({ type: 'haCallService', service: 'light.turn_on', entity: 'light.k', data: '{"brightness":120}' });
  assert.equal(svc.domain, 'light');
  assert.equal(svc.service, 'turn_on');
  assert.deepEqual(svc.data, { brightness: 120 });
  assert.equal(ha.actionToServiceCall({ type: 'haCallService', service: 'not-a-service' }), null);
  assert.equal(ha.actionToServiceCall({ type: 'haCallService', service: 'light.turn_on', data: 'not json' }), null);
});
test('actionToServiceCall maps the new device-specific Deck actions', () => {
  assert.deepEqual(ha.actionToServiceCall({ type: 'haLight', entity: 'light.k', mode: 'brighter' }),
    { domain: 'light', service: 'turn_on', target: { entity_id: 'light.k' }, data: { brightness_step_pct: 15 } });
  assert.equal(ha.actionToServiceCall({ type: 'haMedia', entity: 'media_player.tv', cmd: 'volume_up' }).service, 'volume_up');
  assert.deepEqual(ha.actionToServiceCall({ type: 'haMedia', entity: 'media_player.tv', cmd: 'mute' }).data, { is_volume_muted: true });
  assert.equal(ha.actionToServiceCall({ type: 'haCover', entity: 'cover.b', cmd: 'close' }).service, 'close_cover');
  assert.deepEqual(ha.actionToServiceCall({ type: 'haClimate', entity: 'climate.ac', mode: 'cool' }).data, { hvac_mode: 'cool' });
  assert.equal(ha.actionToServiceCall({ type: 'haVacuum', entity: 'vacuum.v', cmd: 'return' }).service, 'return_to_base');
  assert.equal(ha.actionToServiceCall({ type: 'haLock', entity: 'lock.door', mode: 'unlock' }).service, 'unlock');
  assert.equal(ha.actionToServiceCall({ type: 'haScript', entity: 'script.night' }).domain, 'script');
  assert.equal(ha.actionToServiceCall({ type: 'haButton', entity: 'button.restart' }).service, 'press');
  const al = ha.actionToServiceCall({ type: 'haAlarm', entity: 'alarm_control_panel.home', mode: 'arm_away', code: '1234' });
  assert.equal(al.service, 'alarm_arm_away');
  assert.deepEqual(al.data, { code: '1234' });
  // a bad/empty entity always refuses (never a free-form service to HA)
  assert.equal(ha.actionToServiceCall({ type: 'haMedia', entity: 'bad id', cmd: 'next' }), null);
});

// ── settings: normalization + write-only token ───────────────────────────────
test('normalizeHomeAssistant keeps a valid url, drops a bad one, filters entities', () => {
  const n = ha.normalizeHomeAssistant({ url: 'http://ha:8123', token: 'abc', entities: ['light.a', 'light.a', 'bad', 'switch.b'] });
  assert.equal(n.url, 'http://ha:8123');
  assert.equal(n.token, 'abc');
  assert.deepEqual(n.entities, ['light.a', 'switch.b']);        // deduped + validated
  assert.equal(ha.normalizeHomeAssistant({ url: 'javascript:1' }).url, '');
});
test('preserveHaToken restores an omitted token, keeps a provided one', () => {
  const prev = { homeAssistant: { token: 'SECRET' } };
  assert.equal(ha.preserveHaToken({ homeAssistant: { url: 'x', token: '' } }, prev).homeAssistant.token, 'SECRET');
  assert.equal(ha.preserveHaToken({ homeAssistant: { token: 'NEW' } }, prev).homeAssistant.token, 'NEW');
});
test('preserveHaToken keeps the whole block when the payload omits it', () => {
  const prev = { homeAssistant: { url: 'http://ha:8123', token: 'SECRET', entities: ['light.a'] } };
  const out = ha.preserveHaToken({ appearance: 'dark' }, prev);   // no homeAssistant key at all
  assert.equal(out.homeAssistant.url, 'http://ha:8123');
  assert.equal(out.homeAssistant.token, 'SECRET');
  assert.deepEqual(out.homeAssistant.entities, ['light.a']);
});
test('redactHaToken blanks the token and flags tokenSet', () => {
  const r = ha.redactHaToken({ homeAssistant: { url: 'x', token: 'SECRET', entities: ['light.a'] } });
  assert.equal(r.homeAssistant.token, '');
  assert.equal(r.homeAssistant.tokenSet, true);
  assert.deepEqual(r.homeAssistant.entities, ['light.a']);
  assert.equal(ha.redactHaToken({ homeAssistant: { url: 'x', token: '' } }).homeAssistant.tokenSet, false);
});

// ── cameras: the ONE feature covering every camera HA supports ────────────────
test('haHttpOrigin returns the http(s) origin, rejects non-http', () => {
  assert.equal(ha.haHttpOrigin('http://192.168.1.5:8123'), 'http://192.168.1.5:8123');
  assert.equal(ha.haHttpOrigin('https://ha.example.com/lovelace'), 'https://ha.example.com');   // path dropped
  assert.equal(ha.haHttpOrigin('file:///etc/passwd'), '');
  assert.equal(ha.haHttpOrigin('ws://ha:8123'), '');
  assert.equal(ha.haHttpOrigin(''), '');
});
test('isCameraEntity accepts only camera.* entity ids', () => {
  assert.equal(ha.isCameraEntity('camera.front_door'), true);
  assert.equal(ha.isCameraEntity('light.kitchen'), false);
  assert.equal(ha.isCameraEntity('camera.'), false);
  assert.equal(ha.isCameraEntity('Camera.Front'), false);        // must be lowercase
  assert.equal(ha.isCameraEntity('camera.a; drop'), false);
});
test('normalizeHomeAssistant keeps camera.* cameras (opt-in, deduped) and drops non-cameras', () => {
  const n = ha.normalizeHomeAssistant({
    url: 'http://ha:8123', token: 'abc',
    cameras: ['camera.front', 'camera.front', 'light.k', 'camera.back', 'bad'],
  });
  assert.deepEqual(n.cameras, ['camera.front', 'camera.back']);
  assert.deepEqual(ha.normalizeHomeAssistant({}).cameras, []);   // opt-in default = none
});
test('normalizeHaCamAngles keeps camera transforms, drops neutral + non-camera keys', () => {
  const a = ha.normalizeHaCamAngles({
    'camera.front': { rot: 90, flip: true },
    'camera.back': { rot: 0, flip: 0, zoom: 1 },              // fully neutral → dropped
    'camera.zoom': { zoom: 2, panX: 40, panY: 200 },          // pan clamped to 100
    'light.k': { rot: 90 },                                   // not a camera → dropped
  });
  assert.deepEqual(a['camera.front'], { rot: 90, flip: 1 });
  assert.equal(a['camera.back'], undefined);
  assert.equal(a['camera.zoom'].zoom, 2);
  assert.equal(a['camera.zoom'].panY, 100);
  assert.equal(a['light.k'], undefined);
  // and it flows through the settings normalizer
  const n = ha.normalizeHomeAssistant({ camAngles: { 'camera.x': { rot: 180 } } });
  assert.deepEqual(n.camAngles['camera.x'], { rot: 180, flip: 0 });
});
test('redactHaToken carries cameras + camAngles (not secrets) through the wire', () => {
  const r = ha.redactHaToken({ homeAssistant: { url: 'x', token: 'SECRET', cameras: ['camera.a'], camAngles: { 'camera.a': { rot: 90, flip: 1 } } } });
  assert.equal(r.homeAssistant.token, '');
  assert.deepEqual(r.homeAssistant.cameras, ['camera.a']);      // must survive the round-trip
  assert.deepEqual(r.homeAssistant.camAngles, { 'camera.a': { rot: 90, flip: 1 } });
});

// ── registry: HA + window actions dispatch and degrade cleanly ───────────────
test('registry runs haToggle through the injected provider', async () => {
  let seen = null;
  const reg = createRegistry({ homeAssistant: (a) => { seen = a; return { ok: true }; } });
  const r = await reg.run({ type: 'haToggle', entity: 'light.k', mode: 'toggle' });
  assert.deepEqual(r, { ok: true });
  assert.equal(seen.entity, 'light.k');
});
test('registry HA/window actions degrade to {ok:false} without a provider', async () => {
  const reg = createRegistry({});
  assert.deepEqual(await reg.run({ type: 'haToggle', entity: 'light.k', mode: 'toggle' }), { ok: false, error: 'ha_unavailable' });
  assert.deepEqual(await reg.run({ type: 'windowMove', dir: 'next-monitor' }), { ok: false, error: 'window_unavailable' });
});
test('registry runs windowMove with a constrained dir', async () => {
  let verb = null;
  const reg = createRegistry({ windowAction: (v) => { verb = v; return { ok: true }; } });
  assert.deepEqual(await reg.run({ type: 'windowMove', dir: 'left' }), { ok: true });
  assert.equal(verb, 'left');
  // An out-of-catalog dir is coerced by validateAction to the first option.
  const reg2 = createRegistry({ windowAction: (v) => { verb = v; return { ok: true }; } });
  await reg2.run({ type: 'windowMove', dir: 'evil; rm -rf' });
  assert.equal(verb, 'next-monitor');
});
