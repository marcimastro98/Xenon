// The pop-ups the dashboard and the "widgets only" alerts window share
// (js/alert-toasts.js): what each alert says, and when there is nothing to say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const A = createRequire(import.meta.url)('../js/alert-toasts.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// t() returns the key itself when a string is missing (i18n.js).
const dict = { stocks_alert_up: 'Su forte oggi', guardian_alert_cpu: 'CPU a {v}°{u}', guardian_alert_mem: 'RAM al {v}%', timer_chime_alert: 'ogni {n}' };
const ctx = (over = {}) => ({ t: (k) => dict[k] || k, hwF: false, ...over });

test('the master switch: off, or pop-ups off, means no toast', () => {
  assert.equal(A.popupsAllowed(undefined), true);
  assert.equal(A.popupsAllowed({}), true);
  assert.equal(A.popupsAllowed({ enabled: false }), false);
  assert.equal(A.popupsAllowed({ popups: false }), false);
  assert.equal(A.popupsAllowed({ onScreen: false }), true);
});

test('a missing string falls back to English, never to the raw key', () => {
  const s = A.stocks({ symbol: 'AAPL', dir: 'down', changePct: -5.123 }, ctx());
  assert.equal(s.title, 'AAPL  ▼ -5.12%');
  assert.equal(s.message, 'Down sharply today');
  assert.equal(s.kicker, 'Stocks');
  assert.equal(A.stocks({ name: 'Apple', dir: 'up', changePct: 4 }, ctx()).message, 'Su forte oggi');
});

test('scores and cameras', () => {
  assert.equal(A.football({ home: 'Roma', away: 'Lazio', homeScore: 2, awayScore: 1, status: 'ft' }, ctx()).title, 'Roma 2–1 Lazio');
  assert.equal(A.football({ home: 'Roma', away: 'Lazio' }, ctx()).message, 'Score update');
  const u = A.unifi({ kind: 'ring', name: 'Front door' }, ctx());
  assert.deepEqual([u.title, u.message], ['Doorbell', 'Front door']);
  // An unknown kind is shown as sent, never looked up as a key.
  assert.equal(A.unifi({ kind: 'toString', camId: 'c1' }, ctx()).title, 'toString');
});

test('Guardian converts temperatures to the chosen unit, never the RAM percentage', () => {
  assert.equal(A.guardian({ type: 'cpu', value: 95 }, ctx()).title, 'CPU a 95°C');
  assert.equal(A.guardian({ type: 'cpu', value: 95 }, ctx({ hwF: true })).title, 'CPU a 203°F');
  assert.equal(A.guardian({ type: 'mem', value: 93 }, ctx({ hwF: true })).title, 'RAM al 93%');
  assert.equal(A.guardian({ type: 'cpu', value: 95 }, ctx()).type, 'warning');
  // No text for it in any language: nothing to show.
  assert.equal(A.guardian({ type: 'gpu', value: 90 }, ctx()), null);
});

test('timers', () => {
  assert.equal(A.timerDone('', ctx()).title, 'Timer');
  assert.equal(A.timerDone('Pasta', ctx()).message, "Time's up!");
  assert.equal(A.timerChime('', 3725, ctx()).message, 'ogni 1:02:05');
  assert.equal(A.clock(65), '1:05');
  assert.equal(A.clock(-4), '0:00');
});

test('benchmark: the seed says nothing, the button only with a handler', () => {
  assert.equal(A.benchmark({ seed: true, running: true }, ctx()), null);
  assert.equal(A.benchmark({ running: true, game: 'Game.exe' }, ctx()).kicker, 'Game');
  const reveal = () => {};
  const done = A.benchmark({ result: { ok: true, avgFps: 143.6, low1Fps: 88.2, folderMissing: true } }, ctx(), reveal);
  assert.match(done.message, /^144 FPS average, 1% low 88 · /);
  assert.equal(done.important, true);
  assert.equal(done.actions[0].onClick, reveal);
  assert.equal(A.benchmark({ result: { ok: true } }, ctx()).actions, undefined);
  assert.equal(A.benchmark({ result: { error: 'too_short' } }, ctx()).title, 'Benchmark too short, not saved');
});

test('junk payloads show nothing', () => {
  for (const fn of [A.stocks, A.football, A.unifi, A.guardian, A.benchmark]) {
    assert.equal(fn(null, ctx()), null);
    assert.equal(fn('x', ctx()), null);
  }
});

