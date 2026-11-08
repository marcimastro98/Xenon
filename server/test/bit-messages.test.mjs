import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBitMessages, cleanMessage, MAX_MESSAGES } = require('../bit-messages.js');
const { normalizeMessage } = require('../community-messages.js');

const DAY = 24 * 3600 * 1000;
const NOON = new Date(2026, 10, 5, 12).getTime();

function box(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bit-messages-'));
  const clock = { now: NOON };
  const changes = [];
  const file = path.join(dir, 'bit-messages.json');
  const make = () => createBitMessages({
    file, now: () => clock.now, onChange: () => changes.push(1), log: { warn() {} }, ...overrides,
  });
  return { inbox: make(), make, clock, changes, file };
}

const hub = (id, more = {}) => ({ id: `hub:${id}`, kind: 'hub', title: `Title ${id}`, line: 'A line', ...more });

test('a message is rebuilt field by field', () => {
  const msg = cleanMessage({
    ...hub('a'),
    title: 'Hello\nthere',
    extra: 'dropped',
    media: { type: 'image', url: 'https://evil.example/a.webp' },
    action: { type: 'url', label: 'Go', url: 'https://evil.example/' },
    shownAt: 5,
  }, NOON);
  assert.equal(msg.title, 'Hello there');
  assert.equal(msg.media, undefined);
  assert.equal(msg.action, undefined);
  assert.equal(msg.extra, undefined);
  assert.equal(msg.shownAt, 0);
});

test('what cannot be shown is refused', () => {
  assert.equal(cleanMessage(hub('a', { title: '' }), NOON), null);
  assert.equal(cleanMessage(hub('a', { kind: 'other' }), NOON), null);
  assert.equal(cleanMessage(hub('a', { id: '../x' }), NOON), null);
  assert.equal(cleanMessage([], NOON), null);
});

test('pictures and links keep the rules of the feed', () => {
  const msg = cleanMessage({
    ...hub('a'),
    entryId: 'night-drive',
    media: { type: 'image', url: 'https://assets.xenon-app.com/community/shots/night-drive.webp' },
    action: { type: 'store', label: 'Open' },
  }, NOON);
  assert.equal(msg.media.url, 'https://assets.xenon-app.com/community/shots/night-drive.webp');
  assert.deepEqual(msg.action, { type: 'store', label: 'Open' });
  assert.equal(cleanMessage({ ...hub('b'), action: { type: 'store', label: 'Open' } }, NOON).action, undefined);
  assert.equal(cleanMessage({ ...hub('c'), action: { type: 'run', label: 'Go' } }, NOON).action, undefined);
  assert.deepEqual(cleanMessage({ ...hub('d'), action: { type: 'sparks', label: 'Buy' } }, NOON).action, { type: 'sparks', label: 'Buy' });
});

test('a poll stays in the corner', () => {
  const poll = { options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] };
  assert.equal(cleanMessage(hub('a', { where: 'stage', poll }), NOON).where, 'corner');
  assert.equal(cleanMessage(hub('a', { where: 'stage' }), NOON).where, 'stage');
});

test('one new message a day, and an unread one keeps showing', async () => {
  const { inbox, clock } = box();
  await inbox.post({ messages: [hub('a'), hub('b')] });
  assert.equal((await inbox.view()).next.id, 'hub:a');
  await inbox.shown('hub:a');
  assert.equal((await inbox.view()).next.id, 'hub:a');
  await inbox.read('hub:a');
  assert.equal((await inbox.view()).next, null);
  clock.now += DAY;
  assert.equal((await inbox.view()).next.id, 'hub:b');
});

test('waiting for the day does not stop a card already shown on another day', async () => {
  const { inbox, clock } = box();
  await inbox.post({ messages: [hub('a'), hub('b')] });
  await inbox.shown('hub:a');
  clock.now += DAY;
  assert.equal((await inbox.view()).next.id, 'hub:a');
});

test('the first day belongs to the person: news and drops start the day after', async () => {
  const d = new Date(NOON);
  const firstRunDay = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  const { inbox, clock } = box({ settings: () => ({ firstRunDay }) });
  await inbox.post({ messages: [hub('a'), { id: 'drop:b', kind: 'drop', title: 'B', line: 'A drop' }] });
  assert.equal((await inbox.view('dashboard')).next, null);
  assert.equal((await inbox.view('screen')).next, null);
  clock.now = NOON + DAY;
  assert.equal((await inbox.view('dashboard')).next.id, 'hub:a');
});

