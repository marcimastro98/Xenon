'use strict';
// Deck key editor: a modal to create/edit ONE key. It does not touch storage —
// it builds a raw key object and hands it back via opts.onSave(rawKey), or
// opts.onDelete(). Caller (deck.js) persists + re-renders. window.DeckEditor.
(function () {
  const t = (k) => (typeof window.t === 'function' ? window.t(k) : k);

  // Shared preset palette for every Deck colour picker (accent, tap-effect colour,
  // LED colour). Ordered as a spectrum — red → orange → yellow → green → teal →
  // blue → indigo → purple → pink — then the neutrals (white, grey), so the row
  // reads as an organised rainbow instead of a scattered set. The native colour
  // dialog was unreliable in the WebView, so these presets are the picker.
  const DECK_SWATCHES = [
    '#ff3b30', // red
    '#ff6b22', // red-orange
    '#ff9500', // orange
    '#ffcc00', // yellow
    '#a2e635', // lime
    '#34c759', // green
    '#00c7be', // teal
    '#5ac8fa', // sky
    '#2b6cff', // blue
    '#5e5ce6', // indigo
    '#af52de', // purple
    '#ff2d92', // pink
    '#e7e9ee', // white
    '#8e8e93', // grey
  ];

  // Append a rainbow "any colour" swatch that opens the in-app ColorPicker —
  // the escape hatch beyond the presets (the native dialog stays unusable in
  // the iCUE WebView). `getValue`/`apply` bridge to the row's local state.
  function addCustomSwatch(row, getValue, apply) {
    if (!window.ColorPicker) return null;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'deck-ed-swatch cp-open-swatch';
    b.title = t('color_custom');
    b.addEventListener('click', () => window.ColorPicker.open({
      anchor: b, value: getValue() || '#1ed760', onPick: apply,
    }));
    row.appendChild(b);
    return b;
  }
  // True when `hex` came from the picker rather than the preset row.
  const isCustomColor = (hex) => !!hex && !DECK_SWATCHES.includes(hex);

  // A reusable swatch row: optional "none" cell, the preset palette, and the
  // custom picker. get/set bridge the caller's local state. Returns {el, refresh}.
  function swatchRow(getVal, setVal, opts) {
    const row = document.createElement('div'); row.className = 'deck-ed-swatches';
    let customBtn = null;
    const refresh = () => {
      const want = getVal() || '';
      row.querySelectorAll('.deck-ed-swatch').forEach((s) => s.classList.toggle('sel', s.dataset.c === want));
      if (customBtn) customBtn.classList.toggle('sel', !!want && isCustomColor(want));
    };
    if (!opts || opts.allowNone !== false) {
      const none = document.createElement('button');
      none.type = 'button'; none.className = 'deck-ed-swatch deck-ed-swatch-none'; none.dataset.c = ''; none.textContent = '✕'; none.title = '—';
      none.addEventListener('click', () => { setVal(''); refresh(); });
      row.appendChild(none);
    }
    DECK_SWATCHES.forEach((c) => {
      const s = document.createElement('button'); s.type = 'button'; s.className = 'deck-ed-swatch';
      s.dataset.c = c; s.style.background = c; s.title = c;
      s.addEventListener('click', () => { setVal(c); refresh(); });
      row.appendChild(s);
    });
    customBtn = addCustomSwatch(row, () => getVal() || '#1ed760', (hex) => { setVal(hex); refresh(); });
    refresh();
    return { el: row, refresh };
  }

  // Curated two-colour presets for the gradient face — one tap sets both stops
  // and the direction. Rendered as chips painted with the actual gradient.
  const GRADIENT_PRESETS = [
    { c1: '#ff6b22', c2: '#ff2d92', dir: 'd' },   // sunset
    { c1: '#2b6cff', c2: '#00c7be', dir: 'd' },   // ocean
    { c1: '#af52de', c2: '#2b6cff', dir: 'd' },   // royal
    { c1: '#ff3b30', c2: '#ffcc00', dir: 'v' },   // ember
    { c1: '#34c759', c2: '#00c7be', dir: 'v' },   // emerald
    { c1: '#5ac8fa', c2: '#e7e9ee', dir: 'v' },   // ice
    { c1: '#5e5ce6', c2: '#ff2d92', dir: 'r' },   // violet dusk
    { c1: '#8e8e93', c2: '#1c1c1e', dir: 'r' },   // carbon
  ];
  // CSS preview of a gradient pick (mirrors the cap's direction variants).
  function gradientCss(c1, c2, dir) {
    if (dir === 'v') return 'linear-gradient(180deg, ' + c1 + ', ' + c2 + ')';
    if (dir === 'r') return 'radial-gradient(135% 135% at 30% 18%, ' + c1 + ', ' + c2 + ')';
    return 'linear-gradient(135deg, ' + c1 + ', ' + c2 + ')';
  }

  // Style clipboard for "copy style" / "paste style" across keys (and decks).
  // Session-scoped on purpose: styles travel between editors, not restarts.
  let styleClipboard = null;

  // Darken a #rrggbb (or #rgb) hex — used to derive the second gradient stop
  // when auto-tinting from an image that yields a single dominant colour.
  function darkenHex(hex, factor) {
    const v = String(hex || '').replace('#', '');
    const full = v.length === 3 ? v.split('').map((ch) => ch + ch).join('') : v.slice(0, 6);
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return hex;
    const ch = (i) => Math.max(0, Math.min(255, Math.round(parseInt(full.slice(i, i + 2), 16) * factor)));
    return '#' + [ch(0), ch(2), ch(4)].map((n) => n.toString(16).padStart(2, '0')).join('');
  }

  // OBS and remote-control capability flags. Both start null (unknown) so their
  // actions show until we learn they're unavailable. Re-checked every time the
  // editor opens, so configuring either feature in Settings takes effect without
  // a full page reload.
  let obsConfigured = null;
  let remoteConfigured = null;
  let twitchConnected = null;
  let youtubeConnected = null;
  let streamerbotConfigured = null;
  let discordConnected = null;
  let spotifyConnected = null;
  let homeAssistantConfigured = null;
  let chromaEnabled = null;
  let wavelinkEnabled = null;
  let signalrgbEnabled = null;
  let lightingConfigured = null;
  let signalRgbEffectsPromise = null;   // SignalRGB effect list ({value,label})
  let scenesPromise = null;
  let sourcesPromise = null;
  let appsPromise = null;
  let storeAppsPromise = null;
  let sbActionsPromise = null;
  let sbCodeTriggersPromise = null;
  let sbGlobalsPromise = null;
  let discordChannelsPromise = null;
  let discordSoundsPromise = null;
  let haEntitiesPromise = null;
  let haDomains = null;   // Set of HA device domains the user actually has (null = unknown)
  let wlChannelsPromise = null;   // Wave Link mixer channel list ({value,label})
  let lightDevicesPromise = null;   // lighting hub device list ({value:id,label})
  let sdkWidgetsPromise = null;
  let sdkMacroItemsCache = null;   // resolved macro list; the sync gate reads it (null = unknown → hidden)
  let sdkHandlerItemsCache = null; // resolved handler-action list (same gating idea)
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
      const nextSignalRgb = !!(d && d.capabilities && d.capabilities.signalrgbEnabled);
      const nextLighting = !!(d && d.capabilities && d.capabilities.lightingConfigured);
      const changed = nextObs !== obsConfigured || nextRemote !== remoteConfigured || nextTwitch !== twitchConnected || nextYouTube !== youtubeConnected || nextSb !== streamerbotConfigured || nextDiscord !== discordConnected || nextSpotify !== spotifyConnected || nextHa !== homeAssistantConfigured || nextChroma !== chromaEnabled || nextWl !== wavelinkEnabled || nextSignalRgb !== signalrgbEnabled || nextLighting !== lightingConfigured;
      obsConfigured = nextObs;
      remoteConfigured = nextRemote;
      twitchConnected = nextTwitch;
      youtubeConnected = nextYouTube;
      streamerbotConfigured = nextSb;
      discordConnected = nextDiscord;
      spotifyConnected = nextSpotify;
      homeAssistantConfigured = nextHa;
      chromaEnabled = nextChroma;
      wavelinkEnabled = nextWl;
      signalrgbEnabled = nextSignalRgb;
      lightingConfigured = nextLighting;
      if (changed) { scenesPromise = null; sourcesPromise = null; sbActionsPromise = null; sbCodeTriggersPromise = null; sbGlobalsPromise = null; discordChannelsPromise = null; discordSoundsPromise = null; haEntitiesPromise = null; haDomains = null; wlChannelsPromise = null; lightDevicesPromise = null; signalRgbEffectsPromise = null; }   // config changed → re-fetch the lists
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
      const prevSdk = (sdkMacroItemsCache ? sdkMacroItemsCache.length : 0) + (sdkHandlerItemsCache ? sdkHandlerItemsCache.length : 0);
      const sdkCheck = Promise.all([sdkMacros(), sdkHandlers()])
        .then(([m, h]) => (((m ? m.length : 0) + (h ? h.length : 0)) !== prevSdk)).catch(() => false);
      let haCheck;
      if (!nextHa) {
        const had = haDomains; haDomains = null;
        haCheck = Promise.resolve(changed || had !== null);
      } else {
        const prev = haDomains ? [...haDomains].sort().join(',') : null;
        haCheck = haEntities().then((items) => {
          haDomains = new Set((items || []).map((it) => { const v = String(it.value); const i = v.indexOf('.'); return i > 0 ? v.slice(0, i) : ''; }).filter(Boolean));
          return changed || ([...haDomains].sort().join(',') !== prev);
        }).catch(() => changed);
      }
      return Promise.all([haCheck, sdkCheck]).then(([a, b]) => a || b);
    }).catch(() => false);
  }
  // Capabilities are (re)probed every time the editor opens (see open()), so we
  // do NOT fetch /actions/catalog at module load — a page with no Deck key being
  // edited shouldn't hit the endpoint at all.
  function obsScenes() {
    if (!scenesPromise) scenesPromise = fetch('/obs/scenes').then((r) => r.json()).then((d) => (d && d.scenes) || []).catch(() => []);
    return scenesPromise;
  }
  function obsSources() {
    if (!sourcesPromise) sourcesPromise = fetch('/obs/sources').then((r) => r.json()).then((d) => (d && d.sources) || []).catch(() => []);
    return sourcesPromise;
  }
  // Live Streamer.bot action list ({value:id, label:name}) for the sbAction picker.
  function sbActions() {
    if (!sbActionsPromise) sbActionsPromise = fetch('/streamerbot/actions').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.actions)) ? d.actions : []).map((a) => ({ value: a.id, label: a.name || a.id })))
      .catch(() => []);
    return sbActionsPromise;
  }
  // Live Streamer.bot code-trigger list ({value:name, label:"Group › name"}) for the
  // sbCodeTrigger picker. Stored by trigger name (what ExecuteCodeTrigger takes).
  function sbCodeTriggers() {
    if (!sbCodeTriggersPromise) sbCodeTriggersPromise = fetch('/streamerbot/codetriggers').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.triggers)) ? d.triggers : []).map((a) => ({ value: a.name, label: (a.group ? a.group + ' › ' : '') + a.name })))
      .catch(() => []);
    return sbCodeTriggersPromise;
  }
  // Live Streamer.bot global-variable names for the "reflect a global" state picker.
  function sbGlobals() {
    if (!sbGlobalsPromise) sbGlobalsPromise = fetch('/streamerbot/globals').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.globals)) ? d.globals : []).map((g) => String(g.name)).filter(Boolean))
      .catch(() => []);
    return sbGlobalsPromise;
  }
  // Live voice-channel list ({value:id, label:"Guild › Channel"}) for the Discord
  // join picker. Falls back to [] (→ typed channel-id field) when Discord is off.
  function discordChannels() {
    if (!discordChannelsPromise) discordChannelsPromise = fetch('/stream/discord/channels').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.channels)) ? d.channels : []).map((c) => ({ value: c.id, label: (c.guild ? c.guild + ' › ' : '') + (c.name || c.id) })))
      .catch(() => []);
    return discordChannelsPromise;
  }
  // Live soundboard list for the discordSound picker. Each item's value is the
  // opaque "guildId|soundId" ref the provider parses back at play time; the label
  // is "Server › Sound". Falls back to [] (→ read-only field) when Discord is off.
  function discordSounds() {
    if (!discordSoundsPromise) discordSoundsPromise = fetch('/stream/discord/sounds').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.sounds)) ? d.sounds : []).map((s) => ({ value: (s.guildId || '') + '|' + s.id, label: (s.guild ? s.guild + ' › ' : '') + (s.name || s.id) })))
      .catch(() => []);
    return discordSoundsPromise;
  }
  // Installed SignalRGB effects ({value:effectName, label:"Name (kind)"}) for the
  // signalRgbEffect picker. Empty (→ typed field) when SignalRGB is off/absent.
  function signalRgbEffects() {
    if (!signalRgbEffectsPromise) signalRgbEffectsPromise = fetch('/api/signalrgb/effects').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.effects)) ? d.effects : []).map((e) => ({ value: e.value, label: e.label })))
      .catch(() => []);
    return signalRgbEffectsPromise;
  }
  // Live Home Assistant entity list ({value:entity_id, label:"Area › Name"}) for the
  // haEntity picker. Falls back to [] (→ typed entity-id field) when HA is off.
  function haEntities() {
    if (!haEntitiesPromise) haEntitiesPromise = fetch('/api/homeassistant/entities').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.entities)) ? d.entities : []).map((e) => ({ value: e.id, label: (e.area ? e.area + ' › ' : '') + (e.name || e.id) })))
      .catch(() => []);
    return haEntitiesPromise;
  }
  // Live Wave Link mixer channel list ({value:mixId, label:name}) for the wlChannel
  // picker. Falls back to [] (→ typed mixId field) when Wave Link is off/unreachable.
  function wlChannels() {
    if (!wlChannelsPromise) wlChannelsPromise = fetch('/api/wavelink/channels').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.channels)) ? d.channels : []))
      .catch(() => []);
    return wlChannelsPromise;
  }
  // Lighting hub device list ({value:id, label:name}) for the lightDevice picker.
  // Falls back to [] (→ typed id field) when no lighting is configured/reachable.
  function lightDevices() {
    if (!lightDevicesPromise) lightDevicesPromise = fetch('/api/lighting/devices').then((r) => r.json())
      .then((d) => ((d && Array.isArray(d.devices)) ? d.devices : []))
      .catch(() => []);
    return lightDevicesPromise;
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
    if (!sdkWidgetsPromise) {
      sdkWidgetsPromise = (sdkEnabled()
        ? fetch('/sdk/widgets').then((r) => r.json()).then((d) => ((d && Array.isArray(d.packages)) ? d.packages : []))
        : Promise.resolve([])
      ).catch(() => []);
    }
    return sdkWidgetsPromise;
  }
  // Deck macros contributed by installed packages ({value:'pkg/macroId',
  // label:'Widget › Macro'}). The server re-checks grants + manifest at run time.
  function sdkMacros() {
    return sdkPackages().then((pkgs) => {
      const out = [];
      pkgs.forEach((p) => {
        ((p.deck && p.deck.actions) || []).forEach((m) => out.push({ value: p.id + '/' + m.id, label: p.name + ' › ' + m.name }));
      });
      sdkMacroItemsCache = out;
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
      sdkHandlerItemsCache = out;
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
  // Lazy fetch of apps with an audio session from /audio/apps. Returns
  // Promise<{value,label}[]> where value is the durable process name and label is
  // the friendly display name. /audio/apps is broader than /audio: it lists apps
  // with an active OR inactive session, so apps that aren't playing right now still
  // appear. Not reset in refreshCapabilities — the app list is not a capability flag.
  function audioApps() {
    if (!appsPromise) appsPromise = fetch('/audio/apps').then((r) => r.json()).then((d) => {
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
    return appsPromise;
  }
  // Lazy fetch of installed Store/UWP apps from /apps/store. Returns
  // Promise<{value,label}[]> where value is the AppUserModelID and label the app name.
  function storeApps() {
    if (!storeAppsPromise) storeAppsPromise = fetch('/apps/store').then((r) => r.json())
      .then((d) => (d && Array.isArray(d.apps)) ? d.apps : []).catch(() => []);
    return storeAppsPromise;
  }

  function close() {
    const m = document.getElementById('deck-editor-backdrop');
    if (m) m.remove();
  }

  // Upgrade every native <select> in `root` to the shared custom dropdown so the
  // editor's pickers match the rest of the app. data-cs-fixed makes the panel
  // float (the modal scrolls, which would otherwise clip an absolute panel). Safe
  // to call repeatedly — already-initialised selects are skipped.
  function enhanceSelects(root) {
    if (!root || typeof window.initCustomSelect !== 'function') return;
    root.querySelectorAll('select.deck-ed-input').forEach((s) => {
      if (s.dataset.csInit) return;
      s.setAttribute('data-cs-fixed', '');
      window.initCustomSelect(s);
    });
  }

  function field(labelKey) {
    const wrap = document.createElement('label');
    wrap.className = 'deck-ed-field';
    const span = document.createElement('span');
    span.className = 'deck-ed-label';
    span.setAttribute('data-i18n', labelKey);
    span.textContent = t(labelKey);
    wrap.appendChild(span);
    return wrap;
  }

  function input(type, value) {
    const el = document.createElement('input');
    el.type = type;
    if (value != null) el.value = value;
    el.className = 'deck-ed-input';
    return el;
  }

  // Emoji presets, grouped so the picker reads as an organised palette rather
  // than a random wall of glyphs. Each group has an i18n category label.
  const EMOJI_CATEGORIES = [
    { labelKey: 'deck_cat_media', list: ['🎙️', '🎤', '🎧', '🔇', '🔊', '🔉', '🎵', '🎶', '▶️', '⏯️', '⏸️', '⏹️', '⏭️', '⏮️', '🔴', '⏺️', '🎬', '🎥', '📹', '📷', '📸', '🎞️', '🎚️', '🎛️'] },
    { labelKey: 'deck_cat_system', list: ['🖥️', '💻', '⌨️', '🖱️', '🕹️', '🎮', '💾', '💿', '🔌', '🔋', '🖨️', '📁', '📂', '🗂️', '⚙️', '🛠️', '🔧', '🔩', '🧰', '🖧'] },
    { labelKey: 'deck_cat_comm', list: ['💬', '🗨️', '📢', '📣', '✉️', '📧', '📨', '📞', '📱', '🔔', '🔕', '📅', '📆', '🗓️', '📝', '📋', '📌', '📎', '🔗', '🌐'] },
    { labelKey: 'deck_cat_symbol', list: ['✅', '☑️', '✔️', '❌', '⛔', '🚫', '⚠️', '❗', '❓', '⭐', '🌟', '✨', '💡', '🔆', '🔒', '🔓', '🔑', '⚡', '🔥', '🏆', '🎯', '❤️'] },
    { labelKey: 'deck_cat_fun', list: ['😀', '😎', '🤖', '👍', '👎', '👏', '🙌', '🤔', '🎉', '🚀', '🎨', '☀️', '🌙', '☁️', '⏰', '⏱️', '⏳', '📊', '📈', '💰', '🛒', '☕'] },
    { labelKey: 'deck_cat_color', list: ['🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤', '⚪', '⚫', '🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '⬜', '⬛'] },
  ];

  // Downscale an uploaded image (shared rasterToCanvas core, utils.js) to a
  // small square-ish icon (max 192px on the long edge) and re-encode as PNG.
  // Keeps the stored data URL tiny so it survives in localStorage and stays
  // crisp on a key. Resolves to a data URL — the original image's when the
  // downscale can't run (decode failure, tainted canvas), '' when unreadable.
  async function downscaleImage(file, maxEdge) {
    const cv = await rasterToCanvas(file, maxEdge);
    if (cv) {
      try { return cv.toDataURL('image/png'); }
      catch { /* tainted canvas etc. → fall back to the original */ }
    }
    return fileToDataUrl(file);
  }

  // Read an uploaded picture for a key. Animated GIFs are kept as-is when they
  // fit the stored-icon budget (the canvas downscale would re-encode to a static
  // PNG and kill the animation); everything else is downscaled as usual. The cap
  // is deliberately modest: a GIF is stored full-resolution as a base64 data URL
  // that is cloned per key by "apply to page", and the deck config has an 8 MB
  // server accept limit — a larger cap made it easy to blow past it.
  function readKeyImage(file, maxEdge) {
    if (file && file.type === 'image/gif' && file.size <= 512 * 1024) return fileToDataUrl(file);
    return downscaleImage(file, maxEdge);
  }

  // Icon picker with three modes: an emoji grid (or a custom typed emoji), a
  // library of built-in vector icons, or an uploaded image (downscaled, stored as
  // a data URL — no server round-trip). Returns { element, read, readStyle }.
  // hooks.getAppTarget() -> { kind:'path'|'aumid', value } | null : the key's
  // open-app / open-Store-app target, if any. Enables the "use the app's own
  // icon" shortcut (pulls the exe's embedded icon or the UWP tile logo).
  function buildIconPicker(existing, onChange, hooks) {
    const getAppTarget = hooks && typeof hooks.getAppTarget === 'function' ? hooks.getAppTarget : null;
    let ready = false;   // suppress onChange during construction (callers may not be initialised yet)
    const exType = existing && existing.icon && existing.icon.type;
    const isImage = exType === 'image';
    const isBuiltin = exType === 'builtin';
    let mode = isImage ? 'image' : isBuiltin ? 'builtin' : 'emoji';
    let emojiVal = (!isImage && !isBuiltin && existing && existing.icon) ? (existing.icon.value || '') : '';
    let builtinVal = isBuiltin ? existing.icon.value : '';
    let imageVal = isImage ? existing.icon.value : '';
    const FITS = (window.DeckModel && window.DeckModel.ICON_FITS) || ['cover', 'contain', 'small'];
    let imageFit = (isImage && existing.icon && FITS.includes(existing.icon.fit)) ? existing.icon.fit : 'cover';

    const wrap = document.createElement('div');
    wrap.className = 'deck-ed-field';
    const lbl = document.createElement('span');
    lbl.className = 'deck-ed-label';
    lbl.setAttribute('data-i18n', 'deck_edit_icon');
    lbl.textContent = t('deck_edit_icon');
    wrap.appendChild(lbl);

    const seg = document.createElement('div'); seg.className = 'deck-ed-seg';
    const bEmoji = document.createElement('button'); bEmoji.type = 'button'; bEmoji.className = 'deck-ed-segbtn'; bEmoji.textContent = '😀'; bEmoji.title = t('deck_icontab_emoji');
    const bIcons = document.createElement('button'); bIcons.type = 'button'; bIcons.className = 'deck-ed-segbtn deck-ed-segbtn-icon'; bIcons.title = t('deck_icontab_icons');
    if (window.DeckIcons) { const s = window.DeckIcons.el('star'); if (s) bIcons.appendChild(s); } else { bIcons.textContent = '◆'; }
    const bImage = document.createElement('button'); bImage.type = 'button'; bImage.className = 'deck-ed-segbtn'; bImage.textContent = '🖼️'; bImage.title = t('deck_icontab_image');
    seg.appendChild(bEmoji); seg.appendChild(bIcons); seg.appendChild(bImage); wrap.appendChild(seg);

    // "Use the app's own icon" — only shown for launch keys (open app / open Store
    // app). Fetches the exe's embedded icon or the UWP tile logo from the server
    // and drops it in as an image icon, so no external picture is needed.
    const appIconRow = document.createElement('div');
    appIconRow.className = 'deck-ed-appicon-row';
    appIconRow.style.display = 'none';
    const appIconBtn = document.createElement('button');
    appIconBtn.type = 'button'; appIconBtn.className = 'deck-ed-btn deck-ed-appicon-btn';
    appIconBtn.setAttribute('data-i18n', 'deck_edit_useappicon');
    appIconBtn.textContent = t('deck_edit_useappicon');
    appIconRow.appendChild(appIconBtn);
    wrap.appendChild(appIconRow);
    let appIconBusy = false;
    function flashAppIconMsg(key) {
      const base = t('deck_edit_useappicon');
      appIconBtn.textContent = t(key);
      setTimeout(() => { if (!appIconBusy) appIconBtn.textContent = base; }, 1800);
    }
    appIconBtn.addEventListener('click', async () => {
      const tgt = getAppTarget && getAppTarget();
      if (!tgt || appIconBusy) return;
      appIconBusy = true;
      appIconBtn.disabled = true;
      appIconBtn.textContent = t('deck_edit_useappicon') + '…';
      try {
        const qs = tgt.kind === 'aumid'
          ? 'aumid=' + encodeURIComponent(tgt.value)
          : 'path=' + encodeURIComponent(tgt.value);
        const res = await fetch('/deck/app-icon?' + qs);
        const data = await res.json();
        appIconBusy = false; appIconBtn.disabled = false;
        appIconBtn.textContent = t('deck_edit_useappicon');
        if (data && data.ok && data.icon) {
          imageVal = data.icon; mode = 'image'; imageFit = 'contain';
          if (fitSel) fitSel.value = 'contain';
          sync();
        } else {
          flashAppIconMsg('deck_edit_useappicon_none');
        }
      } catch {
        appIconBusy = false; appIconBtn.disabled = false;
        flashAppIconMsg('deck_edit_useappicon_none');
      }
    });

    // ── Emoji panel: a scrollable, category-labelled grid. ──
    const emojiPanel = document.createElement('div'); emojiPanel.className = 'deck-ed-pickscroll';
    EMOJI_CATEGORIES.forEach((cat) => {
      const head = document.createElement('div'); head.className = 'deck-ed-cat'; head.setAttribute('data-i18n', cat.labelKey); head.textContent = t(cat.labelKey);
      const grid = document.createElement('div'); grid.className = 'deck-ed-emojis';
      cat.list.forEach((e) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'deck-ed-emoji'; b.textContent = e;
        b.addEventListener('click', () => { emojiVal = e; mode = 'emoji'; sync(); });
        grid.appendChild(b);
      });
      emojiPanel.appendChild(head); emojiPanel.appendChild(grid);
    });
    wrap.appendChild(emojiPanel);

    const custom = input('text', !isImage && !isBuiltin ? emojiVal : '');
    custom.maxLength = 8; custom.placeholder = '😀';
    custom.addEventListener('input', () => { emojiVal = custom.value.trim(); mode = 'emoji'; syncSelected(); });
    wrap.appendChild(custom);

    // ── Built-in vector icon panel: same grid, but each cell is an SVG icon. ──
    const iconPanel = document.createElement('div'); iconPanel.className = 'deck-ed-pickscroll';
    if (window.DeckIcons) {
      window.DeckIcons.CATEGORIES.forEach((cat) => {
        const head = document.createElement('div'); head.className = 'deck-ed-cat'; head.setAttribute('data-i18n', cat.labelKey); head.textContent = t(cat.labelKey);
        const grid = document.createElement('div'); grid.className = 'deck-ed-emojis';
        cat.ids.forEach((id) => {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'deck-ed-emoji deck-ed-icon'; b.dataset.iconId = id;
          const svg = window.DeckIcons.el(id); if (svg) b.appendChild(svg);
          b.addEventListener('click', () => { builtinVal = id; mode = 'builtin'; sync(); });
          grid.appendChild(b);
        });
        iconPanel.appendChild(head); iconPanel.appendChild(grid);
      });
    }
    // Installed icon packs (the 'icons' preset kind): one section per pack,
    // appended after the built-in categories. Picking a pack icon EMBEDS it
    // into the key as an image data: URI (same shape as an uploaded picture),
    // so the key keeps working if the pack is uninstalled and shared profiles
    // stay self-contained. Async fill — the picker opens instantly either way.
    fetch('/icon-packs').then((res) => res.json()).then((data) => {
      (data && Array.isArray(data.packs) ? data.packs : []).forEach((pack) => {
        if (!pack || !Array.isArray(pack.icons) || !pack.icons.length) return;
        const head = document.createElement('div'); head.className = 'deck-ed-cat';
        head.textContent = String(pack.name || pack.id || '');
        const grid = document.createElement('div'); grid.className = 'deck-ed-emojis';
        pack.icons.forEach((icon) => {
          if (!icon || !icon.file) return;
          const src = '/icon-pack/' + encodeURIComponent(pack.id) + '/' + encodeURIComponent(icon.file);
          const b = document.createElement('button'); b.type = 'button'; b.className = 'deck-ed-emoji deck-ed-icon deck-ed-packicon';
          b.title = String(icon.label || icon.id || '');
          const img = document.createElement('img'); img.src = src; img.alt = ''; img.loading = 'lazy';
          b.appendChild(img);
          b.addEventListener('click', async () => {
            try {
              const blob = await fetch(src).then((r) => (r.ok ? r.blob() : null));
              if (!blob) return;
              const uri = await fileToDataUrl(blob);
              if (!uri) return;
              imageVal = uri; mode = 'image'; imageFit = 'contain';
              if (fitSel) fitSel.value = 'contain';
              sync();
            } catch { /* pack file unreadable — leave the key as it was */ }
          });
          grid.appendChild(b);
        });
        iconPanel.appendChild(head); iconPanel.appendChild(grid);
      });
    }).catch(() => { /* no packs / offline — built-ins already rendered */ });
    wrap.appendChild(iconPanel);

    // ── Image upload panel. ──
    const imgPanel = document.createElement('div'); imgPanel.className = 'deck-ed-imgpick';
    const file = document.createElement('input'); file.type = 'file'; file.accept = 'image/*'; file.className = 'deck-ed-file';
    const fileBtn = document.createElement('button'); fileBtn.type = 'button'; fileBtn.className = 'deck-ed-btn'; fileBtn.setAttribute('data-i18n', 'deck_edit_image'); fileBtn.textContent = t('deck_edit_image');
    // Paste raw SVG markup instead of uploading a file (stored as a data: URI).
    const svgBtn = document.createElement('button'); svgBtn.type = 'button'; svgBtn.className = 'deck-ed-btn'; svgBtn.setAttribute('data-i18n', 'svg_paste'); svgBtn.textContent = t('svg_paste');
    const preview = document.createElement('img'); preview.className = 'deck-ed-imgprev'; preview.alt = '';
    fileBtn.addEventListener('click', () => file.click());
    svgBtn.addEventListener('click', async () => {
      const uri = await openSvgPasteDialog();
      if (uri) { imageVal = uri; mode = 'image'; sync(); }
    });
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      readKeyImage(f, 192).then((url) => { imageVal = url; mode = 'image'; sync(); });
    });
    imgPanel.appendChild(fileBtn); imgPanel.appendChild(svgBtn); imgPanel.appendChild(preview); imgPanel.appendChild(file);
    wrap.appendChild(imgPanel);

    // Image fit picker (image mode only): how the picture sits in the square cap.
    const fitField = document.createElement('div'); fitField.className = 'deck-ed-field deck-ed-subfield';
    const fitLbl = document.createElement('span'); fitLbl.className = 'deck-ed-label';
    fitLbl.setAttribute('data-i18n', 'deck_edit_imagefit'); fitLbl.textContent = t('deck_edit_imagefit');
    const fitSel = document.createElement('select'); fitSel.className = 'deck-ed-input';
    FITS.forEach((v) => { const o = document.createElement('option'); o.value = v; o.setAttribute('data-i18n', 'deck_fit_' + v); o.textContent = t('deck_fit_' + v); fitSel.appendChild(o); });
    fitSel.value = imageFit;
    fitSel.addEventListener('change', () => { imageFit = fitSel.value; });
    fitField.appendChild(fitLbl); fitField.appendChild(fitSel);
    wrap.appendChild(fitField);

    // Icon colour (builtin vector icons tint via currentColor — shown only for
    // that mode) and icon size preset (glyph icons only: a full-bleed image's
    // size is governed by its Fit mode, so the size preset is hidden there).
    let iconColorVal = (existing && existing.iconColor) || '';
    const colField = document.createElement('div'); colField.className = 'deck-ed-field deck-ed-subfield';
    const colLbl = document.createElement('span'); colLbl.className = 'deck-ed-label';
    colLbl.setAttribute('data-i18n', 'deck_edit_iconcolor'); colLbl.textContent = t('deck_edit_iconcolor');
    colField.appendChild(colLbl);
    colField.appendChild(swatchRow(() => iconColorVal, (v) => { iconColorVal = v; }).el);
    wrap.appendChild(colField);

    let iconSizeVal = (existing && ['sm', 'lg'].includes(existing.iconSize)) ? existing.iconSize : 'md';
    const sizeField = document.createElement('div'); sizeField.className = 'deck-ed-field deck-ed-subfield';
    const sizeLbl = document.createElement('span'); sizeLbl.className = 'deck-ed-label';
    sizeLbl.setAttribute('data-i18n', 'deck_edit_iconsize'); sizeLbl.textContent = t('deck_edit_iconsize');
    sizeField.appendChild(sizeLbl);
    const sizeSeg = document.createElement('div'); sizeSeg.className = 'deck-ed-seg deck-ed-seg-text';
    [['sm', t('deck_keysize_sm')], ['md', t('deck_keysize_md')], ['lg', t('deck_keysize_lg')]].forEach(([v, lab]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'deck-ed-segbtn'; b.textContent = lab;
      b.classList.toggle('active', iconSizeVal === v);
      b.addEventListener('click', () => {
        iconSizeVal = v;
        sizeSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      });
      sizeSeg.appendChild(b);
    });
    sizeField.appendChild(sizeSeg);
    wrap.appendChild(sizeField);

    function syncSelected() {
      emojiPanel.querySelectorAll('.deck-ed-emoji').forEach((b) => b.classList.toggle('sel', mode === 'emoji' && b.textContent === emojiVal));
      iconPanel.querySelectorAll('.deck-ed-icon').forEach((b) => b.classList.toggle('sel', mode === 'builtin' && b.dataset.iconId === builtinVal));
    }
    function sync() {
      bEmoji.classList.toggle('active', mode === 'emoji');
      bIcons.classList.toggle('active', mode === 'builtin');
      bImage.classList.toggle('active', mode === 'image');
      emojiPanel.style.display = mode === 'emoji' ? '' : 'none';
      custom.style.display = mode === 'emoji' ? '' : 'none';
      iconPanel.style.display = mode === 'builtin' ? '' : 'none';
      imgPanel.style.display = mode === 'image' ? '' : 'none';
      fitField.style.display = mode === 'image' ? '' : 'none';
      colField.style.display = mode === 'builtin' ? '' : 'none';
      // Size preset only affects glyph icons (emoji/vector); an image is sized by Fit.
      sizeField.style.display = mode === 'image' ? 'none' : '';
      if (document.activeElement !== custom) custom.value = emojiVal;
      syncSelected();
      if (imageVal) { preview.src = imageVal; preview.style.display = ''; }
      else { preview.removeAttribute('src'); preview.style.display = 'none'; }
      if (ready && typeof onChange === 'function') onChange();
    }
    bEmoji.addEventListener('click', () => { mode = 'emoji'; sync(); });
    bIcons.addEventListener('click', () => { mode = 'builtin'; sync(); });
    bImage.addEventListener('click', () => { mode = 'image'; sync(); });
    // Show the "use the app's own icon" shortcut only while the key has a launch
    // action to read the target from; re-checked by the editor on every edit. Not
    // called during construction — the trigger data it reads doesn't exist yet;
    // the editor calls it once the form is fully built.
    function syncAppTarget() {
      const tgt = getAppTarget && getAppTarget();
      appIconRow.style.display = tgt ? '' : 'none';
    }
    sync();
    ready = true;

    return {
      element: wrap,
      // Re-evaluate whether the "use app icon" shortcut applies (the launch target
      // can appear/disappear as the user edits the key's actions).
      syncAppTarget,
      read() {
        if (mode === 'image' && imageVal) return { type: 'image', value: imageVal, fit: imageFit };
        if (mode === 'builtin' && builtinVal) return { type: 'builtin', value: builtinVal };
        return { type: 'emoji', value: emojiVal };
      },
      // Key-level icon styling composed here for UI cohesion (colour + size).
      // iconColor only applies to builtin vector icons (currentColor); its swatch
      // row is hidden in emoji/image mode, so don't persist a stale tint the user
      // can't see — it would otherwise leak through copy-style / apply-to-page.
      readStyle() {
        return { iconColor: mode === 'builtin' ? iconColorVal : '', iconSize: iconSizeVal };
      },
      // True when the face is a full-bleed picture (so a separate backdrop image
      // would be painted behind it and never seen — the editor hides that section).
      isFullFaceImage() { return mode === 'image' && !!imageVal && imageFit !== 'small'; },
      // The current image, if any — feeds the "colours from image" auto-tint.
      imageUrl() { return imageVal || ''; },
    };
  }

  // opts: { key (existing or null), onSave(rawKey), onDelete() }
  function open(opts) {
    close();
    // Re-fetch OBS scene/source lists and the running-app list on each open so
    // scenes/sources just created in OBS — and apps just launched — show up
    // without a page reload.
    scenesPromise = null; sourcesPromise = null; appsPromise = null; storeAppsPromise = null; sbActionsPromise = null; sbCodeTriggersPromise = null; sbGlobalsPromise = null; discordChannelsPromise = null; discordSoundsPromise = null; haEntitiesPromise = null; wlChannelsPromise = null; lightDevicesPromise = null; sdkWidgetsPromise = null; signalRgbEffectsPromise = null;
    const DA = window.DeckActions;
    const DM = window.DeckModel;
    // Hard dependencies: bail cleanly (rather than throwing mid-build and leaving
    // an orphaned backdrop) if either module failed to load.
    if (!DA || !DM) { console.error('DeckEditor: DeckActions/DeckModel not loaded'); return; }
    const existing = opts && opts.key;

    const backdrop = document.createElement('div');
    backdrop.id = 'deck-editor-backdrop';
    backdrop.className = 'deck-ed-backdrop';
    const modal = document.createElement('div');
    modal.className = 'deck-ed-modal';

    // ── Shell: header / (side rail + tabbed main) / footer. The side rail keeps
    // the live preview always in view (also on the Xeneon touchscreen, where the
    // old floating preview was hidden); every section lands in one of three tab
    // panes so the form reads as short pages instead of one endless scroll. ──
    const edHead = document.createElement('div'); edHead.className = 'deck-ed-head';
    const edBody = document.createElement('div'); edBody.className = 'deck-ed-body';
    const edSide = document.createElement('div'); edSide.className = 'deck-ed-side';
    const edMain = document.createElement('div'); edMain.className = 'deck-ed-main';
    edBody.appendChild(edSide); edBody.appendChild(edMain);
    const tabBar = document.createElement('div'); tabBar.className = 'deck-ed-tabs';
    const paneAction = document.createElement('div'); paneAction.className = 'deck-ed-pane';
    const paneLook = document.createElement('div'); paneLook.className = 'deck-ed-pane';
    const paneFx = document.createElement('div'); paneFx.className = 'deck-ed-pane';
    const TAB_DEFS = [
      { id: 'actions', labelKey: 'deck_tab_actions', pane: paneAction },
      { id: 'look', labelKey: 'deck_tab_look', pane: paneLook },
      { id: 'fx', labelKey: 'deck_tab_fx', pane: paneFx },
    ];
    // A new key starts on Actions (assign what it does first); an existing key
    // opens on Look (the common revisit). Rebuild-style reopens keep their tab.
    let activeTab = (opts && opts.tab) || (existing ? 'look' : 'actions');
    if (!TAB_DEFS.some((d) => d.id === activeTab)) activeTab = 'actions';
    const tabBtns = {};
    function showTab(id) {
      activeTab = id;
      TAB_DEFS.forEach((d) => {
        tabBtns[d.id].classList.toggle('active', d.id === id);
        d.pane.style.display = d.id === id ? '' : 'none';
      });
    }
    TAB_DEFS.forEach((d) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'deck-ed-tab';
      b.setAttribute('data-i18n', d.labelKey); b.textContent = t(d.labelKey);
      b.addEventListener('click', () => showTab(d.id));
      tabBar.appendChild(b); tabBtns[d.id] = b;
    });
    showTab(activeTab);

    const h = document.createElement('h3');
    h.className = 'deck-ed-title';
    h.setAttribute('data-i18n', 'deck_edit_title');
    h.textContent = t('deck_edit_title');
    edHead.appendChild(h);
    const edClose = document.createElement('button');
    edClose.type = 'button'; edClose.className = 'deck-ed-close';
    edClose.title = t('deck_edit_cancel'); edClose.textContent = '×';
    edClose.addEventListener('click', close);
    edHead.appendChild(edClose);
    modal.appendChild(edHead);

    // Saved single-key presets: tap a chip to load its fields into the form (then
    // Save to place it), or remove it with the ×. The durable, server-backed store
    // is owned by the deck runtime (window.Deck); this is just the picker.
    const presetWrap = document.createElement('div');
    presetWrap.className = 'deck-ed-presets';
    function fillKeyPresets() {
      presetWrap.replaceChildren();
      const list = (window.Deck && typeof window.Deck.listKeyPresets === 'function') ? window.Deck.listKeyPresets() : [];
      if (!list.length) { presetWrap.style.display = 'none'; return; }
      presetWrap.style.display = '';
      const lbl = document.createElement('span');
      lbl.className = 'deck-ed-presets-label';
      lbl.setAttribute('data-i18n', 'deck_key_presets');
      lbl.textContent = t('deck_key_presets');
      presetWrap.appendChild(lbl);
      list.forEach((ps) => {
        const chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'deck-ed-preset-chip'; chip.title = t('preset_insert');
        chip.appendChild(document.createTextNode(ps.name));
        chip.addEventListener('click', () => {
          const k = Object.assign({}, ps.key); delete k.id;   // fresh id assigned on save
          open(Object.assign({}, opts, { key: k, tab: activeTab }));  // reload from the preset, same tab
        });
        const del = document.createElement('span');
        del.className = 'deck-ed-preset-del'; del.setAttribute('role', 'button');
        del.title = t('preset_delete'); del.textContent = '×';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (window.Deck && typeof window.Deck.deleteKeyPreset === 'function') window.Deck.deleteKeyPreset(ps.id);
          fillKeyPresets();
        });
        chip.appendChild(del);
        presetWrap.appendChild(chip);
      });
    }
    fillKeyPresets();
    edSide.appendChild(presetWrap);

    const fTitle = field('deck_edit_name');
    const inTitle = input('text', existing ? existing.title : '');
    fTitle.appendChild(inTitle);
    edMain.appendChild(fTitle);
    edMain.appendChild(tabBar);
    edMain.appendChild(paneAction);
    edMain.appendChild(paneLook);
    edMain.appendChild(paneFx);
    modal.appendChild(edBody);

    // The picker pings back on any change so the auto-tint button below can
    // appear as soon as an image icon is uploaded (syncBgImg is hoisted).
    const iconPicker = buildIconPicker(existing, () => syncBgImg(), { getAppTarget: currentLaunchTarget });
    paneLook.appendChild(iconPicker.element);

    // ── Cap background: a solid accent OR a two-colour gradient, plus an
    // optional backdrop picture that sits UNDER the icon/label. ──
    const fColor = field('deck_edit_color');
    let colorTouched = !!(existing && existing.bg);
    let bgColor = (existing && existing.bg) || '';
    let gradC1 = (existing && existing.bg2 && existing.bg) || '';
    let gradC2 = (existing && existing.bg2) || '';
    let bgDir = (existing && ['v', 'r'].includes(existing.bgDir)) ? existing.bgDir : 'd';
    let bgMode = gradC2 ? 'grad' : 'solid';
    // True once the user actually commits to a gradient (picks a preset, a stop, or
    // auto-tint) — merely tapping "Gradiente" to preview seeds stops but must NOT
    // persist a gradient the user never chose (matches "no tint until you pick").
    let gradTouched = !!gradC2;

    const modeSeg = document.createElement('div'); modeSeg.className = 'deck-ed-seg deck-ed-seg-text';
    const bSolid = document.createElement('button'); bSolid.type = 'button'; bSolid.className = 'deck-ed-segbtn';
    bSolid.setAttribute('data-i18n', 'deck_bg_solid'); bSolid.textContent = t('deck_bg_solid');
    const bGrad = document.createElement('button'); bGrad.type = 'button'; bGrad.className = 'deck-ed-segbtn';
    bGrad.setAttribute('data-i18n', 'deck_bg_gradient'); bGrad.textContent = t('deck_bg_gradient');
    modeSeg.appendChild(bSolid); modeSeg.appendChild(bGrad);
    fColor.appendChild(modeSeg);

    // Solid: optional accent — no tint until a swatch is picked.
    const solidRow = swatchRow(
      () => (colorTouched ? bgColor : ''),
      (v) => { bgColor = v; colorTouched = !!v; },
    );
    fColor.appendChild(solidRow.el);

    // Gradient: preset chips (one tap = both stops + direction), the two stop
    // rows and a direction pick.
    const gradWrap = document.createElement('div'); gradWrap.className = 'deck-ed-gradwrap';
    const chips = document.createElement('div'); chips.className = 'deck-ed-gradchips';
    const c1Row = swatchRow(() => gradC1, (v) => { gradC1 = v || gradC1; gradTouched = true; syncGradient(); }, { allowNone: false });
    const c2Row = swatchRow(() => gradC2, (v) => { gradC2 = v || gradC2; gradTouched = true; syncGradient(); }, { allowNone: false });
    const dirSeg = document.createElement('div'); dirSeg.className = 'deck-ed-seg';
    const DIR_GLYPHS = { d: '⤡', v: '↓', r: '◎' };
    const dirBtns = {};
    ['d', 'v', 'r'].forEach((d) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'deck-ed-segbtn';
      b.textContent = DIR_GLYPHS[d]; b.title = t('deck_grad_dir_' + d);
      b.addEventListener('click', () => { bgDir = d; syncGradient(); });
      dirSeg.appendChild(b); dirBtns[d] = b;
    });
    function syncGradient() {
      Object.keys(dirBtns).forEach((d) => dirBtns[d].classList.toggle('active', d === bgDir));
      chips.querySelectorAll('.deck-ed-gradchip').forEach((chip) => {
        chip.classList.toggle('sel', chip.dataset.c1 === gradC1 && chip.dataset.c2 === gradC2 && chip.dataset.dir === bgDir);
      });
      c1Row.refresh(); c2Row.refresh();
    }
    GRADIENT_PRESETS.forEach((g) => {
      const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'deck-ed-gradchip';
      chip.dataset.c1 = g.c1; chip.dataset.c2 = g.c2; chip.dataset.dir = g.dir;
      chip.style.background = gradientCss(g.c1, g.c2, g.dir);
      chip.addEventListener('click', () => { gradC1 = g.c1; gradC2 = g.c2; bgDir = g.dir; gradTouched = true; syncGradient(); });
      chips.appendChild(chip);
    });
    gradWrap.appendChild(chips);
    const c1Lbl = document.createElement('span'); c1Lbl.className = 'deck-ed-label';
    c1Lbl.setAttribute('data-i18n', 'deck_grad_c1'); c1Lbl.textContent = t('deck_grad_c1');
    gradWrap.appendChild(c1Lbl); gradWrap.appendChild(c1Row.el);
    const c2Lbl = document.createElement('span'); c2Lbl.className = 'deck-ed-label';
    c2Lbl.setAttribute('data-i18n', 'deck_grad_c2'); c2Lbl.textContent = t('deck_grad_c2');
    gradWrap.appendChild(c2Lbl); gradWrap.appendChild(c2Row.el);
    const dirLbl = document.createElement('span'); dirLbl.className = 'deck-ed-label';
    dirLbl.setAttribute('data-i18n', 'deck_grad_dir'); dirLbl.textContent = t('deck_grad_dir');
    gradWrap.appendChild(dirLbl); gradWrap.appendChild(dirSeg);
    fColor.appendChild(gradWrap);

    function syncBgMode() {
      bSolid.classList.toggle('active', bgMode === 'solid');
      bGrad.classList.toggle('active', bgMode === 'grad');
      solidRow.el.style.display = bgMode === 'solid' ? '' : 'none';
      gradWrap.style.display = bgMode === 'grad' ? '' : 'none';
    }
    bSolid.addEventListener('click', () => { bgMode = 'solid'; syncBgMode(); });
    bGrad.addEventListener('click', () => {
      bgMode = 'grad';
      // Sensible starting stops: reuse the solid accent when it exists.
      if (!gradC1) gradC1 = (colorTouched && bgColor) || '#2b6cff';
      if (!gradC2) gradC2 = '#ff2d92';
      syncGradient(); syncBgMode();
    });
    syncGradient(); syncBgMode();
    paneLook.appendChild(fColor);

    // Backdrop picture: separate layer under the icon — upload, dim, remove.
    let bgImgVal = (existing && existing.bgImage && existing.bgImage.value) || '';
    let bgImgDim = (existing && existing.bgImage && Number.isFinite(existing.bgImage.dim)) ? existing.bgImage.dim : 35;
    let bgImgBlur = (existing && existing.bgImage && Number.isFinite(existing.bgImage.blur)) ? existing.bgImage.blur : 0;
    const fBgImg = field('deck_edit_bgimage');
    const bgImgRow = document.createElement('div'); bgImgRow.className = 'deck-ed-imgpick';
    const bgImgFile = document.createElement('input'); bgImgFile.type = 'file'; bgImgFile.accept = 'image/*'; bgImgFile.className = 'deck-ed-file';
    const bgImgBtn = document.createElement('button'); bgImgBtn.type = 'button'; bgImgBtn.className = 'deck-ed-btn';
    bgImgBtn.setAttribute('data-i18n', 'deck_edit_image'); bgImgBtn.textContent = t('deck_edit_image');
    const bgImgPrev = document.createElement('img'); bgImgPrev.className = 'deck-ed-imgprev'; bgImgPrev.alt = '';
    const bgImgDel = document.createElement('button'); bgImgDel.type = 'button'; bgImgDel.className = 'deck-ed-btn deck-ed-imgdel'; bgImgDel.textContent = '×';
    bgImgDel.title = t('preset_delete');
    bgImgBtn.addEventListener('click', () => bgImgFile.click());
    bgImgFile.addEventListener('change', () => {
      const f = bgImgFile.files && bgImgFile.files[0];
      if (!f) return;
      readKeyImage(f, 256).then((url) => { if (url) bgImgVal = url; syncBgImg(); });
    });
    bgImgDel.addEventListener('click', () => { bgImgVal = ''; syncBgImg(); });
    bgImgRow.appendChild(bgImgBtn); bgImgRow.appendChild(bgImgPrev); bgImgRow.appendChild(bgImgDel); bgImgRow.appendChild(bgImgFile);
    fBgImg.appendChild(bgImgRow);
    // Dim slider: how dark the legibility scrim over the picture is.
    const dimWrap = document.createElement('div'); dimWrap.className = 'deck-ed-subfield deck-ed-dimrow';
    const dimLbl = document.createElement('span'); dimLbl.className = 'deck-ed-label';
    dimLbl.setAttribute('data-i18n', 'deck_bgimg_dim'); dimLbl.textContent = t('deck_bgimg_dim');
    const dimRange = document.createElement('input'); dimRange.type = 'range'; dimRange.className = 'deck-ed-range';
    dimRange.min = '0'; dimRange.max = '85'; dimRange.step = '5'; dimRange.value = String(bgImgDim);
    dimRange.addEventListener('input', () => { bgImgDim = Number(dimRange.value); });
    dimWrap.appendChild(dimLbl); dimWrap.appendChild(dimRange);
    fBgImg.appendChild(dimWrap);
    // Blur slider: how soft the backdrop picture is (0–20px).
    const blurWrap = document.createElement('div'); blurWrap.className = 'deck-ed-subfield deck-ed-dimrow';
    const blurLbl = document.createElement('span'); blurLbl.className = 'deck-ed-label';
    blurLbl.setAttribute('data-i18n', 'deck_bgimg_blur'); blurLbl.textContent = t('deck_bgimg_blur');
    const blurRange = document.createElement('input'); blurRange.type = 'range'; blurRange.className = 'deck-ed-range';
    blurRange.min = '0'; blurRange.max = '20'; blurRange.step = '1'; blurRange.value = String(bgImgBlur);
    blurRange.addEventListener('input', () => { bgImgBlur = Number(blurRange.value); });
    blurWrap.appendChild(blurLbl); blurWrap.appendChild(blurRange);
    fBgImg.appendChild(blurWrap);
    // Auto-tint: pull the dominant colours out of the key's picture (backdrop
    // or image icon) and set the KEY BACKGROUND to a matching gradient. Gives
    // explicit feedback — it silently did nothing before on a monochrome image
    // (no dominant colour to extract), which read as broken.
    const autoBtn = document.createElement('button'); autoBtn.type = 'button'; autoBtn.className = 'deck-ed-btn deck-ed-autotint';
    autoBtn.setAttribute('data-i18n', 'deck_autotint'); autoBtn.textContent = t('deck_autotint');
    autoBtn.title = t('deck_autotint_hint');
    const toast = (type, msg) => { if (window.XenonToast) window.XenonToast.show({ type, kicker: 'Deck', title: t('deck_autotint'), message: msg }); };
    autoBtn.addEventListener('click', () => {
      const url = bgImgVal || iconPicker.imageUrl();
      if (!url) { toast('info', t('deck_autotint_noimg')); return; }
      if (typeof window.extractAlbumAccent !== 'function') return;
      window.extractAlbumAccent(url).then((res) => {
        if (!res) { toast('info', t('deck_autotint_none')); return; }
        gradC1 = res.led || res.accent;
        gradC2 = (res.ledPalette && res.ledPalette[1]) || darkenHex(gradC1, .45);
        bgMode = 'grad'; gradTouched = true;
        syncGradient(); syncBgMode();
        toast('success', t('deck_autotint_done'));
      });
    });
    fBgImg.appendChild(autoBtn);
    function syncBgImg() {
      // A full-bleed photo face would paint over any backdrop, so hide the whole
      // backdrop section in that case (the picture IS the face there).
      const fullFace = iconPicker.isFullFaceImage();
      fBgImg.style.display = fullFace ? 'none' : '';
      if (bgImgVal) { bgImgPrev.src = bgImgVal; bgImgPrev.style.display = ''; }
      else { bgImgPrev.removeAttribute('src'); bgImgPrev.style.display = 'none'; }
      bgImgDel.style.display = bgImgVal ? '' : 'none';
      dimWrap.style.display = bgImgVal ? '' : 'none';
      blurWrap.style.display = bgImgVal ? '' : 'none';
      autoBtn.style.display = (bgImgVal || iconPicker.imageUrl()) ? '' : 'none';
    }
    syncBgImg();
    paneLook.appendChild(fBgImg);

    // ── Live value ON the key face: none / a ticking timer countdown (matched
    // by label; empty = the running timer ending soonest) / a live hardware
    // sensor (temps/load/fan RPM/watts/battery %) / a state an SDK widget
    // publishes. Stored as key.live; rendered via textContent only. ──
    let liveSource = (existing && existing.live && existing.live.source) || '';
    let liveName = (existing && existing.live && existing.live.name) || '';
    const fLive = field('deck_edit_live');
    const selLive = document.createElement('select'); selLive.className = 'deck-ed-input';
    [['', 'deck_live_none'], ['timer', 'deck_live_timer']].forEach(([v, lk]) => {
      const o = document.createElement('option'); o.value = v; o.setAttribute('data-i18n', lk); o.textContent = t(lk); selLive.appendChild(o);
    });
    // Fixed hardware metrics (value carries the metric name).
    const SENSOR_METRICS = (window.DeckModel && window.DeckModel.DECK_SENSOR_METRICS) || [];
    SENSOR_METRICS.forEach((m) => {
      const o = document.createElement('option'); o.value = 'sensor:' + m;
      o.setAttribute('data-i18n', 'deck_live_sensor_' + m); o.textContent = t('deck_live_sensor_' + m);
      selLive.appendChild(o);
    });
    // An existing sdkState/battery binding gets its option SYNCHRONOUSLY: the
    // async population below lands after the initial syncLive() call, which
    // would otherwise read the still-empty select and silently drop the binding
    // on save (the key loses its live badge just by opening the editor).
    if (liveSource === 'sdkState' && liveName) {
      const o = document.createElement('option'); o.value = 'sdk:' + liveName; o.textContent = liveName; selLive.appendChild(o);
      selLive.value = 'sdk:' + liveName;
    }
    if (liveSource === 'sensor' && liveName && liveName.startsWith('battery:')) {
      const o = document.createElement('option'); o.value = 'sensor:' + liveName; o.textContent = liveName.slice('battery:'.length); selLive.appendChild(o);
      selLive.value = 'sensor:' + liveName;
    }
    // Published SDK states join the list lazily (value carries the state name).
    sdkDeckStates().then((items) => {
      (items || []).forEach((it) => {
        const prev = Array.from(selLive.options).find((o) => o.value === 'sdk:' + it.value);
        if (prev) { prev.textContent = it.label; return; }   // placeholder added above → real label
        const o = document.createElement('option'); o.value = 'sdk:' + it.value; o.textContent = it.label; selLive.appendChild(o);
      });
      enhanceSelects(fLive);
    }).catch(() => {});
    // Known wireless-device batteries join lazily too (same placeholder rule).
    fetch('/api/battery').then((r) => r.json()).then((d) => {
      const devs = (d && Array.isArray(d.devices)) ? d.devices : [];
      devs.forEach((dev) => {
        if (!dev || !dev.name) return;
        const val = 'sensor:battery:' + dev.name;
        const prev = Array.from(selLive.options).find((o) => o.value === val);
        const label = t('deck_live_battery', 'Battery') + ' · ' + dev.name;
        if (prev) { prev.textContent = label; return; }
        const o = document.createElement('option'); o.value = val; o.textContent = label; selLive.appendChild(o);
      });
      if (devs.length) enhanceSelects(fLive);
    }).catch(() => {});
    if (liveSource === 'timer') selLive.value = 'timer';
    if (liveSource === 'sensor' && liveName && !liveName.startsWith('battery:')) selLive.value = 'sensor:' + liveName;
    fLive.appendChild(selLive);
    const liveNameWrap = document.createElement('div'); liveNameWrap.className = 'deck-ed-subfield';
    const liveNameIn = input('text', liveSource === 'timer' ? liveName : '');
    liveNameIn.placeholder = t('deck_ph_live_timer');
    liveNameIn.addEventListener('input', () => { liveName = liveNameIn.value.trim(); });
    liveNameWrap.appendChild(liveNameIn);
    fLive.appendChild(liveNameWrap);
    function syncLive() {
      const v = selLive.value;
      liveSource = v === 'timer' ? 'timer' : (v.startsWith('sdk:') ? 'sdkState' : (v.startsWith('sensor:') ? 'sensor' : ''));
      if (liveSource === 'sdkState') liveName = v.slice(4);
      else if (liveSource === 'sensor') liveName = v.slice('sensor:'.length);
      else if (liveSource === 'timer') liveName = liveNameIn.value.trim();
      liveNameWrap.style.display = liveSource === 'timer' ? '' : 'none';
    }
    selLive.addEventListener('change', syncLive);
    syncLive();
    paneLook.appendChild(fLive);

    // ── Label styling: position, size, weight, colour. ──
    let labelPosVal = (existing && ['top', 'hidden'].includes(existing.labelPos)) ? existing.labelPos : 'bottom';
    let labelSizeVal = (existing && ['sm', 'lg'].includes(existing.labelSize)) ? existing.labelSize : 'md';
    let labelBoldVal = !!(existing && existing.labelBold);
    let labelColorVal = (existing && existing.labelColor) || '';
    const fLabel = field('deck_edit_label');
    const posSeg = document.createElement('div'); posSeg.className = 'deck-ed-seg deck-ed-seg-text';
    [['bottom', 'deck_label_pos_bottom'], ['top', 'deck_label_pos_top'], ['hidden', 'deck_label_pos_hidden']].forEach(([v, lk]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'deck-ed-segbtn';
      b.setAttribute('data-i18n', lk); b.textContent = t(lk);
      b.classList.toggle('active', labelPosVal === v);
      b.addEventListener('click', () => {
        labelPosVal = v;
        posSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      });
      posSeg.appendChild(b);
    });
    fLabel.appendChild(posSeg);
    const lsRow = document.createElement('div'); lsRow.className = 'deck-ed-seg deck-ed-seg-text deck-ed-subfield';
    [['sm', t('deck_keysize_sm')], ['md', t('deck_keysize_md')], ['lg', t('deck_keysize_lg')]].forEach(([v, lab]) => {
      // Scoped class so the size toggle only clears sibling size buttons — the Bold
      // button shares this row but is an independent toggle.
      const b = document.createElement('button'); b.type = 'button'; b.className = 'deck-ed-segbtn deck-ed-lsize'; b.textContent = lab;
      b.classList.toggle('active', labelSizeVal === v);
      b.addEventListener('click', () => {
        labelSizeVal = v;
        lsRow.querySelectorAll('.deck-ed-lsize').forEach((x) => x.classList.toggle('active', x === b));
      });
      lsRow.appendChild(b);
    });
    const boldBtn = document.createElement('button'); boldBtn.type = 'button'; boldBtn.className = 'deck-ed-segbtn deck-ed-boldbtn';
    boldBtn.textContent = 'B'; boldBtn.title = t('deck_label_bold');
    boldBtn.classList.toggle('active', labelBoldVal);
    boldBtn.addEventListener('click', () => { labelBoldVal = !labelBoldVal; boldBtn.classList.toggle('active', labelBoldVal); });
    lsRow.appendChild(boldBtn);
    fLabel.appendChild(lsRow);
    const labelColorRow = swatchRow(() => labelColorVal, (v) => { labelColorVal = v; });
    const lcWrap = document.createElement('div'); lcWrap.className = 'deck-ed-subfield';
    lcWrap.appendChild(labelColorRow.el);
    fLabel.appendChild(lcWrap);
    paneFx.appendChild(fLabel);

    // Tap feedback: the effect the cap plays/holds when the key fires. Applies to any
    // key (action or folder); validated by normalizeKey on save.
    const PRESS_FX = (DM.PRESS_FX) || ['glow', 'press', 'stay', 'flash', 'off'];
    const fPress = field('deck_edit_press');
    const selPress = document.createElement('select'); selPress.className = 'deck-ed-input';
    PRESS_FX.forEach((v) => { const o = document.createElement('option'); o.value = v; o.setAttribute('data-i18n', 'deck_press_' + v); o.textContent = t('deck_press_' + v); selPress.appendChild(o); });
    selPress.value = (existing && PRESS_FX.includes(existing.press)) ? existing.press : 'glow';
    fPress.appendChild(selPress); paneFx.appendChild(fPress);

    // Effect colour (only the colour-bearing effects: glow, stay, flash). A preset
    // palette like the accent picker; "none" leaves the effect on its default tint.
    let pressColorTouched = !!(existing && existing.pressColor);
    let pressColor = (existing && existing.pressColor) || '';
    const fPressColor = field('deck_edit_presscolor'); fPressColor.classList.add('deck-ed-subfield');
    const pcSwatches = document.createElement('div'); pcSwatches.className = 'deck-ed-swatches';
    function markPressColor() {
      const want = pressColorTouched ? pressColor : '';
      pcSwatches.querySelectorAll('.deck-ed-swatch').forEach((s) => s.classList.toggle('sel', s.dataset.c === want));
      if (pcCustom) pcCustom.classList.toggle('sel', pressColorTouched && isCustomColor(pressColor));
    }
    const pcNone = document.createElement('button');
    pcNone.type = 'button'; pcNone.className = 'deck-ed-swatch deck-ed-swatch-none'; pcNone.dataset.c = ''; pcNone.textContent = '✕'; pcNone.title = '—';
    pcNone.addEventListener('click', () => { pressColorTouched = false; pressColor = ''; markPressColor(); });
    pcSwatches.appendChild(pcNone);
    DECK_SWATCHES.forEach((c) => {
      const s = document.createElement('button'); s.type = 'button'; s.className = 'deck-ed-swatch';
      s.dataset.c = c; s.style.background = c; s.title = c;
      s.addEventListener('click', () => { pressColor = c; pressColorTouched = true; markPressColor(); });
      pcSwatches.appendChild(s);
    });
    const pcCustom = addCustomSwatch(pcSwatches, () => pressColor, (hex) => { pressColor = hex; pressColorTouched = true; markPressColor(); });
    fPressColor.appendChild(pcSwatches); paneFx.appendChild(fPressColor);
    markPressColor();
    const PRESS_COLOR_FX = ['glow', 'stay', 'flash'];   // effects where a colour applies
    function syncPressColor() { fPressColor.style.display = PRESS_COLOR_FX.includes(selPress.value) ? '' : 'none'; }
    selPress.addEventListener('change', syncPressColor);
    syncPressColor();

    // Ambient animation: an always-on cap motion (vs the tap feedback above).
    const KEY_ANIMS = DM.KEY_ANIMS || ['none', 'breathe', 'shift'];
    const fAnim = field('deck_edit_anim');
    const selAnim = document.createElement('select'); selAnim.className = 'deck-ed-input';
    KEY_ANIMS.forEach((v) => { const o = document.createElement('option'); o.value = v; o.setAttribute('data-i18n', 'deck_anim_' + v); o.textContent = t('deck_anim_' + v); selAnim.appendChild(o); });
    selAnim.value = (existing && KEY_ANIMS.includes(existing.anim)) ? existing.anim : 'none';
    fAnim.appendChild(selAnim); paneFx.appendChild(fAnim);

    // ── Alternate face while the bound state is ON (toggle keys): optional
    // emoji, label and accent that replace the base face when .is-on. Only
    // meaningful for stateful action keys; collectKey stores it as stateStyle
    // and normalizeKey re-validates every field. ──
    let ssIconVal = (existing && existing.stateStyle && existing.stateStyle.icon) || '';
    let ssLabelVal = (existing && existing.stateStyle && existing.stateStyle.label) || '';
    let ssColorVal = (existing && existing.stateStyle && existing.stateStyle.color) || '';
    const fStateStyle = field('deck_edit_statestyle');
    const ssHint = document.createElement('div'); ssHint.className = 'deck-ed-hint';
    ssHint.setAttribute('data-i18n', 'deck_statestyle_hint'); ssHint.textContent = t('deck_statestyle_hint');
    fStateStyle.appendChild(ssHint);
    const ssRow = document.createElement('div'); ssRow.className = 'deck-ed-subfield';
    const ssIconIn = input('text', ssIconVal);
    ssIconIn.placeholder = t('deck_ph_statestyle_icon');
    ssIconIn.maxLength = 8;
    ssIconIn.addEventListener('input', () => { ssIconVal = ssIconIn.value.trim(); });
    ssRow.appendChild(ssIconIn);
    const ssLabelIn = input('text', ssLabelVal);
    ssLabelIn.placeholder = t('deck_ph_statestyle_label');
    ssLabelIn.maxLength = 40;
    ssLabelIn.addEventListener('input', () => { ssLabelVal = ssLabelIn.value.trim(); });
    ssRow.appendChild(ssLabelIn);
    fStateStyle.appendChild(ssRow);
    const ssColorRow = swatchRow(() => ssColorVal, (v) => { ssColorVal = v; });
    const ssColorWrap = document.createElement('div'); ssColorWrap.className = 'deck-ed-subfield';
    ssColorWrap.appendChild(ssColorRow.el);
    fStateStyle.appendChild(ssColorWrap);
    paneFx.appendChild(fStateStyle);

    // ── Style tools: copy this key's look, paste a copied look, or repaint the
    // whole page with it. The clipboard survives across editors (session-only). ──
    const styleTools = document.createElement('div'); styleTools.className = 'deck-ed-styletools';
    const flash = (btn) => {
      const prev = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = prev; }, 900);
    };
    const btnCopyStyle = document.createElement('button'); btnCopyStyle.type = 'button'; btnCopyStyle.className = 'deck-ed-btn';
    btnCopyStyle.setAttribute('data-i18n', 'deck_style_copy'); btnCopyStyle.textContent = t('deck_style_copy');
    btnCopyStyle.addEventListener('click', () => {
      styleClipboard = DM.keyStyleOf(collectKey(true));
      flash(btnCopyStyle);
      syncStyleTools();
    });
    const btnPasteStyle = document.createElement('button'); btnPasteStyle.type = 'button'; btnPasteStyle.className = 'deck-ed-btn';
    btnPasteStyle.setAttribute('data-i18n', 'deck_style_paste'); btnPasteStyle.textContent = t('deck_style_paste');
    btnPasteStyle.addEventListener('click', () => {
      if (!styleClipboard) return;
      // Rebuild the editor from the current form with the copied style laid
      // over it (style fields not in the clipboard are cleared — whole look).
      const k = collectKey(false);
      (DM.KEY_STYLE_FIELDS || []).forEach((f) => { delete k[f]; });
      Object.assign(k, styleClipboard);
      open(Object.assign({}, opts, { key: k, tab: activeTab }));
    });
    const btnPageStyle = document.createElement('button'); btnPageStyle.type = 'button'; btnPageStyle.className = 'deck-ed-btn';
    btnPageStyle.setAttribute('data-i18n', 'deck_style_page'); btnPageStyle.textContent = t('deck_style_page');
    btnPageStyle.addEventListener('click', () => {
      if (typeof opts.onApplyStyle !== 'function') return;
      opts.onApplyStyle(DM.keyStyleOf(collectKey(false)));
      flash(btnPageStyle);
    });
    function syncStyleTools() { btnPasteStyle.disabled = !styleClipboard; }
    syncStyleTools();
    if (typeof opts.onApplyStyle !== 'function') btnPageStyle.style.display = 'none';
    styleTools.appendChild(btnCopyStyle); styleTools.appendChild(btnPasteStyle); styleTools.appendChild(btnPageStyle);
    edSide.appendChild(styleTools);

    // Trigger data (no DOM yet). Defined early so the per-key "dynamic state"
    // field below can pre-suggest a source from the tap action.
    const TRIGGERS = ['tap', 'double', 'hold'];
    const rawTriggers = (existing && existing.triggers) || {};
    // Each trigger is a list of step descriptors {type, params, delayMs}.
    const stepsOf = (name) => DA.triggerSteps(rawTriggers[name]).map((s) => {
      const params = Object.assign({}, s.action); delete params.type;
      return { type: s.action.type, params, delayMs: s.delayMs };
    });
    const trig = { tap: stepsOf('tap'), double: stepsOf('double'), hold: stepsOf('hold') };
    // Open on the first trigger that has any step so an existing double/hold key doesn't look empty.
    let activeTrig = trig.tap.length ? 'tap' : trig.double.length ? 'double' : trig.hold.length ? 'hold' : 'tap';

    // First open-app / open-Store-app target across the key's triggers, if any —
    // feeds the icon picker's "use the app's own icon" shortcut. Hoisted so the
    // picker (built above) can hold a reference; only read at click/refresh time,
    // once `trig` is populated.
    function currentLaunchTarget() {
      // Guarded: hoisting lets the icon picker hold a reference to this before the
      // trigger data below is initialised, so a stray early call returns null
      // instead of throwing on the temporal-dead-zone access.
      try {
        for (const tr of TRIGGERS) {
          for (const s of trig[tr]) {
            const p = s && s.params;
            if (s.type === 'openApp' && p && String(p.path || '').trim()) return { kind: 'path', value: String(p.path).trim() };
            if (s.type === 'openStoreApp' && p && String(p.appId || '').trim()) return { kind: 'aumid', value: String(p.appId).trim() };
          }
        }
      } catch { /* trigger data not built yet */ }
      return null;
    }

    // Derive the live-state binding implied by the key's actions (first step of any
    // trigger). Mic/speaker mute + the four OBS sources each map to a source; only a
    // volume *mute* implies speaker state. Returns the state object or null. Shared
    // by the auto-bind on save and the LED-reaction duration default below.
    function detectKeyState() {
      const steps0 = TRIGGERS.map((tr) => trig[tr][0]).filter(Boolean);
      const find = (pred) => steps0.find(pred);
      if (find((s) => s.type === 'micMute')) return { source: 'micMuted' };
      if (find((s) => s.type === 'volume' && s.params && s.params.mode === 'mute')) return { source: 'speakerMuted' };
      if (find((s) => s.type === 'obsRecord')) return { source: 'obsRecording' };
      if (find((s) => s.type === 'obsStream')) return { source: 'obsStreaming' };
      const scn = find((s) => s.type === 'obsScene' && s.params && s.params.scene);
      if (scn) return { source: 'obsScene', scene: scn.params.scene };
      const inp = find((s) => s.type === 'obsMute' && s.params && s.params.source);
      if (inp) return { source: 'obsInputMuted', input: inp.params.source };
      // Remote-control state bindings (only meaningful when remoteConfigured).
      if (find((s) => s.type === 'remoteBlock') && remoteConfigured !== false) return { source: 'remoteActive' };
      // Discord voice toggles mirror the live mute/deafen flags.
      if (find((s) => s.type === 'discordMute')) return { source: 'discordMuted' };
      if (find((s) => s.type === 'discordDeafen')) return { source: 'discordDeafened' };
      // Spotify / generic media play keys light while playback is live.
      if (find((s) => s.type === 'spotifyPlay')) return { source: 'spotifyPlaying' };
      if (find((s) => s.type === 'media' && s.params && (s.params.cmd === 'playpause' || s.params.cmd === 'play'))) return { source: 'mediaPlaying' };
      // Home Assistant toggle-style keys follow the entity's live state.
      const ha = find((s) => ['haToggle', 'haLight', 'haFan', 'haCover', 'haLock', 'haVacuum'].includes(s.type) && s.params && s.params.entity);
      if (ha) return { source: 'haEntity', entity: ha.params.entity };
      // Timer keys light while their timer is counting down.
      const tmr = find((s) => (s.type === 'timerStart' || s.type === 'timerToggle') && s.params && s.params.label);
      if (tmr) return { source: 'timerRunning', name: tmr.params.label };
      return null;
    }

    // Manual "reflect a Streamer.bot global" binding (phase 2). Unlike the auto
    // sources above, a global can't be inferred from the action, so the user picks
    // it explicitly below. Declared here so the LED-duration default and collectKey
    // can treat a global-bound key as stateful. `value` (optional) matches a
    // specific value; empty = truthy.
    let sbStateName = (existing && existing.state && existing.state.source === 'sbGlobal' && existing.state.name) ? String(existing.state.name) : '';
    let sbStateValue = (existing && existing.state && existing.state.source === 'sbGlobal' && existing.state.value != null) ? String(existing.state.value) : '';
    function manualSbState() {
      return sbStateName ? Object.assign({ source: 'sbGlobal', name: sbStateName }, sbStateValue ? { value: sbStateValue } : {}) : null;
    }
    // "Reflect a widget state" binding (SDK packages publish states over the
    // bridge; same shape as the Streamer.bot global binding, name = "pkg/stateId").
    let sdkStateName = (existing && existing.state && existing.state.source === 'sdkState' && existing.state.name) ? String(existing.state.name) : '';
    let sdkStateValue = (existing && existing.state && existing.state.source === 'sdkState' && existing.state.value != null) ? String(existing.state.value) : '';
    function manualSdkState() {
      return sdkStateName ? Object.assign({ source: 'sdkState', name: sdkStateName }, sdkStateValue ? { value: sdkStateValue } : {}) : null;
    }
    // The key's effective state binding: an explicit global binding wins, else the
    // action-derived one. Used by the LED "follows state" default and on save.
    function effectiveKeyState() { return manualSbState() || manualSdkState() || detectKeyState(); }

    const fKind = field('deck_edit_kind');
    const selKind = document.createElement('select');
    selKind.className = 'deck-ed-input';
    [['action', 'deck_edit_kind_action'], ['folder', 'deck_edit_kind_folder'], ['slider', 'deck_edit_kind_slider']].forEach(([val, lk]) => {
      const o = document.createElement('option'); o.value = val; o.setAttribute('data-i18n', lk); o.textContent = t(lk); selKind.appendChild(o);
    });
    selKind.value = existing ? existing.kind : 'action';
    fKind.appendChild(selKind); paneAction.appendChild(fKind);

    // ── Slider (touch fader) config: target + its per-target picker + direction.
    // Targets whose service isn't configured are gated like the action picker.
    let sliderModel = {
      target: (existing && existing.slider && existing.slider.target) || 'volume',
      app: (existing && existing.slider && existing.slider.app) || '',
      entity: (existing && existing.slider && existing.slider.entity) || '',
      source: (existing && existing.slider && existing.slider.source) || '',
      orient: (existing && existing.slider && existing.slider.orient) || 'v',
    };
    const fSlider = field('deck_edit_slider');
    const sliderTargetSel = document.createElement('select'); sliderTargetSel.className = 'deck-ed-input';
    const SLIDER_TARGET_GATE = {
      volume: () => true,
      appVolume: () => true,
      spotifyVolume: () => spotifyConnected !== false,
      obsInput: () => obsConfigured !== false,
      haLight: () => homeAssistantConfigured !== false && (!haDomains || haDomains.has('light')),
      discordInput: () => discordConnected !== false,
      discordOutput: () => discordConnected !== false,
    };
    (DM.SLIDER_TARGETS || []).forEach((tg) => {
      if (!(SLIDER_TARGET_GATE[tg] ? SLIDER_TARGET_GATE[tg]() : true) && sliderModel.target !== tg) return;
      const o = document.createElement('option'); o.value = tg; o.setAttribute('data-i18n', 'deck_slider_' + tg); o.textContent = t('deck_slider_' + tg); sliderTargetSel.appendChild(o);
    });
    sliderTargetSel.value = sliderModel.target;
    fSlider.appendChild(sliderTargetSel);
    const sliderParamHost = document.createElement('div'); sliderParamHost.className = 'deck-ed-subfield';
    fSlider.appendChild(sliderParamHost);
    function paintSliderParam() {
      sliderParamHost.replaceChildren();
      const step = { params: sliderModel };   // adapt the picker controls' {params} contract
      if (sliderModel.target === 'appVolume') sliderParamHost.appendChild(appPickControl(step, 'app'));
      else if (sliderModel.target === 'haLight') sliderParamHost.appendChild(haEntityPickControl(step, 'entity', 'light'));
      else if (sliderModel.target === 'obsInput') sliderParamHost.appendChild(obsPickControl(step, 'source', obsSources, 'deck_param_source'));
    }
    sliderTargetSel.addEventListener('change', () => { sliderModel.target = sliderTargetSel.value; paintSliderParam(); });
    paintSliderParam();
    const orientSeg = document.createElement('div'); orientSeg.className = 'deck-ed-seg deck-ed-seg-text deck-ed-subfield';
    [['v', 'deck_slider_vert'], ['h', 'deck_slider_horiz']].forEach(([v, lk]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'deck-ed-segbtn';
      b.setAttribute('data-i18n', lk); b.textContent = t(lk);
      b.classList.toggle('active', sliderModel.orient === v);
      b.addEventListener('click', () => {
        sliderModel.orient = v;
        orientSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      });
      orientSeg.appendChild(b);
    });
    fSlider.appendChild(orientSeg);
    paneAction.appendChild(fSlider);

    // Key Logic: one action per trigger (tap / double / hold). The picker below
    // edits whichever trigger is active.
    // A plain div (NOT a <label>): a <label> wrapping multiple buttons forwards a
    // click to its first button, which made Double/Hold snap straight back to Tap.
    const fTrig = document.createElement('div');
    fTrig.className = 'deck-ed-field';
    const trigLbl = document.createElement('span');
    trigLbl.className = 'deck-ed-label';
    trigLbl.setAttribute('data-i18n', 'deck_triggers');
    trigLbl.textContent = t('deck_triggers');
    fTrig.appendChild(trigLbl);
    const segTrig = document.createElement('div'); segTrig.className = 'deck-ed-seg';
    const trigBtns = {};
    TRIGGERS.forEach((tr) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'deck-ed-trigbtn';
      const nm = document.createElement('span'); nm.className = 'deck-ed-trigname';
      nm.setAttribute('data-i18n', 'deck_trigger_' + tr); nm.textContent = t('deck_trigger_' + tr);
      const ac = document.createElement('span'); ac.className = 'deck-ed-trigact';  // shows the assigned action, or "—"
      b.appendChild(nm); b.appendChild(ac);
      b.addEventListener('click', () => { activeTrig = tr; renderSteps(); markActive(); });
      segTrig.appendChild(b); trigBtns[tr] = b;
    });
    fTrig.appendChild(segTrig); paneAction.appendChild(fTrig);

    const fAction = field('deck_edit_action');
    const stepsHost = document.createElement('div');
    stepsHost.className = 'deck-ed-steps';
    fAction.appendChild(stepsHost); paneAction.appendChild(fAction);

    // ── LED reaction: an optional lighting consequence attached to THIS key. ──
    const existingLight = existing && existing.light;
    const fLight = field('deck_light_title');
    const lightModes = ['none', 'color', 'coloreffect'];
    let lightModeVal = !existingLight ? 'none' : (existingLight.style && existingLight.style !== 'solid' ? 'coloreffect' : 'color');
    const selLightMode = document.createElement('select'); selLightMode.className = 'deck-ed-input';
    lightModes.forEach((m) => { const o = document.createElement('option'); o.value = m; o.setAttribute('data-i18n', 'deck_light_' + m); o.textContent = t('deck_light_' + m); selLightMode.appendChild(o); });
    selLightMode.value = lightModeVal;
    fLight.appendChild(selLightMode);

    let lightColor = (existingLight && existingLight.color) || '#ff3b30';
    const lightSwatches = document.createElement('div'); lightSwatches.className = 'deck-ed-swatches';
    function markLightSwatch() {
      lightSwatches.querySelectorAll('.deck-ed-swatch').forEach((s) => s.classList.toggle('sel', s.dataset.c === lightColor));
      if (lightCustom) lightCustom.classList.toggle('sel', isCustomColor(lightColor));
    }
    DECK_SWATCHES.forEach((c) => {
      const s = document.createElement('button'); s.type = 'button'; s.className = 'deck-ed-swatch'; s.dataset.c = c; s.style.background = c; s.title = c;
      s.addEventListener('click', () => { lightColor = c; markLightSwatch(); });
      lightSwatches.appendChild(s);
    });
    const lightCustom = addCustomSwatch(lightSwatches, () => lightColor, (hex) => { lightColor = hex; markLightSwatch(); });
    fLight.appendChild(lightSwatches);

    const fLightFx = document.createElement('div'); fLightFx.className = 'deck-ed-subfield';
    const selLightFx = document.createElement('select'); selLightFx.className = 'deck-ed-input';
    ['solid', 'breathing', 'cycle'].forEach((s) => { const o = document.createElement('option'); o.value = s; o.setAttribute('data-i18n', 'deck_lightfx_' + s); o.textContent = t('deck_lightfx_' + s); selLightFx.appendChild(o); });
    selLightFx.value = (existingLight && ['solid', 'breathing', 'cycle'].includes(existingLight.style)) ? existingLight.style : 'breathing';
    fLightFx.appendChild(selLightFx); fLight.appendChild(fLightFx);

    const fLightDur = document.createElement('div'); fLightDur.className = 'deck-ed-subfield';
    const selLightDur = document.createElement('select'); selLightDur.className = 'deck-ed-input';
    [['press', 'deck_light_oneshot'], ['state', 'deck_light_state']].forEach(([v, lk]) => { const o = document.createElement('option'); o.value = v; o.setAttribute('data-i18n', lk); o.textContent = t(lk); selLightDur.appendChild(o); });
    // Smart default: a brand-new reaction on a toggle-with-state key (OBS record/
    // stream, mic/speaker mute, OBS scene) defaults to "follows state" — which
    // auto-reverts on the second press — instead of the fire-and-forget one-shot.
    selLightDur.value = existingLight ? (existingLight.when === 'state' ? 'state' : 'press') : (effectiveKeyState() ? 'state' : 'press');
    let durTouched = false;
    selLightDur.addEventListener('change', () => { durTouched = true; });
    // Re-apply the smart default when the action changes — until the user picks a
    // duration by hand, or when editing a reaction that already has a saved choice.
    function refreshLedDurDefault() {
      if (existingLight || durTouched) return;
      selLightDur.value = effectiveKeyState() ? 'state' : 'press';
    }
    fLightDur.appendChild(selLightDur); fLight.appendChild(fLightDur);

    const lightHint = document.createElement('div'); lightHint.className = 'deck-ed-hint';
    lightHint.setAttribute('data-i18n', 'deck_light_hint'); lightHint.textContent = t('deck_light_hint');
    fLight.appendChild(lightHint);

    function syncLight() {
      const m = selLightMode.value;
      const showColor = m !== 'none';
      lightSwatches.style.display = showColor ? '' : 'none';
      fLightFx.style.display = m === 'coloreffect' ? '' : 'none';
      fLightDur.style.display = showColor ? '' : 'none';
      lightHint.style.display = showColor ? '' : 'none';
      markLightSwatch();
    }
    selLightMode.addEventListener('change', syncLight);
    syncLight();
    paneAction.appendChild(fLight);

    // ── Reflect a Streamer.bot global (phase 2 "stateful key"): the key shows as ON
    // while a chosen global is truthy (or equals a given value). Optional; the tap
    // action stays whatever the user set (usually an sbDoAction that flips it). Only
    // meaningful when Streamer.bot is configured, so it's hidden otherwise. ──
    const fSbState = field('deck_edit_sbglobal');
    const sbNameWrap = document.createElement('div');
    const sbNameTxt = input('text', sbStateName);       // typed fallback when SB is offline
    sbNameTxt.placeholder = t('deck_param_global');
    sbNameTxt.addEventListener('input', () => { sbStateName = sbNameTxt.value.trim(); syncSbState(); });
    sbNameWrap.appendChild(sbNameTxt);
    sbGlobals().then((names) => {
      if (!names || !names.length) return;              // offline / none → typed field only
      const sel = document.createElement('select'); sel.className = 'deck-ed-input';
      const none = document.createElement('option'); none.value = ''; none.setAttribute('data-i18n', 'deck_opt_none'); none.textContent = t('deck_opt_none'); sel.appendChild(none);
      let list = names.slice();
      if (sbStateName && !list.includes(sbStateName)) list = [sbStateName, ...list];   // keep an assigned-but-missing global
      list.forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
      sel.value = sbStateName;
      sel.addEventListener('change', () => { sbStateName = sel.value; syncSbState(); });
      sbNameWrap.replaceChildren(sel);
      enhanceSelects(sbNameWrap);
    }).catch(() => {});
    fSbState.appendChild(sbNameWrap);
    // Optional exact-value match (empty = on for any truthy value).
    const sbValWrap = document.createElement('div'); sbValWrap.className = 'deck-ed-subfield';
    const sbValLbl = document.createElement('span'); sbValLbl.className = 'deck-ed-label';
    sbValLbl.setAttribute('data-i18n', 'deck_edit_sbglobalval'); sbValLbl.textContent = t('deck_edit_sbglobalval');
    const sbValIn = input('text', sbStateValue); sbValIn.placeholder = t('deck_ph_sbglobalval');
    sbValIn.addEventListener('input', () => { sbStateValue = sbValIn.value.trim(); });
    sbValWrap.appendChild(sbValLbl); sbValWrap.appendChild(sbValIn);
    fSbState.appendChild(sbValWrap);
    const sbHint = document.createElement('div'); sbHint.className = 'deck-ed-hint';
    sbHint.setAttribute('data-i18n', 'deck_sbglobal_hint'); sbHint.textContent = t('deck_sbglobal_hint');
    fSbState.appendChild(sbHint);
    function syncSbState() {
      const on = !!sbStateName;
      sbValWrap.style.display = on ? '' : 'none';
      sbHint.style.display = on ? '' : 'none';
      refreshLedDurDefault();   // a global binding makes the key stateful → LED "follows state" default
    }
    syncSbState();
    // Visibility (SB configured AND kind=action) is owned by syncKind() below.
    paneAction.appendChild(fSbState);

    // ── Reflect a WIDGET state (SDK packages): same idea as the Streamer.bot
    // binding, fed by states installed widget packages publish over the bridge.
    // Only shown once the (lazy) package scan finds at least one state — or when
    // the key already carries a binding, so it can always be cleared. ──
    let sdkStatesAvail = !!sdkStateName;
    const fSdkState = field('deck_edit_sdkstate');
    const sdkNameWrap = document.createElement('div');
    fSdkState.appendChild(sdkNameWrap);
    const sdkValWrap = document.createElement('div'); sdkValWrap.className = 'deck-ed-subfield';
    const sdkValLbl = document.createElement('span'); sdkValLbl.className = 'deck-ed-label';
    sdkValLbl.setAttribute('data-i18n', 'deck_edit_sdkstateval'); sdkValLbl.textContent = t('deck_edit_sdkstateval');
    const sdkValIn = input('text', sdkStateValue); sdkValIn.placeholder = t('deck_ph_sbglobalval');
    sdkValIn.addEventListener('input', () => { sdkStateValue = sdkValIn.value.trim(); });
    sdkValWrap.appendChild(sdkValLbl); sdkValWrap.appendChild(sdkValIn);
    fSdkState.appendChild(sdkValWrap);
    const sdkHint = document.createElement('div'); sdkHint.className = 'deck-ed-hint';
    sdkHint.setAttribute('data-i18n', 'deck_sdkstate_hint'); sdkHint.textContent = t('deck_sdkstate_hint');
    fSdkState.appendChild(sdkHint);
    function syncSdkState() {
      const on = !!sdkStateName;
      sdkValWrap.style.display = on ? '' : 'none';
      sdkHint.style.display = on ? '' : 'none';
      refreshLedDurDefault();   // a widget-state binding makes the key stateful too
    }
    sdkDeckStates().then((items) => {
      const list = (items || []).slice();
      if (sdkStateName && !list.some((it) => it.value === sdkStateName)) list.unshift({ value: sdkStateName, label: sdkStateName });
      if (!list.length) return;   // nothing published and nothing bound → field stays hidden
      const sel = document.createElement('select'); sel.className = 'deck-ed-input';
      const none = document.createElement('option'); none.value = ''; none.setAttribute('data-i18n', 'deck_opt_none'); none.textContent = t('deck_opt_none'); sel.appendChild(none);
      list.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
      sel.value = sdkStateName;
      sel.addEventListener('change', () => { sdkStateName = sel.value; syncSdkState(); });
      sdkNameWrap.replaceChildren(sel);
      enhanceSelects(sdkNameWrap);
      sdkStatesAvail = true;
      syncKind();
    }).catch(() => {});
    syncSdkState();
    // Visibility (states available AND kind=action) is owned by syncKind() below.
    paneAction.appendChild(fSdkState);

    // Action picker categories (in display order); each maps an ACTION_CATALOG
    // `group` to a localized header. The `lighting` group carries the visible
    // whole-system light actions (the legacy hidden `lighting` reaction is
    // filtered out by its `hidden` flag).
    const ACTION_CATEGORIES = [
      { group: 'system', labelKey: 'deck_cat_system' },
      { group: 'media', labelKey: 'deck_cat_media' },
      { group: 'soundboard', labelKey: 'deck_cat_soundboard' },
      { group: 'timer', labelKey: 'deck_cat_timer' },
      { group: 'audio', labelKey: 'deck_cat_audio' },
      { group: 'obs', labelKey: 'deck_cat_obs' },
      { group: 'stream', labelKey: 'deck_cat_stream' },
      { group: 'streamerbot', labelKey: 'deck_cat_streamerbot' },
      { group: 'discord', labelKey: 'deck_cat_discord' },
      { group: 'spotify', labelKey: 'deck_cat_spotify' },
      { group: 'homeassistant', labelKey: 'deck_cat_homeassistant' },
      { group: 'chroma', labelKey: 'deck_cat_chroma' },
      { group: 'wavelink', labelKey: 'deck_cat_wavelink' },
      { group: 'lighting', labelKey: 'deck_cat_lighting' },
      { group: 'window', labelKey: 'deck_cat_window' },
      { group: 'remote', labelKey: 'deck_cat_remote' },
      { group: 'sdk', labelKey: 'deck_cat_sdk' },
      { group: 'ai', labelKey: 'deck_cat_ai' },
    ];
    // Per-action inline icons (currentColor). Kept compact; an action with no
    // entry simply shows no icon.
    const _ai = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
    const ACTION_ICONS = {
      openApp: _ai('<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18"/>'),
      openFile: _ai('<path d="M6 3h9l3 3v15H6z"/><path d="M9 13h6M9 17h4"/>'),
      runScript: _ai('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>'),
      openStoreApp: _ai('<path d="M5 8h14l-1 12H6z"/><path d="M9 8a3 3 0 0 1 6 0"/>'),
      launchSteamGame: _ai('<rect x="2" y="7" width="20" height="10" rx="5"/><path d="M7 10v4M5 12h4M15 11h.01M18 13h.01"/>'),
      openUrl: _ai('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>'),
      hotkey: _ai('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
      typeText: _ai('<path d="M4 7V5h16v2M12 5v14M9 19h6"/>'),
      lockWorkstation: _ai('<path d="M18 8h-1V6a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm3.1-9H8.9V6a3.1 3.1 0 0 1 6.2 0z"/>'),
      signalRgbEffect: _ai('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'),
      webhook: _ai('<path d="M9 17H7A5 5 0 0 1 7 7h1M16 7h1a5 5 0 0 1 0 10h-2M8 12h8"/>'),
      media: _ai('<path d="M8 5v14l11-7z"/>'),
      playSound: _ai('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/>'),
      timerStart: _ai('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>'),
      timerToggle: _ai('<circle cx="12" cy="13" r="8"/><path d="M10 10v6M14 10v6M9 2h6"/>'),
      timerCancel: _ai('<circle cx="12" cy="13" r="8"/><path d="M9.5 10.5l5 5M14.5 10.5l-5 5M9 2h6"/>'),
      micMute: _ai('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
      volume: _ai('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
      appVolume: _ai('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9v6"/>'),
      appMute: _ai('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 4 6M20 9l-4 6"/>'),
      appMixer: _ai('<path d="M5 5v14M12 5v14M19 5v14"/><circle cx="5" cy="10" r="2" fill="currentColor"/><circle cx="12" cy="14" r="2" fill="currentColor"/><circle cx="19" cy="9" r="2" fill="currentColor"/>'),
      obsScene: _ai('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>'),
      obsSceneNext: _ai('<path d="M16 6h2v12h-2zM6 18l9-6-9-6z"/>'),
      obsRecord: _ai('<circle cx="12" cy="12" r="6" fill="currentColor"/>'),
      obsStream: _ai('<circle cx="12" cy="12" r="3"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/>'),
      obsMute: _ai('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 4 6M20 9l-4 6"/>'),
      obsInputVolume: _ai('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a9 9 0 0 1 0 12"/>'),
      twitchClip: _ai('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9.5h18M8 5l-1.5 4.5M16 5l-1.5 4.5"/>'),
      twitchMarker: _ai('<path d="M6 3h12v18l-6-4-6 4z"/>'),
      twitchAd: _ai('<path d="M4 9v6h3l7 4V5L7 9H4Z"/><path d="M17.5 9a4 4 0 0 1 0 6"/>'),
      twitchTitle: _ai('<path d="M4 7V5h16v2M9 19h6M12 5v14"/>'),
      twitchGame: _ai('<rect x="2" y="7" width="20" height="10" rx="4"/><path d="M7 11v2M6 12h2"/><circle cx="16" cy="11" r="1" fill="currentColor"/><circle cx="18" cy="13.5" r="1" fill="currentColor"/>'),
      twitchChat: _ai('<path d="M4 5h16v11H8l-4 3z"/><path d="M8 10h8M8 13h5"/>'),
      twitchShoutout: _ai('<path d="M3 11v2l4 1 2 5h2l-1-4 9 2V7l-9 2-4-.5z"/><path d="M19 8a4 4 0 0 1 0 8"/>'),
      twitchChatMode: _ai('<path d="M12 3l8 3v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12h6M12 9v6"/>'),
      ytBroadcast: _ai('<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9l5 3-5 3z"/>'),
      sbDoAction: _ai('<path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="4"/><path d="m7 7 2 2M15 15l2 2M17 7l-2 2M9 15l-2 2"/>'),
      remoteDisconnect: _ai('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M8 8l8 6M16 8l-8 6"/>'),
      remoteBlock: _ai('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>'),
      remoteScreenCycle: _ai('<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"/>'),
      ai: _ai('<path d="M12 3l2.2 6.5L21 12l-6.8 2.5L12 21l-2.2-6.5L3 12l6.8-2.5z"/>'),
      discordMute: _ai('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
      discordDeafen: _ai('<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2" y="14" width="5" height="6" rx="1.5"/><rect x="17" y="14" width="5" height="6" rx="1.5"/>'),
      discordPtt: _ai('<rect x="8" y="2" width="8" height="13" rx="4"/><path d="M12 15v5M8 20h8"/>'),
      discordJoin: _ai('<path d="M4 14v-2a8 8 0 0 1 12.5-6.6"/><rect x="2" y="14" width="5" height="6" rx="1.5"/><path d="M15 11h7M19 8l3 3-3 3"/>'),
      discordLeave: _ai('<path d="M14 12H4M8 8l-4 4 4 4"/><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/>'),
      discordInputVol: _ai('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M18 6l3-3M21 3v3h-3"/>'),
      discordOutputVol: _ai('<path d="M4 9v6h3l6 4V5L7 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8 8 0 0 1 0 12"/>'),
      discordAudioToggle: _ai('<path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"/><path d="M5 11a7 7 0 0 0 14 0M4 4l16 16"/>'),
      discordSoundboard: _ai('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
      haToggle: _ai('<path d="M12 3 3 11h2v8h6v-5h2v5h6v-8h2z"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>'),
      haScene: _ai('<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>'),
      haCallService: _ai('<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1l-.4-2.6H9.5l-.4 2.6a7 7 0 0 0-1.7 1l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.4 2.6h4.9l.4-2.6a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5a7 7 0 0 0 .1-1Z"/>'),
      windowMove: _ai('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14l-2 2 2 2M16 14l2 2-2 2M6 16h12"/>'),
      spotifyPlay: _ai('<circle cx="12" cy="12" r="9"/><path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none"/>'),
      spotifyNext: _ai('<path d="M6 5l9 7-9 7z" fill="currentColor" stroke="none"/><path d="M18 5v14"/>'),
      spotifyPrev: _ai('<path d="M18 5l-9 7 9 7z" fill="currentColor" stroke="none"/><path d="M6 5v14"/>'),
      spotifySave: _ai('<circle cx="12" cy="12" r="9"/><path d="M7.5 10c3-.8 6-.5 8.5 1M8 13c2.3-.6 4.6-.4 6.5.9"/>'),
      spotifyLike: _ai('<path d="M12 20.3 4.2 12.5a4.4 4.4 0 0 1 6.2-6.2l1.6 1.6 1.6-1.6a4.4 4.4 0 0 1 6.2 6.2z"/>'),
      spotifyShuffle: _ai('<path d="M16 3h5v5M4 20l16-16M21 16v5h-5M15 15l6 6M4 4l5 5"/>'),
      spotifyRepeat: _ai('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
      spotifyVolume: _ai('<path d="M4 9v6h3l6 4V5L7 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>'),
      spotifySeek: _ai('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
      spotifyPlaylist: _ai('<path d="M4 7h11M4 12h11M4 17h7"/><circle cx="18" cy="15" r="3"/><path d="M21 15V6l-3 1"/>'),
      spotifyDevice: _ai('<rect x="4" y="3" width="16" height="18" rx="3"/><circle cx="12" cy="14" r="3"/><path d="M11 7h2"/>'),
      sdkMacro: _ai('<path d="M14 7h4a1 1 0 0 1 1 1v3.5a1.5 1.5 0 0 0 0 3V18a1 1 0 0 1-1 1h-3.5a1.5 1.5 0 0 1-3 0H8a1 1 0 0 1-1-1v-3.5a1.5 1.5 0 0 1 0-3V8a1 1 0 0 1 1-1h3.5a1.5 1.5 0 0 1 3 0Z"/>'),
      sdkHandler: _ai('<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>'),
      chromaColor: _ai('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>'),
      chromaOff: _ai('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M4 5l16 14"/>'),
      wlInputVolume: _ai('<path d="M6 4v16M12 4v16M18 4v16"/><circle cx="6" cy="9" r="1.8" fill="currentColor"/><circle cx="12" cy="14" r="1.8" fill="currentColor"/><circle cx="18" cy="8" r="1.8" fill="currentColor"/>'),
      wlInputMute: _ai('<path d="M6 4v16M12 4v16M18 4v16"/><path d="M3 3l18 18"/>'),
      wlOutputVolume: _ai('<path d="M4 9v6h3l6 4V5L7 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>'),
      wlOutputMute: _ai('<path d="M4 9v6h3l6 4V5L7 9H4Z"/><path d="m16 9 4 6M20 9l-4 6"/>'),
      wlSwitchMonitoring: _ai('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
      wlSetMonitorMix: _ai('<circle cx="8.5" cy="12" r="5.5"/><circle cx="15.5" cy="12" r="5.5"/>'),
      lightPower: _ai('<path d="M12 3v9"/><path d="M6.6 7A8 8 0 1 0 17.4 7"/>'),
      lightColor: _ai('<path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-1.3 1-2.4 2.3-2.4H18a3 3 0 0 0 3-3c0-5-4-8-9-8Z"/><circle cx="7.5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="8" r="1" fill="currentColor"/><circle cx="16" cy="11" r="1" fill="currentColor"/>'),
      lightAuto: _ai('<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"/><circle cx="12" cy="12" r="2.5"/>'),
      lightEffect: _ai('<path d="m12 3 2.2 6.5L21 12l-6.8 2.5L12 21l-2.2-6.5L3 12l6.8-2.5z"/>'),
      lightDevice: _ai('<rect x="4" y="4" width="16" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M8 9h.01M11 9h.01M14 9h.01"/>'),
    };

    // A service category whose provider isn't configured/connected stays visible
    // as a single disabled "hint" row pointing to its setup, instead of vanishing
    // — so the user discovers OBS/Twitch/Streamer.bot/Remote Deck actions exist.
    const LOCKED_HINTS = {
      obs: 'deck_cat_hint_obs',
      stream: 'deck_cat_hint_stream',
      streamerbot: 'deck_cat_hint_streamerbot',
      discord: 'deck_cat_hint_discord',
      spotify: 'deck_cat_hint_spotify',
      homeassistant: 'deck_cat_hint_homeassistant',
      chroma: 'deck_cat_hint_chroma',
      wavelink: 'deck_cat_hint_wavelink',
      lighting: 'deck_cat_hint_lighting',
      remote: 'deck_cat_hint_remote',
    };
    const LOCK_ICON = _ai('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>');

    // Whether an action is available to the current user (hidden actions and
    // unconfigured OBS/remote/stream services are filtered out of the picker).
    function actionGateOk(a) {
      if (a.hidden) return false;
      if (a.group === 'obs' && obsConfigured === false) return false;
      if (a.group === 'remote' && remoteConfigured === false) return false;
      if (a.group === 'stream') {                       // mixes Twitch + YouTube
        const isYt = a.type === 'ytBroadcast';
        if (isYt && youtubeConnected === false) return false;
        if (!isYt && twitchConnected === false) return false;
      }
      if (a.group === 'streamerbot' && streamerbotConfigured === false) return false;
      if (a.group === 'discord' && discordConnected === false) return false;
      if (a.group === 'spotify' && spotifyConnected === false) return false;
      if (a.group === 'chroma' && chromaEnabled === false) return false;
      if (a.group === 'wavelink' && wavelinkEnabled === false) return false;
      // SignalRGB is a separate opt-in scene switcher: it lives in the lighting
      // group but is gated on its OWN enable flag, not the colour-rig config — so
      // it can be offered even when no iCUE/Hue/WLED rig is set up (and hidden
      // when SignalRGB is off, whatever the rest of the lighting state is).
      if (a.type === 'signalRgbEffect') return signalrgbEnabled === true;
      if (a.group === 'lighting' && lightingConfigured === false) return false;
      // Widget-SDK contributions: each action type is offered only once the
      // (lazy) package scan found matching entries. No locked-hint row — an
      // empty "Widget" category would be noise for everyone else.
      if (a.type === 'sdkMacro' && !(sdkMacroItemsCache && sdkMacroItemsCache.length)) return false;
      if (a.type === 'sdkHandler' && !(sdkHandlerItemsCache && sdkHandlerItemsCache.length)) return false;
      if (a.group === 'homeassistant') {
        if (homeAssistantConfigured === false) return false;
        // Capability-aware (generic): a device-type action (haLight, haCover…) is
        // offered only when the user actually has a device of that domain. The
        // generic on/off (haToggle) and advanced call-service are always available.
        const ep = a.params && a.params.find((p) => p.kind === 'haEntity' && p.domain);
        if (ep && haDomains && !haDomains.has(ep.domain)) return false;
      }
      return true;
    }

    function actionSelect(value) {
      const sel = document.createElement('select'); sel.className = 'deck-ed-input';
      const none = document.createElement('option'); none.value = ''; none.setAttribute('data-i18n', 'deck_edit_none'); none.textContent = t('deck_edit_none'); sel.appendChild(none);
      // Group the actions into labelled categories with a per-action icon, mirroring
      // the dashboard "+" palette. Categories render as <optgroup>s; the custom
      // select turns those into headers and shows each option's data-cs-icon.
      ACTION_CATEGORIES.forEach((cat) => {
        const all = DA.ACTION_CATALOG.filter((a) => a.group === cat.group && !a.hidden);
        if (!all.length) return;
        const acts = all.filter(actionGateOk);
        const og = document.createElement('optgroup'); og.label = t(cat.labelKey);
        if (!acts.length) {
          // Locked service category → one disabled hint row instead of hiding it.
          const hintKey = LOCKED_HINTS[cat.group];
          if (!hintKey) return;
          const o = document.createElement('option');
          // A sentinel value (never a real action type, and disabled so it can't be
          // chosen) — keeps it from matching the empty "None" selection and being
          // styled as selected.
          o.value = '__locked_' + cat.group + '__'; o.disabled = true;
          o.setAttribute('data-i18n', hintKey); o.textContent = t(hintKey);
          o.dataset.csIcon = LOCK_ICON;
          og.appendChild(o);
          sel.appendChild(og);
          return;
        }
        acts.forEach((a) => {
          const o = document.createElement('option');
          o.value = a.type; o.setAttribute('data-i18n', a.labelKey); o.textContent = t(a.labelKey);
          if (ACTION_ICONS[a.type]) o.dataset.csIcon = ACTION_ICONS[a.type];
          og.appendChild(o);
        });
        sel.appendChild(og);
      });
      sel.value = value || '';
      // A key may carry an action that isn't in the picker — a hidden/internal one
      // (e.g. `lighting`, which Genesis can configure), or a service action whose
      // provider isn't currently configured. Show it as its own trailing option so
      // the select reads its real name instead of silently falling back to "None"
      // (which made AI-built keys look broken, with stray untranslated params).
      if (value && sel.value !== value) {
        const spec = DA.actionSpec(value);
        const o = document.createElement('option');
        o.value = value;
        if (spec && spec.labelKey) { o.setAttribute('data-i18n', spec.labelKey); o.textContent = t(spec.labelKey); }
        else { o.textContent = value; }
        if (ACTION_ICONS[value]) o.dataset.csIcon = ACTION_ICONS[value];
        sel.appendChild(o);
        sel.value = value;
      }
      return sel;
    }

    // A param control that starts as a text field and upgrades to a dropdown of
    // OBS's live list (scenes or audio sources) when reachable; stays a typed
    // text field when OBS is offline. `fetcher` returns a Promise<string[]>.
    function obsPickControl(step, name, fetcher, placeholderKey) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t(placeholderKey);
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      fetcher().then((items) => {
        if (!items || !items.length) return;
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        const names = (cur && !items.includes(cur)) ? [cur, ...items] : items;
        names.forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
        sel.value = cur || items[0];
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);   // OBS scene/source list arrived → style its dropdown too
      }).catch(() => {});
      return wrap;
    }

    // Soundboard clip picker: a typed path field that upgrades to a dropdown of
    // the uploaded library (GET /deck/sounds), with a "Carica" button that POSTs
    // a new clip and selects it. The manual path stays available as the first
    // option so an existing absolute-path key round-trips untouched.
    // The pickable clip list: the uploaded library plus every installed sound
    // pack's clips ("Pack name › clip"), whose values are the PACK-RELATIVE
    // paths a shared profile can carry across machines.
    async function soundLibrary() {
      const [loose, packs] = await Promise.all([
        fetch('/deck/sounds').then((r) => r.json()).then((d) => (d && d.sounds) || []).catch(() => []),
        fetch('/deck/sound-packs').then((r) => r.json()).then((d) => (d && d.packs) || []).catch(() => []),
      ]);
      const out = loose.map((s) => ({ path: s.path, name: s.name }));
      packs.forEach((p) => (p.clips || []).forEach((c) => out.push({ path: c.path, name: p.name + ' › ' + c.label })));
      return out;
    }
    function soundPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_file');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      const uploadBtn = document.createElement('button');
      uploadBtn.type = 'button'; uploadBtn.className = 'deck-ed-btn deck-ed-subfield';
      uploadBtn.setAttribute('data-i18n', 'deck_sound_upload'); uploadBtn.textContent = t('deck_sound_upload');
      const fileIn = document.createElement('input');
      fileIn.type = 'file'; fileIn.accept = 'audio/*'; fileIn.style.display = 'none';
      uploadBtn.addEventListener('click', () => fileIn.click());
      const rebuild = (sounds) => {
        if (!sounds || !sounds.length) return;
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        const manual = document.createElement('option');
        manual.value = '__manual__'; manual.setAttribute('data-i18n', 'deck_sound_manual'); manual.textContent = t('deck_sound_manual');
        sel.appendChild(manual);
        sounds.forEach((s) => { const o = document.createElement('option'); o.value = s.path; o.textContent = s.name; sel.appendChild(o); });
        const inLib = cur && sounds.some((s) => s.path === cur);
        sel.value = inLib ? cur : '__manual__';
        const syncManual = () => {
          const isManual = sel.value === '__manual__';
          txt.style.display = isManual ? '' : 'none';
          if (!isManual) step.params[name] = sel.value;
          else step.params[name] = txt.value;
        };
        sel.addEventListener('change', syncManual);
        wrap.insertBefore(sel, txt);
        syncManual();
        enhanceSelects(wrap);
      };
      fileIn.addEventListener('change', async () => {
        const f = fileIn.files && fileIn.files[0];
        if (!f) return;
        const fd = new FormData();
        fd.append('sound', f, f.name);
        try {
          const r = await fetch('/deck/sound-upload', { method: 'POST', body: fd });
          const d = await r.json().catch(() => null);
          if (!d || !d.ok) { toast('error', t('deck_sound_upload_failed')); return; }
          step.params[name] = d.path;
          txt.value = d.path;
          // Rebuild the dropdown fresh so the new clip appears selected.
          wrap.querySelectorAll('select, .cs-wrap').forEach((n) => n.remove());
          rebuild(await soundLibrary());
          const sel = wrap.querySelector('select');
          if (sel) { sel.value = d.path; sel.dispatchEvent(new Event('change')); }
        } catch { toast('error', t('deck_sound_upload_failed')); }
        finally { fileIn.value = ''; }
      });
      wrap.appendChild(fileIn);
      wrap.appendChild(uploadBtn);
      soundLibrary().then(rebuild).catch(() => {});
      return wrap;
    }

    // A param control for the sbAction kind: a dropdown of Streamer.bot's live
    // actions ({value:id, label:name}). The action is stored by id (stable across
    // renames). A typed text field is the fallback shown while streamer.bot is
    // unreachable, so an already-assigned id is never lost when offline.
    function sbActionPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_action');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      sbActions().then((items) => {
        if (!items || !items.length) return;   // offline → typed id field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        // Preserve an assigned id that's no longer in the list as a trailing option
        // so the select reads its real value instead of silently switching actions.
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);   // streamer.bot list arrived → style its dropdown too
      }).catch(() => {});
      return wrap;
    }

    // A param control for the sbCodeTrigger kind: a dropdown of Streamer.bot code
    // triggers, stored by trigger name. A typed field is the fallback while
    // streamer.bot is unreachable, so an assigned trigger is never lost (mirrors
    // sbActionPickControl).
    function sbCodeTriggerPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_trigger');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      sbCodeTriggers().then((items) => {
        if (!items || !items.length) return;   // offline → typed name field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);   // code-trigger list arrived → style its dropdown too
      }).catch(() => {});
      return wrap;
    }

    // A param control for the signalRgbEffect kind: a searchable dropdown of the
    // user's installed SignalRGB effects (the list can be long → data-cs-search).
    // A typed field is the fallback while the list is empty/loading, so an already
    // assigned effect is never lost (mirrors sbCodeTriggerPickControl).
    function signalRgbEffectPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_effect');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      signalRgbEffects().then((items) => {
        if (!items || !items.length) return;   // off/absent → typed effect field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        sel.setAttribute('data-cs-search', '');
        sel.setAttribute('data-cs-search-placeholder', t('deck_param_effect'));
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);   // effect list arrived → style + search-enable its dropdown
      }).catch(() => {});
      return wrap;
    }

    // A param control for the sdkMacro kind: a dropdown of the macros installed
    // widget packages contribute ({value:'pkg/macroId', label:'Widget › Macro'}).
    // A typed ref field is the fallback when no package is readable, so an
    // already-assigned macro is never lost (mirrors sbActionPickControl).
    function sdkMacroPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_macro');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      sdkMacros().then((items) => {
        if (!items || !items.length) return;   // none installed → typed ref field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);   // package list arrived → style its dropdown too
      }).catch(() => {});
      return wrap;
    }

    // The whole-action control for sdkHandler: a dropdown of the handler actions
    // installed packages contribute PLUS an auto-generated form for the chosen
    // handler's manifest-declared params (text/select/number). The form's values
    // serialize into step.params.args as JSON — the exact string the server
    // re-coerces through validateHandlerArgs at run time.
    function sdkHandlerParams(host, step) {
      if (step.params.handler == null) step.params.handler = '';
      if (step.params.args == null) step.params.args = '';
      const fH = field('deck_param_handler');
      const wrap = document.createElement('div');
      const txt = input('text', step.params.handler);   // typed-ref fallback (packages unreadable)
      txt.placeholder = t('deck_param_handler');
      const writeTxt = () => { step.params.handler = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      fH.appendChild(wrap);
      const argsHost = document.createElement('div');
      const readArgs = () => {
        try { const o = JSON.parse(step.params.args || '{}'); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
        catch { return {}; }
      };
      const renderHandlerArgs = (items) => {
        argsHost.replaceChildren();
        const it = (items || []).find((x) => x.value === step.params.handler);
        const params = (it && it.params) || [];
        if (!params.length) { step.params.args = ''; return; }
        const cur = readArgs();
        const next = {};
        const write = () => { step.params.args = JSON.stringify(next); };
        params.forEach((p) => {
          const pf = document.createElement('div'); pf.className = 'deck-ed-subfield';
          const lbl = document.createElement('span'); lbl.className = 'deck-ed-label';
          lbl.textContent = p.label || p.name;   // untrusted manifest text → textContent
          pf.appendChild(lbl);
          if (p.kind === 'select') {
            const sel = document.createElement('select'); sel.className = 'deck-ed-input';
            (p.options || []).forEach((o) => { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; sel.appendChild(opt); });
            sel.value = (p.options || []).includes(cur[p.name]) ? cur[p.name] : (p.options || [])[0] || '';
            next[p.name] = sel.value;
            sel.addEventListener('change', () => { next[p.name] = sel.value; write(); });
            pf.appendChild(sel);
          } else if (p.kind === 'number') {
            const num = input('number', cur[p.name] != null ? String(cur[p.name]) : '');
            if (p.min != null) num.min = String(p.min);
            if (p.max != null) num.max = String(p.max);
            if (cur[p.name] != null) next[p.name] = Number(cur[p.name]);
            const w = () => { const n = Number(num.value); if (Number.isFinite(n)) next[p.name] = n; else delete next[p.name]; write(); };
            num.addEventListener('input', w); num.addEventListener('change', w);
            pf.appendChild(num);
          } else {
            const ti = input('text', cur[p.name] != null ? String(cur[p.name]) : '');
            ti.maxLength = 200;   // = HANDLER_ARG_TEXT_MAX, the server's per-value delivery cap
            if (cur[p.name] != null) next[p.name] = String(cur[p.name]);
            const w = () => { if (ti.value) next[p.name] = ti.value; else delete next[p.name]; write(); };
            ti.addEventListener('input', w); ti.addEventListener('change', w);
            pf.appendChild(ti);
          }
          argsHost.appendChild(pf);
        });
        write();
        enhanceSelects(argsHost);
      };
      sdkHandlers().then((items) => {
        if (items && items.length) {
          const sel = document.createElement('select'); sel.className = 'deck-ed-input';
          const cur = step.params.handler || '';
          let list = items;
          if (cur && !list.some((it) => it.value === cur)) list = [{ value: cur, label: cur, params: [] }, ...list];
          list.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
          sel.value = cur || list[0].value;
          step.params.handler = sel.value;
          sel.addEventListener('change', () => { step.params.handler = sel.value; step.params.args = ''; renderHandlerArgs(list); });
          wrap.replaceChildren(sel);
          enhanceSelects(wrap);
          renderHandlerArgs(list);
        }
      }).catch(() => {});
      host.appendChild(fH);
      host.appendChild(argsHost);
    }

    // A param control for the discordChannel kind: a dropdown of the user's live
    // voice channels ({value:id, label:"Guild › Channel"}), stored by channel id.
    // A typed id field is the fallback while Discord is unreachable, so an already-
    // assigned channel is never lost when offline (mirrors sbActionPickControl).
    function discordChannelPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_channel');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      discordChannels().then((items) => {
        if (!items || !items.length) return;   // offline → typed id field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);   // channel list arrived → style its dropdown too
      }).catch(() => {});
      return wrap;
    }

    // A param control for the discordSound kind: a dropdown of the user's live
    // soundboard sounds, stored as an opaque "guildId|soundId" ref. A read-only
    // text field mirrors the saved ref while Discord is unreachable, so an already-
    // assigned sound is never lost when offline (mirrors discordChannelPickControl).
    function discordSoundPickControl(step, name) {
      const wrap = document.createElement('div');
      wrap.className = 'deck-ed-sound-row';
      const txt = input('text', step.params[name] || '');
      txt.readOnly = true;   // the ref is opaque — the dropdown is the only way to set it
      txt.placeholder = t('deck_param_sound');
      // Preview: audition the SELECTED sound locally from Discord's CDN, so you can
      // hear it while assigning the key (no voice channel needed). A built-in default
      // sound or a network hiccup simply no-ops. One shared <audio>, replaced per play.
      const preview = document.createElement('button');
      preview.type = 'button'; preview.className = 'deck-ed-btn deck-ed-sound-preview';
      preview.title = t('deck_sound_preview');
      preview.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      let audio = null;
      preview.addEventListener('click', (e) => {
        e.preventDefault();
        const soundId = String(step.params[name] || '').split('|').pop();
        if (!/^\d+$/.test(soundId)) return;
        try { if (audio) audio.pause(); audio = new Audio('https://cdn.discordapp.com/soundboard-sounds/' + soundId); audio.volume = 0.8; audio.play().catch(() => {}); } catch { /* ignore */ }
      });
      wrap.append(txt, preview);
      discordSounds().then((items) => {
        if (!items || !items.length) return;   // offline → read-only ref field + preview
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel, preview);
        enhanceSelects(wrap);   // sound list arrived → style its dropdown too
      }).catch(() => {});
      return wrap;
    }

    // A param control for the haEntity kind: a dropdown of the user's live Home
    // Assistant entities ({value:entity_id, label:"Area › Name"}), stored by
    // entity_id. A typed field is the fallback while HA is unreachable, so an
    // already-assigned entity is never lost when offline (mirrors discordChannel).
    function haEntityPickControl(step, name, domain) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_entity');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      haEntities().then((items) => {
        // Capability-aware: a domain-scoped action (haMedia, haCover…) only lists
        // entities of that domain, so the picker shows the RIGHT devices.
        if (domain) items = items.filter((it) => String(it.value).startsWith(domain + '.'));
        if (!items || !items.length) return;   // offline / none of this kind → typed id field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);   // entity list arrived → style its dropdown too
      }).catch(() => {});
      return wrap;
    }

    // A param control for the wlChannel kind: a dropdown of the user's live Wave
    // Link mixer channels ({value:mixId, label}), stored by mixId. A typed field is
    // the fallback while Wave Link is unreachable, so an assigned channel survives
    // offline (mirrors haEntityPickControl).
    function wlChannelPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_mixId');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      wlChannels().then((items) => {
        if (!items || !items.length) return;   // offline / none → typed mixId field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);
      }).catch(() => {});
      return wrap;
    }

    // A param control for the lightDevice kind: a dropdown of the user's lighting
    // devices ({value:id, label}), stored by device id. A typed field is the
    // fallback while no lighting is configured, so an assigned id survives offline
    // (mirrors wlChannelPickControl).
    function lightDevicePickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_device');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      lightDevices().then((items) => {
        if (!items || !items.length) return;   // none → typed id field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);
      }).catch(() => {});
      return wrap;
    }

    // A param control for the audioApp kind. The text field is the source of truth
    // (the user can type ANY process name, e.g. "spotify" or "discord", even for an
    // app that isn't currently playing). A quick-pick dropdown of the apps that ARE
    // currently producing audio is added alongside as a convenience: choosing one
    // fills the text field. Stores the process name (proc), not the display name.
    function appPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_app');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      audioApps().then((items) => {
        if (!items || !items.length) return;   // nothing playing → typed field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const ph = document.createElement('option'); ph.value = '';
        ph.setAttribute('data-i18n', 'deck_opt_apppick'); ph.textContent = t('deck_opt_apppick');
        sel.appendChild(ph);
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        const cur = step.params[name] || '';
        sel.value = items.some((it) => it.value === cur) ? cur : '';
        sel.addEventListener('change', () => {
          if (!sel.value) return;
          txt.value = sel.value;            // mirror the pick into the editable field
          step.params[name] = sel.value;
        });
        wrap.appendChild(sel);
        enhanceSelects(wrap);
      }).catch(() => {});
      return wrap;
    }

    // A param control for the storeApp kind: a dropdown of installed Store/UWP apps
    // (value = AppUserModelID, label = friendly name). Pure dropdown — the AUMID is
    // cryptic, so it isn't typed by hand. A previously-saved app that is no longer
    // listed (uninstalled) is kept as the current option so the key isn't silently
    // cleared. The list arrives from /apps/store (Get-StartApps, UWP only).
    function storeAppPickControl(step, name) {
      const wrap = document.createElement('div');
      const sel = document.createElement('select'); sel.className = 'deck-ed-input';
      const ph = document.createElement('option'); ph.value = '';
      ph.setAttribute('data-i18n', 'deck_opt_storeapp'); ph.textContent = t('deck_opt_storeapp');
      sel.appendChild(ph);
      sel.addEventListener('change', () => { step.params[name] = sel.value; });
      wrap.appendChild(sel);
      storeApps().then((items) => {
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) {
          const o = document.createElement('option'); o.value = cur; o.textContent = cur; sel.appendChild(o);
        }
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur;
        enhanceSelects(wrap);
      }).catch(() => {});
      return wrap;
    }

    // Bespoke params for the AI action: a mode select, plus a prompt textarea that
    // only appears for mode 'prompt' (voice/open need no text). Edits write into
    // step.params so the generic save path picks them up unchanged.
    function aiParams(host, step) {
      host.replaceChildren();
      const modes = ['prompt', 'voice', 'open'];
      if (!modes.includes(step.params.mode)) step.params.mode = 'prompt';
      const fMode = field('deck_param_mode');
      const sel = document.createElement('select'); sel.className = 'deck-ed-input';
      modes.forEach((m) => { const o = document.createElement('option'); o.value = m; o.setAttribute('data-i18n', 'deck_opt_' + m); o.textContent = t('deck_opt_' + m); sel.appendChild(o); });
      sel.value = step.params.mode;
      fMode.appendChild(sel); host.appendChild(fMode);

      const fPrompt = field('deck_param_prompt');
      const ta = document.createElement('textarea'); ta.className = 'deck-ed-input'; ta.rows = 2;
      ta.value = step.params.prompt || '';
      ta.placeholder = t('deck_ph_prompt');
      const writePrompt = () => { step.params.prompt = ta.value; };
      ta.addEventListener('input', writePrompt); ta.addEventListener('change', writePrompt);
      fPrompt.appendChild(ta); host.appendChild(fPrompt);

      const syncPrompt = () => { fPrompt.style.display = sel.value === 'prompt' ? '' : 'none'; };
      sel.addEventListener('change', () => { step.params.mode = sel.value; syncPrompt(); });
      syncPrompt();
    }

    // Build the param inputs for one step, writing edits straight into step.params.
    // Map a KeyboardEvent's main (non-modifier) key to a hotkey token, or null.
    const _HK_NAMED = { ' ': 'space', Enter: 'enter', Escape: 'esc', Tab: 'tab', Backspace: 'backspace', Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    function hotkeyToken(e) {
      const k = e.key;
      if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return null;   // modifier
      if (/^[a-zA-Z]$/.test(k)) return k.toLowerCase();
      if (/^[0-9]$/.test(k)) return k;
      if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) return k.toLowerCase();
      return _HK_NAMED[k] || null;
    }
    // Hotkey composer for the `keys` param. Press-to-record is impossible for any
    // combo with Win (Win+D, Win+Shift+arrow…): holding Win physically fires the OS
    // shortcut before the page ever sees the keydown, so the user can't set it. Here
    // the modifiers are toggle chips (no physical Win press) and only the single main
    // key is captured by tapping the field. Stored format is unchanged: "win+d".
    const _HK_MODS = [
      { id: 'ctrl', label: 'Ctrl' },
      { id: 'shift', label: 'Shift' },
      { id: 'alt', label: 'Alt' },
      { id: 'win', label: 'Win' },
    ];
    // Split a stored "ctrl+shift+m" into its modifier set + main key.
    function parseHotkeyCombo(str) {
      const mods = new Set();
      let main = '';
      String(str || '').split('+').map((s) => s.trim().toLowerCase()).filter(Boolean).forEach((tok) => {
        if (tok === 'ctrl' || tok === 'control') mods.add('ctrl');
        else if (tok === 'shift') mods.add('shift');
        else if (tok === 'alt') mods.add('alt');
        else if (tok === 'win' || tok === 'meta' || tok === 'super' || tok === 'cmd') mods.add('win');
        else main = tok;
      });
      return { mods, main };
    }
    function hotkeyCaptureControl(step, name) {
      const wrap = document.createElement('div'); wrap.className = 'deck-ed-hotkey';
      const parsed = parseHotkeyCombo(step.params[name]);
      const mods = parsed.mods;
      let main = parsed.main;

      const preview = document.createElement('div'); preview.className = 'deck-ed-hotkey-preview';
      const commit = () => {
        const ordered = _HK_MODS.filter((m) => mods.has(m.id)).map((m) => m.id);
        const combo = main ? ordered.concat(main).join('+') : '';
        step.params[name] = combo;
        preview.textContent = combo || t('deck_hotkey_empty');
        preview.classList.toggle('is-empty', !combo);
      };

      // Modifier toggle chips — tapping never physically presses the key.
      const modRow = document.createElement('div'); modRow.className = 'deck-ed-hotkey-mods';
      _HK_MODS.forEach((m) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'deck-ed-hotkey-mod'; b.textContent = m.label;
        if (mods.has(m.id)) b.classList.add('active');
        b.addEventListener('click', () => {
          if (mods.has(m.id)) { mods.delete(m.id); b.classList.remove('active'); }
          else { mods.add(m.id); b.classList.add('active'); }
          commit();
        });
        modRow.appendChild(b);
      });

      // Main-key field — tap it and press a single key (letter, digit, F-key…). No
      // modifier is held here, so no OS shortcut can hijack the capture.
      const row = document.createElement('div'); row.className = 'deck-ed-hotkey-row';
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'deck-ed-input deck-ed-hotkey-input'; inp.readOnly = true;
      inp.value = main;
      inp.placeholder = t('deck_hotkey_mainkey');
      inp.title = t('deck_hotkey_mainkey');
      inp.addEventListener('keydown', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Backspace' || e.key === 'Delete') { main = ''; inp.value = ''; commit(); return; }
        const tok = hotkeyToken(e);
        if (!tok) return;   // modifier alone / unsupported key: ignore
        main = tok; inp.value = tok; commit();
      });
      const clear = document.createElement('button');
      clear.type = 'button'; clear.className = 'deck-ed-hotkey-clear'; clear.textContent = '✕'; clear.title = t('deck_hotkey_clear');
      clear.addEventListener('click', () => {
        mods.clear(); main = ''; inp.value = '';
        modRow.querySelectorAll('.deck-ed-hotkey-mod.active').forEach((x) => x.classList.remove('active'));
        commit();
      });
      row.append(inp, clear);

      wrap.append(modRow, row, preview);
      commit();
      return wrap;
    }

    function stepParams(host, step) {
      host.replaceChildren();
      const spec = DA.actionSpec(step.type);
      if (!spec) return;
      if (step.type === 'ai') { aiParams(host, step); return; }
      if (step.type === 'sdkHandler') { sdkHandlerParams(host, step); return; }   // handler + declared-params form
      spec.params.forEach((p) => {
        const f = field('deck_param_' + p.name);
        if (step.type === 'hotkey' && p.name === 'keys') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(hotkeyCaptureControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'audioApp') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(appPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'storeApp') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(storeAppPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'obsScene' || p.kind === 'obsSource') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          const fetcher = p.kind === 'obsScene' ? obsScenes : obsSources;
          f.appendChild(obsPickControl(step, p.name, fetcher, 'deck_param_' + p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'sbAction') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(sbActionPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'sbCodeTrigger') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(sbCodeTriggerPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'signalRgbEffect') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(signalRgbEffectPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'sdkMacro') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(sdkMacroPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'discordChannel') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(discordChannelPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'discordSound') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(discordSoundPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'haEntity') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(haEntityPickControl(step, p.name, p.domain));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'wlChannel') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(wlChannelPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'lightDevice') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(lightDevicePickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'sound') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(soundPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'color') {
          // Native colour picker; stored as "#rrggbb" (validated server-side).
          const cur = /^#[0-9a-fA-F]{6}$/.test(step.params[p.name] || '') ? step.params[p.name] : '#7c5cff';
          const ctrl = input('color', cur);
          step.params[p.name] = ctrl.value;
          const write = () => { step.params[p.name] = ctrl.value; };
          ctrl.addEventListener('change', write); ctrl.addEventListener('input', write);
          f.appendChild(ctrl); host.appendChild(f);
          return;
        }
        let ctrl;
        if (p.kind === 'select') {
          ctrl = document.createElement('select'); ctrl.className = 'deck-ed-input';
          p.options.forEach((o) => { const opt = document.createElement('option'); opt.value = o; opt.setAttribute('data-i18n', 'deck_opt_' + o); opt.textContent = t('deck_opt_' + o); ctrl.appendChild(opt); });
          ctrl.value = (step.params[p.name] != null && p.options.includes(step.params[p.name])) ? step.params[p.name] : p.options[0];
        } else {
          ctrl = input('text', step.params[p.name] || '');
          // Helpful example placeholders so it's obvious what to enter per param.
          ctrl.placeholder = { path: 'C:\\...\\app.exe', file: 'C:\\...\\suono.mp3', url: 'https://esempio.com', keys: 'ctrl+shift+m', args: '{"key":"value"}', gameId: '1086940', message: t('deck_ph_message'), text: t('deck_ph_text') }[p.name] || '';
        }
        step.params[p.name] = ctrl.value;                 // seed the default
        const write = () => { step.params[p.name] = ctrl.value; };
        ctrl.addEventListener('change', write); ctrl.addEventListener('input', write);
        f.appendChild(ctrl); host.appendChild(f);
      });
    }

    function renderSteps() {
      stepsHost.replaceChildren();
      const list = trig[activeTrig];
      list.forEach((step, i) => {
        const row = document.createElement('div'); row.className = 'deck-ed-step';
        if (i > 0) {
          const dWrap = document.createElement('label'); dWrap.className = 'deck-ed-stepdelay';
          const dLbl = document.createElement('span'); dLbl.className = 'deck-ed-label'; dLbl.setAttribute('data-i18n', 'deck_step_delay'); dLbl.textContent = t('deck_step_delay');
          const dIn = input('number', step.delayMs); dIn.min = '0'; dIn.max = '10000';
          dIn.addEventListener('input', () => { step.delayMs = DA.clampDelay(dIn.value); });
          dWrap.appendChild(dLbl); dWrap.appendChild(dIn); row.appendChild(dWrap);
        }
        const head = document.createElement('div'); head.className = 'deck-ed-step-head';
        const sel = actionSelect(step.type);
        sel.addEventListener('change', () => { step.type = sel.value; step.params = {}; renderSteps(); updateTrigLabels(); refreshLedDurDefault(); });
        head.appendChild(sel);
        const tools = document.createElement('div'); tools.className = 'deck-ed-step-tools';
        const up = document.createElement('button'); up.type = 'button'; up.className = 'deck-ed-stepbtn'; up.textContent = '↑'; up.disabled = i === 0;
        up.addEventListener('click', () => { list.splice(i - 1, 0, list.splice(i, 1)[0]); renderSteps(); });
        const down = document.createElement('button'); down.type = 'button'; down.className = 'deck-ed-stepbtn'; down.textContent = '↓'; down.disabled = i === list.length - 1;
        down.addEventListener('click', () => { list.splice(i + 1, 0, list.splice(i, 1)[0]); renderSteps(); });
        const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'deck-ed-stepbtn danger'; rm.textContent = '✕';
        rm.addEventListener('click', () => { list.splice(i, 1); renderSteps(); updateTrigLabels(); });
        tools.appendChild(up); tools.appendChild(down); tools.appendChild(rm);
        head.appendChild(tools); row.appendChild(head);
        const ph = document.createElement('div'); ph.className = 'deck-ed-params';
        stepParams(ph, step); row.appendChild(ph);
        stepsHost.appendChild(row);
      });
      const add = document.createElement('button'); add.type = 'button'; add.className = 'deck-ed-addstep';
      add.setAttribute('data-i18n', 'deck_add_action'); add.textContent = '+ ' + t('deck_add_action');
      add.addEventListener('click', () => { list.push({ type: '', params: {}, delayMs: 0 }); renderSteps(); updateTrigLabels(); });
      stepsHost.appendChild(add);
      enhanceSelects(stepsHost);   // upgrade the freshly-built action/param dropdowns
    }

    function markActive() {
      TRIGGERS.forEach((tr) => trigBtns[tr].classList.toggle('active', tr === activeTrig));
    }
    function trigSummary(list) {
      const valid = list.filter((s) => s.type && DA.actionSpec(s.type));
      if (!valid.length) return '—';
      const first = t(DA.actionSpec(valid[0].type).labelKey);
      return valid.length > 1 ? first + ' +' + (valid.length - 1) : first;
    }
    function updateTrigLabels() {
      TRIGGERS.forEach((tr) => {
        trigBtns[tr].querySelector('.deck-ed-trigact').textContent = trigSummary(trig[tr]);
        trigBtns[tr].classList.toggle('has', trig[tr].some((s) => s.type && DA.actionSpec(s.type)));
      });
    }

    renderSteps();
    markActive();
    updateTrigLabels();
    // Re-check OBS availability now (it may have just been configured in Settings);
    // if it changed, rebuild the action lists so OBS actions appear/disappear.
    refreshCapabilities().then((changed) => { if (changed) renderSteps(); });

    function syncKind() {
      const isAction = selKind.value === 'action';
      const isSlider = selKind.value === 'slider';
      fSlider.style.display = isSlider ? '' : 'none';
      fTrig.style.display = isAction ? '' : 'none';
      fAction.style.display = isAction ? '' : 'none';
      fLight.style.display = isAction ? '' : 'none';
      // The Streamer.bot state binding is action-only too: collectKey/normalizeKey
      // only persist `state` on action keys, so showing it on a folder would
      // silently discard the user's choice on save.
      fSbState.style.display = (isAction && streamerbotConfigured !== false) ? '' : 'none';
      // Widget-state binding: only once the package scan found published states
      // (or the key already carries one) — hidden noise-free for everyone else.
      fSdkState.style.display = (isAction && sdkStatesAvail) ? '' : 'none';
      // Alternate ON face: stateful action keys only (state is action-only too).
      fStateStyle.style.display = isAction ? '' : 'none';
      // Live value badge: action keys only (normalizeKey drops it on folders).
      fLive.style.display = isAction ? '' : 'none';
    }
    selKind.addEventListener('change', syncKind);
    syncKind();

    const actions = document.createElement('div');
    actions.className = 'deck-ed-actions';
    const btnSave = document.createElement('button'); btnSave.type = 'button'; btnSave.className = 'deck-ed-btn primary'; btnSave.setAttribute('data-i18n', 'deck_edit_save'); btnSave.textContent = t('deck_edit_save');
    const btnSavePreset = document.createElement('button'); btnSavePreset.type = 'button'; btnSavePreset.className = 'deck-ed-btn'; btnSavePreset.setAttribute('data-i18n', 'deck_key_save_preset'); btnSavePreset.textContent = t('deck_key_save_preset');
    const btnCancel = document.createElement('button'); btnCancel.type = 'button'; btnCancel.className = 'deck-ed-btn'; btnCancel.setAttribute('data-i18n', 'deck_edit_cancel'); btnCancel.textContent = t('deck_edit_cancel');
    actions.appendChild(btnSave);
    actions.appendChild(btnSavePreset);
    if (existing && opts.onDelete) {
      const btnDel = document.createElement('button'); btnDel.type = 'button'; btnDel.className = 'deck-ed-btn danger'; btnDel.setAttribute('data-i18n', 'deck_edit_delete'); btnDel.textContent = t('deck_edit_delete');
      btnDel.addEventListener('click', () => { close(); opts.onDelete(); });
      actions.appendChild(btnDel);
    }
    actions.appendChild(btnCancel);
    modal.appendChild(actions);

    btnCancel.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    // Read the current form into a raw key object. `forPreset` omits the durable
    // id so a key placed/loaded from a preset always gets a fresh one on save.
    function collectKey(forPreset) {
      const kind = selKind.value === 'folder' ? 'folder' : (selKind.value === 'slider' ? 'slider' : 'action');
      const key = {
        id: forPreset ? undefined : ((existing && existing.id) || DM.newKeyId()),
        kind,
        title: inTitle.value,
        // The icon picker yields {type:'emoji'|'builtin'|'image', value[, fit]}.
        icon: iconPicker.read(),
        bg: colorTouched ? bgColor : '',
        press: selPress.value,   // tap feedback effect
      };
      if (key.id === undefined) delete key.id;
      // Cap background: gradient mode stores both stops (+ non-default direction),
      // but only once the user actually committed to a gradient — a bare preview
      // must not overwrite the solid/none choice.
      if (bgMode === 'grad' && gradTouched && gradC1 && gradC2) {
        key.bg = gradC1;
        key.bg2 = gradC2;
        if (bgDir !== 'd') key.bgDir = bgDir;
      }
      if (bgImgVal) key.bgImage = { value: bgImgVal, dim: bgImgDim, blur: bgImgBlur };
      // Icon + label styling (defaults are omitted; normalizeKey re-validates).
      const iconStyle = iconPicker.readStyle();
      if (iconStyle.iconColor) key.iconColor = iconStyle.iconColor;
      if (iconStyle.iconSize && iconStyle.iconSize !== 'md') key.iconSize = iconStyle.iconSize;
      if (labelPosVal !== 'bottom') key.labelPos = labelPosVal;
      if (labelSizeVal !== 'md') key.labelSize = labelSizeVal;
      if (labelBoldVal) key.labelBold = true;
      if (labelColorVal) key.labelColor = labelColorVal;
      if (selAnim.value !== 'none') key.anim = selAnim.value;
      if (pressColorTouched && pressColor) key.pressColor = pressColor;
      if (kind === 'action') {
        key.triggers = {};
        TRIGGERS.forEach((tr) => {
          const steps = trig[tr].map((s) => ({ action: Object.assign({ type: s.type }, s.params), delayMs: s.delayMs }));
          const v = DA.compactTrigger(steps);
          if (v) key.triggers[tr] = v;
        });
        // Reflect live state: an explicit Streamer.bot global binding if set, else
        // auto-derived from the key's actions (shared with the LED duration default).
        const st = effectiveKeyState();
        if (st) key.state = st;
        // Alternate face while ON (only useful with a state binding, but stored
        // regardless — normalizeKey validates; the renderer ignores it stateless).
        const ss = {};
        if (ssIconVal) ss.icon = ssIconVal;
        if (ssLabelVal) ss.label = ssLabelVal;
        if (ssColorVal) ss.color = ssColorVal;
        if (Object.keys(ss).length) key.stateStyle = ss;
        // Live value badge (timer countdown / SDK state text) on the face.
        if (liveSource) {
          key.live = Object.assign({ source: liveSource }, liveName ? { name: liveName } : {});
        }
        // LED reaction (optional). 'color' = steady colour; 'coloreffect' = chosen
        // animation. Stored on the key; normalizeKey re-validates it.
        const lm = selLightMode.value;
        if (lm !== 'none') {
          key.light = {
            when: selLightDur.value === 'state' ? 'state' : 'press',
            color: lightColor,
            style: lm === 'coloreffect' ? selLightFx.value : 'solid',
          };
        }
      } else if (kind === 'slider') {
        key.slider = {
          target: sliderModel.target,
          orient: sliderModel.orient,
        };
        if (sliderModel.target === 'appVolume') key.slider.app = sliderModel.app;
        if (sliderModel.target === 'haLight') key.slider.entity = sliderModel.entity;
        if (sliderModel.target === 'obsInput') key.slider.source = sliderModel.source;
      } else {
        key.folder = (existing && existing.folder) ? existing.folder : { pages: [] };
      }
      return key;
    }

    btnSave.addEventListener('click', () => {
      const key = collectKey(false);
      // A slider whose target needs a pick (app/entity/source) would be DROPPED
      // by normalizeSlider → the key silently vanishes on save. Block instead.
      if (key.kind === 'slider') {
        const s = key.slider || {};
        const missing = (s.target === 'appVolume' && !s.app)
          || (s.target === 'haLight' && !s.entity)
          || (s.target === 'obsInput' && !s.source);
        if (missing) { toast('error', t('deck_slider_missing_target')); return; }
      }
      close();
      opts.onSave(key);
    });

    // Save the key currently being edited as a reusable preset, then refresh the
    // preset strip so it shows up immediately (the modal stays open).
    btnSavePreset.addEventListener('click', () => {
      if (window.Deck && typeof window.Deck.saveKeyPreset === 'function') {
        window.Deck.saveKeyPreset(collectKey(true), inTitle.value);
      }
      fillKeyPresets();
    });

    // ── Live preview: a non-interactive cap beside the modal that shows exactly
    // what the key will look like once saved — deck cap theme + shape included.
    // Rebuilt on any edit via delegated listeners, coalesced to one rebuild/frame. ──
    const previewPanel = document.createElement('div');
    previewPanel.className = 'deck-ed-preview';
    const previewCaption = document.createElement('span');
    previewCaption.className = 'deck-ed-preview-caption';
    previewCaption.setAttribute('data-i18n', 'deck_preview');
    previewCaption.textContent = t('deck_preview');
    const previewStage = document.createElement('div');
    previewStage.className = 'deck-ed-preview-stage';
    const previewCap = document.createElement('div');
    previewCap.className = 'deck-ed-preview-cap';
    previewStage.appendChild(previewCap);
    previewPanel.appendChild(previewCaption);
    previewPanel.appendChild(previewStage);

    let previewRaf = 0;
    function updatePreview() {
      if (!window.Deck || typeof window.Deck.renderKeyPreview !== 'function') { previewPanel.style.display = 'none'; return; }
      let node = null;
      try { node = window.Deck.renderKeyPreview(collectKey(true), opts && opts.look); } catch { node = null; }
      if (node) previewCap.replaceChildren(node);
    }
    function schedulePreview() {
      if (previewRaf) return;
      previewRaf = requestAnimationFrame(() => { previewRaf = 0; updatePreview(); });
    }
    // One delegated set of listeners covers every control: swatches/segments fire
    // 'click', selects/range fire 'change', text/file inputs fire 'input'.
    modal.addEventListener('click', schedulePreview);
    modal.addEventListener('change', schedulePreview);
    modal.addEventListener('input', schedulePreview);
    // Reveal/hide the "use the app's own icon" shortcut as the key gains or loses a
    // launch action (typing a path, switching action type, adding/removing steps).
    const syncAppIconVis = () => iconPicker.syncAppTarget();
    modal.addEventListener('change', syncAppIconVis);
    modal.addEventListener('input', syncAppIconVis);
    modal.addEventListener('click', syncAppIconVis);
    syncAppIconVis();

    // The preview leads the side rail (presets + style tools sit under it).
    edSide.insertBefore(previewPanel, edSide.firstChild);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    if (typeof applyTranslations === 'function') applyTranslations();
    enhanceSelects(modal);
    updatePreview();
    inTitle.focus();
  }

  window.DeckEditor = { open, close };
})();
