// Import from iCUE (lights/icue-profile.js + lights/icue-import.js): the look each light had in
// iCUE's profile file, onto the lights Xenon drives itself that still follow Xenon. It came from
// a PC where iCUE stayed closed and the LINK hub showed Xenon's colour instead of the orange set
// in iCUE. The profile below is invented: same shape as iCUE's cereal XML, no real device ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from './browser-source.mjs';

const require = createRequire(import.meta.url);
const { profileLooks, hexOf } = require('../lights/icue-profile.js');
const { createIcueImport, icueDir, XENON_IDS, SPAN_MS } = require('../lights/icue-import.js');

const layer = (n, { id, name, enabled = true, option = 'AllLeds', lighting }) => `<value${n}>
  <polymorphic_id>${id}</polymorphic_id>${name ? `<polymorphic_name>${name}</polymorphic_name>` : ''}
  <ptr_wrapper><id>${id}</id><data>
    <base><name>Layer</name><enabled>${enabled}</enabled><option>${option}</option></base>
    <lighting>${lighting}</lighting>
  </data></ptr_wrapper></value${n}>`;
const effect = (typeId, type, ptrId, data) => `<polymorphic_id>${typeId}</polymorphic_id>${type ? `<polymorphic_name>${type}</polymorphic_name>` : ''}
  <ptr_wrapper><id>${ptrId}</id>${data ? `<data>${data}</data>` : ''}</ptr_wrapper>`;
const device = (n, deviceId, vid, pid, layers) => `<value${n}>
  <key><deviceId>${deviceId}</deviceId><modelId><usbVid>${vid}</usbVid><usbPid>${pid}</usbPid></modelId><hidCaps>Undefined</hidCaps></key>
  <value><polymorphic_id>1073741824</polymorphic_id><ptr_wrapper><valid>1</valid><data><channelProperties size="dynamic"><value0><key>0</key>
    <value><layers size="dynamic">${layers.join('')}</layers></value></value0></channelProperties></data></ptr_wrapper></value>
</value${n}>`;
const HIGH = 0x80000000;
const first = (i) => String(HIGH + i);
const STATIC = (rgb) => `<base><base><duration>1000</duration></base><transitions size="dynamic"><value0><time>0</time><color>rgb(${rgb})</color></value0></transitions></base><opacity>255</opacity>`;

const PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<cereal><profile><name>Pretend</name><devices size="dynamic">
${device(0, 'PRETEND-HUB-0001', 6940, 3135, [
    layer(0, { id: first(1), name: 'AdvancedLightingLayer', option: 'ConcreteLeds', lighting: effect(first(2), 'RainbowLighting', first(3), '<base><duration>1000</duration></base><speed>3</speed>') }),
    layer(1, { id: first(4), lighting: effect(first(5), 'StaticLighting', first(6), STATIC('0.941176 0.556863 0.2')) }),
    layer(2, { id: first(7), lighting: effect(first(8), 'WidgetLighting', first(9), '<base/>') }),
  ])}
${device(1, 'vid&lt;1b1c&gt;pid&lt;1b00&gt;serial&lt;PRETEND&gt;', 6940, 6912, [
    layer(0, { id: first(10), enabled: false, lighting: effect('5', '', first(11), STATIC('1 1 1')) }),
    layer(1, { id: first(12), lighting: effect('2', '', '3') }),
  ])}