test('what the person did themselves is not held back on the first day', async () => {
  const d = new Date(NOON);
  const firstRunDay = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  const { inbox } = box({ settings: () => ({ firstRunDay }) });
  await inbox.post({ messages: [{ id: 'sparks:low', kind: 'sparks', title: 'Few Sparks left', line: 'A line' }] });
  assert.equal((await inbox.view('dashboard')).next.id, 'sparks:low');
});

test('an install with no first day on record is not held back', async () => {
  const { inbox } = box({ settings: () => ({}) });
  await inbox.post({ messages: [hub('a')] });
  assert.equal((await inbox.view('dashboard')).next.id, 'hub:a');
});

// Seen 7 Nov 2026: folded, it sat on the close key of the full-screen Settings.
test('a folded card waits under every window, and an open one stays on top', () => {
  const css = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const layer = (text, selector) => Number(new RegExp(selector + ' \\{[^}]*z-index: (\\d+)').exec(text)[1]);
  const cards = css('components/BitMessage/BitMessage.css');
  assert.ok(layer(cards, '\\.bm-card\\.is-face') < layer(css('components/TabSwitcher/TabSwitcher.css'), '\\.[a-z-]+'), 'under the lowest window');
  assert.ok(layer(cards, '\\.bm-card') > 5000);
});

test('the hub goes first, then the oldest', async () => {
  const { inbox, clock } = box();
  await inbox.post({ messages: [{ id: 'share:setup', kind: 'share', title: 'Share' }] });
  clock.now += 1000;
  await inbox.post({ messages: [{ id: 'drop:x', kind: 'drop', title: 'Drop', entryId: 'x' }] });
  clock.now += 1000;
  await inbox.post({ messages: [hub('b')] });
  assert.equal((await inbox.view()).next.id, 'hub:b');
});

test('a message arrives once', async () => {
  const { inbox, changes } = box();
  assert.equal(await inbox.post({ messages: [hub('a')] }), true);
  assert.equal(await inbox.post({ messages: [hub('a')] }), false);
  assert.equal(changes.length, 1);
});

test('the words written for a drop replace the ones from the catalog, once', async () => {
  const { inbox } = box();
  await inbox.post({ messages: [{ id: 'drop:x', kind: 'drop', title: 'Catalog', entryId: 'x' }] });
  await inbox.post({ messages: [hub('x-news', { entryId: 'x' })] });
  assert.equal((await inbox.view()).next.id, 'hub:x-news');
  await inbox.post({ messages: [{ id: 'drop:x', kind: 'drop', title: 'Catalog', entryId: 'x' }] });
  assert.equal((await inbox.view()).next.id, 'hub:x-news');
});

test('a drop already told is not told again by the hub', async () => {
  const { inbox } = box();
  await inbox.post({ messages: [{ id: 'drop:x', kind: 'drop', title: 'Catalog', entryId: 'x' }] });
  await inbox.shown('drop:x');
  await inbox.post({ messages: [hub('x-news', { entryId: 'x' })] });
  assert.equal((await inbox.view()).next.id, 'drop:x');
});

test('what the hub withdraws goes away unless it was read', async () => {
  const { inbox } = box();
  await inbox.post({ messages: [hub('a'), hub('b')] });
  await inbox.read('hub:a');
  await inbox.post({ live: { hub: [] } });
  const view = await inbox.view();
  assert.equal(view.next, null);
  assert.deepEqual(view.messages.map((m) => m.id), ['hub:a']);
});

test('a switch that is off holds its messages back', async () => {
  const settings = { hubMessages: false, monthlyDrops: false };
  const { inbox } = box({ settings: () => settings });
  await inbox.post({ messages: [hub('a'), { id: 'drop:x', kind: 'drop', title: 'Drop', entryId: 'x' }] });
  assert.equal((await inbox.view()).next, null);
  settings.monthlyDrops = true;
  assert.equal((await inbox.view()).next.id, 'drop:x');
});

test('an expired message is not shown', async () => {
  const { inbox, clock } = box();
  await inbox.post({ messages: [hub('a', { expires: NOON + 1000 })] });
  clock.now += 2000;
  assert.equal((await inbox.view()).next, null);
});

