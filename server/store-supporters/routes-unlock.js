// What the engine answers about what a supporter unlocks: a code redeemed, the trial pass, and
// the lyrics translation and developer cleanup features with their trial and unlock.

const { readBody } = require('../http/read-body.js');
const supporterRedeem = require('../supporter-redeem.js');
const { DATA_DIR } = require('../engine/paths.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /api/community/redeem': async (req, _res, { json, err500 }, { trialVault }) => {
    // Supporter-code redemption for v2 remote-locked drops. This server only
    // validates shape, attaches the persisted install id and forwards to the
    // author-owned hub (see server/supporter-redeem.js) — the one-time /
    // 3-device policy is enforced hub-side. In CSRF_MUTATION_PATHS.
    // An EMPTY code is not a malformed request: it means "use the supporter
    // pass this machine already redeemed with" (supporter-redeem.js).
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = await supporterRedeem.redeem({
        entryId: body.entryId, code: body.code, kv: body.kv, dataDir: DATA_DIR,
      });
      // Opened with the pass trial: the key stays here. This server decrypts the
      // drop (body.enc, the public locked file), keeps its widgets in the vault
      // and answers with the inner code, packages replaced by vault markers.
      if (r && r.ok && r.trial === true) {
        const { cek, trial, ...answer } = r;
        const opened = await trialVault.open({
          entryId: body.entryId, kv: body.kv, enc: body.enc, cek, catalogVersion: body.catalogVersion,
        });
        json(opened.ok ? { ...answer, inner: opened.inner } : { ok: false, error: opened.error });
        return;
      }
      json(r);
    } catch (e) { err500(e.message); }
  },

  'GET /api/community/trial': async (_req, _res, { json, err500 }, { trialPass }) => {
    // The pass trial's state for this install, from the hub's last answer. Never
    // the code. A pure read: no hub call (that is /check).
    try { json(await trialPass.status()); } catch (e) { err500(e.message); }
  },

  'POST /api/community/trial/check': async (_req, _res, { json, err500 }, { trialPass }) => {
    // A dashboard opening: the hub's latest word, asked at most every 10 minutes.
    // A conversion lands here too (the supporter code is saved). In CSRF_MUTATION_PATHS.
    try { json(await trialPass.refresh()); } catch (e) { err500(e.message); }
  },

  'POST /api/community/trial/tried': async (req, _res, { json, err500 }, { trialPass }) => {
    // What the dashboard took off when the trial ended, so a conversion can put it
    // back. Validated in trial-pass.js. In CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await trialPass.setTried(body && body.tried, { end: !!(body && body.end === true) }));
    } catch (e) { err500(e.message); }
  },

  'GET /api/features/lyrics': async (_req, _res, { json, err500 }, { featureUnlock }) => {
    // Is the supporter-only Lyrics widget usable on this install? `unlocked`
    // covers a running trial too; `owned`, `trialEndsAt` and `trialAvailable`
    // tell the tile which of the two it is. The lyrics themselves stay free:
    // the Media tile's button reads them too.
    try { json({ ok: true, ...(await featureUnlock.status('lyrics')) }); } catch (e) { err500(e.message); }
  },

  'POST /api/features/lyrics/trial': async (_req, _res, { json, err500 }, { featureUnlock }) => {
    // Starts the one-week trial, once per install. No hub call, no code. In
    // CSRF_MUTATION_PATHS; a paired phone may start it like any tile action.
    try { json(await featureUnlock.startTrial('lyrics')); } catch (e) { err500(e.message); }
  },

  'POST /api/features/lyrics/unlock': async (req, _res, { json, err500 }, { featureUnlock }) => {
    // One /redeem against the hub's `feature-lyrics` entry, with the saved pass
    // (or a code typed in the tile). In CSRF_MUTATION_PATHS + REMOTE_ADMIN.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await featureUnlock.unlock('lyrics', typeof body.code === 'string' ? body.code : ''));
    } catch (e) { err500(e.message); }
  },

  'GET /api/features/devclean': async (_req, _res, { json, err500 }, { featureUnlock }) => {
    // Is the supporter-only Dev cleanup unlocked on this install? A boolean.
    try { json({ ok: true, unlocked: await featureUnlock.isUnlocked('devclean') }); } catch (e) { err500(e.message); }
  },

  'GET /api/features/devclean/preview': async (_req, _res, { json }, { devClean }) => {
    // What the locked tile shows a non-supporter: this PC's own numbers, the
    // same names-free summary the SDK's devStorage stream carries for free.
    // Pulled only while the tile is on screen.
    try { json({ ok: true, ...(await devClean.summary()) }); }
    catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }
  },

  'POST /api/features/devclean/unlock': async (req, _res, { json, err500 }, { featureUnlock }) => {
    // One /redeem against the hub's `feature-devclean` entry, with the saved
    // pass (or a code typed in the tile). In CSRF_MUTATION_PATHS + REMOTE_ADMIN.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await featureUnlock.unlock('devclean', typeof body.code === 'string' ? body.code : ''));
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
