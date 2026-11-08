// Votes on Store entries (server/rating-votes.js, ai-rate-store.js, pc-id.js): tickets
// only with the stats switch on, real use before Bit asks, one ask a week, and a vote
// that is spent once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createRatingVotes, ownedEntries, inUse, WAIT_MS, SEEN_MS, ASK_EVERY_MS,
} = require('../rating-votes.js');
const { createPcId, parseMachineGuid } = require('../pc-id.js');
const aiRateStore = require('../ai-rate-store.js');
const { parsePlatformUuid } = require('../darwin-collectors.js');

const NOON = new Date(2026, 10, 6, 12).getTime();
const TICK = 10 * 60 * 1000;
const receipt = (id, more = {}) => ({ id: `tx-${id}`, name: `Name ${id}`, source: 'catalog', sourceId: id, installedAt: NOON, ...more });

function rig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rating-votes-'));
  const clock = { now: NOON };
  const hubCalls = [];
  const asks = [];
  const voted = [];
  const world = {
    settings: { catalogStats: true, contentInstalls: [receipt('neon')] },
    answer: (pathname) => (pathname === '/ratings/ticket'
      ? { ok: true, ticket: 'signed-ticket', at: Math.floor(clock.now / 1000) }
      : { ok: true }),
  };
  const make = () => createRatingVotes({
    file: path.join(dir, 'rating-votes.json'),
    pcId: async () => 'pc-hash',
    scopedId: async () => 'scoped-hash',
    hub: async (pathname, body) => { hubCalls.push({ pathname, body }); return world.answer(pathname, body); },
    fileAsk: async (msg) => { asks.push(msg); },
    settings: () => world.settings,
    onVoted: (id) => voted.push(id),
    now: () => clock.now,
    log: { warn() {} },
    ...overrides,
  });
  return { votes: make(), make, clock, hubCalls, asks, voted, world };
}

// A ticket in hand and enough hours on screen for Bit to ask.
async function ripe(r) {
  await r.votes.tick();
  r.clock.now += WAIT_MS;
  for (let seen = 0; seen <= SEEN_MS + TICK; seen += TICK) {
    r.clock.now += TICK;
    await r.votes.tick();
  }
}

test('a catalog receipt is owning it; a trial or an import is not', () => {
  const owned = ownedEntries({ contentInstalls: [
    receipt('neon'), receipt('tried', { trial: true }), receipt('file', { source: 'import' }), receipt('../bad'),
  ] });
  assert.deepEqual([...owned.keys()], ['neon']);
});

test('a widget counts while placed, anything else while installed', () => {
  const widget = { resources: { widgetIds: ['sdk-clock'] } };
  assert.equal(inUse(widget, '["sdk-clock"]'), true);
  assert.equal(inUse(widget, '["sdk-other"]'), false);
  assert.equal(inUse({ resources: {} }, '[]'), true);
});

test('no ticket is asked for with the stats switch off', async () => {
  const r = rig();
  r.world.settings.catalogStats = false;
  await r.votes.tick();
  assert.equal(r.hubCalls.length, 0);
  assert.equal((await r.votes.stateOf('neon')).state, 'off');
  assert.equal(await r.votes.ratingId(), '');
});

test('the ticket request carries hashes only, and the entry opens after three days', async () => {
  const r = rig();
  await r.votes.tick();
  assert.deepEqual(r.hubCalls[0], { pathname: '/ratings/ticket', body: { entryId: 'neon', ratingId: 'pc-hash', scopedId: 'scoped-hash' } });
  const waiting = await r.votes.stateOf('neon');
  assert.equal(waiting.state, 'wait');
  assert.equal(waiting.ripeAt, Math.floor(NOON / 1000) * 1000 + WAIT_MS);
  r.clock.now += WAIT_MS;
  assert.equal((await r.votes.stateOf('neon')).state, 'open');
});

test('what is not installed cannot be voted, a past vote still shows', async () => {
  const r = rig();
  assert.equal((await r.votes.stateOf('other')).state, 'none');
  assert.deepEqual(await r.votes.stateOf('BAD ID'), { ok: false, error: 'bad_request' });
  assert.equal((await r.votes.vote({ entryId: 'other', stars: 5 })).error, 'no_ticket');
  await r.votes.tick();
  r.clock.now += WAIT_MS;
  await r.votes.vote({ entryId: 'neon', stars: 4 });
  r.world.settings.contentInstalls = [];
  assert.deepEqual(await r.votes.stateOf('neon'), { ok: true, state: 'voted', stars: 4 });
});

