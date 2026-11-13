// What the search keeps while the engine runs: the installed apps it found, the search windows
// it opened, and how long the index waits after start.

// ── Installed applications (the search's Applications tier) ────────────────
// Two sources, merged and cached: Start Menu .lnk shortcuts (classic desktop
// apps — Steam, Chrome) and Get-StartApps UWP entries (Store apps — Spotify,
// WhatsApp — whose launcher is an AUMID, not an exe on disk, which is exactly
// why a filename search can never find them). The search pins name-matching
// apps above every file result, macOS-style. Entries are server-enumerated
// only: launching resolves an opaque result id back to THIS list — never a
// caller-supplied path or AUMID.
const _installedApps = { list: [], at: 0, inflight: null };

// Local file search (Spotlight). Opens go through deck-actions.ps1's 'open'
// verb — the same launcher every Deck key uses — after the module re-checks
// the openFile blocklist; the PS search host it manages is retired in
// _gracefulShutdown.
// Linux gets its own implementation of the same surface. The helper the Living
// Index drives is built for Windows and macOS only, so on Linux `helperPresent()`
// was false for ever: search had no backend at all, while Spotlight still told
// the user to add a folder in Settings to switch one on. linux-index.js does the
// walk in Node and makes that sentence true.
// Walking every file is the heaviest thing Xenon does and nothing needs it while
// the PC is starting. Search and the disk map already read "still building".
const INDEX_START_DELAY_MS = 90 * 1000;

const _spotlightPopupPids = new Set();

module.exports = { _installedApps, INDEX_START_DELAY_MS, _spotlightPopupPids };
