// The Game face's line of what plays (js/pump/face-sensors.js): a song, never an app that is
// only heard. While a game records, Xenon's capture engine holds its sound open; the media
// stand-in named it, and the pump said "xenon-capture" under the frame rate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom } from './mini-dom.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function gameFace() {
  const { document } = makeDom();
  const window = {};
  const ctx = vm.createContext({ window, document, Intl, Number, Math, Date, Object, String, Array, JSON });
  vm.runInContext(read('../js/pump/face-kit.js'), ctx);
  window.PumpFaceKit.setWords({ locale: 'en-US' }, { lang: 'en', tempUnit: 'c' });
  vm.runInContext(read('../js/pump/face-drop.js'), ctx);
  vm.runInContext(read('../js/pump/face-sensors.js'), ctx);
  const root = document.createElement('div');
  const face = window.PumpFaceKit.get('face', 'game')(root, { readings: ['fps', 'cpuTemp', 'gpuTemp'], track: true });
  const track = () => root.querySelector('.pf-game-track');
  return { face, track };
}

const system = { fps: 144, cpuTemp: 61, gpuTemp: 70 };

test('a song plays: its title and artist under the frame rate', () => {
  const { face, track } = gameFace();
  face.update({ system, media: { playbackStatus: 'Playing', title: 'Night Drive', artist: 'Low Sun', app: 'Spotify' } });
  assert.equal(track().hidden, false);
  assert.equal(track().textContent, 'Night Drive  /  Low Sun');
});

test('an app only heard, with nothing but its name, is not a song', () => {
  const { face, track } = gameFace();
  face.update({ system, media: { playbackStatus: 'Playing', title: 'xenon-capture', app: 'xenon-capture', fallback: true } });
  assert.equal(track().hidden, true);
  assert.equal(track().textContent, '');
  face.update({ system, media: { playbackStatus: 'Playing', title: 'Track.mp3', app: 'vlc', fallback: true } });
  assert.equal(track().hidden, false, 'a heard app whose window names a song still shows it');
});
