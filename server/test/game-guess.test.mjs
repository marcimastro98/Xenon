// "Is it a game?" (server/game-guess/): a windowed app that draws like a game
// while Xenon sees no game gets one card, once. The point of these tests is the
// other half: the card must NOT show for anything else (a browser, a launcher's
// trailer, a video call, an app in the background, a short burst, a full-screen
// window, a game already found, an app already on a list), and an answer must
// land in the user's lists through the same action the Deck key and Bit use.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { readFileSync as readParts } from './browser-source.mjs';
import { engineSource } from './engine-source.mjs';
import { appStringsSource } from './i18n-source.mjs';

const require = createRequire(import.meta.url);
const { createFrontFrames } = require('../game-guess/front-frames.js');
const { createGameGuess, ASK_AFTER_MS, BREAK_MS } = require('../game-guess/watch.js');
const gd = require('../performance/gamedetect.js');
const fpsmon = require('../performance/fpsmon.js');
const AlertToasts = require('../js/alerts/alert-toasts.js');
const gameMode = require('../capabilities/game-mode.js');
const { createCapabilities } = require('../capabilities/index.js');
const { validateAction } = require('../js/deck/deck-actions.js');
const read = (rel) => readParts(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('front frames: the composed frames of one pid, read as a rate, gone when it stops', () => {
  let t = 0;
  const ff = createFrontFrames({ now: () => t });
  assert.equal(ff.read(), null);
  ff.add({ pid: '7', present: 16.7, composed: false });
  assert.equal(ff.read(), null, 'a flip-model row is the FPS reader\'s, not ours');
  for (let i = 0; i < 30; i++) ff.add({ pid: '7', present: 16.7, composed: true });
  assert.deepEqual(ff.read(), { pid: '7', fps: 60 });
  ff.add({ pid: '9', present: 33.3, composed: true });
  assert.deepEqual(ff.read(), { pid: '9', fps: 30 }, 'another app in front starts over');
  ff.add({ pid: '9', present: 30, composed: true, usesFps: true });
  t = 1600;
  assert.equal(ff.read(), null, 'stopped drawing');
  ff.add(null);
  ff.add({ pid: '9', present: 0, composed: true });
  assert.equal(ff.read(), null);
});

test('fpsmon reads the app in front\'s composed row only through its pid', () => {
  const cols = fpsmon.parseHeader('Application,ProcessID,PresentMode,msBetweenPresents'.split(','));
  const row = ['pol.exe', '4242', 'Composed: Copy with GPU GDI', '16.6'];
  assert.equal(fpsmon.rowValues(cols, row, null), null, 'still dropped for the FPS counter');
  assert.ok(fpsmon.rowValues(cols, row, { pid: '4242', name: '' }).composed);
  assert.equal(fpsmon.rowValues(cols, row, { pid: '5555', name: '' }), null, 'an app in the background never counts');
  assert.equal(fpsmon.rowValues(cols, ['chrome.exe', '4242', 'Composed: Flip', '16.6'], { pid: '4242', name: '' }), null,
    'a browser in front never counts');
  const src = read('../performance/fpsmon.js');
  assert.match(src, /if \(!r\) \{\n {4}if \(front\) _frontFrames\.add\(rowValues\(_csv\.cols, fields, \{ pid: front, name: '' \}\)\);\n {4}return;/);
  assert.equal(typeof fpsmon.getFrontFrames, 'function');
});

// A world the watch reads, all of it under the test's control.
function world(over = {}) {
  const w = {
    t: 0, gaming: false, asked: [],
    front: { process: 'pol', fullscreen: false, ignored: false, listed: false },
    frontPid: 4242, frames: { pid: '4242', fps: 60 },
    ...over,
  };
  w.watch = createGameGuess({
    now: () => w.t, gaming: () => w.gaming, front: () => w.front, frontPid: () => w.frontPid,
    frames: () => w.frames, windowedNonGame: (n) => gd.isWindowedNonGame(n),
    broadcast: (p) => w.asked.push(p),
  });
  // Ticks every `step` ms for `ms`.
  w.run = (ms, step = 1000) => { for (let i = 0; i < ms; i += step) { w.t += step; w.watch.onTick(); } };
  return w;
}

test('asks once, after it drew like a game in front for the whole time', () => {
  const w = world();
  w.run(ASK_AFTER_MS - 2000);
  assert.deepEqual(w.asked, [], 'not before');
  w.run(3000);
  assert.deepEqual(w.asked, [{ process: 'pol' }]);
  w.run(120000);
  assert.equal(w.asked.length, 1, 'once per app');
});

test('never asks when it should not', () => {
  const cases = {
    'a game is already detected': { gaming: true },
    'full screen': { front: { process: 'pol', fullscreen: true } },
    'on "Not games" or built in': { front: { process: 'pol', ignored: true } },
    'already on "Always games"': { front: { process: 'pol', listed: true } },
    'nothing in front': { front: null },
    'unknown app': { front: { process: '?' } },
    'too slow to be a game': { frames: { pid: '4242', fps: 20 } },
    'no frames at all (macOS, Linux, no PresentMon)': { frames: null },
    'frames of another app': { frames: { pid: '9999', fps: 60 } },
    'no pid in front': { frontPid: 0 },
  };
  for (const [why, over] of Object.entries(cases)) {
    const w = world(over);
    w.run(ASK_AFTER_MS * 3);
    assert.deepEqual(w.asked, [], why);
  }
  for (const name of ['Battle.net', 'EpicGamesLauncher', 'EADesktop', 'UbisoftConnect', 'upc', 'GalaxyClient',
    'RiotClientUx', 'LeagueClientUx', 'Zoom', 'ApplicationFrameHost', 'lghub', 'wallpaper64',
    'vlc', 'Photoshop', 'WhatsApp', 'Telegram', 'ms-teams', 'Figma']) {
    const w = world({ front: { process: name + '.exe', fullscreen: false, ignored: false, listed: false } });
    w.run(ASK_AFTER_MS * 3);
    assert.deepEqual(w.asked, [], name);
  }
});

test('a loading screen keeps the count, a longer break or another app starts it again', () => {
  const w = world();
  w.run(10000);
  const frames = w.frames;
  w.frames = null;
  w.run(BREAK_MS - 1000);
  w.frames = frames;
  w.run(ASK_AFTER_MS - 10000 + 1000);
  assert.equal(w.asked.length, 1, 'a short break');

  const v = world();
  v.run(15000);
  v.frames = null;
  v.run(BREAK_MS + 2000);
  v.frames = frames;
  v.run(ASK_AFTER_MS - 2000);
  assert.deepEqual(v.asked, [], 'a long break starts over');

  const a = world();
  a.run(15000);
  a.front = { process: 'other', fullscreen: false, ignored: false, listed: false };
  a.run(10000);
  a.front = { process: 'pol', fullscreen: false, ignored: false, listed: false };
  a.run(ASK_AFTER_MS - 2000);
  assert.deepEqual(a.asked, [], 'another app in front starts over');
});

test('on the real detector: a browser, Xenon or a listed app is never asked about', () => {
  gd.setAlwaysSource(() => ['pol']);
  gd.setIgnoreSource(() => ['notagame']);
  try {
    // The asked-about app first: a listed one is a game, and its grace would cover the next.
    for (const [name, asks] of [['ffxi', true], ['chrome', false], ['xenon', false], ['notagame', false], ['pol', false]]) {
      gd.applySample({ fullscreen: false, process: name, pid: process.pid });
      const asked = [];
      let t = 0;
      const watch = createGameGuess({
        now: () => t, gaming: () => gd.isGaming(), front: () => gd.getGamingWindow(),
        frontPid: () => gd.getForegroundPid(), frames: () => ({ pid: String(process.pid), fps: 60 }),
        windowedNonGame: (n) => gd.isWindowedNonGame(n), broadcast: (p) => asked.push(p),
      });
      for (; t < ASK_AFTER_MS * 2; t += 1000) {
        gd.applySample({ fullscreen: false, process: name, pid: process.pid });
        watch.onTick();
      }
      assert.equal(asked.length, asks ? 1 : 0, name);
    }
  } finally {
    gd.setAlwaysSource(null);
    gd.setIgnoreSource(null);
  }
});

test('the card: two answers, the app named, nothing without an app', () => {
  const answers = [];
  const card = AlertToasts.gameGuess({ process: 'pol.exe' }, {}, (n, g) => answers.push([n, g]));
  assert.equal(card.type, 'info', 'do not disturb holds it back like any unasked pop-up');
  assert.equal(card.title, 'Is pol a game?');
  assert.deepEqual(card.actions.map((a) => a.label), ['It\'s a game', 'Not a game']);
  card.actions[0].onClick();
  card.actions[1].onClick();
  assert.deepEqual(answers, [['pol', true], ['pol', false]]);
  assert.equal(AlertToasts.gameGuess({}, {}, () => {}), null);
  assert.equal(AlertToasts.gameGuess({ process: 'pol' }, {}, null), null);
  const it = { t: (k) => ({ game_guess_title: '{app} è un gioco?', settings_gamealways_is_game: 'È un gioco' })[k] || k };
  assert.equal(AlertToasts.gameGuess({ process: 'pol' }, it, () => {}).title, 'pol è un gioco?');
  assert.equal(AlertToasts.gameGuessDone('pol', true, { ok: true }, {}).title, 'pol counts as a game now');
  assert.equal(AlertToasts.gameGuessDone('pol', false, { ok: true }, {}).title, 'Xenon will not ask about pol again');
  assert.equal(AlertToasts.gameGuessDone('pol', true, { ok: false, error: 'games_full' }, {}).type, 'error');
  assert.equal(AlertToasts.gameGuessDone('pol', true, null, {}).type, 'error');
});

test('the answer the card sends lands in the lists, moving the name across', async () => {
  const store = { gameIgnore: [], gameAlways: [] };
  const settingKeys = { get: (k) => store[k], update: async (k, fn) => (store[k] = fn(store[k])) };
  const caps = createCapabilities({ settingKeys, front: () => '', neverGame: gd.isNeverGame, game: () => '' });
  const run = (isGame) => caps.run(validateAction({ type: isGame ? 'gameAlways' : 'gameIgnore', mode: 'add', name: 'pol' }));
  assert.equal((await run(true)).ok, true);
  assert.deepEqual(store, { gameIgnore: [], gameAlways: ['pol'] });
  assert.equal((await run(false)).ok, true);
  assert.deepEqual(store, { gameIgnore: ['pol'], gameAlways: [] });
  assert.equal(typeof gameMode.editAlways, 'function');
});

test('every surface: the PC\'s dashboard and the alerts window, never a phone', () => {
  const server = engineSource();
  assert.match(server, /const \{ createGameGuess \} = require\('\.\/game-guess\/watch\.js'\);/);
  assert.match(server, /broadcast: \(payload\) => broadcastSSE\('game_guess', payload\)/);
  assert.match(server, /try \{ _gameGuess\.onTick\(\); \} catch \{\}/);
  assert.match(read('../js/grid/data-stream.js'), /es\.addEventListener\('game_guess', e => \{\n {6}try \{ if \(window\.PerfWidget\) window\.PerfWidget\.onGameGuess\(JSON\.parse\(e\.data\)\); \} catch \{\}/);
  const perf = read('../js/perf-widget/perf-widget.js');
  assert.match(perf, /if \(!window\.XenonToast \|\| !window\.AlertToasts \|\| window\.__xenonRemote\) return;/);
  assert.match(perf, /if \(toast && typeof showAlertToast === 'function'\) showAlertToast\(toast\);/);
  assert.match(perf, /type: isGame \? 'gameAlways' : 'gameIgnore', mode: 'add', name/);
  const alerts = read('../js/alerts/screen-alerts.js');
  assert.match(alerts, /function gameGuess\(d\) \{\n {4}if \(!popups\(\)\) return;/);
  assert.match(alerts, /game_guess: gameGuess,/);
  assert.match(alerts, /type: isGame \? 'gameAlways' : 'gameIgnore', mode: 'add', name/);
});

test('every string exists in all 11 languages', () => {
  const i18n = appStringsSource();
  for (const key of ['game_guess_title', 'game_guess_msg', 'game_guess_yes_done', 'game_guess_no_done', 'game_guess_where', 'game_guess_failed']) {
    assert.equal(i18n.split('\n    ' + key + ': ').length - 1, 11, key);
  }
  for (const line of i18n.split('\n').filter((l) => /^ {4}game_guess_(title|yes_done|no_done): /.test(l))) {
    assert.match(line, /\{app\}/, line);
  }
});
