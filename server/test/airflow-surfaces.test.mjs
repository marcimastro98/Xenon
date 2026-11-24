// Where Airflow meets the rest of Xenon: the capability probe and dispatch, what a
// paired phone may do, the Deck/Bit catalog against the model, and the one line a Linux
// user pastes to give Xenon the fan files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';
import { airflowView } from './airflow-view-fixture.mjs';

const require = createRequire(import.meta.url);
const { createCapabilities } = require('../capabilities/index.js');
const { remoteMayRun, FREE } = require('../paired/remote-actions.js');
const Catalog = require('../js/capabilities/catalog-airflow.js');
const Model = require('../js/airflow/airflow-model.js');
const SDK = require('../widget-sdk/surface.js');
const { accessCommand, udevRule, GROUP, RULE_FILE } = require('../airflow/linux-access.js');

const fakeAirflow = (available) => {
  const ran = [];
  return { ran, available: () => available, actions: { run: async (a) => { ran.push(a.type); return { ok: true }; } } };
};

test('fanControl follows whether Airflow can reach fans here', () => {
  assert.equal(createCapabilities({ airflow: fakeAirflow(true) }).probes().fanControl, true);
  assert.equal(createCapabilities({ airflow: fakeAirflow(false) }).probes().fanControl, false);
});

test('every Airflow action is dispatched to Airflow\'s one rule set', async () => {
  const airflow = fakeAirflow(true);
  const caps = createCapabilities({ airflow });
  for (const type of ['airflowGet', 'airflowMode', 'airflowSet', 'airflowCheck']) assert.deepEqual(await caps.run({ type }), { ok: true });
  assert.deepEqual(airflow.ran, ['airflowGet', 'airflowMode', 'airflowSet', 'airflowCheck']);
});

test('a phone may change the mode and the choices, never start the fan check', () => {
  for (const type of ['airflowMode', 'airflowSet', 'airflowGet']) assert.ok(FREE.has(type), type);
  assert.equal(FREE.has('airflowCheck'), false);
  assert.equal(remoteMayRun({ type: 'airflowCheck', do: 'start' }, {}).ok, false, 'the check runs every fan loud for minutes');
  assert.deepEqual(remoteMayRun({ type: 'airflowMode', mode: 'quiet' }, {}), { ok: true });
});

test('the catalog offers the model\'s modes, needs fanControl, and names no raw speed', () => {
  const list = Catalog.CAPABILITIES;
  assert.deepEqual(list.map((c) => c.type).sort(), ['airflowCheck', 'airflowGet', 'airflowMode', 'airflowSet']);
  const mode = list.find((c) => c.type === 'airflowMode');
  assert.deepEqual(mode.params[0].options, [...Model.MODES]);
  for (const c of list) {
    assert.equal(c.capability.requires, 'fanControl', c.type);
    for (const p of c.params) assert.ok(!/duty|pwm|rpm|speed/i.test(p.name), `${c.type}.${p.name}`);
  }
});

// POSIX single quotes: '...' is literal, '\'' closes, adds a quote, reopens.
function unquoteSingle(s) {
  let out = '';
  for (const m of s.matchAll(/'([^']*)'|\\'/g)) out += m[1] !== undefined ? m[1] : "'";
  return out;
}

test('Linux: the pasted line writes exactly the rule, and touches only the fan files', () => {
  const cmd = accessCommand();
  const quoted = cmd.match(/echo ('(?:[^']|'\\'')*') \| sudo tee/);
  assert.ok(quoted, 'the rule is passed to tee quoted');
  assert.equal(unquoteSingle(quoted[1]), udevRule());
  assert.ok(cmd.includes(`sudo tee ${RULE_FILE} `));
  assert.ok(cmd.includes(`sudo usermod -aG ${GROUP} "$USER"`));
  const rule = udevRule();
  assert.match(rule, /^ACTION=="add", SUBSYSTEM=="hwmon", RUN\+=/);
  // Group write on pwmN and pwmN_enable, nothing wider: no world bits, no other files.
  assert.deepEqual([...rule.matchAll(/\/sys%p\/(\S+)/g)].map((m) => m[1]), ['pwm[0-9]', 'pwm[0-9]_enable', 'pwm[0-9]', 'pwm[0-9]_enable']);
  assert.ok(!/chmod (?!g\+w)|o\+|a\+|777|666|rm /.test(cmd));
});

// What a widget sees of a pulled reply (js/custom-widget/stream-readers.js), run on its own.
function readers() {
  const window = {};
  vm.runInNewContext(readFileSync(new URL('../js/custom-widget/stream-readers.js', import.meta.url), 'utf8'), { window });
  // Plain objects again: the readers' come from another realm.
  const plain = (fn) => (d) => JSON.parse(JSON.stringify(fn(d)));
  return { airflow: plain(window.CustomWidgetStreamReaders.airflow), netPath: plain(window.CustomWidgetStreamReaders.netPath) };
}

