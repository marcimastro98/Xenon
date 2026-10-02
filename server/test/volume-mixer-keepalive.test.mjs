// "It used to show every app I had open, now it shows nothing."
//
// Since v4.10.0 the server reads the volume of every app only while somebody is
// using the Volume panel: an audio request keeps the 8 second read going for two
// minutes and then it stops. The dashboard fetched once, when the page loaded, and
// never again, so a game or a call that started after those two minutes never
// reached the mixer, and the list sat empty.
//
// While a Volume or Microphone surface is on screen the dashboard now says so
// every 30 seconds, and fetches the moment one comes into view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// LF only, so the slices below find their ends on a CRLF (Windows) checkout too.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const VOLUME = read('../js/volume.js');
const SERVER = read('../server.js');

function cut(src, start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `cannot cut ${start}`);
  return src.slice(a, b);
}

// A page that can be told what is on it, and a clock that only moves when told.
function harness({ hidden = false, width = 1000, height = 600 } = {}) {
  const calls = { fetchAudio: 0, pings: [] };
  const clock = { t: 1_000_000 };
  const surfaces = [];
  const doc = { hidden, querySelectorAll: () => surfaces };
  const win = { innerWidth: width, innerHeight: height };
  const body = cut(VOLUME, 'const AUDIO_WATCH_TICK_MS', 'setInterval(audioWatchTick');
  const api = new Function('document', 'window', 'fetchAudio', 'fetch', 'SERVER', 'Date',
    body + '\nreturn { audioSurfaceOnScreen, audioWatchTick, AUDIO_WATCH_TICK_MS, AUDIO_WATCH_PING_MS };')(
    doc, win,
    () => { calls.fetchAudio++; },
    (url) => { calls.pings.push(url); return Promise.resolve({}); },
    'http://x',
    { now: () => clock.t });
  const surface = (rect, laidOut = true) => {
    const el = { getClientRects: () => (laidOut ? [rect] : []), getBoundingClientRect: () => rect };
    surfaces.push(el);
    return el;
  };
  return { api, calls, clock, doc, surfaces, surface };
}
const inView = { left: 100, top: 100, right: 400, bottom: 300, width: 300, height: 200 };

test('a Volume surface that is laid out and inside the viewport counts as on screen', () => {
  const h = harness();
  assert.equal(h.api.audioSurfaceOnScreen(), false, 'nothing on the page');
  h.surface(inView);
  assert.equal(h.api.audioSurfaceOnScreen(), true);
});

test('a closed tab, a page swiped away and a hidden window do not', () => {
  const closedTab = harness();
  closedTab.surface(inView, false);              // display:none on it or above it
  assert.equal(closedTab.api.audioSurfaceOnScreen(), false);

  const otherPage = harness();
  otherPage.surface({ left: 1000, top: 100, right: 1300, bottom: 300, width: 300, height: 200 });
  assert.equal(otherPage.api.audioSurfaceOnScreen(), false, 'the next page sits just right of the viewport');

  const behind = harness({ hidden: true });
  behind.surface(inView);
  assert.equal(behind.api.audioSurfaceOnScreen(), false, 'a minimised or covered window');
});

test('one of several surfaces being in view is enough', () => {
  const h = harness();
  h.surface({ left: 1000, top: 0, right: 1200, bottom: 100, width: 200, height: 100 });
  h.surface(inView);
  assert.equal(h.api.audioSurfaceOnScreen(), true);
});

test('coming into view fetches at once; staying in view only pings, every 30 seconds', () => {
  const h = harness();
  h.surface(inView);
  h.api.audioWatchTick();
  assert.equal(h.calls.fetchAudio, 1, 'the list is refreshed the moment the panel appears');
  assert.deepEqual(h.calls.pings, []);

  h.clock.t += h.api.AUDIO_WATCH_TICK_MS;
  h.api.audioWatchTick();
  assert.equal(h.calls.fetchAudio, 1, 'no second fetch while it just stays there');
  assert.deepEqual(h.calls.pings, [], 'and no ping yet');

  h.clock.t += h.api.AUDIO_WATCH_PING_MS;
  h.api.audioWatchTick();
  assert.deepEqual(h.calls.pings, ['http://x/audio/watch']);
  assert.equal(h.calls.fetchAudio, 1);

  h.clock.t += h.api.AUDIO_WATCH_TICK_MS;
  h.api.audioWatchTick();
  assert.equal(h.calls.pings.length, 1, 'the next ping is another 30 seconds away');
});

test('nothing is asked while no mixer is on screen, and it fetches again when one returns', () => {
  const h = harness();
  const el = h.surface(inView);
  h.api.audioWatchTick();
  assert.equal(h.calls.fetchAudio, 1);

  el.getClientRects = () => [];                  // the user switched to another tab
  for (let i = 0; i < 40; i++) { h.clock.t += h.api.AUDIO_WATCH_TICK_MS; h.api.audioWatchTick(); }
  assert.equal(h.calls.fetchAudio, 1);
  assert.deepEqual(h.calls.pings, [], 'ten minutes with the panel closed asks for nothing');

  el.getClientRects = () => [inView];            // and back
  h.api.audioWatchTick();
  assert.equal(h.calls.fetchAudio, 2, 'what started playing meanwhile is shown at once');
});

test('the ping is well inside the window the server keeps reading for', () => {
  const window_ = Number(/const AUDIO_WATCH_WINDOW_MS = (\d+);/.exec(SERVER)[1]);
  const ping = Number(/const AUDIO_WATCH_PING_MS = (\d+);/.exec(VOLUME)[1]);
  assert.ok(ping * 2 <= window_, `a ping every ${ping} ms must survive a missed one inside ${window_} ms`);
});

test('the server route only re-arms the read: it reads and spawns nothing', () => {
  const route = cut(SERVER, "reqPath === '/audio/watch' && req.method === 'GET'", '\n  } else if (');
  assert.match(route, /json\(\{ ok: true \}\);/);
  assert.doesNotMatch(route, /getAudioInfo|readSoundVolumeRows|execFile|svvExec/);
  // Re-arming is done once, for every audio route, before any of them runs.
  const guard = cut(SERVER, "if (reqPath.startsWith('/audio')", '_noteAudioWatched();');
  assert.match(guard, /reqPath\.startsWith\('\/audio'\)/);
});

test('the volume card, the microphone panel and the "audio unavailable" notice are the surfaces', () => {
  assert.match(VOLUME, /querySelectorAll\('\.volume-wrap, \.mic-panel, \[data-volf="vol-error"\]'\)/);
  // The notice is the one that matters when the read fails: it is on screen while
  // the card inside the hidden audio block is not.
  assert.match(read('../index.html'), /class="audio-unavailable" data-volf="vol-error"/);
});

test('the tick is actually scheduled', () => {
  assert.match(VOLUME, /setInterval\(audioWatchTick, AUDIO_WATCH_TICK_MS\);/);
});
