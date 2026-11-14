'use strict';
// The programs that are never a game, even in full screen or with many frames: launchers,
// browsers, players and tools.

// Foreground apps that are never a game even full-screen or presenting GPU
// frames: the dashboard's own host browser/WebView, iCUE/Corsair, the Windows
// shell, the lock/logon screens (LockApp/LogonUI own a full-screen window on
// resume from sleep, and LockApp stays alive after unlock so the PID-liveness
// check would pin the Companion pill to it forever),
// GPU-accelerated editors/IDEs (VS Code presents flip-model at 60fps),
// terminals (Windows Terminal renders flip-model and DWM can promote it to
// Independent Flip — the actual false positive the user hit), always-on
// chat/media apps (Discord/Slack/Spotify), Electron dev/ops tooling that
// maximises borderless and would otherwise look full-screen (Docker Desktop —
// `docker desktop`/`com.docker.*` — Rancher Desktop, Podman Desktop), the
// Steam client UI
// (steamwebhelper is a full-screen-capable CEF/Chromium surface — Big Picture
// and the library — that took over the foreground after a game closed and got
// pinned to the Companion pill; a real game always runs as its own exe, never
// as steamwebhelper), the Xenon native kiosk app itself (borderless full-screen
// by design: `xenon-native` in dev, `Xenon` from the release productName — its
// own dashboard window must never trip game mode), and the streaming/broadcast
// tools (OBS/Streamlabs/XSplit/vMix) — these render a live preview canvas
// continuously, so PresentMon reports them as a busy presenter and the windowed
// hint path below flags them as a "game"; they are content-creation apps
// (classified as 'streaming' by the dashboard), never a game, so they are
// excluded outright in every window state.
// The game overlays (NVIDIA Overlay from the NVIDIA app, NVIDIA Share from
// GeForce Experience, the Xbox Game Bar's GameBar and GameBarFTServer) keep a
// full-screen window above everything, and when a game closes the foreground
// can land on it. They live as long as the session, so one moment in front held
// "a game is running" through the PID check below until the next reboot.
// Distinctive names match as a substring; short, collision-prone ones
// (cmd/wt/hyper/steam, and xenon — real games like Xenonauts/Xenon Racer)
// are matched exactly so they are not swallowed.
// The `.old-<stamp>` tail on our OWN names is not cosmetic: a running Windows
// image cannot be overwritten but CAN be renamed, so an update (and the helper
// refresh, which does exactly this) leaves the still-running process reporting
// `Xenon-native.old-1753…`. Under an exact match that stopped being "us" and the
// kiosk window tripped game mode against itself, pinning Xenon to the Companion
// pill until the next restart. Both shapes appear depending on which side did
// the rename, so `.exe` may sit before the tail.
// The AI desktop clients (Claude, ChatGPT) are Electron windows a user keeps
// maximised on a big monitor and that redraw while an answer streams: a user
// saw Claude switch game mode on. Their names are generic words, so they are
// matched exactly. Anything else the user rules out lives in their own list
// (setIgnoreSource, the gameIgnore setting).
// Matched against the bare process name (no ".exe") reported by the probe.
// The Linux additions play the same role the Windows shell names do: the
// desktop shell (gnome-shell, plasmashell, the compositors), the file manager
// and the terminals all own full-screen-capable windows, and under X11 the
// probe reads them exactly as it reads a game. `foot`, `kitty` and `konsole`
// are matched exactly for the same reason `cmd` and `wt` are — they are short
// enough to swallow a real game's name as a substring.
const IGNORE_PROC_RE = /msedge|chrome|firefox|brave|opera|vivaldi|webview|iexplore|icue|corsair|explorer|searchhost|shellexperiencehost|lockapp|logonui|windowsterminal|openconsole|conhost|powershell|pwsh|alacritty|wezterm|mintty|putty|tabby|discord|slack|spotify|obs64|obs32|streamlabs|xsplit|vmix|nvidia overlay|nvidia share|gamebar|steamwebhelper|docker|rancher|podman|gnome-shell|plasmashell|kwin_|xfdesktop|nautilus|gnome-terminal|gnome-console|ptyxis|xdg-desktop-portal|^(?:code(?:[ -]+insiders)?|cursor|devenv|claude|chatgpt|cmd|wt|hyper|steam|mutter|konsole|kitty|foot|xterm|dolphin|thunar|xenon(?:-native|-helper|-capture)?(?:\.exe)?(?:\.old-[\w.-]*)?)$/i;

// Stricter ignore list for the WINDOWED hint path: media players and creative
// editors also present flip-model frames continuously, so a focused windowed
// VLC — or Photoshop/Premiere/Blender/Resolve mid-edit — would otherwise look
// exactly like a windowed game. These stay on the windowed path only (not the
// blanket ignore above) because some carry generic names (resolve, premiere)
// and a real full-screen game must still be detected by the full-screen path.
// The chat and design apps (WhatsApp, Telegram, Teams, Signal, Notion, Figma)
// redraw while you type or scroll and sit maximised on a second monitor.
const WINDOWED_IGNORE_RE = /vlc|mpc-|wmplayer|potplayer|kodi|plex|mpv|video\.ui|netflix|primevideo|stremio|photoshop|illustrator|afterfx|premiere|blender|resolve|unrealeditor|cinema 4d|krita|lightroom|capcut|whatsapp|telegram|ms-teams|^signal$|notion|figma/i;

module.exports = { IGNORE_PROC_RE, WINDOWED_IGNORE_RE };
