'use strict';
// What a widget can see and do: the SDK version, the live streams it may subscribe to, the
// actions it may ask for by category, and the limits on what an action may carry.

// Version of the host↔widget postMessage protocol (see docs/WIDGET_SDK.md).
const SDK_API_VERSION = 1;

// Data streams a package may request. Most map 1:1 to an SSE event the dashboard
// already receives; the three detailed Discord feeds are lazy, host-fetched
// snapshots so a sandboxed widget never gains general access to local routes.
// The host only forwards streams the user explicitly granted.
// Fan RPM and power draw need no stream of their own: they ride the `system`
// payload (fans / power / sensorAccess). `battery` is separate because wireless
// peripheral levels move slowly and broadcast on their own 90s tick.
// `audioLevels` is the only high-rate stream here (~12/s vs the 8s `audio` tick).
// It carries nothing `audio` does not already expose about WHICH apps exist — only
// how loud each one currently is — so it is no wider a permission, but a widget
// that takes it should expect to be re-rendered continuously.
// `twitchWatch` / `twitchChat` / `youtubeLive` are the watching and broadcasting
// sides of the two builtin tiles. None of them opens a connection of its own:
// each is fed by the tile that was already reading it (see publishStream in
// js/custom-widget.js), with a same-origin loader as the fallback for a
// dashboard where that tile is absent. That is the whole reason `twitchChat` has
// no loader at all — a widget must never be able to make Xenon hold a socket
// open to Twitch on an idle dashboard just by asking for a refresh.
// `scriptStates` is the read side of POST /state/set — the named values any
// local script sets (see DEVELOPER.md, "Deck script states"). A widget can
// REACT to one but never set one: writing into that shared map from a sandbox
// would let one package overwrite another's name, and a package already has
// `deck.states` for states of its own, which are declared and namespaced.
// `lighting` is the user's lights by name and what each shows, with the parts of
// a device that has a map (each fan, the pump, a strip): what a widget needs to
// target `lightDevice` / `lightPart`. A pulled snapshot, no colours per LED.
// `sensors` is every hardware sensor by name (an AIO's liquid, a VRM, each fan),
// the catalog behind Settings → Sensor sources. Read only while granted.
// `netPath` is how the way to the internet is doing, stretch by stretch: this
// PC's link, the router, the provider's first hop, the internet. Numbers only,
// never an address. Pulled; its echoes stop 10 s after the last read (net-path/).
// `energy` is what this PC drew, in Wh per hour (72 h) and per day (90 days),
// from the sensor history (sensor-history/energy.js). Pulled, numbers only.
const SDK_STREAMS = Object.freeze(['status', 'system', 'network', 'diskIo', 'devStorage', 'media', 'audio', 'audioLevels', 'wavelink', 'voicemeeter', 'stocks', 'football', 'news', 'claude', 'codex', 'obs', 'discord', 'discordChannels', 'discordSoundboard', 'discordNotifications', 'streamerbot', 'homeassistant', 'twitchWatch', 'twitchChat', 'youtubeLive', 'youtube', 'tasks', 'notes', 'agenda', 'weather', 'battery', 'processes', 'sensors', 'spotify', 'scriptStates', 'lighting', 'perf', 'gameSessions', 'vitals', 'netPath', 'energy']);