test('SDK: a read-only airflow stream and a fans category with the mode alone', () => {
  assert.ok(SDK.SDK_STREAMS.includes('airflow'));
  assert.deepEqual([...SDK.SDK_ACTION_CATEGORIES.fans], ['airflowMode']);
  const granted = Object.values(SDK.SDK_ACTION_CATEGORIES).flat();
  for (const type of ['airflowSet', 'airflowCheck', 'airflowGet']) assert.ok(!granted.includes(type), `${type} is never a widget's`);
});

test('SDK: the bridge pulls /airflow every 2 s while the widget is seen, through the reader', () => {
  const src = readFileSync(new URL('../js/custom-widget/custom-widget.js', import.meta.url), 'utf8');
  assert.ok(src.includes("    airflow: Object.freeze({ ttl: 2000, load: async () => Readers.airflow(await api('/airflow')) }),"));
  assert.ok(src.includes("    netPath: Object.freeze({ ttl: 1000, load: async () => Readers.netPath(await api('/api/net-path')) }),"));
  assert.ok(src.includes('const Readers = window.CustomWidgetStreamReaders;'));
});

test('SDK: the stream is rebuilt field by field, nothing else reaches a widget', () => {
  const view = airflowView({ shadow: { minutes: 90, quieterDb: 4.46, changesNow: 30, changesXenon: 4 }, check: { phase: 'pair', progress: 1.7 } });
  view.fans[0].name = 'x'.repeat(200);
  view.fans.push(...Array.from({ length: 40 }, (_, i) => ({ id: `lhm:chip1:${i}`, name: 'Extra', kind: 'blower', rpm: -5, duty: 'a', xenon: 'yes', why: 'Not A Code' })));
  const out = readers().airflow({ ok: true, ...view });
  assert.deepEqual(Object.keys(out).sort(), ['check', 'drive', 'fans', 'mode', 'ok', 'quieterDb', 'state', 'why']);
  assert.deepEqual([out.state, out.drive, out.mode, out.why, out.quieterDb, out.check], ['driving', 'on', 'auto', 'idle', 4.5, { progress: 1 }]);
  assert.equal(out.fans.length, 32);
  assert.deepEqual(out.fans[0], { id: 'lhm:chip0:0', name: 'x'.repeat(48), kind: 'fan', place: 'front', rpm: 813, duty: 31, xenon: true, leave: false, why: null });
  assert.deepEqual(out.fans[4], { id: 'lhm:chip1:0', name: 'Extra', kind: 'fan', place: null, rpm: null, duty: null, xenon: false, leave: false, why: null });
});

test('SDK: a PC without Airflow says unavailable, anything else is a failed read', () => {
  const { airflow } = readers();
  assert.deepEqual(airflow({ ok: false, error: 'unavailable' }), { ok: false, error: 'unavailable' });
  assert.deepEqual(airflow({ ok: false, error: 'read_failed' }), { ok: false, error: 'failed' });
  assert.deepEqual(airflow(null), { ok: false, error: 'failed' });
});

test('SDK: netPath keeps its stretches and drops anything else the server adds', () => {
  const { netPath } = readers();
  const stretch = { now: 4, ms: 5.5, min: 3, jitter: 1, loss: 0, lossNow: 0, n: 30, host: '192.0.2.1' };
  const out = netPath({ ok: true, link: 'wifi', linkMbps: 866, signal: 80, dbm: -52, ssid: 'Example', router: stretch, provider: null, internet: { ...stretch, n: 'x' }, traffic: { downBps: 10, upBps: 2, pid: 4 } });
  assert.deepEqual(out, {
    ok: true, link: 'wifi', linkMbps: 866, signal: 80, dbm: -52,
    router: { now: 4, ms: 5.5, min: 3, jitter: 1, loss: 0, lossNow: 0, n: 30 }, provider: null,
    internet: { now: 4, ms: 5.5, min: 3, jitter: 1, loss: 0, lossNow: 0, n: 0 },
    traffic: { downBps: 10, upBps: 2 },
  });
  assert.equal(netPath({ ok: true, link: 'satellite' }).link, null);
  assert.deepEqual(netPath({ ok: false, error: 'not_granted' }), { ok: false, error: 'not_granted' });
  assert.deepEqual(netPath({ ok: false, error: 'boom' }), { ok: false, error: 'failed' });
  assert.deepEqual(netPath(null), { ok: false, error: 'failed' });
});
