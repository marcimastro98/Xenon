// The stopwatch. Asked for on Discord: "count the time up and monitor the
// length of time spent on a task".
//
// It is modelled as a KIND of timer rather than a second feature, because a
// stopwatch is a timer whose duration nobody set: startedAt, pausedElapsed and
// status behave identically, so pause, resume, reset, stop and delete are one
// implementation. Only the two questions that assume an end — "how much is
// left" and "is it finished" — have to know the difference, and those are what
// this file pins.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const TIMER = readFileSync(new URL('../js/timer.js', import.meta.url), 'utf8');
const { ACTION_CATALOG, validateAction } = require('../js/deck-actions.js');

// The three pure server functions, evaluated out of the source that ships.
function load(name, extra = '') {
  const start = SERVER.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  const end = SERVER.indexOf('\n}\n', start);
  return SERVER.slice(start, end + 2) + extra;
}
const KINDS = "const TIMER_KINDS = Object.freeze(['countdown', 'stopwatch']);\n";
const normalize = new Function(KINDS + load('_normalizeTimer') + '; return _normalizeTimer;')();
const remaining = new Function(load('_getTimerRemaining') + '; return _getTimerRemaining;')();
const elapsed = new Function(load('_getTimerElapsed') + '; return _getTimerElapsed;')();

test('a stopwatch is a timer with no duration, and says so', () => {
  const sw = normalize({ label: 'Task', kind: 'stopwatch' });
  assert.equal(sw.kind, 'stopwatch');
  assert.equal(sw.durationSecs, 0, 'a fake 60 would make every "is this a countdown" test lie');
  // Anything else, including a hand-edited file, is a countdown.
  assert.equal(normalize({ label: 'Tea' }).kind, 'countdown');
  assert.equal(normalize({ label: 'x', kind: 'nonsense' }).kind, 'countdown');
  assert.equal(normalize({ label: 'Tea', durationSecs: 300 }).durationSecs, 300);
});

test('a stopwatch never finishes, so it never rings for having ended', () => {
  // _checkTimers rings anything whose remaining time reaches zero. Answering 0
  // for a stopwatch would fire the notification the instant it started, so the
  // answer is that the question does not apply.
  const sw = { kind: 'stopwatch', status: 'running', startedAt: Date.now() - 5000, pausedElapsed: 0, durationSecs: 0 };
  assert.equal(remaining(sw), Infinity);

  // The loop's stopwatch branch may chime, but it must never mark one done or
  // fire timer_done: a stopwatch that "finished" would stop the clock its owner
  // asked to keep running.
  const check = SERVER.slice(SERVER.indexOf('function _checkTimers('));
  const body = check.slice(0, check.indexOf('\n}\n'));
  const branch = body.slice(body.indexOf("if (t.kind === 'stopwatch')"), body.indexOf('if (t.status === \'running\''));
  assert.ok(branch.length > 0, 'the stopwatch branch is gone');
  assert.doesNotMatch(branch, /timer_done/);
  assert.doesNotMatch(branch, /status = 'done'/);
  // …and it does nothing at all unless an interval was asked for.
  assert.match(branch, /!\(t\.intervalSecs > 0\)\) continue/);
});

test('elapsed is the reading, and it survives a pause', () => {
  const now = Date.now();
  assert.equal(Math.round(elapsed({ status: 'running', startedAt: now - 9000, pausedElapsed: 0 })), 9);
  // Paused: frozen at whatever had accumulated, not still climbing.
  assert.equal(elapsed({ status: 'paused', startedAt: now - 9000, pausedElapsed: 12 }), 12);
  // Resumed after a pause: the two halves add up.
  assert.equal(Math.round(elapsed({ status: 'running', startedAt: now - 3000, pausedElapsed: 12 })), 15);
});

test('a countdown is untouched by any of it', () => {
  const t = { kind: 'countdown', status: 'running', durationSecs: 300, startedAt: Date.now() - 60000, pausedElapsed: 0 };
  assert.equal(Math.round(remaining(t)), 240);
  assert.equal(remaining({ ...t, status: 'done' }), 0);
  assert.equal(remaining({ ...t, status: 'paused', pausedElapsed: 100 }), 200);
});