// Action categories a package may request → the deck-action types each grants.
// Deliberately a small, low-blast-radius subset of the action registry; every
// dispatched action is still fully re-validated by server/actions/registry.js.
const SDK_ACTION_CATEGORIES = Object.freeze({
  media: Object.freeze(['media', 'mediaSeek']),
  volume: Object.freeze(['volume', 'appVolume', 'appMute']),
  // Deliberately separate from `volume`: packages already granted `volume` were
  // approved for "raise and lower", and folding device switching in would widen
  // that grant retroactively, with no prompt. Server-side the id is checked
  // against the live OUTPUT enumeration only — see the audioDevice dep.
  //
  // `audioDeviceToggle` (v4.11.10) joins this EXISTING category, the call made
  // for spotifyPlayUri and for the same reason: it is the same kind of act and
  // no more of it. Flipping between two outputs is two `audioDevice` calls with
  // the choice made for you, both ids go through the same live-list check, and
  // a widget granted this could already move the sound to either device. It
  // stays inside "choose which speakers your sound comes out of".
  // `audioDeviceFirst` (v4.11.12) joins it on the same terms: the first output
  // of an ordered list that is connected, each id through the same check.
  audioDevice: Object.freeze(['audioDevice', 'audioDeviceToggle', 'audioDeviceFirst']),
  mic: Object.freeze(['micMute']),
  // signalRgbEffect is the same act by another engine: it picks what the lights
  // show. The name is encoded and passed as one argv entry (signalrgb.js), and
  // nothing runs unless the user turned SignalRGB on.
  lighting: Object.freeze(['lighting', 'lightPower', 'lightColor', 'lightAuto', 'lightEffect', 'lightDevice', 'lightPart', 'signalRgbEffect']),
  chroma: Object.freeze(['chromaColor', 'chromaOff']),
  wavelink: Object.freeze(['wlInputVolume', 'wlInputMute', 'wlOutputVolume', 'wlOutputMute', 'wlMixVolume', 'wlMixMute', 'wlEffect', 'wlSwitchMonitoring', 'wlSetMonitorMix']),
  // Its own line, for the reason audioDevice is not in `volume`: moving a fader
  // and moving the sound to other hardware are different asks.
  wavelinkOutput: Object.freeze(['wlOutputDevice']),
  // Timers and stopwatches on the user's Timers tile, under a name the widget
  // cannot choose (actions/widget-timers.js), so the user's own stay out of reach.
  timers: Object.freeze(['timerStart', 'stopwatchStart', 'timerToggle', 'timerCancel']),
  // Voicemeeter strips, buses and routing. `vmParam` is deliberately LEFT OUT,
  // for the same reason haCallService is: it names any parameter the mixer has,
  // which includes Command.Shutdown and Command.Restart, and "close the user's
  // audio mixer" is not something the typed actions imply. `vmMacro` is in — it
  // presses a macro button the USER built inside Voicemeeter, which is the same
  // shape of trust as sbDoAction.
  voicemeeter: Object.freeze(['vmStripMute', 'vmStripGain', 'vmStripBus', 'vmBusMute', 'vmBusGain', 'vmMacro']),
  // Service-control categories (grant-gated). Each action type is already
  // validated by the registry against the connected service; a widget can only
  // reach the service the user connected AND granted. `haCallService` is
  // deliberately left OUT — an arbitrary HA service call is too broad to hand to
  // untrusted widget code; the typed device actions cover normal control.
  // `spotifyPlayUri` was added to this EXISTING category rather than a new one,
  // which is the opposite of the call made for `audioDevice` and `steam` above —
  // so the reasoning is worth stating. Those two widen a grant into a different
  // KIND of act: "raise and lower" does not imply re-routing the machine's sound,
  // and "open a web link" does not imply invoking a protocol handler. Starting a
  // named track or album is the same kind of act as `spotifyPlaylist`, which has
  // always been here and already starts any playlist the account can reach. It
  // stays inside what "Control Spotify playback" means to the person who agreed
  // to it, so it does not need a second line in the dialog.
  spotify: Object.freeze(['spotifyPlay', 'spotifyNext', 'spotifyPrev', 'spotifySave', 'spotifyLike', 'spotifyShuffle', 'spotifyRepeat', 'spotifyVolume', 'spotifySeek', 'spotifyPlaylist', 'spotifyPlayUri', 'spotifyDevice']),
  obs: Object.freeze(['obsScene', 'obsSceneNext', 'obsRecord', 'obsStream', 'obsMute', 'obsInputVolume']),
  // discordUserVol/discordUserMute change what THIS machine hears from one
  // person in the user's own voice channel — local playback, not moderation and
  // not anything the rest of the channel can observe. Same grant as the other
  // voice controls: a widget the user handed the `discord` category to.
  // discordOpenChat only shows a conversation in the user's own Discord window,
  // it sends nothing, so it needs no line of its own in the dialog.
  discord: Object.freeze(['discordMute', 'discordDeafen', 'discordPtt', 'discordJoin', 'discordLeave', 'discordInputVol', 'discordOutputVol', 'discordUserVol', 'discordUserMute', 'discordOpenChat', 'discordAudioToggle', 'discordSoundboard']),
  homeassistant: Object.freeze(['haToggle', 'haLight', 'haMedia', 'haCover', 'haClimate', 'haFan', 'haVacuum', 'haLock', 'haAlarm', 'haScene', 'haScript', 'haButton']),
  twitch: Object.freeze(['twitchClip', 'twitchMarker', 'twitchAd', 'twitchTitle', 'twitchGame', 'twitchChat', 'twitchShoutout', 'twitchChatMode']),
  youtube: Object.freeze(['ytBroadcast']),
  // The host's own YouTube player, driven by a widget through validated
  // messages. Its own line in the dialog: playing a video INSIDE someone's
  // dashboard is not the same ask as reading their subscriptions, and neither
  // is the same ask as controlling their broadcast.
  youtubePlayer: Object.freeze(['ytPlayer']),
  streamerbot: Object.freeze(['sbDoAction', 'sbSendMessage', 'sbCodeTrigger']),
  // Launching a game the user owns, and nothing else. The AppID is digits-only
  // before it is interpolated into steam://rungameid/<id>, so the widget names a
  // number rather than a command. Deliberately NOT folded into `url`: that one
  // is http(s) links, and widening it to protocol handlers would hand every
  // widget already granted `url` the ability to invoke any registered scheme on
  // the machine, retroactively and with no prompt. Asked for by a widget author
  // whose Steam tile launches the game you click.
  steam: Object.freeze(['launchSteamGame']),
  url: Object.freeze(['openUrl']),
  // Show a page in the Browser tile already on the dashboard. `openUrl` hands
  // the address to the Windows shell, so the page lands on the default browser
  // on the primary monitor — no use to a widget whose point is to put something
  // ON the Xeneon Edge. This keeps the same shape (the widget names an address,
  // it never sees the page) while the destination is a surface Xenon owns.
  // Browser-dispatched like `soundboard`: no registry case, the host hands it to
  // browser-tile.js, which is the only caller of the CDP relay. Deliberately NOT
  // usable from a manifest Deck macro — `validateAction` doesn't know the type,
  // so declaring one fails at install rather than shipping a dead key.
  browser: Object.freeze(['browserOpen']),
  // Personal to-do list: add / toggle / delete a task in the same list the Tasks
  // tile shows. Low-risk (your own notes-style data, no system reach), grant-gated,
  // and each mutation is validated + length-capped in the action registry.
  tasks: Object.freeze(['taskAdd', 'taskToggle', 'taskDelete']),
  // Mark one of the user's own Vitals meters done. Same low reach as tasks:
  // the user's own self-care data, no system access, validated in the registry.
  vitals: Object.freeze(['vitalsRefill']),
  // Soundboard playback. Browser-played (no registry case — the host dispatches
  // to deck.js's DeckSoundPlayer), and SDK-originated playSound may ONLY name a
  // pack-relative clip (packs/<pack>/<clip>.<ext>, see SDK_SOUND_FILE_RE) —
  // arbitrary machine-local paths stay a Deck-key-only privilege.
  soundboard: Object.freeze(['playSound', 'soundStopAll']),
  // Play something in the Twitch / YouTube tiles already on the dashboard.
  // Browser-dispatched like `browser` and `soundboard` (no registry case — the
  // host hands it to the tile), and deliberately NOT usable from a manifest Deck
  // macro: validateAction does not know the type, so declaring one fails at
  // install instead of shipping a key that does nothing.
  //
  // Narrower than `browserOpen`, which is why it does not need its confirm
  // dialog: the widget names a Twitch channel or a YouTube video id, never an
  // address, the id is re-validated against the tile's own pattern, and the
  // destination is a surface Xenon owns and the user is looking at.
  watch: Object.freeze(['twitchWatchPlay', 'ytWatchPlay']),
  // Turn the dashboard to another of ITS OWN pages. The same move the global
  // page shortcuts make, reachable from a widget: a control-room tile with a
  // button per page, or one that brings the media page up when something starts
  // playing.
  //
  // From a widget's own code it is browser-dispatched (like `browser` and
  // `watch`) so only THIS screen turns. It is also a Deck action now, so a
  // manifest Deck macro may name it: a macro runs server-side, where the
  // registry relays the page to every dashboard, the same broadcast the global
  // page shortcuts use. Each dashboard still resolves it against its own pages.
  //
  // Its own grant rather than a corner of an existing one, for the reason
  // `audioDevice` was split out of `volume`: what it does is not a stronger
  // version of anything already granted. A widget with this can take the screen
  // away from whatever its owner was reading, which is a different KIND of act
  // from drawing inside its own tile — and it is the one thing here the user
  // cannot miss happening, so it has to be the one thing they agreed to.
  //
  // It reaches nothing outside the dashboard: no address, no file, no machine
  // state. The target is one of the user's own page ids, or a relative move, and
  // a page this screen does not have is refused rather than redirected.
  pages: Object.freeze(['dashboardPage']),
  // Take a screenshot, start or stop a recording, save the Instant Replay: the
  // capture keys of the Deck, START only. What the widget gets back is ok or an
  // error code, never the picture, the file, its name or where it went (the
  // bridge forwards only those two fields). SDK_ACTION_LIMITS below keeps out
  // the modes that are not a capture: 'reveal' opens a file manager on the
  // PC, replay on/off changes a setting, and the microphone stays the user's
  // choice on their own key. The capture itself is never silent: the saved
  // toast, the recording card and the on-screen badge show it as for a key.
  // Text from the screen goes to the clipboard and the widget gets a line
  // count: only from an area the user drags (SDK_ACTION_LIMITS), because a
  // window or screen read would rewrite the clipboard with no gesture of theirs.
  // A pinned screenshot is the same: an area the user drags, shown on their screen.
  // The colour picker and the ruler wait for the user's own click or drag; the
  // colour or size goes to the clipboard and the widget learns only ok/error.
  // A bookmark on the recording that runs is a time on the user's own video:
  // it starts nothing and reads nothing.
  capture: Object.freeze(['screenshot', 'record', 'replay', 'screenText', 'screenPin', 'screenColor', 'screenMeasure', 'captureMarker']),
  // Start and stop a benchmark of the game in front of the user (v5.0.0). The
  // CSV stays in the user's folder: the widget gets ok or an error code, never
  // the file, its name or the numbers in it ('reveal', which opens a file
  // manager on the PC, is kept out by SDK_ACTION_LIMITS). Whether a run is going
  // is already in the `perf` stream (`bench`), behind that stream's own grant.
  benchmark: Object.freeze(['benchmark']),
  // Open the gallery of what Xenon captured, on the screen the widget is on
  // (the PC's screens when it is not on a dashboard). Only the filter: an `id`
  // is never allowed, since a widget has no way to know one and must not learn
  // that a capture exists by guessing. It never receives the list.
  gallery: Object.freeze(['gallery']),
  // Show or hide the widgets on the desktop and in the overlay, and switch
  // their pages. Same kind of act as `pages` for the dashboard: what moves is
  // the user's own layout, visible the instant it happens, and nothing leaves
  // the PC. Placing, moving and removing widgets stays the user's (the edit mode
  // and the voice), so one widget can never rearrange another. Drawing on the
  // screen belongs here too: a sheet over the user's own screen, closed with
  // Esc, that reads nothing and sends nothing back but whether it is open.
  // Game Companion opens Bit's card for the game on the screen: the screen goes
  // to the AI only when the user taps "Analyze screen" on the card itself.
  layers: Object.freeze(['layersToggle', 'layerPage', 'screenDraw', 'xenonMenu', 'gameCompanion']),
  // Game mode, Performance Mode and "this app is not a game" (v5.0.0): the
  // switches of Settings, Performance, as a key would press them. Performance
  // Mode applies only the safe tweaks the user saved (closing apps always asks
  // on screen), and the not-a-game list takes the app detected right now, never
  // a name the widget picks, so a widget cannot switch detection off for a game.
  // Sensor history is local only: on, off and how often it samples.
  performance: Object.freeze(['gameMode', 'perfMode', 'gameIgnore', 'sensorHistory']),
});

