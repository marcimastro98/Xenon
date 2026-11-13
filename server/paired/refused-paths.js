'use strict';
// The addresses a paired device is refused, each with the reason it needs a person at the PC.

// The deny list: what a paired device may NOT reach, and why. Every entry is
// the same reason — it needs a person at the PC, because it raises a dialog
// there, restarts the server, or downloads and places an executable.
const REMOTE_DENY = new Set([
  // Raises a UAC prompt on the PC. Tapping this from another room produces a
  // prompt nobody is standing in front of.
  '/system/enable-sensors',
  // The updater swaps files and restarts the server underneath the very
  // connection making the request, then verifies /version to decide whether to
  // roll back. Driving that from a device that is about to lose the server is a
  // way to get a half-applied update.
  '/update/prepare',
  '/update/apply',
  // Installers: each downloads something and puts it on disk where it will
  // later be run. Setup happens at the PC, where the progress and any prompt
  // are visible.
  '/api/native/install',
  '/api/gamemode/install-presentmon',
  '/audio/levels/install-helper',
  '/api/lighting/sdk-install',
  '/api/ai-local/whisper-install',
  '/embedded-browser/adblock/install',
  '/remote/install',
  '/second-screen/install',
  '/second-screen/create-display',
  '/second-screen/remove-display',
  // Claude Code's own ingest. These are posted by the `claude` process against
  // a token minted on the PC; nothing in the dashboard calls them, so a paired
  // device asking for them is not a feature, it is a forged session.
  '/api/claude/event',
  '/api/claude/permission',
  '/api/claude/question',
  '/api/claude/turn-end',
  '/api/claude/mod',
  '/api/claude/mod/permission',
  // Hands a tile message to the mod: the answer is the text of the message.
  '/api/claude/mod/inbox',
  // The OpenAI Codex ingest, posted by codex-hook.js (which Codex runs) against
  // a token minted on the PC. Same reason as Claude's.
  '/api/codex/event',
  '/api/codex/permission',
  // The channel's RTMP stream key. Whoever holds it can broadcast to the user's
  // channel, and it is the one credential the dashboard is asked to show on
  // screen. It stays on the PC the user is standing at.
  '/stream/youtube/streamkey',
  // File transfer settings. Everything else about transfers is open to a paired
  // device on purpose — sending a photo from the phone in your hand to the PC
  // in the next room IS the feature — but this one endpoint names the FOLDER on
  // that PC where every future arrival lands. A device that could set it could
  // aim them at the app's own directory or at the user's Documents. The folder
  // is chosen at the PC, with the picker, which is the same shape the Slideshow
  // folder source has: the path lives only in settings and never on the wire.
  '/api/transfer/settings',
  // Opens the folder dialog on the PC for the same folder.
  '/api/transfer/settings/pick',
  // Recording options: the folder recordings land in (a path on the PC, chosen
  // there with the system's folder dialog), and how many old ones may be
  // deleted to stay under a space limit. Set at the PC, like the transfer folder.
  '/capture/settings',
  '/capture/settings/pick',
  // The gallery: delete (no undo from a phone in another room), copy to the
  // PC's clipboard and show in its folder on the PC's screen stay at the PC.
  // A paired device looks, downloads, and makes NEW copies (trim, export,
  // transcript): the original is never touched, and the Deck keys a phone
  // presses already reach the same export and transcript through /actions/run.
  '/captures/delete',
  '/captures/reveal',
  '/captures/copy',
  // "To phone" is sent from the PC; the phone already downloads directly.
  '/captures/send',
  // The editor reads a screenshot on the PC and writes a copy beside it.
  '/captures/spots',
  '/captures/save',
  // Dialling a number. The phonebook, the call log and the live call state ARE
  // reachable from a paired device — that is the dashboard being the dashboard
  // — but placing the call is not, and the reason is what happens next rather
  // than a worry about trust: the call's audio comes out of the PC (or the
  // phone itself), never the tablet that started it. A dial button on a screen
  // in another room begins a call the user cannot hear or end, which is the
  // "looks alive, does nothing" failure this codebase refuses everywhere else.
  // It is also the one action in the product that costs money per use.
  '/api/phone/dial',
  // Sending a message. Reading them IS allowed from a paired device — that is
  // the dashboard being the dashboard, and the notification mirror already
  // shows the text of the same messages — but sending one goes out under the
  // user's own number to somebody else, cannot be recalled, and is metered.
  '/api/phone/send',
  // The native shell's own report of what it draws (widget layers, monitors).
  // A phone is not that shell: a report from one would offer the AI placements
  // nothing on the PC will draw.
  '/layers/host',
  // Which virtual desktop the PC shows; from a phone it would flip the widget pages.
  '/layers/desk',
  // The sound/AI/mixer step of a Deck shortcut belongs to a dashboard on the PC;
  // a phone that claimed it would play the sound in the user's pocket.
  '/deck/shortcut-claim',
  // A Deck key's AI chat or mixer handed to the PC's dashboard: it opens there.
  '/deck/client-step',
  // A key placed on the PC's screen is pressed there, by a hand at that PC. A phone
  // has the Deck itself, under its own rules (remote-actions.js).
  '/deck/press',
  // Same for what Bit plays in a tile: it belongs on the PC's screens.
  '/tiles/play-claim',
  // The hidden page that keeps the widget windows in sync in "widgets only"
  // mode (shell-driver.html). It belongs to the shell's own window; a phone that
  // loaded it would drive nothing and only hold a stream open.
  '/shell-driver',
  // The on-screen alerts window of "widgets only" (screen-alerts.html): pop-ups
  // drawn on this PC's screen. A phone has its own dashboard and its own toasts.
  '/screen-alerts',
  // The hidden Store widget host of "widgets only" (sdk-service.html). A phone
  // that loaded it would run a second copy of every widget's Deck actions.
  '/sdk-service',
  // The desktop scene (scene.html): the wallpaper and the screensaver drawn on
  // this PC's screens. A phone has its own Ambient.
  '/scene',
  // The drawing sheet (draw.html) laid over this PC's screen, and whether it is
  // open. A phone that loaded it would draw on nothing.
  '/draw',
  '/screen-draw',
  // The Xenon menu window over this PC's screen (menu.html) and whether it is
  // open (screen-menu.js). A phone opens the same menu as a panel of its own
  // dashboard (GET /xenon-menu stays reachable, its rows run through
  // /actions/run like the Deck); it never drives the PC's menu window.
  '/menu',
  '/screen-menu',
  // Performance Mode of "widgets only" (perf-screen.js): the driver page's save
  // of its session and the cards it puts on this PC's screen. A phone has its
  // own dashboard; one that answered here would start a session on the PC.
  '/api/performance/screen',
  '/api/performance/state',
  // Allow pressed on a widget on the PC's screen (sdk-grant.js). A phone cannot
  // approve a widget, here or through /settings (keepGrants, remote-actions.js).
  '/sdk/grant',
  // A tile's choices saved from a widget on the PC's screen (tile-settings.js).
  // A phone has the whole dashboard and saves through /settings.
  '/settings/tile',
  // The Vitals state from a widget on the PC's screen (vitals-state.js), same reason.
  '/api/vitals/state',
  // Code on the PC, one way or another: PC Control's approved command, a new
  // Claude Code run (any prompt, then a phone could approve its own commands:
  // the raw form of the claudeAsk key it may not invent), and remote desktop
  // (Sunshine), whose pairing would hand a phone the whole screen and keyboard.
  // Set up at the PC. Answering a card of a run started there stays open.
  '/ai/pc-run',
  '/api/claude/run',
  '/remote/pin',
  '/remote/enable',
  '/remote/unblock',
  '/remote/ondemand',
  '/remote/sunshine/configure',
  // Whoever opens the Tailscale sign-in link puts this PC on their own network.
  '/remote/tailscale/login',
  // A backup replaces the Deck, the settings and the stores at once, past
  // every per-route rule a phone is held to. Restore it at the PC.
  '/backup/import',
  // And the export carries what a phone is never shown on its own: private
  // calendar links, Deck webhook addresses, every note. Made at the PC.
  '/backup/export',
]);

