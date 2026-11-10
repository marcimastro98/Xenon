// Buying Sparks is not supporting: the site's supporters wall leaves Sparks
// purchases out (tools/supporters-sparks.mjs, used by tools/build-supporters.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSparksExtra, withoutSparks } from '../../tools/supporters-sparks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const support = (over = {}) => ({
  support_id: 1, payer_email: 'buyer@example.com', payer_name: 'Ada', support_coffees: 1,
  support_coffee_price: '5.01', support_currency: 'USD', support_created_on: '2026-11-10 11:43:10', ...over,
});
const pack = (over = {}) => ({
  purchase_id: 2, payer_email: 'buyer@example.com', purchase_amount: '5.01', purchase_currency: 'USD',
  purchased_on: '2026-11-10 11:43:00', extra: { reward_title: '500 Sparks' }, ...over,
});

test('a Sparks pack is told apart from any other extra by its title', () => {
  for (const title of ['500 Sparks', '1050 Scintille', '2200 credits']) assert.equal(isSparksExtra({ extra: { reward_title: title } }), true, title);
  for (const title of ['Wall Plate', 'Sparkle theme']) assert.equal(isSparksExtra({ extra: { reward_title: title } }), false, title);
});

test('the support BMC lists for a Sparks purchase never reaches the wall', () => {
  assert.deepEqual(withoutSparks([support()], [pack()]), []);
  // Case and spaces in the address do not matter.
  assert.deepEqual(withoutSparks([support({ payer_email: ' Buyer@Example.com ' })], [pack()]), []);
});

test('real supports stay: another person, another moment, another sum, or no pack at all', () => {
  const kept = [
    support({ support_id: 2, payer_email: 'donor@example.com' }),
    support({ support_id: 3, support_created_on: '2026-11-10 14:00:00' }),
    support({ support_id: 4, support_coffees: 5, support_coffee_price: '5' }),
  ];
  assert.deepEqual(withoutSparks(kept, [pack()]).map((s) => s.support_id), [2, 3, 4]);
  assert.deepEqual(withoutSparks([support()], [pack({ extra: { reward_title: 'Wall Plate' } })]).length, 1);
  assert.deepEqual(withoutSparks([support()], []).length, 1);
});

test('the wall builder filters with it and reads the right BMC endpoint', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/build-supporters.mjs'), 'utf8');
  assert.ok(src.includes("fetchAllPages('extras')"), 'the API path is extras');
  assert.ok(src.includes('oneOff = withoutSparks(oneOff, extras);'));
  assert.ok(!/for \(const s of extras\) addUsd/.test(src), 'extras are never added to the wall');
});