${device(2, 'PRETEND-STRIP', 6940, 6913, [layer(0, { id: first(13), lighting: effect('5', '', first(14), STATIC('0 0 0')) })])}
${device(3, 'PRETEND-PULSE', 6940, 6914, [layer(0, { id: first(15), lighting: effect(first(16), 'SingleColorPulseLighting', first(17), '<color>rgb(0 128 255)</color><speed>1</speed>') })])}
${device(4, 'PRETEND-SCREEN', 6940, 3150, [layer(0, { id: first(18), lighting: effect('8', '', first(19), '<base/>') })])}
${device(5, '', 6940, 3135, [layer(0, { id: first(20), lighting: effect('2', '', '3') })])}
${device(6, 'PRETEND-NOUSB', 0, 0, [layer(0, { id: first(21), lighting: effect('2', '', '3') })])}
</devices></profile></cereal>`;

test('a profile gives each device the look Xenon can play, resolving the ids cereal writes once', () => {
  assert.deepEqual(profileLooks(PROFILE), [
    { usb: '1b1c:0c3f', effect: 'StaticLighting', look: { mode: 'color', color: '#f08e33' } },
    { usb: '1b1c:1b00', effect: 'RainbowLighting', look: { mode: 'animation', anim: { style: 'cycle', speed: 75 } } },
    { usb: '1b1c:1b01', effect: 'StaticLighting', look: { mode: 'off' } },
    { usb: '1b1c:1b02', effect: 'SingleColorPulseLighting', look: { mode: 'animation', anim: { style: 'breathing', speed: 30, color: '#0080ff' } } },
  ], 'a layer on every LED wins over one on some; off layers, the screen, templates and no-USB entries are left out');
  assert.deepEqual(profileLooks('not xml at all <<'), []);
  assert.deepEqual(profileLooks(''), []);
});

test('colours read as iCUE writes them, 0-1 or 0-255, and nothing else', () => {
  assert.equal(hexOf('rgb(1 0.5 0)'), '#ff8000');
  assert.equal(hexOf('rgb(255 128 0)'), '#ff8000');
  assert.equal(hexOf('rgb(2 300 -1)'), null);
  assert.equal(hexOf('#ff0000'), null);
});

// A pretend disk: a path is a file with text and a time, or missing.
function disk(files) {
  const reads = [];
  const missing = (p) => Object.assign(new Error('ENOENT ' + p), { code: 'ENOENT' });
  return {
    reads,
    fs: {
      readFile: async (p) => { reads.push(p); if (!(p in files)) throw missing(p); return files[p].text; },
      stat: async (p) => { if (!(p in files)) throw missing(p); return { mtimeMs: files[p].at, size: files[p].text.length }; },
      readdir: async (dir) => Object.keys(files).filter((p) => path.dirname(p) === dir).map((p) => path.basename(p)),
    },
  };
}
const DIR = path.join('pretend', 'Corsair', 'CUE5');
const at = (name) => path.join(DIR, 'profiles', name);
const ID = '{11111111-2222-4333-8444-555555555555}';
const HUB = { id: XENON_IDS.get('1b1c:0c3f'), model: 'iCUE LINK System Hub', source: 'native', mode: 'follow' };

test('the profile iCUE starts with is read, again only when it changed and at most once a minute', async () => {
  let t = 0;
  const files = {
    [path.join(DIR, 'config.cuecfg')]: { text: `<config><value name="defaultProfile">${ID}</value></config>`, at: 1 },
    [at(ID + '.cueprofiledata')]: { text: PROFILE, at: 1 },
    [at('{99999999-2222-4333-8444-555555555555}.cueprofiledata')]: { text: '<cereal/>', at: 9 },
  };
  const d = disk(files);
  const imp = createIcueImport({ dir: () => DIR, fs: d.fs, now: () => t });
  await imp.refresh();
  assert.deepEqual(imp.offer([HUB]), [{ id: 'corsair-link-hub', name: 'iCUE LINK System Hub', look: { mode: 'color', color: '#f08e33' } }]);
  const profileReads = () => d.reads.filter((p) => p.endsWith('.cueprofiledata')).length;
  assert.equal(profileReads(), 1);
  t = SPAN_MS - 1;
  await imp.refresh();
  assert.equal(d.reads.length, 2, 'within the minute: not even the config');
  t = SPAN_MS;
  await imp.refresh();
  assert.equal(profileReads(), 1, 'same file, same time: not read again');
  files[at(ID + '.cueprofiledata')] = { text: '<cereal/>', at: 2 };
  await imp.refresh(true);
  assert.equal(profileReads(), 2, 'changed, and asked now: read again');
  assert.deepEqual(imp.offer([HUB]), []);
});

test('without a starting profile the newest is read; no folder, no profile or a broken disk offers nothing', async () => {
  const files = {
    [at('{aaaaaaaa-2222-4333-8444-555555555555}.cueprofiledata')]: { text: '<cereal/>', at: 1 },
    [at('{bbbbbbbb-2222-4333-8444-555555555555}.cueprofiledata')]: { text: PROFILE, at: 5 },
  };
  const newest = createIcueImport({ dir: () => DIR, fs: disk(files).fs });
  await newest.refresh();
  assert.equal(newest.offer([HUB]).length, 1);
  const none = createIcueImport({ dir: () => null, fs: disk({}).fs });
  await none.refresh();
  assert.deepEqual(none.offer([HUB]), [], 'not Windows: nothing looked at');
  const broken = createIcueImport({ dir: () => DIR, fs: { ...disk(files).fs, readFile: async () => { throw new Error('EIO'); } } });
  await assert.doesNotReject(broken.refresh());
  assert.deepEqual(broken.offer([HUB]), []);
  assert.equal(icueDir(undefined), null);
  assert.equal(icueDir('pretend'), path.join('pretend', 'Corsair', 'CUE5'));
});

test('only a light Xenon drives itself and that still follows Xenon is offered, once', async () => {
  const imp = createIcueImport({ dir: () => DIR, fs: disk({ [at('{cccccccc-2222-4333-8444-555555555555}.cueprofiledata')]: { text: PROFILE + PROFILE, at: 1 } }).fs });
  await imp.refresh();
  assert.equal(imp.offer([HUB]).length, 1, 'two entries for one device: one offer');
  assert.deepEqual(imp.offer([{ ...HUB, mode: 'color' }]), [], 'a look set in Xenon is never replaced');
  assert.deepEqual(imp.offer([{ ...HUB, mode: undefined }]).length, 1);
  assert.deepEqual(imp.offer([{ id: 'pretend-kb', model: 'Keyboard', mode: 'follow' }]), [], 'iCUE keeps the lights it drives');
});

test('the id the import gives the LINK hub is the one Airflow names it with', () => {
  const linkLights = readFileSync(new URL('../airflow/link-lights.js', import.meta.url), 'utf8');
  assert.match(linkLights, new RegExp(`const DEVICE_ID = '${XENON_IDS.get('1b1c:0c3f')}';`));
});

test('the status names the lights on offer, the status route looks again, and the import route sets and saves them', () => {
  const status = readFileSync(new URL('../lights/status.js', import.meta.url), 'utf8');
  assert.match(status, /status\.icueImport = icueImport\.offer\(status\.devices\)\.map\(\(\{ id, name \}\) => \(\{ id, name \}\)\);/);
  const routes = readFileSync(new URL('../lights/routes.js', import.meta.url), 'utf8');
  assert.match(routes, /await icueImport\.refresh\(\);\n\s+\/\/ A board[^\n]*\n\s+if \(!native\.status\(\)\.enabled\) await boardProbe\.refresh\(\);\n\s+json\(lighting\.getStatus\(\)\);/);
  const route = readFileSync(new URL('../lights/routes-icue-import.js', import.meta.url), 'utf8');
  assert.match(route, /'POST \/api\/lighting\/icue-import': importLooks/);
  assert.match(route, /await icueImport\.refresh\(true\);[\s\S]*?for \(const t of taken\) lighting\.setDeviceMode\(t\.id, t\.look\);\n\s+if \(taken\.length\) await _persistLighting\(\);/);
  assert.match(readFileSync(new URL('../feature-routes.js', import.meta.url), 'utf8'), /\n {2}require\('\.\/lights\/routes-icue-import\.js'\),\n/);
});