test('a message for the dashboard does not reach the screen window', async () => {
  const { inbox } = box();
  await inbox.post({ messages: [{ id: 'share:setup', kind: 'share', title: 'Share', surface: 'dashboard' }] });
  assert.equal((await inbox.view('screen')).next, null);
  assert.equal((await inbox.view('dashboard')).next.id, 'share:setup');
});

test('an answer must be one of the options', async () => {
  const { inbox } = box();
  const poll = { options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] };
  await inbox.post({ messages: [hub('a', { poll }), hub('b', { poll })] });
  await inbox.read('hub:a', 'yes');
  await inbox.read('hub:b', 'maybe');
  const { messages } = await inbox.view();
  assert.equal(messages.find((m) => m.id === 'hub:a').answer, 'yes');
  assert.equal(messages.find((m) => m.id === 'hub:b').answer, undefined);
});

test('read and shown survive a restart', async () => {
  const { inbox, make } = box();
  await inbox.post({ messages: [hub('a'), hub('b')] });
  await inbox.shown('hub:a');
  await inbox.read('hub:a');
  const after = await make().view();
  assert.equal(after.next, null);
  assert.deepEqual(after.messages.map((m) => m.id), ['hub:a']);
});

test('a broken file starts empty and does not throw', async () => {
  const { make, file } = box();
  fs.writeFileSync(file, '{not json');
  assert.deepEqual((await make().view()).messages, []);
});

test('a stored message is checked again when read back', async () => {
  const { make, file } = box();
  fs.writeFileSync(file, JSON.stringify({
    messages: [hub('a', { readAt: 1, media: { type: 'image', url: 'https://evil.example/a.webp' } }), { id: 'x' }],
  }));
  const { messages } = await make().view();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].media, undefined);
});

test('the old letters land as already read and nothing comes back', async () => {
  const { inbox } = box();
  await inbox.importLetters({
    letters: [hub('old', { at: NOON - 2 * DAY })],
    gone: ['hub:thrown'],
    seen: ['announced'],
  });
  const view = await inbox.view();
  assert.equal(view.next, null);
  assert.equal(view.messages[0].at, NOON - 2 * DAY);
  await inbox.post({ messages: [hub('old'), hub('thrown'), hub('announced')] });
  assert.equal((await inbox.view()).next, null);
});

test('old messages leave, and do not come back', async () => {
  const { inbox, clock } = box();
  await inbox.post({ messages: [hub('old')] });
  await inbox.read('hub:old');
  clock.now += 91 * DAY;
  await inbox.post({ messages: [hub('new')] });
  await inbox.post({ messages: [hub('old')] });
  const view = await inbox.view();
  assert.deepEqual(view.messages.map((m) => m.id), []);
  assert.equal(view.next.id, 'hub:new');
});

test('the inbox has a size', async () => {
  const { inbox } = box();
  const many = Array.from({ length: MAX_MESSAGES + 10 }, (_, i) => hub(`m${i}`));
  await inbox.post({ messages: many });
  for (const m of many) await inbox.read(m.id);
  assert.equal((await inbox.view()).messages.length, MAX_MESSAGES);
});

test('the feed says where a message appears', () => {
  assert.equal(normalizeMessage({ id: 'a', level: 'modal', title: 'T' }).where, 'corner');
  const stage = normalizeMessage({ id: 'a', where: 'stage', title: 'T' });
  assert.equal(stage.where, 'stage');
  assert.equal(stage.level, 'modal');
  assert.equal(normalizeMessage({ id: 'a', where: 'corner', title: 'T' }).level, 'toast');
  assert.equal(normalizeMessage({ id: 'a', where: 'wall', title: 'T' }).where, 'corner');
});

test('a vote asked for keeps its entry and date, and never counts as told', () => {
  const msg = cleanMessage({ id: 'rate:neon:1', kind: 'rate', title: 'Neon', entryId: 'neon', since: NOON - 5 * DAY }, NOON);
  assert.equal(msg.kind, 'rate');
  assert.equal(msg.entryId, 'neon');
  assert.equal(msg.since, NOON - 5 * DAY);
  assert.equal(cleanMessage(hub('a', { since: NOON }), NOON).since, undefined);
});