test('a vote spends the ticket: no second one, not even from a fresh start', async () => {
  const r = rig();
  await r.votes.tick();
  r.clock.now += WAIT_MS;
  assert.deepEqual(await r.votes.vote({ entryId: 'neon', stars: 2, why: 'slow' }), { ok: true });
  const sent = r.hubCalls.at(-1);
  assert.deepEqual(sent, { pathname: '/ratings', body: { entryId: 'neon', ticket: 'signed-ticket', stars: 2, why: 'slow' } });
  assert.deepEqual(r.voted, ['neon']);
  assert.equal((await r.votes.vote({ entryId: 'neon', stars: 5 })).error, 'already_voted');
  await r.votes.flush();
  const again = r.make();
  assert.deepEqual(await again.stateOf('neon'), { ok: true, state: 'voted', stars: 2 });
  assert.equal((await again.vote({ entryId: 'neon', stars: 5 })).error, 'already_voted');
});

test('stars outside 1 to 5 never reach the hub, a reason rides only on a low vote', async () => {
  const r = rig();
  await r.votes.tick();
  r.clock.now += WAIT_MS;
  for (const stars of [0, 6, 3.5, 'x']) assert.equal((await r.votes.vote({ entryId: 'neon', stars })).error, 'bad_request');
  assert.equal(r.hubCalls.filter((c) => c.pathname === '/ratings').length, 0);
  await r.votes.vote({ entryId: 'neon', stars: 4, why: 'slow' });
  assert.equal(r.hubCalls.at(-1).body.why, undefined);
});

test('a junk reason is dropped', async () => {
  const r = rig();
  await r.votes.tick();
  r.clock.now += WAIT_MS;
  await r.votes.vote({ entryId: 'neon', stars: 1, why: 'free text from anyone' });
  assert.equal(r.hubCalls.at(-1).body.why, undefined);
});

test('two taps at once send one vote', async () => {
  const r = rig();
  await r.votes.tick();
  r.clock.now += WAIT_MS;
  const [a, b] = await Promise.all([
    r.votes.vote({ entryId: 'neon', stars: 5 }),
    r.votes.vote({ entryId: 'neon', stars: 5 }),
  ]);
  assert.deepEqual([a.ok, b.error], [true, 'rate_limited']);
  assert.equal(r.hubCalls.filter((c) => c.pathname === '/ratings').length, 1);
});

test('the hub has the last word on a vote', async () => {
  const r = rig();
  await r.votes.tick();
  r.clock.now += WAIT_MS;
  r.world.answer = () => ({ ok: false, error: 'too_soon', ripeAt: 99 });
  assert.deepEqual(await r.votes.vote({ entryId: 'neon', stars: 5 }), { ok: false, error: 'too_soon', ripeAt: 99000 });
  r.world.answer = () => ({ ok: false, error: 'something_else' });
  assert.equal((await r.votes.vote({ entryId: 'neon', stars: 5 })).error, 'network');
  assert.equal((await r.votes.stateOf('neon')).state, 'open', 'a failed send keeps the ticket');
  r.world.answer = () => ({ ok: false, error: 'bad_ticket' });
  assert.equal((await r.votes.vote({ entryId: 'neon', stars: 5 })).error, 'bad_ticket');
  assert.equal((await r.votes.stateOf('neon')).state, 'used');
});

test('reinstalling gives no new ticket: the hub says the PC had one', async () => {
  const r = rig();
  r.world.answer = () => ({ ok: false, error: 'already_issued' });
  await r.votes.tick();
  assert.equal((await r.votes.stateOf('neon')).state, 'used');
  r.world.answer = () => ({ ok: true, voted: 3 });
  r.world.settings.contentInstalls = [receipt('neon'), receipt('old')];
  await r.votes.tick();
  assert.deepEqual(await r.votes.stateOf('old'), { ok: true, state: 'voted', stars: 3 });
});

