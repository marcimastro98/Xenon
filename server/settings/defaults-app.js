// What a new install starts with, third part: the app's gestures and zoom, starting with the
// system, updates, anonymous counts and the cards already seen.

const HUB_DEFAULTS_APP = Object.freeze({
  // Native app only: quick up-swipe from the bottom of the screen collapses the
  // kiosk to a slim strip and reveals the Windows desktop (native-bridge.js).
  swipeHomeGesture: true,
  // Native app only: interface scale (in-page CSS zoom) applied by native-bridge.js,
  // independent of the Windows display scale. 1 = 100%.
  nativeZoom: 1,
  // Native app only: hide the kiosk window while the machine is used over RDP
  // (monitor.rs watches SM_REMOTESESSION; native-bridge.js relays the toggle).
  hideOnRdp: false,
  // Windows keeps a separate default for calls (Discord, Teams): true = moving
  // the output or input moves that one too, as Xenon always did.
  audioSetCommunications: true,
  // Open the dashboard in the default browser at Windows logon. The user's
  // intent (default on); the actual scheduled task is registered/removed by
  // /startup/auto-open and only ever for real-browser use, never Xeneon Edge.
  autoOpenBrowser: true,
  // Anonymous version ping — ON by default for installs made from v4.8.0 onwards;
  // the switch is in Settings → Generale → Aggiornamenti. Sends only {version, os}
  // on the update check the app already makes; never the install id. See
  // server/version-ping.js and docs/privacy.html.
  //
  // These defaults are read ONLY when settings.json does not exist yet (see the
  // `|| { ...DEFAULT_HUB_SETTINGS }` fallbacks), so this reaches a fresh install
  // and nothing else. `normalizeHubSettings` deliberately keeps the strict
  // `=== true` test, which means an existing install whose blob predates the key
  // stays OFF instead of being switched on by an update — it was documented to
  // those users as off-unless-you-choose. Do not relax that test to `!== false`.
  versionPing: true,
  // Announcements (js/hub-messages.js) and the paid-drop card (js/catalog-drop.js).
  // ON by default and normalized with `!== false`, which is the OPPOSITE of
  // versionPing above and deliberate: these are not a data opt-in, they are a
  // preference about being interrupted, and the honest default for a channel the
  // user can switch off in one tap is on. Both were localStorage-only before
  // v4.9.0 — per surface, and with no way back once muted (see the migration in
  // each module).
  hubMessages: true,
  catalogDrops: true,
  monthlyDrops: true,
  // Automatic updates (server/auto-update.js). ON by default and normalized
  // with `!== false`, so existing installs get it with this update as well: it
  // sends nothing anywhere new (the release check already runs), it only
  // installs what the user would otherwise be asked to install, at a moment
  // they are not using the PC. One tap in Settings -> General turns it off.
  autoUpdate: true,
  // Store widgets update themselves (server/widget-auto-update.js). Same posture
  // as autoUpdate: ON, normalized with `!== false`, sends nothing anywhere new (it
  // reads the catalog the Store already reads). It never raises a widget's
  // permissions and never touches a theme, a page or a Deck: a version that asks
  // for more than was approved waits for the user, as an update always did.
  autoUpdateWidgets: true,
  // Counts an install of a catalog entry, with NO identifier attached: the hub
  // bumps a per-entry counter and discards the request (see community-installs.js).
  // Normalized `=== true` like versionPing, NOT `!== false` like the two above:
  // this is a new outbound report, so a fresh install starts on and an existing
  // one stays off until its owner chooses. Turning it on for everyone during an
  // update is the move that costs trust.
  catalogStats: true,
  // Bit may ask for a vote on something in real use (rating-votes.js).
  ratingAsks: true,
  // Anonymous feature counts (server/usage-stats.js): which built-in features
  // run, as counters with no identifier, at most one report a day. Same posture
  // as catalogStats: `=== true`, so a fresh install starts on and an existing
  // one stays off until its owner chooses. Changed only from the PC itself (the
  // settings save below keeps the stored value for a paired device).
  usageStats: true,
  // Reading the charge of a device on a dongle means sending it a request. Same rule
  // as usageStats for a paired device: this is the PC owner's choice.
  batteryAskDevices: true,
  // The two startup cards' "don't show again": the What's New modal (the release
  // id the user dismissed) and the Discord invite card (a plain flag).
  //
  // Both lived ONLY in localStorage until v4.11.6, which made a permanent choice
  // exactly as durable as the browser's site data — a browser set to clear it on
  // exit, or a cleanup tool, put both cards back at every boot with the
  // dismissal gone. They also never crossed surfaces: the native WebView and a
  // browser tab are separate stores on the same URL, so each had to be told.
  // Reported on Discord. Same move hubMessages/catalogDrops made in v4.9.0.
  //
  // Empty/false on a fresh install: nobody has dismissed anything yet, and the
  // legacy key is promoted into these by the client on first hydrate (see
  // promoteLegacySeenFlags in js/settings.js), so an existing user does not have
  // to answer either card a second time.
  whatsNewSeen: '',
  releaseNotesSeen: '',
  updateFailSeen: '',
  discordInviteSeen: false,
  // Voice channels pinned to the top of the Discord widget's Channels tab, as
  // Discord channel ids. Server-side rather than per-device on purpose: which
  // channels you care about is a fact about YOU, so it should follow you to the
  // phone and the Edge. Contrast the tile layout, which is per-device precisely
  // because the right answer differs from screen to screen.
  // Which servers the user has collapsed in the Discord widget's Channels tab,
  // by guild id. Remembered rather than reset per visit: someone with a dozen
  // servers collapses the ones they never join once, and a list that forgets
  // makes them do it again at every sign-in (asked for on Discord, Sep 2026 —
  // "so your not forever scrolling"). Guild ids, not names, so a renamed server
  // stays collapsed and two servers with the same name are told apart.
  discordFavChannels: Object.freeze([]),
  discordCollapsedGuilds: Object.freeze([]),
});

module.exports = { HUB_DEFAULTS_APP };
