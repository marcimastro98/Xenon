// _hydrateHubSettingsImpl(): merges the settings the engine holds into the ones on this page.
'use strict';

async function _hydrateHubSettingsImpl() {
  try {
    const res = await fetch('/settings', { cache: 'no-store' });
    if (!res.ok) { scheduleHubHydrateRetry(); return; }
    const data = await res.json().catch(() => ({}));
    if (!data || !data.settings) {
      // Server answered but has no settings payload (pre-/settings build): the
      // legacy seed path. Only seed it from a local copy that has real history —
      // never from factory defaults (rev 0), which would overwrite nothing
      // useful anyway and could mask a transient error as "configured".
      markHubHydrated();
      const seeded = loadHubSettings();
      if ((Number(seeded.rev) || 0) > 0) queueHubSettingsServerSave();
      return;
    }
    // Readiness, not the value: the key itself is redacted on the wire and is
    // '' on both sides of this comparison, so comparing values would never fire.
    const keyBefore = geminiKeyReady(hubSettings);
    // rawLocal can still carry a real geminiApiKey written by a pre-v4.11.0
    // build; the merge below pushes it up once and it is never written again.
    let rawLocal = {};
    try { rawLocal = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}') || {}; } catch { rawLocal = {}; }
    const localRaw = normalizeSettings(rawLocal);
    const serverRev = Number.isFinite(data.settings.rev) ? data.settings.rev : 0;
    const localRev = Number.isFinite(localRaw.rev) ? localRaw.rev : 0;
    // If the local copy is newer than the server's — a change (e.g. a new page or
    // a moved widget) that didn't reach the server before the last shutdown —
    // keep local and push it back, instead of letting the stale server copy
    // clobber it. Otherwise the server copy wins (covers a wiped localStorage).
    //
    // "Newer" only means anything WITHIN one settings store: a mirror left over
    // from a store that was replaced (a reinstall, a deleted server/data) always
    // outranks the fresh one, whose rev restarts at 0. See settingsMirrorIsForeign.
    const serverStoreId = typeof data.settings.storeId === 'string' ? data.settings.storeId : '';
    const foreignStore = settingsMirrorIsForeign(serverStoreId, readKnownSettingsStore());
    const localNewer = localRev > serverRev && !foreignStore;
    const base = localNewer ? localRaw : data.settings;
    // Grid-units laundering fence (mirror of the server's POST /settings
    // guard): when the RAW local copy predates the 24-column grid (no
    // layout.gridCols flag) while the server's is already migrated, the local
    // geometry was authored by pre-v4 JS — possibly by CLAMPING this server's
    // already-migrated 24-column layout down to 12 columns. normalizeSettings
    // above just re-migrated that ×2 and stamped the flag, so pushing it
    // (localNewer, e.g. a save that never landed while the server restarted
    // for the update) would hand the server doubled, full-screen geometry it
    // has no way to detect. Layout and presets from the server win instead.
    // The same stale-schema signal also means every settings section the old
    // client never knew is absent from the raw local copy — fill those from
    // the server too, or normalize would reset them to factory defaults and
    // the localNewer push would spread that over the user's configuration.
    const serverLayout = data.settings.dashboardLayout;
    const localUnitsStale = localNewer
      && serverLayout && Number(serverLayout.gridCols) === DASHBOARD_GRID_COLUMNS
      && Number(rawLocal.dashboardLayout && rawLocal.dashboardLayout.gridCols) !== DASHBOARD_GRID_COLUMNS;
    // Snapshot the rendered page list so we can tell, after merging, whether the
    // set of dashboard pages changed (e.g. the server copy restored a page that
    // the local copy — rendered at startup — didn't have). applyDashboardLayout
    // only places widgets into EXISTING page grids; a new page needs the pager
    // rebuilt, or its section/dot never appears until a manual reload.
    const pagesBefore = JSON.stringify(getDashboardLayout().pages.map(p => p.id));
    // Snapshot which widgets sit on which page too. A widget ADDED on another
    // surface (a primary made visible, a duplicate/custom copy, or a group change)
    // reaches us in the layout, but the incremental applyDashboardLayout pass
    // doesn't reliably materialize a newly-visible PRIMARY tile (a bare <section>
    // that lives in #widget-pool until wrapped by a full grid mount) — so it only
    // showed up after a manual reload (GitHub #72). When this placement signature
    // changes we do a full pager rebuild instead, exactly what a reload does.
    const placementBefore = _dashboardPlacementSig(getDashboardLayout());
    // Snapshot the SDK-widget assign/grants so we can tell whether a custom widget
    // was installed/assigned elsewhere: the assign map syncs via settings, but the
    // installed-package registry is a separate /sdk/widgets fetch the other screen
    // never refreshes on sync — leaving the tile stuck on "package was removed"
    // until a manual Rescan (GitHub #72). Refresh the registry when this changes.
    const sdkBefore = JSON.stringify((hubSettings && hubSettings.sdkWidgets) || {});
    // Safe mode lives OUTSIDE sdkWidgets but changes what the widget tiles show —
    // a flip saved on another surface must repaint them here too.
    const safeModeBefore = !!(hubSettings && hubSettings.safeMode);
    // Weather inputs before the merge: when ANOTHER surface changed them, this
    // sync path is the only signal we get — without a refetch here the widget
    // keeps showing the previous location's data until the next poll (GitHub
    // #72: the Edge stayed on stale weather; only an actual language change
    // happened to refetch, via setLang → fetchWeather).
    const weatherBefore = _weatherSyncSig(hubSettings && hubSettings.weather);
    hubSettings = normalizeSettings({
      ...base,
      ...(localUnitsStale
        ? { ...data.settings, ...rawLocal, dashboardLayout: serverLayout, dashboardPresets: data.settings.dashboardPresets }
        : {}),
      rev: Math.max(localRev, serverRev),
      // The server is authoritative and always answers '' (server-only secret).
      // The local fallback exists ONLY for the one-time migration of a key a
      // pre-v4.11.0 build left in localStorage: it is pushed up by the backup
      // save below and never mirrored locally again. `*Set` is what the UI and
      // the gates read, and it must be true in BOTH cases — the server's stored
      // key, or the legacy local one still on its way there.
      geminiApiKey: data.settings.geminiApiKey || localRaw.geminiApiKey || '',
      geminiApiKeySet: data.settings.geminiApiKeySet === true || !!String(localRaw.geminiApiKey || '').trim(),
      // Client-owned settings: keep whichever side actually has them so they
      // survive an older server build / a server restart.
      performance: base.performance || data.settings.performance || localRaw.performance,
      // Imported themes are client-owned (like dashboardPresets); an older server
      // that doesn't round-trip them yet must never blank the gallery on hydrate.
      customThemes: (Array.isArray(base.customThemes) && base.customThemes.length) ? base.customThemes
        : (Array.isArray(localRaw.customThemes) && localRaw.customThemes.length) ? localRaw.customThemes
        : (Array.isArray(data.settings.customThemes) ? data.settings.customThemes : []),
      contentInstalls: (Array.isArray(base.contentInstalls) && base.contentInstalls.length) ? base.contentInstalls
        : (Array.isArray(localRaw.contentInstalls) && localRaw.contentInstalls.length) ? localRaw.contentInstalls
        : (Array.isArray(data.settings.contentInstalls) ? data.settings.contentInstalls : []),
      // Native canvas Ambient scenes are client-owned too — same survival rule.
      ambientScenes: (Array.isArray(base.ambientScenes) && base.ambientScenes.length) ? base.ambientScenes
        : (Array.isArray(localRaw.ambientScenes) && localRaw.ambientScenes.length) ? localRaw.ambientScenes
        : (Array.isArray(data.settings.ambientScenes) ? data.settings.ambientScenes : []),
      gameMode: typeof base.gameMode === 'boolean' ? base.gameMode
        : (typeof data.settings.gameMode === 'boolean' ? data.settings.gameMode : localRaw.gameMode),
      // Weather is server-owned: POST /api/weather/config is its sole writer and
      // the whole-blob POST /settings preserves the stored copy (server.js
      // keep-prev guard, GitHub #109). So the SERVER's weather is authoritative
      // here — even when `base` is localRaw because this surface's unrelated local
      // edits pushed its top-level rev past the server's. Without this override,
      // such a surface takes ...base.weather and resurrects its own stale location
      // (e.g. flips a manual city back to auto on every restart) and ignores a
      // location set on another surface — the app-vs-browser divergence reported
      // as the GitHub #88 follow-up. The one exception is a local weather edit
      // this surface hasn't had acknowledged yet (dirty / parked pre-first-hydrate):
      // keep it so the copy we just fetched can't clobber a change still in flight.
      weather: (_weatherConfigDirty || _weatherConfigSavePending)
        ? ((localRaw && localRaw.weather) || data.settings.weather)
        : (data.settings.weather || (localRaw && localRaw.weather)),
    });
    saveHubSettings({ server: false });
    // The merge landed — server-bound saves are safe from here on: whatever we
    // push now carries the server-informed state, never blind defaults.
    markHubHydrated();
    // Adopt the store we just merged with, so the next load can tell a mirror of
    // THIS store from one left behind by an install it replaced.
    rememberSettingsStore(serverStoreId);
    // Say it once, and only when the check actually changed the outcome: this
    // surface was holding a newer-looking copy of a store that no longer exists,
    // and its dashboard has just been replaced by the one on the PC. Swapping a
    // user's whole layout without a word is the "reads like a broken setting"
    // failure the scene-fallback toast exists for.
    if (foreignStore && localRev > serverRev && window.XenonToast) {
      window.XenonToast.show({
        type: 'info',
        title: t('settings_store_changed'),
        message: t('settings_store_changed_hint'),
      });
    }
    // Back the local copy up to the server when it won the merge, when it holds
    // an API key the server was missing (also triggers wake-word start), or when
    // a save was parked while we were still blind (pre-hydrate user change).
    // The middle term is the legacy-key migration: this browser still holds a
    // Gemini key in localStorage and the server has none stored. One save moves
    // it, after which the local mirror is written without it (see
    // saveLocalHubSettings) and this can never fire again on this device.
    if (localNewer || (hubSettings.geminiApiKey && data.settings.geminiApiKeySet !== true)
        || _hubServerSavePending) {
      // Through the queue (not a one-shot POST): a save the server misses here —
      // restarting mid-update, a transient network error — retries until it lands.
      queueHubSettingsServerSave();
    }
    _hubServerSavePending = false;
    // A weather change made before this first hydrate was parked (it must not push
    // over its own dedicated channel until we've merged with the server); flush it
    // now that we have, so the pre-hydrate location edit still reaches the server.
    if (_weatherConfigSavePending) { _weatherConfigSavePending = false; queueWeatherConfigServerSave(); }
    applyHubSettings();
    // Rebuild the pager when the page set changed (creates the missing page
    // section + dot); otherwise just reposition widgets in the existing grids.
    // DashboardPages.rebuild() runs applyDashboardLayout() itself at the end.
    const pagesAfter = JSON.stringify(getDashboardLayout().pages.map(p => p.id));
    const placementAfter = _dashboardPlacementSig(getDashboardLayout());
    // A page-set OR widget-placement change needs the full rebuild (mounts new page
    // grids AND re-wraps primaries into grid items, which the incremental pass
    // can't do for a bare pooled <section>); an unchanged set is just a reposition.
    // The pager preserves the current page across a rebuild, so this never yanks the
    // viewer to page 1.
    if ((pagesAfter !== pagesBefore || placementAfter !== placementBefore)
        && window.DashboardPages && typeof window.DashboardPages.rebuild === 'function') {
      window.DashboardPages.rebuild();
    } else if (typeof applyDashboardLayout === 'function') {
      applyDashboardLayout();
    }
    // Refetch/repoll weather when the merge changed what — or how often — we
    // fetch, mirroring what the local weather-control handlers already do.
    const weatherAfter = _weatherSyncSig(hubSettings.weather);
    if (weatherAfter.fetch !== weatherBefore.fetch) queueWeatherSettingsRefresh();
    if (weatherAfter.refreshMin !== weatherBefore.refreshMin
        && typeof startWeatherPolling === 'function') startWeatherPolling();
    // Reflect per-tile Browser state (toolbar hidden) that another surface changed
    // onto our already-mounted tiles — a mounted tile reads its config only at
    // mount, so without this the Edge kept its toolbar out of step (GitHub #72).
    if (window.BrowserTile && typeof window.BrowserTile.reconcileFromSettings === 'function') {
      window.BrowserTile.reconcileFromSettings();
    }
    // A custom (SDK) widget installed/assigned on another surface arrives here as a
    // changed assign map, but the installed-package registry is a separate
    // /sdk/widgets fetch this screen loaded once at boot — so the tile would render
    // "This widget package was removed" until a manual Rescan. Re-fetch the registry
    // (exactly what Rescan does) only when the SDK-widget state actually changed, so
    // an unrelated broadcast never triggers a disk rescan (GitHub #72).
    if (JSON.stringify(hubSettings.sdkWidgets || {}) !== sdkBefore
        && window.CustomWidget && typeof window.CustomWidget.refreshPackages === 'function') {
      window.CustomWidget.refreshPackages();
    }
    if (safeModeBefore !== !!hubSettings.safeMode
        && window.CustomWidget && typeof window.CustomWidget.renderWidgets === 'function') {
      window.CustomWidget.renderWidgets();
    }
    // Re-push the current album-art colour to the lighting bridge now that the
    // settings (and thus the server's lighting state) are hydrated: at a cold
    // boot the bridge may not have been ready for media.js's first one-shot push,
    // and its de-dupe would never retry — leaving the lights out of sync until a
    // manual reload. Best-effort: the server ignores it when lighting is off.
    if (typeof refreshAlbumAccent === 'function') refreshAlbumAccent();
    if ($('settings-overlay') && !$('settings-overlay').hidden) renderSettingsModal();
    // If the key appeared or disappeared after hydration, re-sync the AI chat UI.
    // This handles the case where localStorage was empty at startup but the key
    // was found in the server settings file (e.g. after a fresh browser session).
    if (keyBefore !== geminiKeyReady(hubSettings)) {
      if (typeof onAiKeyUpdated === 'function') onAiKeyUpdated();
    }
    if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
    // Bring the logon "open in browser" task in line with the saved intent —
    // a no-op inside the Edge iframe, so pure-Edge installs never get a tab.
    reconcileAutoOpenBrowser();
    // The first-run question, now that the persisted state is authoritative: one,
    // never two in a row. The app that draws widgets asks how Xenon is used, and
    // that answer says where the dashboard goes too; the browser and other shells
    // have only the screen to ask about. No tour: nobody asked for one yet, so it
    // waits a tap away, in Settings and among Bit's starters.
    //
    // DEFERRED, and what it waits for is the SCRIPT TAGS, not the page. This
    // function is started at the bottom of settings.js — a script tag ~80 tags
    // EARLIER in the document than usage-ask.js and surface-picker.js — and it
    // resumes from a fetch to loopback that can answer in single-digit
    // milliseconds. Whoever wins that race decided whether the globals existed
    // yet: when the fetch won, they were still undefined here and the question
    // silently never ran. Measured, not theorised.
    //
    // `DOMContentLoaded`, NOT `load`. Every classic script in the document has
    // executed by then, so the race above is closed just as completely — while
    // `load` also waits for the images, fonts, backdrop media and widget iframes
    // of a whole dashboard, which is why the first-run question used to arrive
    // long after the dashboard was on screen and looking finished. There is
    // nothing in either surface that needs a decoded image.
    const runFirstRunSurfaces = () => {
      // A fresh install is told what's new too, after this question: the What's
      // New waits for any first-run overlay (js/interrupt-queue.js).
      const cards = window.XenonStartupCards;
      const returning = !!window.XenonReleaseNotice && !!cards && window.XenonReleaseNotice.returningUser({
        asked: getSurfaceChoice().asked, notesSeen: cards.releaseNotesSeen(), tourSeen: getOnboardingSeen(),
      });
      const asked = !!(window.UsageAsk && typeof window.UsageAsk.maybeStart === 'function'
        && window.UsageAsk.maybeStart({ returning }));
      if (!asked && window.SurfacePicker && typeof window.SurfacePicker.maybeStart === 'function') {
        window.SurfacePicker.maybeStart();
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', runFirstRunSurfaces, { once: true });
    else runFirstRunSurfaces();
  } catch {
    // Network error (server restarting, offline boot): stay in the parked state
    // and try again — never fall through to pushing blind local state.
    scheduleHubHydrateRetry();
  }
}