test('a paid entry needs its unlock: one try with the saved pass, then it says so', async () => {
  const tried = [];
  const r = rig({ redeemSaved: async (id) => { tried.push(id); } });
  r.world.answer = () => ({ ok: false, error: 'needs_unlock' });
  await r.votes.tick();
  assert.equal((await r.votes.stateOf('neon')).state, 'wait');
  await r.votes.tick();
  await r.votes.tick();
  assert.deepEqual(tried, ['neon']);
  assert.equal((await r.votes.stateOf('neon')).state, 'locked');
  assert.equal(await r.votes.addTicket('neon', 'from-unlock', Math.floor(NOON / 1000)), true);
  r.clock.now += WAIT_MS;
  assert.equal((await r.votes.stateOf('neon')).state, 'open');
});

test('Bit asks only after three days and real hours on screen', async () => {
  const r = rig();
  await r.votes.tick();
  r.clock.now += WAIT_MS;
  await r.votes.tick();
  assert.equal(r.asks.length, 0, 'three days alone is not use');
  await ripe(r);
  assert.equal(r.asks.length, 1);
  const msg = r.asks[0];
  assert.equal(msg.kind, 'rate');
  assert.equal(msg.entryId, 'neon');
  assert.equal(msg.title, 'Name neon');
  assert.equal(msg.since, NOON);
  assert.equal(msg.id, 'rate:neon:1');
});

test('a widget not on any screen does not gather hours', async () => {
  const r = rig();
  r.world.settings.contentInstalls = [receipt('neon', { resources: { widgetIds: ['sdk-neon'] } })];
  await ripe(r);
  assert.equal(r.asks.length, 0);
  r.world.settings.dashboardLayout = { tiles: ['sdk-neon'] };
  await ripe(r);
  assert.equal(r.asks.length, 1);
});

test('nothing is counted with no screen watching', async () => {
  const r = rig({ watching: () => false });
  await ripe(r);
  assert.equal(r.hubCalls.length, 0);
  assert.equal(r.asks.length, 0);
});

test('one ask a week over everything, the oldest first', async () => {
  const r = rig();
  r.world.settings.contentInstalls = [receipt('neon'), receipt('ember')];
  await ripe(r);
  assert.equal(r.asks.length, 1);
  r.clock.now = r.asks[0].at + ASK_EVERY_MS - TICK;
  await r.votes.tick();
  assert.equal(r.asks.length, 1, 'not inside the week');
  r.clock.now += 2 * TICK;
  await r.votes.tick();
  assert.equal(r.asks.length, 2);
});

test('closing a card ends it for that entry, the Store can still vote', async () => {
  const r = rig();
  await ripe(r);
  await r.votes.close('neon');
  r.clock.now += ASK_EVERY_MS + TICK;
  await r.votes.tick();
  assert.equal(r.asks.length, 1);
  assert.equal((await r.votes.stateOf('neon')).state, 'open');
  assert.deepEqual(await r.votes.vote({ entryId: 'neon', stars: 5 }), { ok: true });
});

test('a card nobody touched comes back once, then never', async () => {
  const r = rig();
  await ripe(r);
  for (let week = 0; week < 3; week++) {
    r.clock.now += ASK_EVERY_MS + TICK;
    await r.votes.tick();
  }
  assert.deepEqual(r.asks.map((m) => m.id), ['rate:neon:1', 'rate:neon:2']);
});

test('the switch in Settings stops the asks and leaves the vote', async () => {
  const r = rig();
  r.world.settings.ratingAsks = false;
  await ripe(r);
  assert.equal(r.asks.length, 0);
  assert.equal((await r.votes.stateOf('neon')).state, 'open');
});

test('a broken store starts empty and keeps working', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rating-votes-'));
  const file = path.join(dir, 'rating-votes.json');
  fs.writeFileSync(file, '{ not json');
  const bad = rig({ file });
  assert.equal((await bad.votes.stateOf('neon')).state, 'wait');
});

test('stored junk is dropped field by field', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rating-votes-'));
  const file = path.join(dir, 'rating-votes.json');
  fs.writeFileSync(file, JSON.stringify({ lastAskAt: 'x', entries: {
    neon: { at: NOON, ticket: 'a'.repeat(500), stars: 9, votedAt: -1, closed: 'yes' },
    '../evil': { at: 1 },
  } }));
  const r = rig({ file });
  assert.equal((await r.votes.stateOf('../evil')).ok, false);
  assert.equal((await r.votes.stateOf('neon')).state, 'wait', 'an oversized ticket is no ticket');
});

