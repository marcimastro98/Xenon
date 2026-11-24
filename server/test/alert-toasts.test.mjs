// The pop-ups the dashboard and the "widgets only" alerts window share
// (js/alerts/alert-toasts.js): what each alert says, and when there is nothing to say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';
import { appStringsSource } from './i18n-source.mjs';

const A = createRequire(import.meta.url)('../js/alerts/alert-toasts.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// t() returns the key itself when a string is missing (i18n.js).
const dict = { airflow_why_heat_cpu: 'Il processore sta lavorando: le ventole lo seguono.', airflow_why_hot: 'Qualcosa scalda troppo.', airflow_rise_title: 'Le ventole stanno salendo', xmenu_sec_airflow: 'Ventole', stocks_alert_up: 'Su forte oggi', guardian_alert_cpu: 'CPU a {v}°{u}', guardian_alert_mem: 'RAM al {v}%', timer_chime_alert: 'ogni {n}' };
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
  const src = read('../js/unifi-widget/unifi-widget.js');
  const block = src.slice(src.indexOf('const NOTIFY_KINDS = ['), src.indexOf('];', src.indexOf('const NOTIFY_KINDS = [')));
  const tile = [...block.matchAll(/\['(\w+)', 'unifi_kind_(\w+)', '([^']+)'\]/g)].map((m) => [m[1], m[2], m[3]]);
  assert.ok(tile.length >= 6);
  for (const [kind, keyKind] of tile) assert.equal(kind, keyKind);
  assert.deepEqual(Object.fromEntries(tile.map(([k, , label]) => [k, label])), { ...A.UNIFI_KINDS });
});

