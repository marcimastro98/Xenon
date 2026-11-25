// The Bit's months (server/bit/months.js): what each month held, counted by difference in the
// store, and the recap cards there are on a given day. Every seed and name here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Model = require('../bit/model.js');
const Months = require('../bit/months.js');
const { createBitStore } = require('../bit/store.js');
const { createBitBackup } = require('../bit/backup.js');

const SEED = '0123456789abcdef';
const born = { ok: true, seed: SEED, number: 1284, born: '2026-11-03T11:00:00.000Z', sig: 'made-up' };
const minute = { gaming: true, music: true, coding: false, hot: false, active: true, open: true };

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-bit-months-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A store whose clock the test moves.
function storeAt(t, start) {
  const clock = { now: start };
  const store = createBitStore({ dataDir: tempDir(t), now: () => clock.now });
  return { store, clock };
}

test('the months as kept: garbage dropped, counts made whole, the newest fourteen only', () => {
  const raw = { 'not-a-month': { days: 3 }, '2026-13': { days: 3 }, '2026-11': { days: -2, gaming: 12.7, items: ['beanie', 'nope', 'beanie'], extra: 1 } };
  for (let m = 1; m <= 12; m++) raw[`2025-${String(m).padStart(2, '0')}`] = { days: m };
  raw['2026-10'] = { days: 'x' };
  const out = Months.normalize(raw);
  assert.equal(Object.keys(out).length, Months.KEEP);
  assert.deepEqual(Object.keys(out).slice(0, 2), ['2025-01', '2025-02']);
  assert.deepEqual(out['2026-11'], { days: 0, gaming: 12, music: 0, coding: 0, hot: 0, night: 0, early: 0, gifts: 0, items: ['beanie'] });
  assert.equal(out['2026-10'].days, 0);
  assert.deepEqual(Months.normalize([1, 2]), {});
  assert.deepEqual(Months.normalize(null), {});
  assert.deepEqual(Model.normalize({}).months, {}, 'a bit.json from before the months has none');
});

test('every change counts in its month: the hatch, the days, the minutes, the gift and the items', async (t) => {
  const { store, clock } = storeAt(t, new Date(2026, 10, 3, 12, 0));
  await store.create(false);
  await store.update((m) => Model.hatched(m, born, clock.now));
  let month = (await store.ready()).months['2026-11'];
  assert.equal(month.days, 1, 'the day it hatched');
  assert.equal(month.items.length, 1, 'with its birth gift');
  for (let i = 0; i < 90; i++) await store.remember((m) => Model.learn(m, minute, clock.now));
  clock.now = new Date(2026, 10, 4, 2, 0);
  await store.remember((m) => Model.learn(m, { active: true }, clock.now));
  await store.update((m) => Model.countDay(m, clock.now));
  month = (await store.ready()).months['2026-11'];
  assert.deepEqual([month.days, month.gaming, month.music, month.night], [2, 90, 90, 1]);
  clock.now = new Date(2026, 11, 1, 9, 0);
  const Gifts = require('../bit/gifts.js');
  await store.update((m) => Gifts.open(m, clock.now, Model.ownedItems(m)));
  await store.update((m) => Model.countDay(m, clock.now));
  const all = (await store.ready()).months;
  assert.deepEqual(Object.keys(all), ['2026-11', '2026-12']);
  assert.equal(all['2026-12'].gifts, 1);
  assert.equal(all['2026-12'].days, 1);
  assert.equal(all['2026-11'].days, 2, 'last month stays as it closed');
  await store.update((m) => Model.rename(m, 'Pixel'));
  assert.deepEqual((await store.ready()).months, all, 'a new name is no event of the month');
});

test('a backup put back is the same Bit, never a month of life; another seed is not counted either', async (t) => {
  const from = storeAt(t, new Date(2026, 10, 3, 12, 0));
  await from.store.create(true);
  await from.store.update((m) => Model.hatched(m, born, from.clock.now));
  const days = { ...(await from.store.ready()), days: { count: 200, last: '2026-11-03' } };
  await from.store.replace(days);
  const section = JSON.parse(JSON.stringify(await createBitBackup({ store: from.store }).save()));
  assert.equal(section.months['2026-11'].days, 1, 'the 200 days put back are not this month');
  const to = storeAt(t, new Date(2026, 11, 9, 12, 0));
  await to.store.create(false);
  await createBitBackup({ store: to.store }).restore(section);
  assert.deepEqual((await to.store.ready()).months, section.months, 'a new PC gets the months as they were');
  const before = await to.store.ready();
  const other = { ...before, bit: { ...before.bit, seed: 'fedcba9876543210' }, days: { count: 500, last: '' } };
  assert.equal(Months.record(before, other, new Date(), Model.ownedItems), other);
});

test('the cards there are: last month all month long, the year from 20 December to the end of January', () => {
  const months = Months.normalize({
    '2026-03': { days: 4, gaming: 600 },
    '2026-11': { days: 12, music: 300, items: ['beanie'] },
    '2026-12': { days: 9, gaming: 120, items: ['scarf', 'beanie'] },
    '2027-01': { days: 2 },
  });
  const at = (y, m, d) => Months.recap(months, new Date(y, m - 1, d, 12));
  assert.deepEqual(at(2026, 12, 1).month, { key: '2026-11', ...months['2026-11'] });
  assert.equal(at(2026, 12, 19).year, null);
  const dec = at(2026, 12, 20).year;
  assert.deepEqual([dec.key, dec.days, dec.gaming, dec.music], ['2026', 25, 720, 300]);
  assert.deepEqual(dec.items, ['beanie', 'scarf'], 'each item once');
  const jan = at(2027, 1, 31);
  assert.deepEqual([jan.month.key, jan.year.key, jan.year.days], ['2026-12', '2026', 25]);
  assert.deepEqual(at(2027, 2, 1), { month: { key: '2027-01', ...months['2027-01'] }, year: null });
  assert.deepEqual(at(2026, 5, 2), { month: null, year: null }, 'nothing in April: no card');
  assert.deepEqual(Months.recap({}, new Date(2026, 11, 24)), { month: null, year: null });
});

test('the view carries the recap to this person\'s screens; a widget\'s reader never does', async () => {
  const model = { ...Model.hatched(Model.normalize({}), born, new Date(2026, 10, 3, 12)).model };
  model.months = Months.normalize({ '2026-11': { days: 5, gaming: 240 } });
  const v = Model.view(model, new Date(2026, 11, 2, 12));
  assert.equal(v.recap.month.key, '2026-11');
  assert.equal(v.recap.month.gaming, 240);
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const window = {};
  vm.runInNewContext(readFileSync(new URL('../js/custom-widget/stream-readers.js', import.meta.url), 'utf8'), { window });
  const seen = JSON.stringify(window.CustomWidgetStreamReaders.bit(JSON.parse(JSON.stringify(v))));
  assert.ok(!seen.includes('recap') && !seen.includes('240'), 'no month reaches a widget');
  const told = require('../bit/actions.js').brief(v);
  assert.deepEqual(told.cards, ['2026-11'], 'Bit in the chat hears which card is ready');
  assert.ok(!JSON.stringify(told).includes('240'), 'never what it counts');
});