test('the camera kinds are the ones the UniFi tile offers, with the same keys', () => {
  const src = read('../js/unifi-widget.js');
  const block = src.slice(src.indexOf('const NOTIFY_KINDS = ['), src.indexOf('];', src.indexOf('const NOTIFY_KINDS = [')));
  const tile = [...block.matchAll(/\['(\w+)', 'unifi_kind_(\w+)', '([^']+)'\]/g)].map((m) => [m[1], m[2], m[3]]);
  assert.ok(tile.length >= 6);
  for (const [kind, keyKind] of tile) assert.equal(kind, keyKind);
  assert.deepEqual(Object.fromEntries(tile.map(([k, , label]) => [k, label])), { ...A.UNIFI_KINDS });
});

test('wiring: the dashboard builds its pop-ups here, not inline', () => {
  const main = read('../js/main.js');
  for (const fn of ['stocks', 'football', 'unifi', 'guardian']) assert.match(main, new RegExp(`AlertToasts\\.${fn}\\(`));
  const timer = read('../js/timer.js');
  assert.match(timer, /AlertToasts\.timerDone\(/);
  assert.match(timer, /AlertToasts\.timerChime\(/);
  assert.match(read('../js/perf-widget.js'), /AlertToasts\.benchmark\(/);
  const html = read('../index.html');
  assert.ok(html.indexOf('js/toast.js') < html.indexOf('js/alert-toasts.js'));
  assert.ok(html.indexOf('js/alert-toasts.js') < html.indexOf('js/main.js'));
});

test('"why does it stutter?": every server reason is worded, in all 11 languages, numbers filled', () => {
  const server = createRequire(import.meta.url)('../stutter-why.js');
  assert.deepEqual([...A.STUTTER_REASONS], [...server.REASONS]);
  const i18n = read('../js/i18n.js');
  for (const r of A.STUTTER_REASONS) {
    for (const key of ['why_' + r, 'why_' + r + '_tip']) {
      assert.equal((i18n.match(new RegExp('^    ' + key + ': ', 'gm')) || []).length, 11, key);
    }
  }
  const capped = A.stutterWhy({ ok: true, reason: 'capped', cap: 144, process: 'Game.EXE' }, ctx());
  assert.deepEqual([capped.type, capped.kicker, capped.title], ['success', 'Game', 'Capped at 144 FPS']);
  assert.equal(A.stutterWhy({ ok: true, reason: 'smooth', fps: 99.6 }, ctx()).message, '100 FPS and no stutter.');
  assert.equal(A.stutterWhy({ ok: true, reason: 'smooth' }, ctx()).message, '-- FPS and no stutter.');
  const hot = A.stutterWhy({ ok: true, reason: 'gpu_hot', gpuTemp: 91 }, ctx());
  assert.equal(hot.type, 'info');
  assert.doesNotMatch(hot.title + hot.message, /91|°/, 'temperatures stay out: the unit is the user\'s');
  assert.equal(A.stutterWhy({ ok: false, error: 'no_frames' }, ctx()), null);
  assert.equal(A.stutterWhy({ ok: true, reason: 'nope' }, ctx()), null);
  assert.equal(A.stutterLabel('nope', {}, ctx()), '');
  // Both places that show alerts listen for it.
  assert.match(read('../js/screen-alerts.js'), /stutter_why: \(d\) => show\(AlertToasts\.stutterWhy\(d, ctx\(\)\)\)/);
  assert.match(read('../js/main.js'), /addEventListener\('stutter_why'[\s\S]{0,120}PerfWidget\.onStutterWhy/);
});

test("Bit's vitals popup: its line, for as long as the server says, never past it or empty", () => {
  const now = 1000;
  assert.deepEqual(A.vitals({ text: ' drink ', until: now + 9000 }, now),
    { type: 'warning', kicker: 'Bit', title: 'drink', message: '', duration: 9000 });
  assert.equal(A.vitals({ text: 'x', until: now + 60000 }, now).duration, 15000);
  assert.equal(A.vitals({ text: 'x', until: now }, now), null);
  assert.equal(A.vitals({ text: '  ', until: now + 9000 }, now), null);
  assert.equal(A.vitals({ text: 'x', until: 'soon' }, now), null);
  assert.equal(A.vitals(null, now), null);
});
