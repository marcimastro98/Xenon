// The lists the deck editor offers in its menus, each asked of the server once: scenes, sources,
// actions, channels, mixers, lights, apps and sound devices.
'use strict';

(() => {
  const { t } = window.DeckEditorFormRows;
  const { state } = window.DeckEditorConnected;

  // Capabilities are (re)probed every time the editor opens (see open()), so we
  // do NOT fetch /actions/catalog at module load — a page with no Deck key being
  // edited shouldn't hit the endpoint at all.
  function obsScenes() {
    if (!state.scenesPromise) state.scenesPromise = fetch('/obs/scenes').then((r) => r.json()).then((d) => (d && d.scenes) || []).catch(() => []);
    return state.scenesPromise;
  }

  function obsSources() {
    if (!state.sourcesPromise) state.sourcesPromise = fetch('/obs/sources').then((r) => r.json()).then((d) => (d && d.sources) || []).catch(() => []);
    return state.sourcesPromise;
  }

  // Live Streamer.bot action list ({value:id, label:name}) for the sbAction picker.
  function sbActions() {
    if (!state.sbActionsPromise) state.sbActionsPromise = fetch('/streamerbot/actions').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.actions)) ? d.actions : []).map((a) => ({ value: a.id, label: a.name || a.id })))
      .catch(() => []);
    return state.sbActionsPromise;
  }

  // Live Streamer.bot code-trigger list ({value:name, label:"Group › name"}) for the
  // sbCodeTrigger picker. Stored by trigger name (what ExecuteCodeTrigger takes).
  function sbCodeTriggers() {
    if (!state.sbCodeTriggersPromise) state.sbCodeTriggersPromise = fetch('/streamerbot/codetriggers').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.triggers)) ? d.triggers : []).map((a) => ({ value: a.name, label: (a.group ? a.group + ' › ' : '') + a.name })))
      .catch(() => []);
    return state.sbCodeTriggersPromise;
  }

  // Live Streamer.bot global-variable names for the "reflect a global" state picker.
  function sbGlobals() {
    if (!state.sbGlobalsPromise) state.sbGlobalsPromise = fetch('/streamerbot/globals').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.globals)) ? d.globals : []).map((g) => String(g.name)).filter(Boolean))
      .catch(() => []);
    return state.sbGlobalsPromise;
  }

  // Live voice-channel list ({value:id, label:"Guild › Channel"}) for the Discord
  // join picker. Falls back to [] (→ typed channel-id field) when Discord is off.
  function discordChannels() {
    if (!state.discordChannelsPromise) state.discordChannelsPromise = fetch('/stream/discord/channels').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.channels)) ? d.channels : []).map((c) => ({ value: c.id, label: (c.guild ? c.guild + ' › ' : '') + (c.name || c.id) })))
      .catch(() => []);
    return state.discordChannelsPromise;
  }

  // Live soundboard list for the discordSound picker. Each item's value is the
  // opaque "guildId|soundId" ref the provider parses back at play time; the label
  // is "Server › Sound". Falls back to [] (→ read-only field) when Discord is off.
  function discordSounds() {
    if (!state.discordSoundsPromise) state.discordSoundsPromise = fetch('/stream/discord/sounds').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.sounds)) ? d.sounds : []).map((s) => ({ value: (s.guildId || '') + '|' + s.id, label: (s.guild ? s.guild + ' › ' : '') + (s.name || s.id) })))
      .catch(() => []);
    return state.discordSoundsPromise;
  }

  // Installed SignalRGB effects ({value:effectName, label:"Name (kind)"}) for the
  // signalRgbEffect picker. Empty (→ typed field) when SignalRGB is off/absent.
  function signalRgbEffects() {
    if (!state.signalRgbEffectsPromise) state.signalRgbEffectsPromise = fetch('/api/signalrgb/effects').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.effects)) ? d.effects : []).map((e) => ({ value: e.value, label: e.label })))
      .catch(() => []);
    return state.signalRgbEffectsPromise;
  }

  // The projects a Claude Code run may be started in ({value:id, label:name}) —
  // the server's own allowlist, so the editor cannot offer a folder the runner
  // would refuse.
  function claudeProjects() {
    if (!state.claudeProjectsPromise) {
      state.claudeProjectsPromise = fetch('/api/claude/projects').then((r) => r.json())
        .then((d) => ((d && Array.isArray(d.projects)) ? d.projects : []).map((p) => ({ value: p.id, label: p.name })))
        .catch(() => []);
    }
    return state.claudeProjectsPromise;
  }

  // Live Wave Link mixer channel list ({value:mixId, label:name}) for the wlChannel
  // picker. Falls back to [] (→ typed mixId field) when Wave Link is off/unreachable.
  function wlChannels() {
    if (!state.wlChannelsPromise) state.wlChannelsPromise = fetch('/api/wavelink/channels').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.channels)) ? d.channels : []))
      .catch(() => []);
    return state.wlChannelsPromise;
  }

  // One read of the live mixer feeds the mix, effect and output-device pickers.
  function wlState() {
    if (!state.wlStatePromise) state.wlStatePromise = fetch('/api/wavelink/state').then((r) => r.json()).catch(() => null);
    return state.wlStatePromise;
  }

  // Mixes, with the three words the action contract has always accepted listed
  // first: a key configured under Wave Link 2 stores 'stream' and must keep
  // meaning "the stream mix" against a Wave Link 3 mixer, where the mixes carry
  // the names their owner gave them. On 2.x the named list IS local/stream, so
  // appending it would show the same two controls twice.
  function wlMixOptions() {
    return wlState().then((s) => {
      const generic = [
        { value: 'stream', label: t('deck_wl_mix_stream', 'Stream mix') },
        { value: 'local', label: t('deck_wl_mix_local', 'Personal / local mix') },
        { value: 'all', label: t('deck_wl_mix_all', 'Every mix') },
      ];
      const named = (s && s.capabilities && s.capabilities.namedMixes && Array.isArray(s.mixes))
        ? s.mixes.map((m) => ({ value: m.id, label: m.name })) : [];
      return generic.concat(named);
    });
  }

  // The running Voicemeeter, read once. `strips` and `buses` come back sized for
  // the edition that is actually running, which is the whole point: offering
  // Bus[7] to somebody on plain Voicemeeter builds a key that writes nowhere.
  function vmState() {
    if (!state.vmStatePromise) state.vmStatePromise = fetch('/api/voicemeeter/state').then((r) => r.json()).catch(() => null);
    return state.vmStatePromise;
  }

  function vmStripOptions() {
    return vmState().then((s) => ((s && Array.isArray(s.strips)) ? s.strips : [])
      .map((x) => ({ value: String(x.index), label: x.index + ' — ' + x.label })));
  }

  // Buses are offered BY LABEL, never by index: A1/B2 are the words on the
  // mixer's own buttons, and the index behind a label moves between editions.
  function vmBusOptions() {
    return vmState().then((s) => ((s && Array.isArray(s.buses)) ? s.buses : [])
      .map((x) => ({ value: x.label, label: x.label + ' — ' + x.name })));
  }

  // Effects are per channel, but their ids are unique across the mixer, so the
  // picker lists them all and qualifies each with the channel it belongs to.
  function wlEffectOptions() {
    return wlState().then((s) => {
      const out = [];
      for (const c of (s && Array.isArray(s.channels)) ? s.channels : []) {
        for (const e of Array.isArray(c.effects) ? c.effects : []) out.push({ value: e.id, label: c.name + ' — ' + e.name });
      }
      return out;
    });
  }

  function wlOutputOptions() {
    return wlState().then((s) => {
      const devs = (s && s.outputs && Array.isArray(s.outputs.devices)) ? s.outputs.devices : [];
      return devs.map((d) => ({ value: d.id, label: d.name }));
    });
  }

  // Lighting hub device list ({value:id, label:name}) for the lightDevice picker.
  // Falls back to [] (→ typed id field) when no lighting is configured/reachable.
  // Also carries the parts of each device with a map, for the lightPart picker.
  function lightingLists() {
    if (!state.lightDevicesPromise) state.lightDevicesPromise = fetch('/api/lighting/devices').then((r) => r.json())
      .then((d) => ({
        devices: (d && Array.isArray(d.devices)) ? d.devices : [],
        parts: (d && Array.isArray(d.parts)) ? d.parts : [],
      }))
      .catch(() => ({ devices: [], parts: [] }));
    return state.lightDevicesPromise;
  }

  function lightDevices() { return lightingLists().then((l) => l.devices); }

  // Lazy fetch of apps with an audio session from /audio/apps. Returns
  // Promise<{value,label}[]> where value is the durable process name and label is
  // the friendly display name. /audio/apps is broader than /audio: it lists apps
  // with an active OR inactive session, so apps that aren't playing right now still
  // appear. Not reset in refreshCapabilities — the app list is not a capability flag.
  function audioApps() {
    if (!state.appsPromise) state.appsPromise = fetch('/audio/apps').then((r) => r.json()).then((d) => {
      const list = (d && Array.isArray(d.apps)) ? d.apps : [];
      const seen = new Set();
      const out = [];
      for (const a of list) {
        const value = (a && a.proc) ? String(a.proc) : '';
        if (!value || seen.has(value.toLowerCase())) continue;
        seen.add(value.toLowerCase());
        out.push({ value, label: (a && a.name) || value });
      }
      return out;
    }).catch(() => []);
    return state.appsPromise;
  }

  // Lazy fetch of installed Store/UWP apps from /apps/store. Returns
  // Promise<{value,label}[]> where value is the AppUserModelID and label the app name.
  function storeApps() {
    if (!state.storeAppsPromise) state.storeAppsPromise = fetch('/apps/store').then((r) => r.json())
      .then((d) => (d && Array.isArray(d.apps)) ? d.apps : []).catch(() => []);
    return state.storeAppsPromise;
  }

  // Lazy fetch of the output devices from /audio. Returns
  // Promise<{value,label}[]> where value is the device id the audioDevice action
  // needs and label is what the device is called on screen. NOT reset in
  // refreshCapabilities: the device list is not a capability flag. Re-fetched
  // per editor open, which is often enough — a headset plugged in mid-edit shows
  // up the next time the picker is opened.
  function audioDevices() {
    if (!state.audioDevicesPromise) state.audioDevicesPromise = fetch('/audio').then((r) => r.json()).then((d) => {
      const list = (d && Array.isArray(d.speakers)) ? d.speakers : [];
      const out = [];
      const seen = new Set();
      for (const s of list) {
        const value = (s && typeof s.id === 'string') ? s.id : '';
        if (!value || seen.has(value)) continue;
        seen.add(value);
        // `label` is the full "Speakers (Realtek)" reading; `name` is the bare
        // device. Either is a name a person recognises — the id is not.
        out.push({ value, label: (s && (s.label || s.name)) || value, isDefault: !!(s && s.isDefault) });
      }
      return out;
    }).catch(() => []);
    return state.audioDevicesPromise;
  }

  window.DeckEditorMenuLists = {
    obsScenes, obsSources, sbActions, sbCodeTriggers, sbGlobals, discordChannels, discordSounds,
    signalRgbEffects, claudeProjects, wlChannels, wlMixOptions, vmStripOptions, vmBusOptions,
    wlEffectOptions, wlOutputOptions, lightingLists, lightDevices, audioApps, storeApps, audioDevices,
  };
})();
