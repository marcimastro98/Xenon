// The request check (tools/ci/request-check.mjs): what it counts as a server whose
// settings or live stream stopped working.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_KEY, differingKeys, requestProblems, settingsFingerprint } from '../../tools/ci/request-check.mjs';

const base = { rev: 3, storeId: 'a1', language: 'en', [PROBE_KEY]: 0, vitals: { enabled: false, pet: { name: 'Bit' } } };
const saved = { ...base, rev: 4, [PROBE_KEY]: 300 };
const good = { first: base, saveStatus: 200, afterSave: saved, afterRestart: { ...saved }, events: ['media', 'settings'], toldSave: true, wanted: 300, output: 'listening\n' };

test('read, save, read back, restart, read again and one told save is a clean run', () => {
  assert.deepEqual(requestProblems(good), []);
});

test('the fingerprint ignores key order, rev, the store id and the probed setting, and nothing else', () => {
  const shuffled = { vitals: { pet: { name: 'Bit' }, enabled: false }, [PROBE_KEY]: 500, language: 'en', storeId: 'b2', rev: 9 };
  assert.equal(settingsFingerprint(shuffled), settingsFingerprint(base));
  assert.notEqual(settingsFingerprint({ ...base, language: 'it' }), settingsFingerprint(base));
  assert.notEqual(settingsFingerprint({ ...base, vitals: { enabled: false, pet: { name: 'Bot' } } }), settingsFingerprint(base));
});

test('a save that did not stick is named', () => {
  const p = requestProblems({ ...good, afterSave: { ...base, rev: 4 }, afterRestart: { ...base, rev: 4 } });
  assert.ok(p.some((line) => new RegExp(`${PROBE_KEY} reads 0 after saving 300`).test(line)), p.join('\n'));
});

test('a save that is lost by the restart is named', () => {
  const p = requestProblems({ ...good, afterRestart: { ...base } });
  assert.ok(p.some((line) => /after the restart, 300 was saved/.test(line)), p.join('\n'));
  assert.ok(p.some((line) => /rev changed over the restart/.test(line)), p.join('\n'));
});

test('the settings that differ are named, the volatile ones aside', () => {
  assert.deepEqual(differingKeys(base, { ...saved, language: 'it', extra: 1 }), ['extra', 'language']);
  assert.deepEqual(differingKeys(base, { ...saved, vitals: { pet: { name: 'Bit' }, enabled: false } }), []);
});

test('a save that touched another setting, kept rev, or changed the store is named', () => {
  assert.match(requestProblems({ ...good, afterSave: { ...saved, language: 'it' }, afterRestart: { ...saved, language: 'it' } }).join('\n'), /changed more than the one setting: language/);
  assert.match(requestProblems({ ...good, afterSave: { ...saved, rev: 3 }, afterRestart: { ...saved, rev: 3 } }).join('\n'), /did not raise rev/);
  assert.match(requestProblems({ ...good, afterRestart: { ...saved, storeId: 'zz' } }).join('\n'), /store id changed/);
});

test('no answer, a refused save, a silent stream and a crash line are each named', () => {
  const p = requestProblems({ first: null, saveStatus: 403, afterSave: null, afterRestart: null, events: [], toldSave: false, wanted: 300,
    output: 'ok\nReferenceError: hub is not defined\n' });
  assert.match(p.join('\n'), /could not be read/);
  assert.match(p.join('\n'), /the save answered 403/);
  assert.match(p.join('\n'), /sent no event/);
  assert.match(p.join('\n'), /ReferenceError: hub is not defined/);
});

test('a stream whose only settings event came before the save did not tell the save', () => {
  assert.match(requestProblems({ ...good, events: ['settings', 'media', 'system'], toldSave: false }).join('\n'), /did not tell the save/);
});
