// What the deck editor knows of this PC while it is open: which apps and services are connected,
// what the widgets add to a key, and the devices of Home Assistant.
'use strict';

(() => {
  const state = {
    // OBS and remote-control capability flags. Both start null (unknown) so their
    // actions show until we learn they're unavailable. Re-checked every time the
    // editor opens, so configuring either feature in Settings takes effect without
    // a full page reload.
    obsConfigured: null,
    remoteConfigured: null,
    twitchConnected: null,
    youtubeConnected: null,
    streamerbotConfigured: null,
    discordConnected: null,
    spotifyConnected: null,
    homeAssistantConfigured: null,
    chromaEnabled: null,
    wavelinkEnabled: null,
    voicemeeterAvailable: null,
    vmStatePromise: null,    // one read of the running mixer feeds both pickers
    signalrgbEnabled: null,
    lightingConfigured: null,
    claudeLinked: null,        // Claude Code hooks installed (gates the claude group)
    // The whole capabilities block, kept raw so an action can name the one it
    // needs via `requires` (see actionGateOk). null until the first fetch lands.
    serverCaps: null,
    claudeProjectsPromise: null,   // the projects a run may be started in
    signalRgbEffectsPromise: null,   // SignalRGB effect list ({value,label})
    scenesPromise: null,
    sourcesPromise: null,
    appsPromise: null,
    storeAppsPromise: null,
    sbActionsPromise: null,
    sbCodeTriggersPromise: null,
    sbGlobalsPromise: null,
    audioDevicesPromise: null,
    discordChannelsPromise: null,
    discordSoundsPromise: null,
    haEntitiesPromise: null,
    haDomains: null,   // Set of HA device domains the user actually has (null = unknown)
    wlChannelsPromise: null,   // Wave Link mixer channel list ({value,label})
    wlStatePromise: null,      // one live mixer read, shared by the mix/effect/output pickers
    lightDevicesPromise: null,   // lighting hub device list ({value:id,label})
    sdkWidgetsPromise: null,
    sdkMacroItemsCache: null,   // resolved macro list; the sync gate reads it (null = unknown → hidden)
    sdkHandlerItemsCache: null, // resolved handler-action list (same gating idea)
  };

  function refreshCapabilities() {
    return fetch('/actions/catalog').then((r) => r.json()).then((d) => {
      const nextObs = !!(d && d.capabilities && d.capabilities.obsConfigured);
      const nextRemote = !!(d && d.capabilities && d.capabilities.remoteConfigured);
      const nextTwitch = !!(d && d.capabilities && d.capabilities.twitchConnected);
      const nextYouTube = !!(d && d.capabilities && d.capabilities.youtubeConnected);
      const nextSb = !!(d && d.capabilities && d.capabilities.streamerbotConfigured);
      const nextDiscord = !!(d && d.capabilities && d.capabilities.discordConnected);
      const nextSpotify = !!(d && d.capabilities && d.capabilities.spotifyConnected);
      const nextHa = !!(d && d.capabilities && d.capabilities.homeAssistantConfigured);
      const nextChroma = !!(d && d.capabilities && d.capabilities.chromaEnabled);
      const nextWl = !!(d && d.capabilities && d.capabilities.wavelinkEnabled);
      const nextVm = !!(d && d.capabilities && d.capabilities.voicemeeterAvailable);
      const nextSignalRgb = !!(d && d.capabilities && d.capabilities.signalrgbEnabled);
      const nextLighting = !!(d && d.capabilities && d.capabilities.lightingConfigured);
      const nextClaude = !!(d && d.capabilities && d.capabilities.claudeLinked);
      state.serverCaps = (d && d.capabilities) || null;
      const changed = nextObs !== state.obsConfigured || nextRemote !== state.remoteConfigured || nextTwitch !== state.twitchConnected || nextYouTube !== state.youtubeConnected || nextSb !== state.streamerbotConfigured || nextDiscord !== state.discordConnected || nextSpotify !== state.spotifyConnected || nextHa !== state.homeAssistantConfigured || nextChroma !== state.chromaEnabled || nextWl !== state.wavelinkEnabled || nextVm !== state.voicemeeterAvailable || nextSignalRgb !== state.signalrgbEnabled || nextLighting !== state.lightingConfigured || nextClaude !== state.claudeLinked;
      state.obsConfigured = nextObs;
      state.remoteConfigured = nextRemote;
      state.twitchConnected = nextTwitch;
      state.youtubeConnected = nextYouTube;
      state.streamerbotConfigured = nextSb;
      state.discordConnected = nextDiscord;
      state.spotifyConnected = nextSpotify;
      state.homeAssistantConfigured = nextHa;
      state.chromaEnabled = nextChroma;
      state.wavelinkEnabled = nextWl;
      state.voicemeeterAvailable = nextVm;
      state.signalrgbEnabled = nextSignalRgb;
      state.lightingConfigured = nextLighting;
      state.claudeLinked = nextClaude;
      if (changed) { state.scenesPromise = null; state.sourcesPromise = null; state.sbActionsPromise = null; state.sbCodeTriggersPromise = null; state.sbGlobalsPromise = null; state.discordChannelsPromise = null; state.discordSoundsPromise = null; state.haEntitiesPromise = null; state.haDomains = null; state.wlChannelsPromise = null; state.wlStatePromise = null; state.vmStatePromise = null; state.lightDevicesPromise = null; state.signalRgbEffectsPromise = null; state.claudeProjectsPromise = null; }   // config changed → re-fetch the lists
      // Compute the set of HA device domains the user actually HAS, so the action
      // picker offers only the actions relevant to their devices (generic, not
      // hardcoded). This runs after the fast capability check; the caller does a
      // background re-render when the returned `changed` flips, so the first paint
      // isn't blocked on the entity list.
      // SDK widget macros: the "Widget" category is offered only when at least
      // one installed package contributes macros (and the SDK is enabled), so it
      // never shows as an empty group to everyone else. Seed the "previous count"
      // as 0 (not -1) on the first probe so a disabled/empty SDK — which resolves
      // to 0 macros — reports no change and doesn't force a spurious re-render.
      const prevSdk = (state.sdkMacroItemsCache ? state.sdkMacroItemsCache.length : 0) + (state.sdkHandlerItemsCache ? state.sdkHandlerItemsCache.length : 0);
      const sdkCheck = Promise.all([sdkMacros(), sdkHandlers()])
        .then(([m, h]) => (((m ? m.length : 0) + (h ? h.length : 0)) !== prevSdk)).catch(() => false);
      let haCheck;
      if (!nextHa) {
        const had = state.haDomains; state.haDomains = null;
        haCheck = Promise.resolve(changed || had !== null);
      } else {
        const prev = state.haDomains ? [...state.haDomains].sort().join(',') : null;
        haCheck = haEntities().then((items) => {
          state.haDomains = new Set((items || []).map((it) => { const v = String(it.value); const i = v.indexOf('.'); return i > 0 ? v.slice(0, i) : ''; }).filter(Boolean));
          return changed || ([...state.haDomains].sort().join(',') !== prev);
        }).catch(() => changed);
      }
      return Promise.all([haCheck, sdkCheck]).then(([a, b]) => a || b);
    }).catch(() => false);
  }

  // Live Home Assistant entity list ({value:entity_id, label:"Area › Name"}) for the
  // haEntity picker. Falls back to [] (→ typed entity-id field) when HA is off.
  function haEntities() {
    if (!state.haEntitiesPromise) state.haEntitiesPromise = fetch('/api/homeassistant/entities').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.entities)) ? d.entities : []).map((e) => ({ value: e.id, label: (e.area ? e.area + ' › ' : '') + (e.name || e.id) })))
      .catch(() => []);
    return state.haEntitiesPromise;
  }

  // Third-party widget SDK: installed packages (validated manifests) for the
  // macro picker and the "reflect a widget state" binding. Only fetched when the
  // SDK is enabled; the settings blob is the classic-script `hubSettings` (bare
  // name — it is NOT window.hubSettings).
  function sdkEnabled() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.sdkWidgets : null;
    return !!(hs && hs.enabled);
  }

  function sdkPackages() {
    if (!state.sdkWidgetsPromise) {
      state.sdkWidgetsPromise = (sdkEnabled()
        ? fetch('/sdk/widgets').then((r) => r.json()).then((d) => ((d && Array.isArray(d.packages)) ? d.packages : []))
        : Promise.resolve([])
      ).catch(() => []);
    }
    return state.sdkWidgetsPromise;
  }

  // Deck macros contributed by installed packages ({value:'pkg/macroId',
  // label:'Widget › Macro'}). The server re-checks grants + manifest at run time.
  function sdkMacros() {
    return sdkPackages().then((pkgs) => {
      const out = [];
      pkgs.forEach((p) => {
        ((p.deck && p.deck.actions) || []).forEach((m) => out.push({ value: p.id + '/' + m.id, label: p.name + ' › ' + m.name }));
      });
      state.sdkMacroItemsCache = out;
      return out;
    });
  }

  // Handler actions contributed by installed packages ({value:'pkg/handlerId',
  // label:'Widget › Handler', params:[declared params]}). The server re-checks
  // the per-handler grant + manifest at run time.
  function sdkHandlers() {
    return sdkPackages().then((pkgs) => {
      const out = [];
      pkgs.forEach((p) => {
        ((p.deck && p.deck.handlers) || []).forEach((h) => out.push({
          value: p.id + '/' + h.id,
          label: p.name + ' › ' + h.name,
          params: Array.isArray(h.params) ? h.params : [],
        }));
      });
      state.sdkHandlerItemsCache = out;
      return out;
    });
  }

  // Deck states published by installed packages, for the state-binding picker.
  function sdkDeckStates() {
    return sdkPackages().then((pkgs) => {
      const out = [];
      pkgs.forEach((p) => {
        ((p.deck && p.deck.states) || []).forEach((s) => out.push({ value: p.id + '/' + s.id, label: p.name + ' › ' + s.name }));
      });
      return out;
    });
  }

  window.DeckEditorConnected = {
    state, refreshCapabilities, haEntities, sdkMacros, sdkHandlers, sdkDeckStates,
  };
})();
