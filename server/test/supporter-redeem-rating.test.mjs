// supporter-redeem.js: the rating ticket that rides on an unlock. With the votes store handed
// in, a redeem carries this install's rating id and keeps the ticket the hub answers with;
// without it nothing is added, and a votes store that fails never costs the unlock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const redeemMod = require('../supporter-redeem.js');

const GOOD = { entryId: 'july-drop', code: 'XS-ABCD-EFGH-JKLM' };
const RATING_ID = 'a'.repeat(64);
const tmp = () => mkdtempSync(path.join(tmpdir(), 'xenon-redeem-rating-'));

function withVotes(votes, run) {
  return async () => {
    redeemMod.useRatingVotes(votes);
    try { await run(); }
    finally { redeemMod.useRatingVotes(null); redeemMod._setTransport(null); redeemMod._resetInstallIdCache(); }
  };
}

const kept = [];
const votes = {
  ratingId: async () => RATING_ID,
  addTicket: async (...args) => { kept.push(args); },
};

test('an unlock carries the rating id and keeps the ticket the hub answers with', withVotes(votes, async () => {
  kept.length = 0;
  let seen = null;
  redeemMod._setTransport(async (url, body) => {
    seen = body;
    return { ok: true, cek: 'Q0VLLWJhc2U2NA==', ratingTicket: 'ticket-1', ratingTicketAt: 1700000000000 };
  });
  const out = await redeemMod.redeem({ ...GOOD, dataDir: tmp() });
  assert.equal(out.ok, true);
  assert.equal(seen.ratingId, RATING_ID);
  assert.deepEqual(kept, [[GOOD.entryId, 'ticket-1', 1700000000000]]);
}));

test('an answer without a ticket, or a refused unlock, keeps nothing', withVotes(votes, async () => {
  kept.length = 0;
  redeemMod._setTransport(async () => ({ ok: true, cek: 'Q0VLLWJhc2U2NA==', ratingTicket: 7 }));
  assert.equal((await redeemMod.redeem({ ...GOOD, dataDir: tmp() })).ok, true);
  redeemMod._setTransport(async () => ({ ok: false, error: 'wrong_code', ratingTicket: 'ticket-2' }));
  assert.equal((await redeemMod.redeem({ ...GOOD, dataDir: tmp() })).ok, false);
  assert.deepEqual(kept, []);
}));

const failing = {
  ratingId: async () => { throw new Error('no id'); },
  addTicket: async () => { throw new Error('disk full'); },
};

test('a votes store that fails never costs the unlock', withVotes(failing, async () => {
  let seen = null;
  redeemMod._setTransport(async (url, body) => { seen = body; return { ok: true, cek: 'Q0VLLWJhc2U2NA==', ratingTicket: 'ticket-3' }; });
  const out = await redeemMod.redeem({ ...GOOD, dataDir: tmp() });
  assert.equal(out.ok, true);
  assert.equal(out.cek, 'Q0VLLWJhc2U2NA==');
  assert.equal('ratingId' in seen, false, 'no id to send: the request goes without one');
}));

test('without a votes store the request is the one that was built, and no ticket is looked for', withVotes(null, async () => {
  const payload = { entryId: GOOD.entryId };
  assert.equal(await redeemMod.withRatingId(payload), payload);
  await redeemMod.keepRatingTicket(GOOD.entryId, { ratingTicket: 'ticket-4' });
  let seen = null;
  redeemMod._setTransport(async (url, body) => { seen = body; return { ok: true, cek: 'Q0VLLWJhc2U2NA==', ratingTicket: 'ticket-4' }; });
  assert.equal((await redeemMod.redeem({ ...GOOD, dataDir: tmp() })).ok, true);
  assert.equal('ratingId' in seen, false);
}));