test('an empty duration is the gesture that creates one', () => {
  // No second button: the tile is small and already carries two fields, an add
  // button and up to five cards. Typed-but-unparseable still shakes, because
  // that is a mistake rather than a choice.
  const fn = TIMER.slice(TIMER.indexOf('function addTimerFromInput('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /const stopwatch = everyMode \|\| body === ''/);
  assert.match(body, /!stopwatch && \(!durationSecs/, 'a bad duration still reports itself');
  assert.match(body, /kind: 'stopwatch'/, 'and the request says which kind it is');
  // The server agrees: no duration means a stopwatch, however it was asked.
  assert.match(SERVER, /body\.kind == null && !Number\(body\.duration_secs\)/);
});

test('it counts UP, and rounds the way a stopwatch rounds', () => {
  // A countdown rounds up so 0.4s left still reads 0:01. A stopwatch rounding
  // up would read 0:01 the moment it started, which is simply wrong.
  const fmt = new Function(TIMER.slice(TIMER.indexOf('function _formatTime('),
    TIMER.indexOf('function _escHtml(')) + '; return _formatTime;')();
  assert.equal(fmt(0.4), '0:01', 'a countdown never shows 0:00 while it runs');
  assert.equal(fmt(0.4, true), '0:00', 'a stopwatch starts at zero');
  assert.equal(fmt(59.9, true), '0:59');
  assert.equal(fmt(3661, true), '1:01:01');
});

test('the ring sweeps once a minute instead of drawing a fraction of nothing', () => {
  const fn = TIMER.slice(TIMER.indexOf('function _updateTimerDisplays('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // reading / durationSecs is 0/0 for a stopwatch — NaN, and a NaN
  // strokeDashoffset silently blanks the ring.
  assert.match(body, /sw \? \(1 - \(reading % 60\) \/ 60\)/);
  assert.match(body, /!sw && reading <= 0/, 'and it never asks the client to mark one done');
});

test('one new Deck action, because the other two already fit', () => {
  const types = ACTION_CATALOG.filter((a) => a.group === 'timer').map((a) => a.type);
  assert.ok(types.includes('stopwatchStart'));
  // timerToggle and timerCancel address a timer BY LABEL and a stopwatch keeps
  // the same clock, so pausing and cancelling need no stopwatch-shaped twin.
  assert.ok(types.includes('timerToggle') && types.includes('timerCancel'));
  assert.equal(types.filter((x) => x.startsWith('stopwatch')).length, 1);

  const a = validateAction({ type: 'stopwatchStart', label: 'Report' });
  assert.equal(a.label, 'Report');

  const registry = readFileSync(new URL('../actions/registry.js', import.meta.url), 'utf8');
  assert.match(registry, /case 'stopwatchStart':/);
  assert.match(registry, /d\.timers\.stopwatch/);
  // Pressing the key twice restarts from zero rather than stacking a second one.
  const dep = SERVER.slice(SERVER.indexOf('stopwatch: async (label'));
  assert.match(dep.slice(0, 900), /chimes: 0, startedAt: Date\.now\(\), pausedElapsed: 0, status: 'running'/);
});

test('the assistant reports elapsed for a stopwatch, never a remaining of Infinity', () => {
  const list = SERVER.slice(SERVER.indexOf("fnName === 'list_timers'"));
  const body = list.slice(0, 900);
  assert.match(body, /elapsed_secs/);
  assert.match(body, /kind === 'stopwatch'/);
});

test('the stopwatch is named in every language, and so is how to make one', () => {
  const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  for (const key of ['timer_stopwatch', 'deck_act_stopwatchStart']) {
    const n = i18n.split('\n').filter((l) => l.trimStart().startsWith(key + ':')).length;
    assert.equal(n, 11, key + ' is in ' + n + ' languages, expected 11');
  }
  // The format hint is the only place the empty-duration gesture is announced,
  // so a language that lost the suffix is a language where it is undiscoverable.
  const hints = [...i18n.matchAll(/timer_format_hint"?:\s*['"]([^'"]*)['"]/g)].map((m) => m[1]);
  assert.equal(hints.length, 11);
  for (const h of hints) assert.match(h, /=/, 'a hint with no gesture in it: ' + h);
  assert.equal(hints.filter((h) => h.split('·').length >= 4).length, 11,
    'every language must mention the empty-duration stopwatch');
});

// ── The chime ───────────────────────────────────────────────────────────────
// Piotr's "interval timer", once he said what he meant by it: "it just goes up
// and sounds an alert at specified intervals, I use it for stretching". Not a
// third kind of clock, not a work/break cycle — this stopwatch with an alarm on
// the way up. So it costs one character in a field that already has a grammar,
// rather than a control of its own.

test('the interval lives on the stopwatch, and nowhere else', () => {
  const sw = normalize({ label: 'Stretch', kind: 'stopwatch', intervalSecs: 1800 });
  assert.equal(sw.intervalSecs, 1800);
  assert.equal(sw.chimes, 0, 'how many have sounded is persisted, not derived');
  // A countdown already has one alert, at the end.
  assert.equal(normalize({ label: 'Tea', durationSecs: 300, intervalSecs: 60 }).intervalSecs, 0);
  // Silent by default, which is every stopwatch that existed before this.
  assert.equal(normalize({ label: 'Task', kind: 'stopwatch' }).intervalSecs, 0);
  // Bounded: a hand-edited file cannot ask for a chime every 0 seconds.
  assert.equal(normalize({ label: 'x', kind: 'stopwatch', intervalSecs: -5 }).intervalSecs, 0);
  assert.equal(normalize({ label: 'x', kind: 'stopwatch', intervalSecs: 999999 }).intervalSecs, 86400);
});

test('a chime fires once per interval, and a sleeping machine wakes to one', () => {
  // The rule the loop applies, extracted: fire when the interval count passes
  // the number already sounded, then record the new count. Four intervals
  // crossed while the PC slept produce ONE event, not four stacked toasts.
  const due = (elapsed, every) => Math.floor(elapsed / every);
  assert.equal(due(1799, 1800), 0, 'nothing before the first interval');
  assert.equal(due(1800, 1800), 1);
  assert.equal(due(3600, 1800), 2);
  const chimes = 1;
  assert.ok(due(3600, 1800) > chimes, 'a missed interval still fires');
  assert.equal(due(1810, 1800) > 1, false, 'and it does not fire twice for the same one');

  const check = SERVER.slice(SERVER.indexOf('function _checkTimers('));
  const body = check.slice(0, check.indexOf('\n}\n'));
  assert.match(body, /due <= \(t\.chimes \|\| 0\)\) continue/);
  assert.match(body, /t\.chimes = due/, 'the counter jumps to the current interval, not by one');
  assert.match(body, /timer_chime/);
});

test('resetting the clock resets the chimes with it', () => {
  // Otherwise a stopwatch reset after an hour would sit silent for another
  // hour, waiting to pass a count that belongs to a run that already ended.
  const patch = SERVER.slice(SERVER.indexOf("} else if (action === 'reset')"));
  assert.match(patch.slice(0, 700), /t\.chimes = 0/);
  const stop = SERVER.slice(SERVER.indexOf("} else if (action === 'stop')"));
  assert.match(stop.slice(0, 300), /t\.chimes = 0/);
});

test('one leading character, on a grammar that already existed', () => {
  const fn = TIMER.slice(TIMER.indexOf('function addTimerFromInput('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /const everyMode = typed\.startsWith\('\+'\)/);
  // "+" alone says count up and chime every nothing, which is not a thing.
  assert.match(body, /everyMode && \(!intervalSecs \|\| intervalSecs < 1\)/);
  assert.match(body, /interval_secs: intervalSecs/);
  // And the card has to say it out loud: a stopwatch that will interrupt you
  // every half hour and one that will not are otherwise the same card.
  assert.match(TIMER, /timer-every/);
  assert.match(TIMER, /function onTimerChime\(/);
  // The chime is NOT timer_done — nothing finished and the clock keeps running.
  const chime = TIMER.slice(TIMER.indexOf('function onTimerChime('));
  assert.doesNotMatch(chime.slice(0, chime.indexOf('\n}\n')), /status = 'done'|renderTimers/);
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /addEventListener\('timer_chime'/);
});

test('the Deck key can ask for it too, and a bad value never breaks the key', () => {
  const spec = ACTION_CATALOG.find((a) => a.type === 'stopwatchStart');
  const every = spec.params.find((p) => p.name === 'everyMinutes');
  assert.ok(every, 'the key cannot ask for a chime');
  assert.equal(every.optional, true, 'a key saved before this must keep working');

  const registry = readFileSync(new URL('../actions/registry.js', import.meta.url), 'utf8');
  const branch = registry.slice(registry.indexOf("case 'stopwatchStart':"));
  const body = branch.slice(0, branch.indexOf('\n        }'));
  // Unreadable means silent, not failed: turning a working key into a failing
  // one over an optional field is the wrong trade.
  assert.match(body, /Number\.isFinite\(every\) && every > 0/);
  assert.match(body, /: 0;/);
  assert.match(body, /Math\.max\(10,/, 'and a chime every second is not offered');
});

test('every new string is in all eleven languages', () => {
  const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  for (const key of ['timer_every', 'timer_chime_alert', 'deck_param_every_minutes']) {
    const n = i18n.split('\n').filter((l) => l.trimStart().startsWith(key + ':')).length;
    assert.equal(n, 11, key + ' is in ' + n + ' languages, expected 11');
  }
  // The hint is the only place the "+" is announced, in every language.
  const hints = [...i18n.matchAll(/timer_format_hint"?:\s*['"]([^'"]*)['"]/g)].map((m) => m[1]);
  assert.equal(hints.length, 11);
  for (const h of hints) assert.match(h, /\+5/, 'no "+5" in: ' + h);
});
