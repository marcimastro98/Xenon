// What the engine answers about the Store: the catalog, what is installed, the counts, the
// messages, a code, the limited items and the ratings.

const communityCatalog = require('../community-catalog.js');
const { semverNewer } = require('../semver.js');
const { APP_VERSION } = require('../updates/app-version.js');
const { hub } = require('../settings/current.js');
const { readBody } = require('../http/read-body.js');
const communityInstalls = require('../community-installs.js');
const communityMessages = require('../community-messages.js');
const supporterRedeem = require('../supporter-redeem.js');
const { DATA_DIR } = require('../engine/paths.js');
const communityLimited = require('../community-limited.js');
const communityRatings = require('../community-ratings.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /api/community/catalog': async (_req, _res, { json, err500, urlObj }) => {
    // Community gallery catalog — proxied from the project site with a TTL
    // cache + ETag revalidation (see server/community-catalog.js). Read-only
    // GET: not a CSRF_MUTATION_PATHS candidate, NEVER a JSONP candidate.
    try {
      const out = await communityCatalog.fetchVisibleCatalog(urlObj.searchParams.has('refresh'));
      // Annotate version gating server-side with the same semver helpers the
      // update checker uses, so the client never grows its own comparator.
      if (out && Array.isArray(out.entries)) {
        out.entries = out.entries.map(e => (e && e.appVersionMin)
          ? { ...e, needsNewerApp: semverNewer(e.appVersionMin, APP_VERSION) } : e);
      }
      json(out);
    } catch (e) { err500(e.message); }
  },

  'POST /api/community/installed': async (req, _res, { json, err500 }) => {
    // Count one install of a catalog entry. NO identifier is sent: the hub only
    // increments a per-entry counter, and "have I already reported this one?"
    // is answered from this machine's own install receipts (js/preset-share.js).
    // So the number means installs REPORTED, not unique owners — say that
    // wherever it is shown. Gated like the version ping: a new install is on by
    // default, an existing one stays off until the user says otherwise.
    // In CSRF_MUTATION_PATHS (an outbound request, and Origin:null iframes post).
    try {
      if (!(hub.settings && hub.settings.catalogStats === true)) { json({ ok: false, error: 'disabled' }); return; }
      const body = JSON.parse(await readBody(req) || '{}');
      json(await communityInstalls.reportInstall({ entryId: body.entryId }));
    } catch (e) { err500(e.message); }
  },

  'POST /api/community/poll': async (req, _res, { json, err500 }) => {
    // One answer to a poll carried by an announcement. Nothing identifies the
    // sender: the hub bumps a counter for (message, option) and discards the
    // request, and "have I already answered this?" is remembered on this PC.
    // Gated by the same switch as the announcements themselves — a channel you
    // switched off must not still be collecting answers from you.
    // In CSRF_MUTATION_PATHS.
    try {
      if (!(hub.settings && hub.settings.hubMessages !== false)) { json({ ok: false, error: 'disabled' }); return; }
      const body = JSON.parse(await readBody(req) || '{}');
      json(await communityInstalls.submitPollVote({ messageId: body.messageId, optionId: body.optionId }));
    } catch (e) { err500(e.message); }
  },

  'GET /api/community/installs': async (_req, _res, { json, err500, urlObj }) => {
    // Public per-entry totals for the Store. Read-only, cached; not gated by the
    // setting, because reading a public number reveals nothing about this install.
    try {
      json(await communityInstalls.fetchInstallCounts({ ids: urlObj.searchParams.get('ids') }));
    } catch (e) { err500(e.message); }
  },

  'GET /api/community/support-goal': async (_req, _res, { json, err500 }) => {
    // How many people pay for Xenon right now and the goal that makes it pay for
    // itself: two public integers from the hub, nothing about this install sent,
    // so not gated by a setting either. Cached an hour (community-installs.js).
    // In CSRF_MUTATION_PATHS (a cache miss is an outbound request).
    try { json(await communityInstalls.fetchSupportGoal()); } catch (e) { err500(e.message); }
  },

  'GET /api/community/messages': async (_req, _res, { json, err500, urlObj }) => {
    // Announcement feed — messages.json on the project site, proxied with the
    // same TTL cache + ETag revalidation as the catalog. Every install gets the
    // WHOLE feed; the `match` block is evaluated client-side (js/hub-messages.js)
    // so targeting costs no identifier and the server cannot tell who saw what.
    // In CSRF_MUTATION_PATHS: a cache miss triggers an outbound fetch. Never a
    // JSONP candidate.
    try {
      const out = await communityMessages.fetchVisibleMessages(urlObj.searchParams.has('refresh'));
      // `context` is what THIS install is, handed to the client so it can match
      // locally: the browser has no reliable read of any of it, and the os token has
      // to come from the same vocabulary version-ping.js uses or a filter written
      // against one would silently miss the other. It travels inward only.
      // `supporter` is the boolean /api/community/supporter already answers, never
      // the code; left out when the pass cannot be read, and hub-match.js fails closed.
      const pass = await supporterRedeem.savedStatus(DATA_DIR).catch(() => null);
      json({ ...out, context: { version: APP_VERSION, os: process.platform, supporter: pass ? pass.saved : undefined } });
    } catch (e) { err500(e.message); }
  },

  'GET /api/community/code': async (_req, _res, { json, err500, urlObj }) => {
    // One entry's share code (codes/<id>.txt on the site). The id is validated
    // against a strict charset before it ever reaches the URL. The code itself
    // stays untrusted — the client feeds it to the normal import pipeline.
    try {
      const out = await communityCatalog.fetchCode(urlObj.searchParams.get('id'));
      json(out);
    } catch (e) { err500(e.message); }
  },

  'GET /api/community/limited-status': async (_req, _res, { json, err500, urlObj }) => {
    // Live stock for automatic limited drops. The local proxy pins the Hub
    // origin and validates every id; the browser never receives a configurable
    // backend URL from catalog data.
    try {
      json(await communityLimited.fetchStatus(urlObj.searchParams.get('ids')));
    } catch (e) { err500(e.message); }
  },

  'GET /api/community/ratings': async (_req, _res, { json, err500, urlObj }) => {
    // Star-rating aggregates for gallery entries, proxied from the hub with a
    // TTL cache + in-flight dedup (community-ratings.js). In CSRF_MUTATION_PATHS
    // (a cache miss triggers an outbound fetch).
    try {
      json(await communityRatings.fetchRatings({ ids: urlObj.searchParams.get('ids') }));
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