test('wiring: the dashboard builds its pop-ups here, not inline', () => {
  const main = read('../js/main.js');
  for (const fn of ['unifi', 'guardian']) assert.match(main, new RegExp(`AlertToasts\\.${fn}\\(`));
  // The pop-up-only alerts go through one table: each event to its builder, every builder real.
  for (const [event, fn] of [['stocks_alert', 'stocks'], ['football_alert', 'football'], ['airflow_rise', 'airflowRise']]) {
    assert.ok(main.includes(`['${event}', '${fn}'`), event);
    assert.equal(typeof A[fn], 'function', fn);
  }
  const timer = read('../js/timer/timer.js');
  assert.match(timer, /AlertToasts\.timerDone\(/);
  assert.match(timer, /AlertToasts\.timerChime\(/);
  assert.match(read('../js/perf-widget/perf-widget.js'), /AlertToasts\.benchmark\(/);
  const html = read('../index.html');
  assert.ok(html.indexOf('js/alerts/toast.js') < html.indexOf('js/alerts/alert-toasts.js'));
  assert.ok(html.indexOf('js/alerts/alert-toasts.js') < html.indexOf('js/main.js'));
});

test('"why does it stutter?": every server reason is worded, in all 11 languages, numbers filled', () => {
  const server = createRequire(import.meta.url)('../performance/stutter-why.js');
  assert.deepEqual([...A.STUTTER_REASONS], [...server.REASONS]);
  const i18n = appStringsSource();
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
  assert.match(read('../js/alerts/screen-alerts.js'), /stutter_why: unlessMenu\(\(d\) => show\(AlertToasts\.stutterWhy\(d, ctx\(\)\)\)\)/);
  assert.match(read('../js/main.js'), /addEventListener\('stutter_why'[\s\S]{0,120}PerfWidget\.onStutterWhy/);
});

test('"why does it stutter?": the program that weighs on the PC is named, in all 11 languages', () => {
  const i18n = appStringsSource();
  for (const key of ['why_app_cpu_tip', 'why_app_ram_tip']) {
    const lines = i18n.match(new RegExp('^    ' + key + ': .*$', 'gm')) || [];
    assert.equal(lines.length, 11, key);
    for (const line of lines) assert.match(line, key.includes('cpu') ? /\{app\}[\s\S]*\{cpu\}|\{cpu\}[\s\S]*\{app\}/ : /\{app\}[\s\S]*\{ram\}|\{ram\}[\s\S]*\{app\}/, line);
  }
  const cpu = A.stutterWhy({ ok: true, reason: 'cpu_bound', app: { name: 'encoder', cpu: 15 } }, ctx());
  assert.equal(cpu.title, 'The graphics card waits');
  assert.equal(cpu.message, 'encoder is using 15% of the processor. Close it if you do not need it while you play.');
  const ram = A.stutterWhy({ ok: true, reason: 'ram_full', app: { name: 'browser', ramMB: 3400 } }, ctx());
  assert.equal(ram.message, 'browser is holding 3.3 GB of memory. Close it if you do not need it while you play.');
  assert.equal(A.stutterAppShort({ app: { name: 'browser', ramMB: 3400 } }, { lang: 'it' }), 'browser 3,3 GB');
  assert.equal(A.stutterAppShort({ app: { name: 'encoder', cpu: 15.4 } }, ctx()), 'encoder 15%');
  assert.equal(A.stutterAppShort({ app: { name: 'big', ramMB: 20480 } }, ctx()), 'big 20 GB');
  assert.equal(A.stutterWhy({ ok: true, reason: 'cpu_bound', app: { name: '$&', cpu: 9 } }, ctx()).message.startsWith('$& is'), true, 'a name is text, never a pattern');
  for (const app of [null, { name: '' }, { name: 'x' }, { name: 5, cpu: 1 }]) {
    assert.equal(A.stutterAppShort({ app }, ctx()), '', JSON.stringify(app));
    assert.equal(A.stutterWhy({ ok: true, reason: 'cpu_bound', app }, ctx()).message, 'The processor or the game itself is the limit. Close apps in the background.');
  }
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

test('a press in a game is answered there: Do not disturb lets both cards through', () => {
  assert.equal(A.benchmark({ running: true, game: 'Game.exe' }, ctx()).important, true);
  assert.equal(A.exclusiveHint({ process: 'game.exe' }, ctx()).type, 'warning', 'an info card is silenced during a game');
  assert.equal(A.stutterWhy({ ok: true, reason: 'smooth', fps: 240 }, ctx()).important, true);
});

test('the fans climbing: a short title, the reason in the Fans menu words, a warning only when something is too hot', () => {
  const cpu = A.airflowRise({ reason: 'heat-cpu', from: 25, to: 45, at: 1 }, ctx());
  assert.deepEqual(cpu, { type: 'info', kicker: 'Ventole', title: 'Le ventole stanno salendo', message: 'Il processore sta lavorando: le ventole lo seguono.', actions: [] });
  assert.equal(A.airflowRise({ reason: 'hot', from: null, to: 100 }, ctx()).type, 'warning');
  const open = () => {};
  assert.deepEqual(A.airflowRise({ reason: 'hot' }, ctx(), open).actions, [{ label: 'Open Fans', primary: true, onClick: open }], 'a button opens Fans');
  assert.equal(A.airflowRise({ reason: 'hot' }, { t: (k) => (k === 'airflow_why_hot' ? 'x' : k) }).title, 'The fans are speeding up', 'an older language file still has a title');
  for (const bad of [null, {}, { reason: 'idle' }, { reason: 'learning' }, { reason: '__proto__' }, { reason: 'heat-gpu' }]) {
    assert.equal(A.airflowRise(bad, ctx()), null, JSON.stringify(bad));
  }
});

test('the fans climbing: one sentence names the program behind it, when the server found one that fits', () => {
  const words = {
    ...dict, airflow_why_heat_gpu: 'La scheda video sta lavorando: le ventole la seguono.',
    airflow_rise_why_heat_cpu: '{app} sta usando il {cpu}% del processore: le ventole lo seguono.',
    airflow_rise_why_heat_gpu: '{app} fa lavorare la scheda video: le ventole la seguono.',
  };
  const it = { t: (k) => words[k] || k, lang: 'it' };
  const why = 'Il processore sta lavorando: le ventole lo seguono.';
  const msg = (reason, app, c = it) => A.airflowRise({ reason, app }, c).message;
  assert.equal(msg('heat-cpu', { name: 'Blender', cpu: 38.6 }), 'Blender sta usando il 39% del processore: le ventole lo seguono.');
  assert.equal(msg('heat-gpu', { name: 'Cyberpunk2077', game: true }), 'Cyberpunk2077 fa lavorare la scheda video: le ventole la seguono.');
  assert.equal(msg('heat-cpu', { name: '$& $1', cpu: 7 }), '$& $1 sta usando il 7% del processore: le ventole lo seguono.', 'a name is text, never a pattern');
  assert.equal(msg('heat-gpu', { name: 'Blender', cpu: 40 }), 'La scheda video sta lavorando: le ventole la seguono.', 'a processor figure never names the card heat');
  assert.equal(msg('heat-cpu', { name: 'Cyberpunk2077', game: true }), why, 'nor a game the processor heat, without its share');
  assert.equal(msg('hot', { name: 'Blender', cpu: 40 }), 'Qualcosa scalda troppo.', 'too hot: the sentence stays as it is');
  assert.equal(msg('heat-cpu', { name: 'Blender', cpu: 40 }, ctx()), why, 'an older language file keeps the plain why');
  for (const app of [null, 'Blender', {}, { name: '' }, { name: '  ', cpu: 40 }, { name: '  ', game: true }, { name: 5, cpu: 9 }, { name: 'Blender' }, { name: 'Blender', cpu: 'many' }, { name: 'Blender', ramMB: 4096 }]) {
    assert.equal(msg('heat-cpu', app), why, JSON.stringify(app));
  }
  assert.equal(A.airflowRise({ reason: 'idle', app: { name: 'Blender', cpu: 40 } }, it), null, 'no reason, no notice');
  assert.equal(A.stutterAppShort({ app: { name: 'Cyberpunk2077', game: true } }, it), '', 'the perf tile never shows a game as a culprit');
});

test('the fans climbing: every reason the server tells has its words in every app language', () => {
  const { RAISING } = createRequire(import.meta.url)('../airflow/rise.js');
  const strings = appStringsSource();
  for (const reason of RAISING) {
    const key = 'airflow_why_' + reason.split('-').join('_');
    assert.equal((strings.match(new RegExp('^    ' + key + ': ', 'gm')) || []).length, 11, key);
    assert.ok(A.airflowRise({ reason }, { t: (k) => (k === key ? 'x' : k) }), reason);
  }
  for (const key of ['airflow_rise_title', 'airflow_rise_open', 'airflow_rise_why_heat_cpu', 'airflow_rise_why_heat_gpu', 'airflow_rise_why_game_prepare']) assert.equal((strings.match(new RegExp('^    ' + key + ': ', 'gm')) || []).length, 11, key);
});
