import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const num = require('../phone-numbers.js');

// The weight here is on the REFUSALS. Putting a friend's name on a bank's SMS
// sender, or on a stranger's call, is worse than showing a bare number: the
// user acts on the name, and there is nothing on screen to tell them it was
// guessed. So the loose match is only ever allowed between two long numbers.

test('the same number written four ways is one number', () => {
  const spellings = ['+393463331166', '00393463331166', '346 333 1166', '346-333.1166'];
  const keys = new Set(spellings.map(num.matchKey));
  assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(' / ')}`);
  for (const a of spellings) for (const b of spellings) assert.ok(num.sameNumber(a, b));
});

test('two different mobiles are not the same number', () => {
  assert.ok(!num.sameNumber('+393463331166', '+393463331167'));
  assert.ok(!num.sameNumber('+393463331166', '+393203465082'));
});

test('short codes are compared exactly, never on a tail', () => {
  // 87233 737 is the Trade Republic sender seen on the real phone. Its digits
  // must never be allowed to match the tail of somebody's mobile.
  assert.ok(!num.sameNumber('87233', '+393338987233'));
  assert.ok(num.sameNumber('87233', '87233'));
  assert.ok(!num.sameNumber('4321', '432'));
});

test('a caller resolves to the contact who owns the number', () => {
  const index = num.buildIndex([
    { name: 'Amore', numbers: [{ value: '+393463331166', kind: 'cell' }] },
    { name: 'Papà', numbers: [{ value: '340 264 1223', kind: 'cell' }] },
  ]);
  // The call log writes the international form, the phonebook often does not.
  assert.equal(num.lookup(index, '346 333 1166').name, 'Amore');
  assert.equal(num.lookup(index, '+393402641223').name, 'Papà');
  assert.equal(num.lookup(index, '+393287248309'), null);
  assert.equal(num.lookup(index, ''), null);
});

test('the index skips nameless entries and keeps the first spelling on a clash', () => {
  const index = num.buildIndex([
    { name: '', numbers: [{ value: '+393331112222' }] },
    { name: 'Primo', numbers: [{ value: '+393334445555' }] },
    { name: 'Secondo', numbers: [{ value: '333 444 5555' }] },
  ]);
  assert.equal(num.lookup(index, '+393331112222'), null);
  // Deterministic, and in the phone's own order: a later duplicate silently
  // winning would make the resolved name depend on something invisible.
  assert.equal(num.lookup(index, '+393334445555').name, 'Primo');
});

test('buildIndex survives a malformed contact list', () => {
  assert.equal(num.buildIndex(null).size, 0);
  assert.equal(num.buildIndex([null, {}, { name: 'X' }, { name: 'Y', numbers: 'nope' }]).size, 0);
  // A bare string number instead of the {value} shape still indexes.
  assert.equal(num.buildIndex([{ name: 'Z', numbers: ['+393331112222'] }]).size, 1);
});

test('dialable accepts what a phone accepts and refuses the rest', () => {
  assert.equal(num.dialable('+39 346 333 1166'), '+393463331166');
  assert.equal(num.dialable('(06) 1234-5678'), '0612345678');
  assert.equal(num.dialable('*123#'), '*123#');
  assert.equal(num.dialable(''), '');
  assert.equal(num.dialable('chiama la mamma'), '');
  assert.equal(num.dialable('+39; shutdown -r'), '');
  assert.equal(num.dialable('1'.repeat(40)), '');
});

test('display tidies whitespace and changes nothing else', () => {
  assert.equal(num.displayNumber('  +39  346   333 1166 '), '+39 346 333 1166');
  assert.equal(num.displayNumber(null), '');
});
