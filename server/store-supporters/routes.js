// What the engine answers about a supporter and the Sparks: the saved key, an update of owned
// content, a purchase and the wallet.

const { readBody } = require('../http/read-body.js');
const supporterRedeem = require('../supporter-redeem.js');
const { DATA_DIR } = require('../engine/paths.js');
const sparksWallet = require('../sparks-wallet.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'POST /api/community/update': async (req, _res, { json, err500 }) => {
    // Owner update: "I already unlocked this entry on this install, is there a newer
    // version and may I have its key?" Sends no code. The hub answers only a device
    // it recorded as an owner (the activation /redeem wrote) and says not_owner to
    // every other caller. The key and any private bundle go to the browser exactly
    // as a redeem answer does, and are never kept here. In CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await supporterRedeem.update({
        entryId: body.entryId, have: body.have, kv: body.kv, dataDir: DATA_DIR,
      }));
    } catch (e) { err500(e.message); }
  },

  'GET /api/community/supporter': async (_req, _res, { json, err500 }) => {
    // Does this machine remember a supporter pass? A boolean, never the code:
    // it is a server-only secret and this answer is readable from every paired
    // device (preserve-on-save + redact-on-wire).
    try { json(await supporterRedeem.savedStatus(DATA_DIR)); } catch (e) { err500(e.message); }
  },

  'POST /api/community/supporter/save': async (req, _res, { json, err500 }) => {
    // Storing the pass from Settings, before any drop asks for it. The hub is
    // asked once whether it knows the code (supporter-redeem.js saveTypedCode).
    // In CSRF_MUTATION_PATHS.
    //
    // Its own path rather than a POST on /api/community/supporter: that GET is a
    // pure read the import dialog makes from every surface, including a paired
    // phone, and listing a path in CSRF_MUTATION_PATHS refuses its GET on the
    // remote door. Splitting the write off keeps the read reachable.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const saved = await supporterRedeem.saveTypedCode(DATA_DIR, body.code, { verify: true });
      // A Sparks code already here moves onto the new pass (sparks-wallet.js).
      if (saved && saved.ok) await sparksWallet.mergeIfBoth(DATA_DIR);
      json(saved);
    } catch (e) { err500(e.message); }
  },

  'POST /api/community/supporter/forget': async (_req, _res, { json, err500 }) => {
    // The reset path for that memory. In CSRF_MUTATION_PATHS.
    try { json(await supporterRedeem.forgetCode(DATA_DIR)); } catch (e) { err500(e.message); }
  },

  'POST /api/community/buy': async (req, _res, { json, err500 }) => {
    // A drop bought with Sparks (sparks-wallet.js): this server picks the code
    // that pays (the pass, else the Sparks code), attaches the install id and asks
    // the hub, which charges once per owner and answers with the content key, as
    // a redeem does. An empty code means "with what this PC remembers".
    // In CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await sparksWallet.buy({ entryId: body.entryId, code: body.code, kv: body.kv, consent: body.consent, dataDir: DATA_DIR }));
    } catch (e) { err500(e.message); }
  },

  'GET /api/community/sparks': async (_req, _res, { json, err500 }) => {
    // Can this PC pay with Sparks, and with a pass or a Sparks code. Booleans
    // only, never a code: readable from a paired phone like /api/community/supporter.
    try { json(await sparksWallet.walletStatus(DATA_DIR)); } catch (e) { err500(e.message); }
  },

  'GET /api/community/sparks/owned': async (_req, _res, { json, err500, urlObj }) => {
    // Is this drop already yours? A boolean, never a code; the hub only reads. The
    // buy sheet asks so a copy already bought goes straight to Install.
    try { json(await sparksWallet.owned({ entryId: urlObj.searchParams.get('entryId'), dataDir: DATA_DIR })); } catch (e) { err500(e.message); }
  },

  'POST /api/community/sparks/save': async (req, _res, { json, err500 }) => {
    // The XC Sparks code typed in Settings or the Store. Shape only, like the
    // pass save; with a pass already here it is moved onto it. In CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await sparksWallet.saveTypedWalletCode(DATA_DIR, body.code));
    } catch (e) { err500(e.message); }
  },

  'POST /api/community/sparks/forget': async (_req, _res, { json, err500 }) => {
    // The reset path for the Sparks code. PC only (REMOTE_ADMIN). In CSRF_MUTATION_PATHS.
    try { json(await sparksWallet.forgetWalletCode(DATA_DIR)); } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