// Per-type limits inside a category: a field the widget sends must be one of
// these values (absent is fine: the registry's default is always allowed).
// Mirrored in js/custom-widget.js, where bridge actions are gated.
const SDK_ACTION_LIMITS = Object.freeze({
  screenshot: Object.freeze({ mode: Object.freeze(['take']) }),
  // Never the microphone or the webcam: a widget does not turn either on.
  record: Object.freeze({ mode: Object.freeze(['toggle', 'start', 'stop']), audio: Object.freeze(['sound', 'silent']), webcam: Object.freeze(['off']) }),
  replay: Object.freeze({ mode: Object.freeze(['save']) }),
  screenText: Object.freeze({ target: Object.freeze(['region']) }),
  // Pin an area the user drags, never a capture the widget names (it knows none).
  screenPin: Object.freeze({ source: Object.freeze(['region']), id: Object.freeze([]) }),
  benchmark: Object.freeze({ mode: Object.freeze(['toggle', 'start', 'stop']) }),
  // Empty list = the field must be absent.
  gallery: Object.freeze({ filter: Object.freeze(['all', 'video', 'screenshot']), id: Object.freeze([]) }),
  // A chime every few seconds, from a widget, is noise nobody asked for.
  stopwatchStart: Object.freeze({ everyMinutes: Object.freeze([]) }),
  gameIgnore: Object.freeze({ mode: Object.freeze(['current']), name: Object.freeze([]) }),
});

function sdkActionWithinLimits(action) {
  const limits = action && SDK_ACTION_LIMITS[action.type];
  if (!limits) return true;
  return Object.entries(limits).every(([field, allowed]) => action[field] == null || allowed.includes(action[field]));
}

// Every deck-action type the SDK can reach, across all categories. Macro steps
// are restricted to this set — openApp/openFile/hotkey/webhook stay unreachable.
const SDK_ACTION_TYPES = Object.freeze(Object.values(SDK_ACTION_CATEGORIES).flat());

// Category (grant unit) a deck-action type belongs to, or null. Used to check a
// macro's steps against the categories the user granted the package.
function categoryOfActionType(type) {
  for (const [cat, types] of Object.entries(SDK_ACTION_CATEGORIES)) {
    if (types.includes(type)) return cat;
  }
  return null;
}

module.exports = {
  SDK_API_VERSION, SDK_STREAMS, SDK_ACTION_CATEGORIES, SDK_ACTION_LIMITS, sdkActionWithinLimits,
  SDK_ACTION_TYPES, categoryOfActionType,
};
