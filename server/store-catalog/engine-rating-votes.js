// The engine's keeper of the votes on Store entries.

const path = require('node:path');
const { nativeCollectors } = require('../system/native-collectors.js');
const { sseClients } = require('../http/sse-clients.js');
const supporterRedeem = require('../store-supporters/supporter-redeem.js');
const communityRatings = require('./community-ratings.js');
const { createRatingVotes, ASKS_PER_ENTRY } = require('./rating-votes.js');
const { createPcId } = require('../engine/pc-id.js');
const { DATA_DIR } = require('../engine/paths.js');
const { hub } = require('../settings/current.js');
const { bitMessages } = require('../ai/engine-bit-messages.js');

// Votes on Store entries (rating-votes.js): tickets, real use, and Bit's one ask.
const ratingVotes = createRatingVotes({
  file: path.join(DATA_DIR, 'rating-votes.json'),
  pcId: createPcId({
    collectors: nativeCollectors,
    fallback: () => supporterRedeem.getInstallId(DATA_DIR),
  }),
  scopedId: () => supporterRedeem.getScopedId(DATA_DIR, supporterRedeem.SCOPE_RATINGS),
  deviceId: () => supporterRedeem.getScopedId(DATA_DIR, supporterRedeem.SCOPE_DEVICES),
  hub: (pathname, body) => supporterRedeem.hubPost(pathname, body),
  redeemSaved: (entryId) => supporterRedeem.redeem({ entryId, code: '', dataDir: DATA_DIR, allowTrial: false }),
  fileAsk: (msg) => bitMessages.post({ messages: [msg] }),
  settings: () => hub.settings,
  watching: () => sseClients.size > 0,
  onVoted: (entryId) => {
    communityRatings.forget(entryId);
    for (let n = 1; n <= ASKS_PER_ENTRY; n++) bitMessages.read(`rate:${entryId}:${n}`).catch(() => {});
  },
});

module.exports = { ratingVotes };
