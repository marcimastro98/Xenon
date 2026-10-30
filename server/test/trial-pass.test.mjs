import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createTrialPass, TRUST_MS } = require('../trial-pass.js');

// The hub is the truth about a trial; these tests play the hub with an injected
// post and a movable clock. No network, no timers left behind (stop()).

const tmp = () => mkdtempSync(path.join(tmpdir(), 'xenon-trial-'));
const CODE = 'XTAAAABBBBCCCC';
const DAY = 86400000;

function setup({ answers = [] } = {}) {
  const dir = tmp();
  let clock = 1_700_000_000_000;
  const posts = [];
  const saved = [];
  const tp = createTrialPass({
    dataDir: dir,
    now: () => clock,
    scopedId: async () => 'dev',
    post: async (pathname, body) => { posts.push([pathname, body]); return answers.shift() || null; },
    saveSupporterCode: async (code) => { saved.push(code); return { ok: true }; },
  });
  return { dir, tp, posts, saved, tick: (ms) => { clock += ms; }, at: () => clock };
}
const endsIn = (t, days) => Math.floor((t.at() + days * DAY) / 1000);

test('nothing until a trial code was accepted; then active on the hub clock', async () => {
  const t = setup();
  assert.deepEqual(await t.tp.status(), { ok: true, state: 'none', used: false, endsAt: null, endDone: false, tried: [] });
  assert.equal(await t.tp.activeCode(), '');
  await t.tp.remember(CODE, endsIn(t, 7));
  t.tp.stop();
  const s = await t.tp.status();
  assert.equal(s.state, 'active');
  assert.equal(s.used, true);
  assert.equal(await t.tp.activeCode(), CODE);
  assert.doesNotMatch(JSON.stringify(s), /XTAAAA/, 'the dashboard never sees the code');
});

test('offline for more than 48 hours pauses it; moving the clock back does too', async () => {
  const t = setup();
  await t.tp.remember(CODE, endsIn(t, 7));
  t.tp.stop();
  t.tick(TRUST_MS + 1);
  assert.equal((await t.tp.status()).state, 'unverified');
  assert.equal(await t.tp.isActive(), false);
  t.tick(-TRUST_MS - 2);
  assert.equal((await t.tp.status()).state, 'unverified', 'an answer from the future is not trusted');
});

test('the hub saying it ended ends it, and so does its fixed end passing', async () => {
  const t = setup({ answers: [{ ok: true, active: false, expiresAt: 1, converted: false }] });
  await t.tp.remember(CODE, endsIn(t, 7));
  await t.tp.check();
  t.tp.stop();
  assert.equal((await t.tp.status()).state, 'ended');
  assert.deepEqual(t.posts[0], ['/trial/status', { code: CODE, scopedId: 'dev' }]);

  const u = setup();
  await u.tp.remember(CODE, endsIn(u, 7));
  u.tp.stop();
  u.tick(7 * DAY + 1);
  assert.equal((await u.tp.status()).state, 'ended');
});

test('no answer changes nothing; bad_code means the hub forgot it', async () => {
  const t = setup({ answers: [null, { ok: false, error: 'bad_code' }] });
  await t.tp.remember(CODE, endsIn(t, 7));
  await t.tp.check();
  assert.equal((await t.tp.status()).state, 'active');
  await t.tp.check();
  t.tp.stop();
  assert.equal((await t.tp.status()).state, 'ended');
});

test('becoming a supporter saves the handed-over code once and ends the trial as converted', async () => {
  const t = setup({ answers: [{ ok: true, active: true, expiresAt: 9e9, converted: true, supporterCode: 'XS-QQQQ-WWWW-EEEE' }] });
  await t.tp.remember(CODE, endsIn(t, 7));
  await t.tp.check();
  t.tp.stop();
  assert.deepEqual(t.saved, ['XS-QQQQ-WWWW-EEEE']);
  assert.equal((await t.tp.status()).state, 'converted');
  assert.equal(await t.tp.activeCode(), '');
  assert.doesNotMatch(readFileSync(path.join(t.dir, 'trial-pass.json'), 'utf8'), /XS-QQQQ/, 'the pass is stored where passes live, not here');
});

test('what was tried is kept, cleaned, and survives a restart; a bad or deleted file is a fresh "none"', async () => {
  const t = setup();
  assert.deepEqual(await t.tp.setTried([{ entryId: 'x' }]), { ok: false, error: 'no_trial' });
  await t.tp.remember(CODE, endsIn(t, 7));
  t.tp.stop();
  t.tick(7 * DAY + 1);
  await t.tp.setTried([
    { entryId: 'wall-plate', name: 'Wall Plate', kind: 'widget', widgetIds: ['casa', '../x'], tiles: ['t1', '<b>'] },
    { entryId: '../../etc', name: 'bad' },
    { entryId: 'wall-plate', name: 'dup' },
  ], { end: true });
  const again = createTrialPass({ dataDir: t.dir, now: () => t.at() });
  assert.deepEqual((await again.status()).tried, [{ entryId: 'wall-plate', name: 'Wall Plate', kind: 'widget', widgetIds: ['casa'], tiles: ['t1'] }]);

  writeFileSync(path.join(t.dir, 'trial-pass.json'), '{"code":"not-a-code"}');
  assert.equal((await createTrialPass({ dataDir: t.dir }).status()).state, 'none');
  rmSync(path.join(t.dir, 'trial-pass.json'));
  assert.equal((await createTrialPass({ dataDir: t.dir }).status()).state, 'none');
});

