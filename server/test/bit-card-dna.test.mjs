// What makes the person's own Bit its own on the card and in the video
// (js/bit-companion/card-dna.js): its pose from its DNA or the one picked, its DNA strip with
// the true odds, and a ground in its own colour. Every Bit here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SRC = readFileSync(new URL('../js/bit-companion/card-dna.js', import.meta.url), 'utf8');
const Model = require('../bit/model.js');
const genome = require('../shared/src/bit-genome.js');
const color = require('../shared/src/bit-color.js');
const { QUIRKS } = require('../shared/src/bit-genes.js');

function load(Xenon = {}) {
  const window = { Xenon };
  vm.runInNewContext(SRC, { window, Map, Math, Array, Object, JSON });
  return window.BitDna;
}

test('the pose is its favourite move from the DNA, or the one picked; the turn comes back to its own', () => {
  const D = load();
  for (const { id } of QUIRKS) assert.ok(D.POSES.includes(id), `${id} has a pose`);
  assert.equal(D.poseOf({ genes: { quirk: 'peek' } }), 'peek');
  assert.equal(D.poseOf({ genes: { quirk: 'peek' }, prefs: { pose: 'cool' } }), 'cool');
  assert.equal(D.poseOf({ genes: { quirk: 'notAMove' }, prefs: { pose: 'nope' } }), 'pose', 'unknown: the classic pose');
  // Every pose once, then back to its own, which the server stores as ''.
  let bit = { genes: { quirk: 'wink' }, prefs: { pose: '' } };
  const seen = new Set([D.poseOf(bit)]);
  for (let i = 0; i < D.POSES.length - 1; i++) {
    const next = D.nextPose(bit);
    assert.ok(next && !seen.has(next), `step ${i}: ${next}`);
    seen.add(next);
    bit = { ...bit, prefs: { pose: next } };
  }
  assert.equal(D.nextPose(bit), '', 'the last one leads back to its own');
  assert.equal(seen.size, D.POSES.length);
});

test('the server keeps a known pose and drops anything else', () => {
  assert.equal(Model.normalizePrefs({ pose: 'juggle' }).pose, 'juggle');
  assert.equal(Model.normalizePrefs({ pose: 'pose' }).pose, 'pose');
  assert.equal(Model.normalizePrefs({ pose: '<script>' }).pose, '');
  assert.equal(Model.normalizePrefs({}).pose, '');
  assert.deepEqual([...Model.POSES].sort(), [...load().POSES].sort(), 'the server and the card know the same poses');
});

test('the DNA strip says each gene with its true odds, the pattern counted with its colour', () => {
  const D = load();
  const bit = {
    genes: { shiny: true, classic: false },
    rarity: [
      { gene: 'shiny', chance: 1 / 4096 }, { gene: 'tip', chance: 1 / 16 }, { gene: 'pattern', chance: 1 / 24 },
      { gene: 'patternColor', chance: 1 / 2 }, { gene: 'palette', chance: 1 / 64 }, { gene: 'eyes', chance: 1 / 8 }, { gene: 'cheeks', chance: 1 / 6 },
    ],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(D.genes(bit))), [
    { key: 'shiny', oneIn: 4096 }, { key: 'palette', oneIn: 64 }, { key: 'pattern', oneIn: 48 },
    { key: 'tip', oneIn: 16 }, { key: 'eyes', oneIn: 8 }, { key: 'cheeks', oneIn: 6 },
  ]);
  assert.equal(D.genes({ ...bit, genes: { classic: true } })[0].key, 'classic');
  assert.equal(D.genes({ genes: {} }).length, 0, 'no odds known: no strip');
});

test('the ground takes the hue of its body, deep enough for its light text on every palette', () => {
  const D = load({ bitColor: color, bitGenome: genome });
  assert.deepEqual(Object.keys(D.colors(null)), ['ink', 'text', 'muted', 'line']);
  const grounds = new Set();
  for (const { id: p } of genome.PALETTES) {
    const tone = D.colors({ genes: { palette: p } });
    grounds.add(tone.ink);
    assert.ok(color.contrast(tone.text, tone.ink) >= 7, `palette ${p}: text ${color.contrast(tone.text, tone.ink)}`);
    assert.ok(color.contrast(tone.muted, tone.ink) >= 4.5, `palette ${p}: muted ${color.contrast(tone.muted, tone.ink)}`);
  }
  assert.ok(grounds.size > 16, `the ground follows the Bit (${grounds.size} grounds)`);
});
