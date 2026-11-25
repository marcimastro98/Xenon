'use strict';
// The person's own Bit: one store, one hatch and the minute that teaches it
// (traits.js), shared by the routes and the actions Bit, the Deck and a phone
// run (actions.js). The minute runs only once a Bit is out of its egg, reads only what
// the engine already keeps (facts.js) and is stopped at shutdown.

const path = require('path');
const fsp = require('fs').promises;
const { DATA_DIR } = require('../engine/paths.js');
const installData = require('../store-supporters/install-data.js');
const supporterRedeem = require('../store-supporters/supporter-redeem.js');
const { createBitStore } = require('./store.js');
const { createHatch } = require('./hatch.js');
const { createPublish } = require('./publish.js');
const { createKeep } = require('./keep.js');
const { createBitItems } = require('./items.js');
const sparksWallet = require('../store-supporters/sparks-wallet.js');
const { createBitBackup } = require('./backup.js');
const { readFacts } = require('./facts.js');
const { createBitActions } = require('./actions.js');
const { spriteFor } = require('./sprite.js');
const Model = require('./model.js');
const { broadcastSSE } = require('../http/sse-clients.js');

const TICK_MS = 60 * 1000;
const FLUSH_EVERY = 10; // minutes between writes of what was learnt
// A birth this recent on the version ping's own record is a new install, not a founder.
const NEW_INSTALL_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const store = createBitStore({ dataDir: DATA_DIR, warn: (msg) => console.warn(msg) });
const hub = {
  scopedId: () => installData.getScopedId(DATA_DIR, installData.SCOPE_BIT),
  post: (p, body, max, timeout) => supporterRedeem.hubPost(p, body, max, timeout),
};
const hatch = createHatch({ store, ...hub });
// The Bit on xenon-app.com, only when the person chooses it (publish.js).
const publish = createPublish({ store, ...hub });
// The items made on the hub (items.js): each month's supporters' item and newer shop items.
const items = createBitItems({ dataDir: DATA_DIR, post: hub.post, warn: (msg) => console.warn(msg) });
items.ready(); // read at start, so the popup's Bit (sprite.js, synchronous) wears them too
// Supporter and shop items, through the hub's /redeem and /buy (keep.js). The pass trial
// never keeps one, and without a saved pass there is nothing to ask the hub with.
const keep = createKeep({
  store,
  redeem: async (o) => ((await supporterRedeem.readSavedCode(DATA_DIR))
    ? supporterRedeem.redeem({ ...o, kv: undefined, dataDir: DATA_DIR, allowTrial: false })
    : { ok: false, error: 'no_code' }),
  buy: (o) => sparksWallet.buy({ ...o, consent: o.consent ?? '', kv: undefined, dataDir: DATA_DIR }),
});

/**
 * Did this install have Xenon before Bit came? Not when the data folder was
 * empty at this start, nor when the version ping saw the install born days ago.
 * @param {boolean} fresh FRESH_INSTALL of this engine
 */
async function founder(fresh, dataDir = DATA_DIR, now = Date.now()) {
  if (fresh) return false;
  try {
    const ping = JSON.parse(await fsp.readFile(path.join(dataDir, 'version-ping.json'), 'utf8'));
    const first = ping && ping.born === 'known' ? Date.parse(`${ping.first}T00:00:00Z`) : NaN;
    if (Number.isFinite(first) && now - first < NEW_INSTALL_DAYS * DAY_MS) return false;
  } catch { /* no record: an install older than the version ping */ }
  return true;
}

// The Bit's part of a settings backup (server.js buildBackup / applyBackup).
const backup = createBitBackup({ store });
// Bit in the chat, the Deck and a phone (capabilities/index.js run).
const actions = createBitActions({ store, broadcast: broadcastSSE });

let timer = null;
let minutes = 0;

async function tick() {
  const model = store.peek();
  if (!model?.bit) return;
  const now = new Date();
  const facts = readFacts(now.getTime());
  await store.remember((m) => Model.learn(m, facts, now));
  if (facts.open || facts.active) {
    // A new day can be a new stage: every surface hears it.
    const out = await store.update((m) => Model.countDay(m, now));
    if (out && !out.unchanged && out.model) {
      broadcastSSE('bit', Model.view(out.model, now));
      // A new stage shows on its page too: one call a day at most, only while it is shown.
      if (out.model.shown) publish.refresh().catch(() => {});
    }
  }
  if (++minutes % FLUSH_EVERY === 0) await store.flush();
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref();
}

async function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  await store.flush().catch(() => {});
}

start();

// The person's own Bit for the Windows Vitals popup (vitals-nag.js), or null for the classic one.
const popupSprite = (mood) => spriteFor(store.peek(), mood);

module.exports = { store, hatch, publish, keep, items, founder, backup, actions, popupSprite, stop, _tick: tick };
