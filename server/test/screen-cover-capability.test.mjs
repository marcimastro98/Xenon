// capabilities/screen-cover.js: "Cover private data" for the Deck and Bit.
// Pinned here: only screenshots are covered, the newest by default or one by
// id; the answer is a count by kind, never text or a path; nothing found = no
// copy and its own toast; the copy's toast says how many; the catalog entry,
// the runner and the AI function line up; the editor's words are in 11 languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const screenCover = require('../capabilities/screen-cover.js');
const { createCapabilities, aiFunctions } = require('../capabilities/index.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');

const SHOT = { id: 'aaaaaaaaaaaaaaaa', kind: 'screenshot', file: 'C:\\Users\\u\\Pictures\\Xenon\\Desktop\\a.png' };
const OLD = { ...SHOT, id: 'bbbbbbbbbbbbbbbb' };
const VIDEO = { ...SHOT, id: 'cccccccccccccccc', kind: 'recording' };
const COPY = { id: 'dddddddddddddddd', kind: 'screenshot', name: 'a Covered.png', width: 1920, height: 1080 };

function deps({ answer, last = SHOT, store = true } = {}) {
  const log = { covered: [], saved: [], nothing: 0 };
  const byId = new Map([SHOT, OLD, VIDEO].map(e => [e.id, e]));
  const capture = {
    host: { available: () => true },
    store: () => (store ? { get: (id) => byId.get(id) || null, last: async (k) => (k === 'screenshot' ? last : null) } : null),
    covers: () => ({
      cover: async (id) => { log.covered.push(id); return answer || { ok: true, entry: COPY, covered: 3, found: { email: 2, number: 1 } }; },
    }),
    onSaved: (e) => log.saved.push(e),
    onNothingCovered: () => { log.nothing++; },
  };
  return { d: { capture }, log };
}

test('the newest screenshot by default, one by id; the answer is a count, never text or a path', async () => {
  const { d, log } = deps();
  const r = await screenCover.run(d, {});
  assert.deepEqual(r, { ok: true, covered: 3, found: { email: 2, number: 1 }, id: COPY.id, name: COPY.name });
  assert.deepEqual(log.covered, [SHOT.id]);
  assert.deepEqual(log.saved, [{ ...COPY, covered: 3 }]);
  await screenCover.run(d, { id: OLD.id });
  assert.deepEqual(log.covered, [SHOT.id, OLD.id]);
  assert.ok(!JSON.stringify(r).includes('\\'), 'no path');
});

test('nothing private found: no copy, its own toast, ok with 0', async () => {
  const { d, log } = deps({ answer: { ok: true, covered: 0, found: {} } });
  assert.deepEqual(await screenCover.run(d, {}), { ok: true, covered: 0, found: {} });
  assert.equal(log.nothing, 1);
  assert.equal(log.saved.length, 0);
});

test('a video, an unknown id, no screenshot yet, no engine', async () => {
  assert.deepEqual(await screenCover.run(deps().d, { id: VIDEO.id }), { ok: false, error: 'not_a_picture' });
  assert.deepEqual(await screenCover.run(deps().d, { id: 'ffffffffffffffff' }), { ok: false, error: 'not_found' });
  assert.deepEqual(await screenCover.run(deps({ last: null }).d, {}), { ok: false, error: 'no_file' });
  assert.deepEqual(await screenCover.run(deps({ store: false }).d, {}), { ok: false, error: 'unavailable' });
  assert.deepEqual(await screenCover.run({ capture: {} }, {}), { ok: false, error: 'unavailable' });
});

test('engine errors pass through by name; anything else is "failed"', async () => {
  for (const code of ['no_ocr_language', 'busy', 'write_failed', 'unsupported']) {
    assert.deepEqual(await screenCover.run(deps({ answer: { ok: false, error: code } }).d, {}), { ok: false, error: code });
  }
  assert.deepEqual(await screenCover.run(deps({ answer: { ok: false, error: 'not_picture' } }).d, {}), { ok: false, error: 'not_a_picture' });
  assert.deepEqual(await screenCover.run(deps({ answer: { ok: false, error: 'cover_failed' } }).d, {}), { ok: false, error: 'failed' });
  assert.deepEqual(await screenCover.run(deps({ answer: null }).d, {}), { ok: true, covered: 3, found: { email: 2, number: 1 }, id: COPY.id, name: COPY.name });
});

test('the catalog entry, the runner and the AI function line up', async () => {
  const entry = CAPABILITIES.find(c => c.type === 'screenCover');
  assert.equal(entry.group, 'capture');
  assert.equal(entry.capability.risk, 'sensitive');
  assert.equal(entry.capability.requires, 'captureCover');
  assert.equal(entry.capability.sdk, undefined, 'not a widget action: a widget would start OCR over the user\'s pictures');
  assert.ok(aiFunctions({ capture: true }).some(f => f.name === 'cover_private_data'));
  assert.ok(!aiFunctions({ captureCover: false }).some(f => f.name === 'cover_private_data'));
  const { d, log } = deps();
  const run = createCapabilities({ capture: d.capture });
  const r = await run.run({ type: 'screenCover', id: OLD.id });
  assert.equal(r.ok, true);
  assert.deepEqual(log.covered, [OLD.id]);
});

test('the toast, the Deck icon and the editor speak 11 languages', () => {
  const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  const keys = ['deck_act_screenCover', 'cover_none', 'cover_done', 'cover_check', 'capg_edit',
    'cann_arrow', 'cann_box', 'cann_text', 'cann_highlight', 'cann_cover', 'cann_red', 'cann_yellow', 'cann_white',
    'cann_undo', 'cann_save', 'cann_saving', 'cann_hint', 'cann_text_ph', 'cann_find', 'cann_finding', 'cann_found',
    'cann_none', 'cann_full', 'cann_discard', 'cann_err_ocr', 'cann_err_busy', 'cann_err_save'];
  for (const k of keys) assert.equal((i18n.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 11, k);
  for (const m of i18n.matchAll(/\b(?:cover_done|cann_found): '([^']*)'/g)) assert.ok(m[1].includes('{n}'), m[0]);
  const editor = readFileSync(new URL('../js/deck-editor.js', import.meta.url), 'utf8');
  assert.match(editor, /\n\s+screenCover: _ai\(/);
});
