// A new install sees neither the What's New sheet nor the release notes of the version it was
// installed with, on the dashboard and in widgets only alike; the notes start with the next update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { noticesReadAtBirth } = require('../updates/notices-at-birth.js');
const Notice = require('../js/updates/release-notice.js');

const WN = {
  id: 'v5-xenon', highlights: [{ title: 'One place' }], version: '5.2.0',
  releases: [{ version: '5.2.0', news: [{ title: 'Screens' }], fixes: [] }, { version: '5.1.1', news: [], fixes: [{ area: 'a', text: 'b' }] }],
};

test('a new install has read the sheet and the notes of its own version', async () => {
  const seen = await noticesReadAtBirth(async () => WN, '5.2.0');
  assert.deepEqual(seen, { whatsNewSeen: 'v5-xenon', releaseNotesSeen: '5.2.0' });
  assert.deepEqual(Notice.pick({ wn: WN, whatsNewSeen: seen.whatsNewSeen, notesSeen: seen.releaseNotesSeen }), { major: false, notes: null });
});

test('the next update brings its notes, and only its own', async () => {
  const seen = await noticesReadAtBirth(async () => WN, '5.2.0');
  const next = { ...WN, version: '5.2.1', releases: [{ version: '5.2.1', news: [], fixes: [{ area: 'x', text: 'fixed' }] }, ...WN.releases] };
  const { major, notes } = Notice.pick({ wn: next, whatsNewSeen: seen.whatsNewSeen, notesSeen: seen.releaseNotesSeen });
  assert.equal(major, false);
  assert.equal(notes.version, '5.2.1');
  assert.deepEqual(notes.fixes, [{ area: 'x', text: 'fixed' }]);
});

test('no What\'s New file: only the notes are marked, and a failed read marks nothing wrong', async () => {
  assert.deepEqual(await noticesReadAtBirth(async () => ({ id: '', highlights: [] }), '5.2.0'), { releaseNotesSeen: '5.2.0' });
  assert.deepEqual(await noticesReadAtBirth(async () => { throw new Error('gone'); }, ''), {});
});
