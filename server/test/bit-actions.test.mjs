// What Bit in the chat, a Deck key and a paired phone do with the person's own Bit
// (js/capabilities/catalog-bit.js, server/bit/actions.js): the catalog against the
// model, the same rules as the routes, what a phone may run, the move every own Bit
// plays. Every seed here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Catalog = require('../js/capabilities/catalog-bit.js');
const { CAPABILITIES } = require('../js/capabilities/capability-catalog.js');
const { createCapabilities, aiFunctions } = require('../capabilities/index.js');
const { FREE, remoteMayRun } = require('../paired/remote-actions.js');
const { GROUPS } = require('../ai/ai-tool-groups.js');
const Model = require('../bit/model.js');
const bit = require('../shared/src/bit.js');
require('../shared/src/bit-clips.js');
require('../shared/src/bit-clips-life.js');
const { createBitStore } = require('../bit/store.js');
const { createBitActions } = require('../bit/actions.js');

const SEED = '0123456789abcdef';
const TYPES = ['bitGet', 'bitReact', 'bitPlace', 'bitWear', 'bitRename'];
const NOW = new Date(2026, 11, 3, 12);

function setup({ hatched = true, extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bit-actions-'));
  if (hatched !== null) {
    const egg = Model.normalize({ eggAt: '2026-01-01T00:00:00.000Z' });
    const born = hatched && Model.hatched(egg, { seed: SEED, number: 7, born: NOW.toISOString(), sig: 'made-up' }, NOW).model;
    const model = born ? { ...born, owned: [...born.owned, ...(extra.owned || [])] } : egg;
    writeFileSync(join(dir, 'bit.json'), JSON.stringify(model));
  }
  const sent = [];
  const store = createBitStore({ dataDir: dir });
  const actions = createBitActions({ store, broadcast: (event, data) => sent.push({ event, data }), now: () => NOW, random: () => 0 });
  return { actions, sent, store, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the catalog is appended, its places are the model\'s and every move is a clip', () => {
  for (const type of TYPES) assert.ok(CAPABILITIES.some((c) => c.type === type), type);
  assert.deepEqual(Catalog.PLACES, [...Model.PLACES]);
  for (const m of Catalog.MOVES.filter((x) => x !== 'surprise')) assert.ok(bit.clip(m), m);
  for (const c of Catalog.CAPABILITIES) assert.equal(c.capability.risk, 'safe', c.type);
});

test('a Deck key shows every Bit action, setting and choice by name', () => {
  const en = readFileSync(new URL('../js/i18n/en.js', import.meta.url), 'utf8');
  const has = (key) => en.includes(`\n  ${key}: `);
  for (const c of Catalog.CAPABILITIES.filter((x) => !x.hidden)) {
    assert.ok(has(c.labelKey), c.labelKey);
    for (const p of c.params) {
      assert.ok(has(p.labelKey || `deck_param_${p.name}`), `${c.type} ${p.name}`);
      for (const key of Object.values(p.optionKeys || {})) assert.ok(has(key), key);
    }
  }
});

test('every Bit action reaches Bit\'s one rule set, and Bit AI finds them in one group', async () => {
  const ran = [];
  const caps = createCapabilities({ bit: { actions: { run: async (a) => { ran.push(a.type); return { ok: true }; } } } });
  for (const type of TYPES) assert.deepEqual(await caps.run({ type }), { ok: true });
  assert.deepEqual(ran, TYPES);
  const names = Catalog.CAPABILITIES.map((c) => c.capability.ai.name);
  assert.deepEqual([...GROUPS.my_bit.tools].sort(), [...names].sort());
  const fns = aiFunctions({}).map((f) => f.name);
  for (const n of names) assert.ok(fns.includes(n), n);
});

test('a phone may do everything with its Bit: it is the same dashboard', () => {
  for (const type of TYPES) assert.ok(FREE.has(type), type);
  assert.deepEqual(remoteMayRun({ type: 'bitReact', move: 'wave' }, {}), { ok: true });
});

test('an egg answers egg, and nothing is written for it', async () => {
  const t = setup({ hatched: null });
  try {
    for (const type of TYPES) assert.deepEqual(await t.actions.run({ type, move: 'wave', place: 'off' }), { ok: false, error: 'egg' }, type);
    assert.equal(t.store.onDisk(), false);
    assert.equal(t.sent.length, 0);
  } finally { t.done(); }
});

test('a move is played on every surface, surprise picks a real one', async () => {
  const t = setup();
  try {
    assert.deepEqual(await t.actions.run({ type: 'bitReact', move: 'dance' }), { ok: true, clip: 'dance' });
    assert.deepEqual(await t.actions.run({ type: 'bitReact', move: 'surprise' }), { ok: true, clip: 'wave' });
    assert.deepEqual(await t.actions.run({ type: 'bitReact', move: 'nope' }), { ok: true, clip: 'wave' });
    assert.deepEqual(t.sent.map((s) => [s.event, s.data.clip]), [['bit_play', 'dance'], ['bit_play', 'wave'], ['bit_play', 'wave']]);
  } finally { t.done(); }
});

test('a Deck key from before, still asking for the daily gift, gets a plain no and changes nothing', async () => {
  const t = setup();
  try {
    assert.deepEqual(await t.actions.run({ type: 'bitGift' }), { ok: false, error: 'unsupported' });
    assert.deepEqual(t.sent, []);
  } finally { t.done(); }
});

test('only what it owns can be worn; toggle, on and off do what they say', async () => {
  const t = setup({ extra: { owned: ['scarf'] } });
  try {
    assert.deepEqual(await t.actions.run({ type: 'bitWear', item: 'crown', wear: 'on' }), { ok: false, error: 'not_owned' });
    const on = await t.actions.run({ type: 'bitWear', item: 'scarf', wear: 'toggle' });
    assert.ok(on.bit.worn.includes('scarf'));
    const again = await t.actions.run({ type: 'bitWear', item: 'scarf', wear: 'on' });
    assert.ok(again.bit.worn.includes('scarf'));
    const off = await t.actions.run({ type: 'bitWear', item: 'scarf', wear: 'off' });
    assert.equal(off.bit.worn.includes('scarf'), false);
    assert.deepEqual(t.sent.map((s) => s.event), ['bit', 'bit'], 'a change that changes nothing is not told');
  } finally { t.done(); }
});

test('place and name go through the model\'s rules; the answer has no seed', async () => {
  const t = setup();
  try {
    assert.equal((await t.actions.run({ type: 'bitPlace', place: 'topbar' })).bit.place, 'topbar');
    assert.equal((await t.actions.run({ type: 'bitRename', name: 'Pixel' })).bit.name, 'Pixel');
    const got = await t.actions.run({ type: 'bitGet' });
    assert.equal(got.bit.name, 'Pixel');
    assert.equal(got.bit.number, 7);
    assert.equal(JSON.stringify(got).includes(SEED), false, 'the seed stays on the PC');
    for (const t2 of got.bit.traits) assert.deepEqual(Object.keys(t2).sort(), ['earned', 'id', 'item', 'progress']);
  } finally { t.done(); }
});
