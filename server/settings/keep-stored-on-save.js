// What a save of the whole settings keeps from the stored ones, whatever the page sent.

// POST /settings calls this inside the settings lock, between its read and its write, and
// nowhere else. The lines are the ones the route had, each with its reason above it.

const { DASHBOARD_GRID_COLUMNS } = require('../grid/layout-defaults.js');
const lighting = require('../lights/lighting.js');
const remoteActions = require('../paired/remote-actions.js');
const VitalsState = require('../vitals/vitals-state.js');

/**
 * @param {any} prev what is stored, null on a new install
 * @param {any} incoming what was sent, with the stored secrets and the new save number already in it
 * @param {boolean} isRemote whether a paired device sent it
 * @returns {any} what gets written
 */
function keepStoredOnSave(prev, incoming, isRemote) {
  // Grid-units guard: a dashboard left open across the v4 update (typically
  // the Xeneon Edge screen or an iCUE-mode page) still runs pre-24-column
  // client JS — its normalizer strips layout.gridCols and clamps every tile
  // back to 12 columns before saving. Accepting that save would re-run the
  // ×2 unit migration on already-migrated data, blowing every tile up to
  // full width/height ("all widgets full screen"). Once the stored layout
  // is in 24-column units, only a save that also speaks them may replace
  // it; a flag-less save keeps the stored layout and presets (preset
  // entries carry the same per-entry units flag and would double the same
  // way). The same stale client also authored its blob with a normalizer
  // that drops every settings section it never knew about — so prev-fill
  // the whole object: any top-level key the old client omitted keeps its
  // stored value instead of resetting to defaults (the widget-owned merges
  // below then refine on top of the filled copy). The save is still
  // accepted (not rejected) on purpose: that keeps the client's rev in step
  // with the server's, so its localStorage can never later win a hydrate
  // merge and re-push the mangled geometry. Genuine 12-column data still
  // migrates: the settings-file load and the backup-import path don't pass
  // through this guard.
  if (prev && prev.dashboardLayout
      && Number(prev.dashboardLayout.gridCols) === DASHBOARD_GRID_COLUMNS
      && Number(incoming.dashboardLayout && incoming.dashboardLayout.gridCols) !== DASHBOARD_GRID_COLUMNS) {
    console.warn('[settings] Save from a pre-24-column (stale) client: keeping stored layout/presets and prev-filling sections it omitted. That page needs a reload to edit the layout again.');
    incoming = { ...prev, ...incoming, dashboardLayout: prev.dashboardLayout, dashboardPresets: prev.dashboardPresets, customThemes: prev.customThemes, ambientScenes: prev.ambientScenes, contentInstalls: prev.contentInstalls };
  }
  // lighting.providers / deviceModes / native are bridge-owned (set only via
  // /api/lighting/*) and the client mirror never carries them — refill them
  // from the live bridge so a client save can't wipe external devices and
  // their pairing tokens from settings.json.
  incoming.lighting = {
    ...(incoming.lighting && typeof incoming.lighting === 'object' ? incoming.lighting : {}),
    providers: lighting.getExternalConfig(),
    deviceModes: lighting.getConfig().deviceModes,
    native: lighting.getConfig().native,
  };
  // The stocks watchlist is widget-owned (edited only via POST
  // /api/stocks/watchlist); the browser settings mirror can carry a stale
  // copy, so a plain /settings save would wipe symbols the user just added
  // from the Borsa widget. Keep the persisted watchlist; the rest of the
  // stocks config (provider, keys, alertPercent, tile) stays client-editable.
  if (prev && prev.stocks && Array.isArray(prev.stocks.watchlist)) {
    incoming.stocks = {
      ...(incoming.stocks && typeof incoming.stocks === 'object' ? incoming.stocks : {}),
      watchlist: prev.stocks.watchlist,
    };
  }
  // Same for the football favorite teams — widget-owned (edited only via POST
  // /api/football/teams); keep the persisted list so a settings save can't
  // wipe teams the user just added from the Calcio widget.
  if (prev && prev.football && Array.isArray(prev.football.teams)) {
    incoming.football = {
      ...(incoming.football && typeof incoming.football === 'object' ? incoming.football : {}),
      teams: prev.football.teams,
    };
  }
  // The Claude usage plan/budget is widget-owned (edited only via POST
  // /api/claude/budget); the browser settings model doesn't carry it, so keep
  // the persisted config so a settings save can't reset it to the default.
  if (prev && prev.claude && typeof prev.claude === 'object') {
    incoming.claude = prev.claude;
  }
  // Same for the News followed feeds — widget-owned (edited only via POST
  // /api/news/feeds); keep the persisted list so a settings save can't wipe
  // feeds the user just added from the News widget.
  if (prev && prev.news && Array.isArray(prev.news.feeds)) {
    incoming.news = {
      ...(incoming.news && typeof incoming.news === 'object' ? incoming.news : {}),
      feeds: prev.news.feeds,
    };
  }
  // Lighting is bridge-owned: every change goes through /api/lighting/* (or
  // the AI tools), which persist via _persistLighting WITHOUT bumping the
  // browser mirrors. A surface's mirror therefore holds whatever lighting
  // blob it hydrated at boot, and echoing it here reverted toggles flipped
  // on the lighting page since (empirically: "Album → LED" kept turning
  // itself back on, painting the LEDs with the cover colour while the
  // checkbox showed off). Keep the persisted copy.
  if (prev && prev.lighting && typeof prev.lighting === 'object') {
    incoming.lighting = prev.lighting;
  }
  // Paired-device access is server-owned, and this is the only thing that
  // kept it working. Its sole legitimate writer is POST /api/remote-access/
  // enable (loopback-only, so a phone can never switch itself on). The
  // browser settings model does not carry the key AT ALL — normalizeSettings
  // in js/settings/normalize-settings.js has no `remoteAccess` — so every generic save arrived
  // without it and `normalizeHubSettings` rebuilt it as `{enabled:false}`.
  // The result: remote access switched ITSELF off the first time the user
  // changed any setting anywhere, live sockets were dropped, and from then
  // on every request from the paired phone got the plain 403 that a build
  // without the feature returns — the Deck, the lock key, Ambient and the
  // history all doing nothing, with no way to tell why. Measured on the real
  // install: `remoteAccess: {}` on disk with a device still paired.
  // Keep the persisted value. An absent key means "the browser does not know
  // about this", never "the user turned it off".
  if (prev && prev.remoteAccess && typeof prev.remoteAccess === 'object') {
    incoming.remoteAccess = prev.remoteAccess;
  }
  // File transfer, for the same reason and one more: `inboxDir` is a path on
  // this PC that is deliberately never sent to a browser, so a generic save
  // could not carry it back even if the client modelled the rest. Without
  // this the user's chosen folder would reset to the default on every save
  // from any surface, and arrivals would quietly start landing somewhere
  // else. Its only writer is POST /api/transfer/settings.
  if (prev && prev.fileTransfer && typeof prev.fileTransfer === 'object') {
    incoming.fileTransfer = prev.fileTransfer;
  }
  // The recording options, for the same reason: `folder` is a path on this
  // PC that never reaches a browser. Writers: /capture/settings and the
  // recordingOptions capability (updateCaptureSettings).
  if (prev && prev.capture && typeof prev.capture === 'object') {
    incoming.capture = prev.capture;
  }
  // The widgets on the screen are server-owned too: every edit is a
  // capability (updateLayersSetting) and the browser only carries a mirror,
  // so a dashboard saving an older mirror would undo a widget the AI placed
  // or the page a game just switched to. Backup import has its own route.
  if (prev && prev.layers && typeof prev.layers === 'object') {
    incoming.layers = prev.layers;
  }
  // PC Control lets the assistant run commands on this PC after a tap on
  // its card. A phone must not be able to switch it on and then approve
  // the card itself, so from a paired device the stored choice stands.
  if (isRemote) {
    const was = !!(prev && prev.aiFeatures && prev.aiFeatures.pcControl === true);
    incoming.aiFeatures = { ...(incoming.aiFeatures && typeof incoming.aiFeatures === 'object' ? incoming.aiFeatures : {}), pcControl: was };
    // The app switcher's favourites are what a phone may start on the PC
    // (/windows/launch, remote-actions.js). A phone may remove or reorder
    // them, never add one: a favourite added from the phone would make any
    // program on disk one it can launch. So only favourites the PC already
    // has survive, each kept exactly as the PC saved it (its path cannot
    // be swapped under the same name).
    const favKey = (f) => String((f && (f.key || f.app)) || '').trim().toLowerCase();
    const saved = new Map((prev && Array.isArray(prev.appFavorites) ? prev.appFavorites : []).map((f) => [favKey(f), f]));
    incoming.appFavorites = (Array.isArray(incoming.appFavorites) ? incoming.appFavorites : [])
      .map((f) => saved.get(favKey(f)))
      .filter(Boolean);
    // And a widget's permissions the same way (remote-actions.js keepGrants).
    incoming.sdkWidgets = remoteActions.keepGrants(prev && prev.sdkWidgets, incoming.sdkWidgets);
  }
  // The layout-version migration reads the INCOMING body, and it is the only
  // check in normalizeHubSettings whose failure mode is losing the single
  // largest thing the user built. It is described as a one-time upgrade step,
  // but it lives in the general normalizer, so it re-runs on every save: a body
  // that does not carry `dashboardLayoutVersion` reads as version 0, and the
  // whole dashboard is replaced by the factory default while every other
  // setting in the same save survives untouched — then the file is re-stamped
  // with the current version, so nothing is left on disk to find afterwards.
  //
  // Reported on Discord after an update: layout back to the factory default,
  // theme unchanged, connected accounts intact, installed widgets intact. That
  // is this check's signature and nothing else in the codebase has it.
  //
  // So: an absent version means "this writer does not model the field", exactly
  // like remoteAccess and fileTransfer below. What may legitimately be OLD is
  // the layout on DISK, and that is what the migration is now judged against.
  if (prev && incoming.dashboardLayoutVersion == null && prev.dashboardLayoutVersion != null) {
    incoming.dashboardLayoutVersion = prev.dashboardLayoutVersion;
  }
  // The store id is minted once and belongs to this file, so a save can only
  // ever echo it back — and a save from a surface still holding a mirror of a
  // PREVIOUS store would echo THAT one, which would make this store answer
  // with the identity of the install it just replaced and disarm the check
  // for every other surface. Keep the persisted value.
  if (prev && prev.storeId) {
    incoming.storeId = prev.storeId;
  }
  // Usage history is server-owned for the same reason storeId is: the browser
  // does not model it, so every generic save would arrive without it and
  // normalizeHubSettings would rebuild it as a brand-new install — resetting
  // the clock, and letting the one-time ask come round again. An absent key
  // means "this writer does not know about it", never "start over".
  if (prev) {
    if (prev.firstRunDay) incoming.firstRunDay = prev.firstRunDay;
    if (prev.lastUsageDay) incoming.lastUsageDay = prev.lastUsageDay;
    if (Number(prev.usageDays) > 0) incoming.usageDays = prev.usageDays;
    // …except supportAskSeen, which the BROWSER owns: pressing "not now" is
    // the one thing here a person actually does. Once true it never goes back,
    // so a stale mirror cannot un-dismiss it.
    if (prev.supportAskSeen === true) incoming.supportAskSeen = true;
    if (prev.shareNudgeSeen === true) incoming.shareNudgeSeen = true;
    // Browser-owned too, and just as one-way: the first day stamped stays,
    // and the appeal year only moves forward.
    if (prev.supportAskSeenDay) incoming.supportAskSeenDay = prev.supportAskSeenDay;
    // POST /update/notice-seen owns these two. whatsNewSeen has two writers, so
    // a mirror that has not heard yet can never empty it.
    incoming.releaseNotesSeen = prev.releaseNotesSeen || '';
    incoming.updateFailSeen = prev.updateFailSeen || '';
    if (prev.whatsNewSeen && !incoming.whatsNewSeen) incoming.whatsNewSeen = prev.whatsNewSeen;
    if (Number(prev.supportAppealYear) > (Number(incoming.supportAppealYear) || 0)) {
      incoming.supportAppealYear = prev.supportAppealYear;
    }
  }
  // Vitals state is widget-owned and monotonic (server/vitals/vitals-state.js): a
  // stale settings mirror from another surface must never rewind a refill
  // the user just tapped elsewhere.
  if (prev && prev.vitals && prev.vitals.state && typeof prev.vitals.state === 'object') {
    const inV = incoming.vitals && typeof incoming.vitals === 'object' ? incoming.vitals : {};
    incoming.vitals = { ...inV, state: VitalsState.mergeState(prev.vitals.state, inV.state) };
  }
  // Weather is edited only through the dedicated POST /api/weather/config
  // (which bumps rev + broadcasts so peer surfaces refetch the new location,
  // GitHub #72). Keep the persisted copy on the generic settings save so a
  // background whole-blob push — a Vitals/Bit heartbeat, or the unload beacon —
  // from a surface that still holds the OLD location can't clobber it via
  // last-writer-wins (the "XENON stays on the wrong weather location" bug,
  // GitHub #109). The backup-import path sets weather deliberately and does not
  // pass through this guard.
  if (prev && prev.weather && typeof prev.weather === 'object') {
    incoming.weather = prev.weather;
  }
  // The anonymous feature counts are the PC owner's choice: a paired device
  // can neither switch them on nor off, its save keeps the stored value.
  if (isRemote) incoming.usageStats = !!(prev && prev.usageStats === true);
  if (isRemote) incoming.batteryAskDevices = !prev || prev.batteryAskDevices !== false;
  return incoming;
}

module.exports = { keepStoredOnSave };
