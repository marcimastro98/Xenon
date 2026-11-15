// The save of the whole settings: POST /settings.

const { readBody } = require('../http/read-body.js');
const { withHubSettingsLock } = require('./write-lock.js');
const { readHubSettings } = require('./read.js');
const { preserveSettingsSecrets } = require('./secrets.js');
const { nextSettingsRev } = require('../settings-rev.js');
const { keepStoredOnSave } = require('./keep-stored-on-save.js');
const { writeHubSettings } = require('./write.js');
const { hub } = require('./current.js');
const usageStats = require('../engine/usage-stats.js');
const lighting = require('../lights/lighting.js');
const { refreshExternalFeeds } = require('../time/feeds-refresh.js');
const { discordMirror } = require('../discord/mirrored.js');
const { stopDiscordWatch } = require('../discord/watch-stop.js');
const { refreshWinNotifWatch } = require('../notification-open/watch-refresh.js');
const winNotif = require('../notification-open/winnotif.js');
const calls = require('../calls.js');
const { refreshAudioLevelsWatch } = require('../audio/levels-wanted.js');
const { refreshNews } = require('../ticker/news-refresh.js');
const { _feedWidgetInUse } = require('../grid/feed-widget-in-use.js');
const { newsState } = require('../ticker/news-state.js');
const { broadcastSSE } = require('../http/sse-clients.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /settings': async (req, _res, { json, err500, isRemote }, { _codexChanged, _syncCodexDemand, _syncSessionWatch, autoUpdater, batteryMonitor, deckChroma, deckUnifi, embeddedBrowser, phone, refreshClaude, refreshDiscordWatch, refreshFootball, refreshHaWatch, refreshHotkeyListener, refreshLivingIndex, refreshObsWatch, refreshSbWatch, refreshStocks, refreshUnifiEventsWatch, refreshWakeWordWatch, refreshWlWatch, widgetAutoUpdater }) => {
    try {
      const body    = JSON.parse(await readBody(req));
      // No .catch(() => null) here: readHubSettings already maps ENOENT (no file
      // yet) to null, so any OTHER read failure is a real error. Flattening it to
      // null would silently skip every preserve-on-save merge below (secrets,
      // widget-owned stores, the grid-units guard) and accept the save as if the
      // store were empty — wiping data. Fail the request instead (fail-closed).
      // Serialized against every other settings writer — see withHubSettingsLock.
      const { prev, settings } = await withHubSettingsLock(async () => {
      const prev    = await readHubSettings();
      // The browser settings model doesn't carry the server-only remote-control
      // creds, so carry them over from the persisted copy — a client save must
      // never wipe them (that's what left Sunshine stuck at "Not ready").
      let incoming = preserveSettingsSecrets(body.settings || body, prev);
      // Server-guaranteed monotonic rev: two surfaces saving from the same base
      // send the SAME client rev — the content is still last-writer-wins (the
      // documented residual), but the assigned rev must be strictly higher than
      // the stored one, so the broadcast below always exceeds every stale local
      // rev and the losing surface re-hydrates instead of silently diverging.
      // Shared with POST /api/weather/config — see settings-rev.js for why the
      // rule must live in ONE place.
      incoming.rev = nextSettingsRev(prev && prev.rev, incoming.rev);
      incoming = keepStoredOnSave(prev, incoming, isRemote);
      const settings = await writeHubSettings(incoming);
      hub.settings = settings;
      return { prev, settings };
      });
      if ((prev && prev.autoUpdate !== false) !== (settings.autoUpdate !== false)) {
        try { autoUpdater.settingsChanged(); } catch { /* next tick reads it anyway */ }
      }
      if ((prev && prev.autoUpdateWidgets !== false) !== (settings.autoUpdateWidgets !== false)) {
        try { widgetAutoUpdater.settingsChanged(); } catch { /* next tick reads it anyway */ }
      }
      if ((prev && prev.batteryAskDevices !== false) !== (settings.batteryAskDevices !== false)) batteryMonitor.peripheralsChanged();
      // Counts switched off: what was waiting to be sent is deleted, not kept.
      if (prev && prev.usageStats === true && settings.usageStats !== true) {
        usageStats.clear().catch(() => {});
      }
      // Ad-blocker toggle changed → tear the headless Edge down so the next tile
      // open relaunches it with (or without) --load-extension. Open tiles re-open
      // via BrowserTile.restart() on the client right after this save resolves.
      if (!!(prev && prev.browserAdblock) !== !!settings.browserAdblock) {
        try { embeddedBrowser.shutdown(); } catch (e) { /* next open self-heals */ }
      }
      // (Paired-device access cannot change here: it is kept from `prev` above,
      // and POST /api/remote-access/enable — which hangs up on every connected
      // device itself — is its only writer. This used to hang up when a save
      // "turned it off", which read as defensive and was in fact the mechanism
      // that broke the feature: no browser surface has ever carried the flag,
      // so every save looked like a turn-off.)
      // The save itself succeeded; a lighting apply failure must not fail the
      // request, but it must be visible (log + flag) instead of a silent no-op.
      let lightingApplied = true;
      try { lighting.applyConfig(settings.lighting); _syncSessionWatch(); }
      catch (e) { lightingApplied = false; console.error('Lighting apply failed:', e.message); }
      refreshExternalFeeds().catch(() => {}); // pick up feed add/remove immediately
      refreshObsWatch();                       // start/stop the live OBS watch if its config changed
      refreshHaWatch();                        // start/stop the live Home Assistant watch if its config changed
      refreshSbWatch();                        // start/stop the live Streamer.bot globals watch if its config changed
      refreshWlWatch();                        // start/stop the live Wave Link mixer watch if its config changed
      // UniFi Protect caches a login session — drop it so a changed
      // host/username/password takes effect on the next snapshot pull instead of
      // silently reusing the stale console (login re-runs lazily). Do this BEFORE
      // refreshing the events watch so it reconnects against the fresh session.
      try { deckUnifi.close(); } catch (e) { /* ignore */ }
      refreshUnifiEventsWatch();               // start/stop/reconnect the camera notifications socket
      // Chroma disabled → drop any held session so Synapse resumes immediately.
      if (!(settings.chroma && settings.chroma.enabled === true)) { try { deckChroma.release().catch(() => {}); } catch (e) { /* ignore */ } }
      // Discord notifications toggled — either its own switch OR the master
      // (Settings → Notifiche) — → restart the watch so the NOTIFICATION_CREATE
      // subscription (and its scope check) matches the new setting immediately.
      const masterPrev = !(prev && prev.notifications && prev.notifications.enabled === false);
      const masterNext = !(settings.notifications && settings.notifications.enabled === false);
      const dnPrev = masterPrev && !!(prev && prev.discordNotifications && prev.discordNotifications.enabled);
      const dnNext = masterNext && !!(settings.discordNotifications && settings.discordNotifications.enabled);
      if (dnPrev !== dnNext) {
        if (!dnNext) discordMirror.notifications = [];       // feature off → drop the stored feed
        stopDiscordWatch();
        refreshDiscordWatch();
      }
      // Windows notifications: start/stop the mirror child on toggle change
      // (sync() is idempotent) and re-filter the stored feed in case the
      // per-app mute list changed.
      refreshWinNotifWatch();
      winNotif.applyExclusions();
      // Calls switched off → clear any card still ringing (nobody could answer
      // it any more). Also re-arm the Discord watch: turning Calls on widens the
      // RPC scope this install asks for, and the subscription that carries a
      // ringing call is only made when that scope is present.
      calls.applySettings();
      // Phone switched off → retire the helper host. It holds an OS call-state
      // subscription, so leaving it up would keep pushing rings for a feature
      // the user just turned off.
      phone.applySettings();
      refreshDiscordWatch();
      // Wake word toggled → start/stop the mic listener (sync() is idempotent).
      refreshWakeWordWatch();
      // Spotlight: hotkey combo/enable changed → restart the helper listener;
      // index roots changed → repoint the Living Index (restart only on change).
      refreshHotkeyListener();
      refreshLivingIndex();
      // A grant change — or the Media visualiser switch — can add or remove the
      // only consumer of the meter host.
      refreshAudioLevelsWatch();
      refreshStocks().catch(() => {}); // pick up watchlist/provider/key changes immediately
      refreshFootball().catch(() => {}); // pick up team/refresh/key changes immediately
      refreshNews().catch(() => {});      // pick up feed/refresh/key changes immediately
      // Pick up plan/budget changes and a just-enabled News widget/ticker source
      // immediately (their timers are gated on the widget being in use).
      if (_feedWidgetInUse('claude')) refreshClaude().catch(() => {});
      // A Codex/ChatGPT tile added or removed, or a widget granted the stream.
      _syncCodexDemand();
      _codexChanged();
      if (_feedWidgetInUse('news', 'news') && Date.now() - newsState.cache.refreshedAt > 60 * 1000) refreshNews().catch(() => {});
      // Tell every OTHER open surface (Xeneon Edge screen / browser / native app)
      // that the settings changed, so they re-hydrate live instead of clobbering
      // this save with their own stale copy on their next edit. Clients ignore
      // the event when the rev isn't newer than their local one (their own save).
      broadcastSSE('settings', { rev: settings.rev });
      // Slim ack on purpose — no settings echo. The client already holds the
      // exact blob it just posted (same normalizers both sides), nobody ever
      // read the echoed copy, and with imported themes the echo reached
      // multi-MB: a client that discarded it unread left the response stream
      // permanently backpressured, burning one pooled connection per save
      // until the page's 6-per-host pool starved and the dashboard went deaf
      // (the "app disconnected after importing a heavy theme" wedge).
      json({ ok: true, rev: settings.rev, savedAt: Date.now(), lightingApplied });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
