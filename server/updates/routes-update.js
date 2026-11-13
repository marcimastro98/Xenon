// What the engine answers about updating itself: a notice that was read, where an update
// stands, preparing and applying it, the automatic update and its postponement, and what is new
// in this version.

const { APP_VERSION } = require('./app-version.js');
const releaseNotes = require('../release-notes.js');
const { readBody } = require('../http/read-body.js');
const { readPwshJson } = require('../powershell/read-json.js');
const path = require('node:path');
const { DATA_DIR } = require('../engine/paths.js');
const { checkLatestRelease } = require('./latest-release.js');
const { semverNewer } = require('../semver.js');
const versionPing = require('../version-ping.js');
const { hub } = require('../settings/current.js');
const { settingsBoot } = require('../settings/boot-state.js');
const supporterRedeem = require('../supporter-redeem.js');
const usageStats = require('../usage-stats.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /whatsnew': async (_req, _res, { json, err500 }, { loadWhatsNew }) => {
    // Curated highlights for the running version (see loadWhatsNew). Static and
    // shipped with the build; the client gates display on the `id`. A new install
    // gets them too: the major's sheets first, then the notes since it.
    try { json({ ...(await loadWhatsNew()), version: APP_VERSION }); } catch (e) { err500(e.message); }
  },

  'POST /update/notice-seen': async (req, res, { json }, { saveNoticeSeen }) => {
    // The person read What's New, the fixes of a release or a failed update. The
    // alerts window of "widgets only" only views the settings, and the two
    // versions must hold on every surface, so the server writes them.
    try {
      const seen = releaseNotes.cleanSeen(JSON.parse(await readBody(req, 1024) || '{}'));
      if (Object.keys(seen).length) await saveNoticeSeen(seen);
      json({ ok: true });
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bad_request' }));
    }
  },

  'GET /update/self-status': async (_req, _res, { json, err500 }, { selfUpdate }) => {
    // Whether one-click self-update is possible here (not a git checkout, applier
    // present), and whether a validated build is already staged and ready to apply.
    // `lastResult` is the machine-readable outcome update-apply.ps1 persists to
    // DATA_DIR/update-result.json (success or rollback + reason), so the dashboard
    // can explain a failed apply instead of spinning to a blind timeout. Read
    // fresh per request — the applier writes it while we are down.
    try {
      let lastResult = null;
      // Absent (old applier or no update yet) → null; readPwshJson also strips
      // the PS5 UTF-8 BOM older applier builds wrote.
      const m = await readPwshJson(path.join(DATA_DIR, 'update-result.json'));
      if (m && typeof m.ok === 'boolean') {
        lastResult = {
          ok: m.ok,
          reason: String(m.reason || ''),
          // The failing tool's OWN sentence, when the applier captured one (npm's
          // first ERR! line). The reason code names the stage and stops there,
          // which is the same text for four failures with four different fixes.
          // Free text from a tool, so it is bounded here and rendered as text.
          detail: String(m.detail || '').slice(0, 200),
          rolledBack: m.rolledBack !== false,
          rollbackVerified: m.rollbackVerified !== false,
          from: String(m.from || ''),
          to: String(m.to || ''),
          at: String(m.at || ''),
        };
      }
      // `reason` names WHICH precondition failed, so a stuck install can be
      // diagnosed from this one URL instead of a round of guesses. Empty when
      // self-update is available. `applier` is the path that has to exist —
      // quoted here because "restore this file" is only actionable if the user
      // is told which file.
      const unsupportedFor = selfUpdate.unsupportedReason();
      json({
        supported: !unsupportedFor,
        reason: unsupportedFor,
        applier: unsupportedFor === 'no_applier' ? String(selfUpdate.applierPath || '') : undefined,
        staged: selfUpdate.staged(),
        lastResult,
      });
    } catch (e) { err500(e.message); }
  },

  'POST /update/prepare': async (req, _res, { json }, { selfUpdate }) => {
    // Non-destructive: download + extract + validate the latest release into
    // DATA_DIR. The live install is never touched here.
    try {
      await readBody(req);
      if (!selfUpdate.supported()) { json({ ok: false, error: 'unsupported' }); return; }
      const u = await checkLatestRelease(true);
      if (!u.ok || !semverNewer(u.latest, APP_VERSION)) { json({ ok: false, error: 'no_update' }); return; }
      const r = await selfUpdate.prepare({ tag: u.tag, version: u.latest });
      json(r);
    } catch (e) { json({ ok: false, error: String(e && e.message || e) }); }
  },

  'POST /update/apply': async (req, _res, { json, err500 }, { PORT, selfUpdate }) => {
    // Hand off to the external applier (elevated, detached). Only valid once a
    // build is staged; from here the swap happens outside this process.
    // The port is this server's, so an install on XENON_PORT updates itself
    // and not whatever else listens on 3030.
    try {
      await readBody(req);
      json(selfUpdate.apply({ port: PORT }));
    } catch (e) { err500(e.message); }
  },

  'GET /update/auto-status': async (_req, _res, { json, err500, urlObj }, { autoUpdater, selfUpdate }) => {
    // Where the automatic updater stands, for the line in Settings -> General.
    // ?safe=1 also answers "could the app restart right now?", which the native
    // app asks before updating its own shell; it reads idle time, so it is only
    // computed on request. `shellSilent` says whether that shell update can run
    // with nobody there to answer a password prompt (see self-update.js).
    try {
      const out = autoUpdater.status();
      if (urlObj.searchParams.get('safe') === '1') {
        out.safeNow = await autoUpdater.safeNow();
        out.shellSilent = selfUpdate.shellUpdatesSilently();
      }
      json(out);
    } catch (e) { err500(e.message); }
  },

  'POST /update/auto/postpone': async (req, _res, { json, err500 }, { autoUpdater }) => {
    // "Postpone by an hour" from the countdown on any dashboard. It can only
    // delay an update, never start one, so a paired phone may send it too.
    try {
      await readBody(req);
      json(autoUpdater.postpone());
    } catch (e) { err500(e.message); }
  },

  'GET /update/check': async (_req, _res, { json, err500, urlObj }) => {
    // Latest released version vs the running one (probed at most daily,
    // fail-silent — offline simply reports no update). `?force=1` bypasses the
    // cache for the manual "check now" button.
    try {
      const u = await checkLatestRelease(urlObj.searchParams.get('force') === '1');
      json({
        current: APP_VERSION,
        latest: u.ok ? u.latest : '',
        url: u.ok ? u.url : '',
        notes: u.ok ? u.notes : '',
        name: u.ok ? u.name : '',
        publishedAt: u.ok ? u.publishedAt : '',
        mediaTypes: u.ok ? (u.mediaTypes || {}) : {},
        updateAvailable: !!(u.ok && semverNewer(u.latest, APP_VERSION)),
      });
      // Opt-in anonymous version ping, off by default. Deliberately piggybacks
      // on this check so enabling it adds no new outbound request, and is
      // fire-and-forget so it can never delay or fail the update response.
      versionPing.maybePing({
        dataDir: DATA_DIR,
        version: APP_VERSION,
        enabled: !!(hub.settings && hub.settings.versionPing === true),
        // Only a birth observed at boot may produce a cohort — see version-ping.js.
        fresh: settingsBoot.fileMissing,
        // Already normalized on both sides (WEATHER_LANGS here, SUPPORTED_LANGS in
        // js/settings.js), so reading it costs nothing and adds no new key.
        lang: (hub.settings && hub.settings.language) || '',
      }).catch(() => { /* best-effort: a failed ping is never user-visible */ });
      // Anonymous feature counts, off unless usageStats is on: same ride, same
      // once-a-day rule. The tier is a boolean (is a supporter code saved here),
      // never the code itself.
      if (hub.settings && hub.settings.usageStats === true) {
        supporterRedeem.savedStatus(DATA_DIR)
          .then((st) => usageStats.maybeSend({ enabled: true, supporter: !!(st && st.saved) }))
          .catch(() => { /* best-effort, like the version ping */ });
      }
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