test('the machine id is hashed with its own scope and survives a new install id', async () => {
  const a = createPcId({ collectors: { machineId: async () => 'machine-1' }, fallback: async () => 'install-a' });
  const b = createPcId({ collectors: { machineId: async () => 'machine-1' }, fallback: async () => 'install-b' });
  const other = createPcId({ collectors: { machineId: async () => 'machine-2' }, fallback: async () => 'install-a' });
  const id = await a();
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(id, await b());
  assert.notEqual(id, await other());
  assert.ok(!id.includes('machine-1'));
});

test('a machine with no readable id falls back to the install id', async () => {
  const empty = createPcId({ collectors: { machineId: async () => '' }, fallback: async () => 'install-a' });
  const broken = createPcId({ collectors: { machineId: async () => { throw new Error('no'); } }, fallback: async () => 'install-a' });
  assert.equal(await empty(), await broken());
});

test('machine ids are read off the real output shapes', () => {
  const reg = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    8F3A1B2C-0000-4111-A222-123456789ABC\r\n\r\n';
  assert.equal(parseMachineGuid(reg), '8f3a1b2c-0000-4111-a222-123456789abc');
  assert.equal(parseMachineGuid('ERROR: not found'), '');
  assert.equal(parseMachineGuid(null), '');
  const ioreg = '  | {\n    "IOPlatformUUID" = "ABCDEF12-3456-7890-ABCD-EF1234567890"\n  }\n';
  assert.match(parsePlatformUuid(ioreg), /^abcdef12-3456-7890-abcd-ef1234567890$/i);
  assert.equal(parsePlatformUuid('nothing'), '');
});

function bit(state = { state: 'open' }) {
  const settings = { contentInstalls: [receipt('neon', { name: 'Neon Clock' }), receipt('neon-2', { name: 'Neon Sky' }), receipt('ember', { name: 'Ember' })] };
  return { settings: () => settings, stateOf: async () => state };
}

test('Bit finds the entry by the name said, and asks when two match', async () => {
  const hit = await aiRateStore.plan({ name: 'ember', stars: 4 }, bit());
  assert.deepEqual(hit.action, { type: 'storeRate', entryId: 'ember', name: 'Ember', stars: 4, why: '' });
  const two = await aiRateStore.plan({ name: 'neon', stars: 4 }, bit());
  assert.deepEqual([two.error, two.choices], ['ambiguous', ['Neon Clock', 'Neon Sky']]);
  const none = await aiRateStore.plan({ name: 'nothing', stars: 4 }, bit());
  assert.equal(none.error, 'not_found');
  assert.equal(none.choices.length, 3);
});

test('Bit passes on why a vote cannot happen', async () => {
  const say = async (state) => (await aiRateStore.plan({ name: 'ember', stars: 4 }, bit(state))).error;
  assert.equal(await say({ state: 'wait', ripeAt: 5 }), 'too_soon');
  assert.equal(await say({ state: 'voted', stars: 2 }), 'already_voted');
  assert.equal(await say({ state: 'used' }), 'already_voted');
  assert.equal(await say({ state: 'off' }), 'count_off');
  assert.equal(await say({ state: 'locked' }), 'locked');
  assert.equal(await say({ state: 'none' }), 'not_installed');
  assert.equal((await aiRateStore.plan({ name: 'ember', stars: 9 }, bit())).error, 'bad_stars');
  assert.equal((await aiRateStore.plan({ name: 'ember', stars: 3.5 }, bit())).error, 'bad_stars');
});

test('a reason goes only with a low vote and only from the list', async () => {
  assert.equal((await aiRateStore.plan({ name: 'ember', stars: 2, why: 'slow' }, bit())).action.why, 'slow');
  assert.equal((await aiRateStore.plan({ name: 'ember', stars: 5, why: 'slow' }, bit())).action.why, '');
  assert.equal((await aiRateStore.plan({ name: 'ember', stars: 2, why: 'anything' }, bit())).action.why, '');
});

test('no Deck key, widget or macro can vote', () => {
  const { validateAction } = require('../js/deck-actions.js');
  const { SDK_ACTION_TYPES } = require('../sdk-widgets.js');
  assert.equal(validateAction({ type: aiRateStore.TYPE, entryId: 'neon', stars: 5 }), null);
  assert.ok(!SDK_ACTION_TYPES.includes(aiRateStore.TYPE));
});