test('a dashboard opening asks the hub at most every 10 minutes', async () => {
  const t = setup({ answers: [{ ok: true, active: true, expiresAt: 9e9 }, { ok: true, active: true, expiresAt: 9e9 }] });
  await t.tp.remember(CODE, endsIn(t, 7));
  await t.tp.refresh();
  assert.equal(t.posts.length, 0, 'the redeem just now is the latest word');
  t.tick(11 * 60 * 1000);
  await t.tp.refresh();
  await t.tp.refresh();
  t.tp.stop();
  assert.equal(t.posts.length, 1);
});

test('the end clean-up is claimed once, by the first surface that reports it', async () => {
  const t = setup();
  await t.tp.remember(CODE, endsIn(t, 7));
  t.tp.stop();
  t.tick(7 * DAY + 1);
  const first = await t.tp.setTried([{ entryId: 'wall-plate', name: 'Wall Plate' }], { end: true });
  const second = await t.tp.setTried([{ entryId: 'other', name: 'Other' }], { end: true });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(second.endDone, false, 'the claimer is still working: nobody else tidies yet');
  assert.deepEqual(second.tried.map((x) => x.entryId), ['wall-plate'], 'the loser does not overwrite the list');
  t.tick(11 * 60 * 1000);
  assert.equal((await t.tp.status()).endDone, true);
});

test('a running trial cannot be marked as cleaned up (a paired phone posting end: true)', async () => {
  const t = setup();
  await t.tp.remember(CODE, endsIn(t, 7));
  t.tp.stop();
  assert.deepEqual(await t.tp.setTried([{ entryId: 'planted', name: 'Planted' }], { end: true }), { ok: false, error: 'not_ended' });
  assert.deepEqual(await t.tp.setTried([{ entryId: 'planted' }]), { ok: false, error: 'not_ended' });
  const s = await t.tp.status();
  assert.equal(s.endDone, false);
  assert.deepEqual(s.tried, []);
});

test('a handed-over supporter code that fails to save is kept and saved on the next look', async () => {
  const dir = tmp();
  let clock = 1_700_000_000_000;
  let fail = true;
  const saved = [];
  const answers = [{ ok: true, active: true, expiresAt: 9e9, converted: true, supporterCode: 'XS-QQQQ-WWWW-EEEE' }];
  const tp = createTrialPass({
    dataDir: dir, now: () => clock, scopedId: async () => 'dev',
    post: async () => answers.shift() || null,
    saveSupporterCode: async (code) => { if (fail) return { ok: false, error: 'network' }; saved.push(code); return { ok: true }; },
  });
  await tp.remember(CODE, Math.floor((clock + 7 * DAY) / 1000));
  await tp.check();
  tp.stop();
  assert.equal((await tp.status()).state, 'converted');
  assert.doesNotMatch(JSON.stringify(await tp.status()), /QQQQ/, 'the dashboard never sees it');
  fail = false;
  await tp.refresh();
  assert.deepEqual(saved, ['XSQQQQWWWWEEEE']);
  assert.doesNotMatch(readFileSync(path.join(dir, 'trial-pass.json'), 'utf8'), /QQQQ/, 'gone from the trial file once saved');
});

test('a file edited to say "converted" is corrected by the hub', async () => {
  const t = setup({ answers: [{ ok: true, active: false, expiresAt: 1, converted: false }] });
  await t.tp.remember(CODE, endsIn(t, 7));
  t.tp.stop();
  const file = path.join(t.dir, 'trial-pass.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), converted: true }));
  const again = createTrialPass({ dataDir: t.dir, now: () => t.at(), scopedId: async () => 'dev', post: async () => ({ ok: true, active: false, expiresAt: 1, converted: false }) });
  assert.equal((await again.status()).state, 'converted');
  await again.start();
  again.stop();
  assert.equal((await again.status()).state, 'ended');
});

test('every look at the hub tells the listener (the widget vault follows the trial)', async () => {
  const dir = tmp();
  let told = 0;
  const tp = createTrialPass({
    dataDir: dir, scopedId: async () => 'dev',
    post: async () => ({ ok: true, active: false, converted: false }),
    onCheck: () => { told++; throw new Error('a listener never fails the check'); },
  });
  await tp.remember(CODE, Math.floor(Date.now() / 1000) + 7 * 86400);
  const s = await tp.check();
  tp.stop();
  assert.equal(told, 1);
  assert.equal(s.state, 'ended');
});
