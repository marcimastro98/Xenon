// A Deck key whose "Look while active" follows the speaker mute (issue #139).
//
// Reported on GitHub: the muted face showed only on a freshly started Xenon,
// late, and then never changed again until a restart. The mute rides the
// server's `audio` SSE tick, and the server runs that tick only for two minutes
// after something asked for /audio. The dashboard asks once when it loads, so
// the key followed for two minutes and then froze. Output-device keys already
// kept the tick alive by asking once a minute; mute keys and the master volume
// fader now do the same, and a press asks at once instead of waiting 8s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const DECK = read('../js/deck.js');

// The audio-watch block of js/deck.js, run against a fake page.
function loadWatch({ stateKeys = [], sliders = [], audio = null } = {}) {
  const start = DECK.indexOf('  const AUDIO_WATCH_MS');
  const end = DECK.indexOf('function syncAudioWatch');
  assert.ok(start > 0 && end > start, 'audio watch block moved');
  const body = DECK.slice(start, DECK.indexOf('\n', end));
  const states = [];
  const timers = [];
  const ctx = {
    SERVER: '',
    document: {
      hidden: false,
      querySelectorAll: (sel) => (sel.includes('data-state-bound')
        ? stateKeys.map((source) => ({ _deckState: { source } }))
        : sliders.map((target) => ({ _deckSlider: { target } }))),
    },
    fetch: async () => ({ json: async () => audio }),
    refreshStates: (s) => states.push(s),
    setInterval: (_fn, ms) => { timers.push(ms); return timers.length; },
    clearInterval: () => {},
  };
  vm.runInNewContext(body + '\nthis.api = { deckReadsAudio, pollAudioState, syncAudioWatch, AUDIO_ACTION_TYPES };', ctx);
  return { api: ctx.api, states, timers };
}

test('a key showing the speaker mute keeps the audio state coming', () => {
  assert.equal(loadWatch({ stateKeys: ['speakerMuted'] }).api.deckReadsAudio(), true);
  assert.equal(loadWatch({ stateKeys: ['outputDevice'] }).api.deckReadsAudio(), true);
  assert.equal(loadWatch({ sliders: ['volume'] }).api.deckReadsAudio(), true, 'the master volume fader too');
  assert.equal(loadWatch({ stateKeys: ['micMuted', 'obsScene'], sliders: ['appVolume'] }).api.deckReadsAudio(), false,
    'keys that read nothing from /audio do not keep the poll alive');
});

test('the watch asks once a minute and seeds the mute and the volume', async () => {
  const w = loadWatch({ stateKeys: ['speakerMuted'], audio: { speaker: { id: 'spk', muted: true, volume: 42 } } });
  w.api.syncAudioWatch();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.timers, [60000]);
  assert.deepEqual(JSON.parse(JSON.stringify(w.states)), [{ outputDevice: 'spk', speakerMuted: true, masterVolume: 42 }]);
});

test('an unreadable audio state leaves the key as it was', async () => {
  const w = loadWatch({ stateKeys: ['speakerMuted'], audio: { unavailable: true } });
  await w.api.pollAudioState();
  assert.equal(w.states.length, 0);
});

test('a press on a mute or volume key asks for the new state at once', () => {
  assert.ok(loadWatch().api.AUDIO_ACTION_TYPES.includes('volume'));
  assert.match(DECK, /AUDIO_ACTION_TYPES\.includes\(action\.type\)\) pollAudioState\(\);/);
});

test('after an audio change the next read starts fresh, not from a read begun before it', () => {
  const SRV = read('../server.js');
  const at = SRV.indexOf('function svvExec(args) {');
  assert.ok(at > 0, 'svvExec moved');
  const fn = SRV.slice(at, SRV.indexOf('\n}', at));
  assert.match(fn, /return run\.finally\(\(\) => \{ audioPending = null; \}\);/);
});

test('a press on a mic key pushes the mic state without waiting for the status tick', () => {
  const SRV = read('../server.js');
  const at = SRV.indexOf('  micMute: async (mode) => {');
  assert.ok(at > 0, 'micMute dep moved');
  const dep = SRV.slice(at, SRV.indexOf('  volume: async', at));
  assert.match(dep, /setMicMute\(isMuted\);[\s\S]*broadcastStatusNow\(\);[\s\S]*return \{ muted: isMuted \};/);
});
