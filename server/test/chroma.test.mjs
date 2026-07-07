import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chroma = require('../actions/chroma.js');

// ── bgrInt: colours are BGR (0x00BBGGRR), red is the least-significant byte ──

test('bgrInt packs red/green/blue into the BGR integer format', () => {
  assert.equal(chroma.bgrInt(255, 0, 0), 0x0000FF);   // pure red
  assert.equal(chroma.bgrInt(0, 255, 0), 0x00FF00);   // pure green
  assert.equal(chroma.bgrInt(0, 0, 255), 0xFF0000);   // pure blue
  assert.equal(chroma.bgrInt(255, 255, 255), 0xFFFFFF);
});

test('bgrInt clamps out-of-range channels to 0..255', () => {
  assert.equal(chroma.bgrInt(300, -10, 128), chroma.bgrInt(255, 0, 128));
});

// ── parseColor: the one free-form value that reaches the SDK ──

test('parseColor accepts #rrggbb / rrggbb and returns a BGR int', () => {
  assert.equal(chroma.parseColor('#ff0000'), 0x0000FF);
  assert.equal(chroma.parseColor('00ff00'), 0x00FF00);
  assert.equal(chroma.parseColor('#0000FF'), 0xFF0000);
});

test('parseColor accepts an {r,g,b} object', () => {
  assert.equal(chroma.parseColor({ r: 255, g: 0, b: 0 }), 0x0000FF);
});

test('parseColor rejects malformed input', () => {
  for (const bad of ['', '#fff', 'red', 'gggggg', '#12345', null, undefined, {}, { r: 1 }]) {
    assert.equal(chroma.parseColor(bad), null, JSON.stringify(bad));
  }
});

// ── resolveDevices: 'all' fans to the six endpoints ──

test('resolveDevices maps all / a device / an unknown', () => {
  assert.equal(chroma.resolveDevices('all').length, chroma.DEVICES.length);
  assert.deepEqual(chroma.resolveDevices('keyboard'), ['keyboard']);
  assert.deepEqual(chroma.resolveDevices('KEYBOARD'), ['keyboard']);   // case-insensitive
  assert.deepEqual(chroma.resolveDevices('bogus'), []);
  assert.equal(chroma.resolveDevices(undefined).length, chroma.DEVICES.length);   // default = all
});

// ── chromaActionToEffect: pure action → effect mapping ──

test('chromaActionToEffect: off → CHROMA_NONE on the devices', () => {
  const eff = chroma.chromaActionToEffect({ type: 'chromaOff', device: 'keyboard' });
  assert.deepEqual(eff, { devices: ['keyboard'], body: { effect: 'CHROMA_NONE' } });
});

test('chromaActionToEffect: color → CHROMA_STATIC with a BGR param', () => {
  const eff = chroma.chromaActionToEffect({ type: 'chromaColor', device: 'mouse', color: '#ff0000' });
  assert.deepEqual(eff, { devices: ['mouse'], body: { effect: 'CHROMA_STATIC', param: { color: 0x0000FF } } });
});

test('chromaActionToEffect: a bad colour or bad device is rejected', () => {
  assert.equal(chroma.chromaActionToEffect({ type: 'chromaColor', device: 'keyboard', color: 'nope' }), null);
  assert.equal(chroma.chromaActionToEffect({ type: 'chromaColor', device: 'bogus', color: '#fff000' }), null);
  assert.equal(chroma.chromaActionToEffect({ type: 'unknown' }), null);
});

test('chromaActionToEffect: custom grid targets the keyboard endpoint only', () => {
  const eff = chroma.chromaActionToEffect({ type: 'chromaCustom', device: 'all', grid: [['#ff0000']] });
  assert.deepEqual(eff.devices, ['keyboard']);
  assert.equal(eff.body.effect, 'CHROMA_CUSTOM');
});

// ── buildCustomGrid: pad/truncate to the fixed keyboard shape ──

test('buildCustomGrid produces a KB_ROWS × KB_COLS grid of BGR ints', () => {
  const grid = chroma.buildCustomGrid([['#ff0000', '#00ff00']]);
  assert.equal(grid.length, chroma.KB_ROWS);
  assert.equal(grid[0].length, chroma.KB_COLS);
  assert.equal(grid[0][0], 0x0000FF);   // red
  assert.equal(grid[0][1], 0x00FF00);   // green
  assert.equal(grid[0][2], 0);          // padded
  assert.equal(grid[5][0], 0);          // padded row
});

test('buildCustomGrid rejects a non-array', () => {
  assert.equal(chroma.buildCustomGrid('x'), null);
  assert.equal(chroma.buildCustomGrid([]), null);
});
