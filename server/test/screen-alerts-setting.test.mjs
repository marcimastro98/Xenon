// "Avvisi sullo schermo" (hubSettings.notifications.onScreen): the setting on
// both normalizers, Bit's switch for it, the page's route, and the server chime
// that two surfaces asking for the same timer must not play twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync as readRaw } from 'node:fs';

const read = (p) => readRaw(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const { validateAction } = require('../js/deck-actions.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const SERVER = read('../server.js');
const CLIENT = read('../js/settings.js');

function loadNormalizer(src) {
  const m = src.match(/function normalizeNotifications\(value\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'normalizeNotifications not found');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '; return normalizeNotifications;')();
}

for (const [side, src] of [['server', SERVER], ['client', CLIENT]]) {
  test(`${side}: onScreen is on unless turned off, and survives a save`, () => {
    const N = loadNormalizer(src);
    assert.equal(N(undefined).onScreen, true);
    assert.equal(N({}).onScreen, true);
    assert.equal(N({ onScreen: 'no' }).onScreen, true);
    assert.equal(N({ onScreen: false }).onScreen, false);
    assert.equal(N(N({ onScreen: false })).onScreen, false);
  });
}

const shellUp = { available: () => true };
const recorder = () => {
  const writes = [];
  return { writes, settings: { setScreenAlerts: async (on) => { writes.push(on); return on; } } };
};

test('"stop the pop-ups on my screen": Bit turns the alerts off and on', async () => {
  const r = recorder();
  const caps = createCapabilities({ layersHost: shellUp, settings: r.settings });
  const action = aiAction('set_screen_alerts', { alerts: 'off', extra: 1 });
  assert.deepEqual(action, { type: 'screenAlerts', alerts: 'off' });
  assert.deepEqual(await caps.run(validateAction(action)), { ok: true, alerts: 'off' });
  assert.deepEqual(await caps.run({ type: 'screenAlerts', alerts: 'on' }), { ok: true, alerts: 'on' });
  assert.deepEqual(r.writes, [false, true]);
  const bad = await caps.run({ type: 'screenAlerts', alerts: 'maybe' });
  assert.equal(bad.error, 'bad_alerts');
  assert.equal(r.writes.length, 2);
});

test('without the native shell there is no alerts window: not offered, not run', async () => {
  const r = recorder();
  const caps = createCapabilities({ settings: r.settings });
  assert.ok(!aiFunctions(caps.probes()).some((f) => f.name === 'set_screen_alerts'));
  assert.equal((await caps.run({ type: 'screenAlerts', alerts: 'off' })).ok, false);
  assert.deepEqual(r.writes, []);
});

test('the server writes only onScreen, under the settings lock', () => {
  const at = SERVER.indexOf('async function updateScreenAlertsSetting(on)');
  const fn = SERVER.slice(at, SERVER.indexOf('\n}\n', at));
  assert.match(fn, /withHubSettingsLock/);
  assert.match(fn, /\.\.\.\(cur\.notifications \|\| \{\}\), onScreen: on === true/);
  assert.match(SERVER, /setScreenAlerts: \(on\) => updateScreenAlertsSetting\(on\)/);
});

test('the route serves the page uncached, and the phone never gets it', () => {
  const at = SERVER.indexOf("reqPath === '/screen-alerts'");
  assert.ok(at > 0);
  const route = SERVER.slice(at, SERVER.indexOf('} else if', at + 10));
  assert.match(route, /screen-alerts\.html/);
  assert.match(route, /no-store/);
  assert.doesNotMatch(route, /readFileSync/);
  assert.match(read('../remote-access.js'), /'\/screen-alerts'/);
});

test('one chime per timer, whoever asks for it', () => {
  const at = SERVER.indexOf('const REMINDER_BURST');
  const src = SERVER.slice(at, SERVER.indexOf('function playChimeOnServer', at));
  const played = [];
  // eslint-disable-next-line no-new-func
  const chimeRequested = new Function('playChimeOnServer', src + '; return chimeRequested;')((k) => played.push(k));
  assert.equal(chimeRequested('wake', 10_000), true);
  assert.equal(chimeRequested('wake', 10_400), false);
  assert.equal(chimeRequested('close', 10_500), true);
  assert.equal(chimeRequested('anything', 11_600), true);
  assert.deepEqual(played, ['wake', 'close', 'wake']);
  // The alerts window's card cues, each coalesced on its own.
  assert.equal(chimeRequested('warning', 20_000), true);
  assert.equal(chimeRequested('warning', 20_100), false);
  assert.equal(chimeRequested('error', 20_100), true);
  assert.equal(chimeRequested('__proto__', 30_000), true);
  assert.deepEqual(played.slice(3), ['warning', 'error', 'wake'], 'an unknown kind is the timer chime');
});

test('the server cues are the dashboard cues, note for note', () => {
  const cues = read('../js/audio-feedback.js').match(/const NOTIFY_CUES = \{([\s\S]*?)\n\};/)[1];
  const at = SERVER.indexOf('const REMINDER_BURST');
  // eslint-disable-next-line no-new-func
  const notes = new Function(SERVER.slice(at, SERVER.indexOf('\n});', at) + 4) + '; return CHIME_NOTES;')();
  for (const kind of ['notification', 'update', 'warning', 'error']) {
    const m = new RegExp(kind + ':\\s*(\\[\\[.*\\]\\])').exec(cues);
    const client = JSON.parse(m[1]).map(([s, hz]) => [hz, s]);
    assert.deepEqual(notes[kind], client, kind);
  }
  const ring = /const RING_PATTERN = (\[\[.*\]\]);/.exec(read('../js/audio-feedback.js'))[1];
  assert.deepEqual(notes.ring, JSON.parse(ring).map(([s, hz]) => [hz, s]), 'one cycle of the call ring');
  // The calendar alarm: playReminderBurst's notes 0.16 s apart, the burst again at 0.9, 1.8, 2.7 s.
  const fx = read('../js/audio-feedback.js');
  const burst = JSON.parse(/function playReminderBurst\(\) \{[\s\S]*?const notes = (\[[^\]]*\]);/.exec(fx)[1]);
  assert.match(fx, /const at = start \+ index \* 0\.16;/);
  const repeats = [0, ...[...fx.matchAll(/setTimeout\(playReminderBurst, (\d+)\)/g)].map((m) => Number(m[1]) / 1000)];
  assert.deepEqual(repeats, [0, 0.9, 1.8, 2.7]);
  const expected = repeats.flatMap((at) => burst.map((hz, i) => [hz, Math.round((at + i * 0.16) * 100) / 100]));
  assert.deepEqual(notes.reminder.map(([hz, s]) => [hz, s]), expected, 'the calendar alarm');
});

test('Settings: the row is on the Notifiche card, for the native app only', () => {
  const html = read('../index.html');
  assert.match(html, /id="settings-notif-onscreen-row" hidden/);
  assert.match(html, /updateNotifications\('onScreen', this\.checked\)/);
  assert.match(CLIENT, /field !== 'onScreen'/);
  const sync = CLIENT.slice(CLIENT.indexOf('function syncNotificationsControls()'));
  assert.match(sync.slice(0, 3000), /settings-notif-onscreen-row'\);\n  if \(onScreenRow\) onScreenRow\.hidden = !\(window\.__XENON_NATIVE__ === true && caps\.layers === true\)/);
});