// Prefix denials, for routes that carry an id tail.
const REMOTE_DENY_PREFIXES = [];

// The management endpoints are loopback-only by being denied here rather than
// by a check inside each handler: a phone must never be able to enrol another
// phone, rename or revoke the device that would kick it off, or switch the
// whole feature off from outside the house.
const REMOTE_ADMIN = new Set([
  '/api/remote-access/status',
  '/api/remote-access/enable',
  '/api/remote-access/https',
  '/api/remote-access/https/setup',
  '/api/remote-access/pair',
  '/api/remote-access/pair/cancel',
  '/api/remote-access/rename',
  '/api/remote-access/revoke',
  '/api/remote-access/revoke-all',
  // A UAC prompt on the PC and a supporter-pass device slot: both decisions
  // belong to the person sitting at the PC, not to a paired phone.
  '/api/devclean/compact',
  // A 115 MB download that puts programs on the PC.
  '/api/ffmpeg/install',
  '/api/features/devclean/unlock',
  '/api/features/lyrics/unlock',
  // Throws away the PC's remembered supporter pass: only the person at the PC
  // can put it back, so only they may remove it. The Sparks code the same.
  '/api/community/supporter/forget',
  '/api/community/sparks/forget',
  // Saving one replaces what the PC pays with, and buying spends it: Sparks are
  // money, and a paired phone can be lost or lent.
  '/api/community/supporter/save',
  '/api/community/sparks/save',
  '/api/community/buy',
  // Widens where Claude Code may start work on this PC: the person at the PC decides.
  '/api/claude/folder',
]);

module.exports = { REMOTE_DENY, REMOTE_DENY_PREFIXES, REMOTE_ADMIN };
