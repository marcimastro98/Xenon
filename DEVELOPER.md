# Xenon — Developer Guide

Technical reference for working on Xenon. For installation see **[README.md](README.md)**; for the user-facing feature guide see **[FEATURES.md](FEATURES.md)**.

---

## Overview

Xenon is a **local-only** Node.js web app for Windows. The server is a single HTTP/API process (`server/server.js`) that serves a modular browser UI and exposes a loopback-only API. Live data (system stats, media, audio) is pushed to the client over **Server-Sent Events**; everything else is plain JSON over HTTP. Hardware and OS integrations are implemented as small **PowerShell collectors** invoked by the server.

There is no build step for the web widget — the browser loads the ES modules in `server/js/` directly.

- **Runtime:** Node.js ≥ 18.15, Windows x64 only
- **Server:** `http://127.0.0.1:3030` (loopback only)
- **Dependencies:** `koffi` (FFI for the iCUE RGB bridge), `msedge-tts` (local Edge TTS). Do not add more without agreement.

---

## Quick start

```powershell
git clone https://github.com/marcimastro98/Xenon.git
cd Xenon
npm start          # node server/server.js — serves http://127.0.0.1:3030/
```

Then open <http://127.0.0.1:3030/> in any browser, or paste an `<iframe>` pointing at the same URL into a Corsair iCUE iFrame widget.

| Command | Purpose |
|---|---|
| `npm start` | Start the server. |
| `npm run dev` | Kill any process already on port 3030, then start the server (handy on reload). |
| `npm test` | Run the unit test suite (`server/test/*.test.mjs`, plain `node:test` — no test framework dependency). |
| `npm run icue:package` | Package the native iCUE widget (`widget/`). |
| `npm run icue:validate` | Validate the native iCUE widget. |
| `npm run link:shared` | (Re)create the `server/shared` + `widget/shared` junctions to `packages/core` (also runs on `postinstall`). |
| `npm run native:dev` | Run the native Tauri app in dev (requires the Rust toolchain + the backend running). |
| `npm run native:build` | Build the native app + its NSIS installer. |

`INSTALL.bat` is the full user setup (Node, FFmpeg, sensors, PresentMon, silent Windows startup task). Use `server/start.bat` to launch manually when Node is already installed. If you use `npm start` instead of `INSTALL.bat`, install FFmpeg yourself if you want automatic MP4 → WebM background conversion.

### Validation before handing back

```powershell
git diff --check
node --check server/server.js
node --check server/js/<changed-file>.js   # for each changed JS module
npm test                                    # unit tests (server/test/)
npm run icue:package                        # only for widget/ changes
```

For UI changes, also inspect the affected markup/CSS for responsive behavior and overflow at supported sizes (Xeneon Edge short screen, portrait, large desktop).

---

## Architecture

### Workspace, shared core & the four surfaces

Xenon is an npm workspace. **The dashboard in `server/` is the single source of the UI.** The browser tab, the iCUE `<iframe>` and the native app all load that **same** dashboard from `http://127.0.0.1:3030` — none of them is a copy. A feature or fix written once in `server/` therefore appears in all three with no extra work.

```text
packages/core/          @xenon/core — surface-agnostic shared code, the SINGLE source of
                        truth for logic that would otherwise be duplicated: the i18n
                        dictionary, constants, pure formatters, sensor models. Authored
                        UMD-lite (attaches to window.Xenon.* as a classic <script>, and
                        exports via CommonJS for Node/tests/iCUE packaging) — so NO surface
                        moves to ES modules and there is NO browser build step.
packages/design-system/ Shared design spec/tokens.
apps/native/            The native Tauri kiosk app (see below).
server/                 Backend + dashboard UI (unchanged home; all runtime paths preserved).
widget/                 Native iCUE widget (in development) — consumes the same packages/core
                        via its packaging step; its only widget-specific layer is the iCUE
                        lifecycle/adapter.
service/                Retired Windows-service host, kept for migration (see below).
```

**How the browser reaches `packages/core` without a build:** a Windows directory junction `server/shared → packages/core` (created by `npm run link:shared`, also `postinstall`, and self-healed at server boot) exposes the files at `/shared/*`, served by the existing static handler (`shared` is on its allowlist; the loopback traversal guard is unchanged because `path.normalize` is lexical). `server/js` consumes them as plain `<script>` includes with inline fallbacks, so the dashboard still boots byte-identically if `/shared` is briefly unavailable. The iCUE packaging step *copies* `packages/core/src` into the package instead of relying on the junction. The junctions are git-ignored.

### Backend startup (`service/` is retired)

The backend runs **in the user's interactive session**, started by a per-logon Task Scheduler task registered by `install.ps1` (`wscript start-hidden.vbs` → `node server/server.js`, hidden). An early v4 beta ran it as a WinSW **Windows service** instead; that is retired: a service lives in session 0, isolated from the interactive desktop, which silently broke Deck app/site launching, SMTC media, hotkeys, window actions, screen capture and TTS audio. `install.ps1` now removes a leftover `XenonEdgeService` before registering the task; `service/` keeps only the uninstall script (used by that migration and by `uninstall.ps1`) — see `service/README.md`. There is still **no** single-exe compile (SEA/pkg break native addons + `__dirname` asset resolution).

### Native app (`apps/native/`)

A **Tauri 2** kiosk shell (Rust in `src-tauri/`). The only bundled page is `splash/index.html`, which waits for the backend then navigates the same webview to the loopback dashboard — so it renders the identical UI and keeps SSE/WebSocket open (presence features behave like an open tab). `src-tauri/src/monitor.rs` pins the borderless full-screen window to the Xeneon Edge (matched by its 2560×720 panel) with a watchdog for display reorders/replug/standby; `tray.rs` adds the tray icon (show/hide/restart/exit); the autostart plugin sets login autostart. Built with `npm run native:build` (NSIS installer, WebView2 ensured). Requires the Rust toolchain; icons must exist in `src-tauri/icons/` before the first build.

### Server (`server/`)

`server.js` is the HTTP/API server. It routes requests, runs PowerShell collectors, caches results, persists JSON data files, and broadcasts SSE. Feature areas are split into focused modules:

| Module | Responsibility |
|---|---|
| `lighting.js` | RGB hub orchestrator (state, effects, device fan-out) |
| `lighting-effects.js` | Reactive/ambient effect computation (temp gradient, flashes, animations) |
| `lighting-discovery.js` | On-demand LAN scan for external lighting devices |
| `lighting-external.js` | External-provider coordinator |
| `lighting-providers/` | Per-system drivers: `wled.js`, `openrgb.js`, `hue.js`, `nanoleaf.js` |
| `ai-local.js` | Local Xenon AI — Ollama (chat) + Whisper.cpp (STT) + Edge neural TTS |
| `wakeword.js` | Local "Hey Xenon" wake-word listener — on-device Whisper, off by default, runs only while a dashboard is open; opens a voice session via the `wake_word` SSE event. No audio leaves the PC |
| `ics-feeds.js` | External calendar `.ics` feed parser/merger |
| `fpsmon.js` | PresentMon ETW FPS reader (started only while a dashboard is open; stopped shortly after the last one closes, with a grace period) |
| `gamedetect.js` | Foreground-fullscreen game detection (game mode) |
| `guardian.js` | Sensor-history recorder (CPU/GPU temp+load, RAM) and PC screen-time tracker; atomic append, opt-in `sensorHistory`; also the AI Guardian data source |
| `briefing.js` | Proactive moments — game-session recap, sustained-heat alerts, morning agenda (all local, no AI) |
| `sdk-widgets.js` | **Widget SDK** host — validates a community widget package (`manifest.json` + HTML) under `server/data/widgets`, resolves its assets, and gates the versioned message bridge (approved data streams + allowlisted actions). See [WIDGET_SDK.md](docs/WIDGET_SDK.md) |
| `winnotif.js` | Windows notification reader (Action Center) for the Notifications tile — Xenon Helper `notifications` mode with a PowerShell fallback |
| `discord-rpc.js` | Discord local RPC — voice control, soundboard, and DM/mention notifications |
| `embedded-browser.js` | Headless-Edge (CDP) host for the Browser widget — launches Edge, screencasts pages, injects input; relayed over `/embedded-browser/ws` |
| `embedded-browser-adblock.js` | Optional uBlock Origin Lite (uBOL) install/load for the Browser tile — atomic download into `current/`, off by default |
| `second-screen.js` | Virtual-display driver lifecycle (install/create/remove) for the Second-screen widget |
| `screen-capture.js` | Second-screen capture host manager — spawns the Xenon Helper `screen-serve` mode, relays JPEG frames over `/second-screen/ws`, forwards input, idle-retires the process |
| `stream-creds.js` | Server-only stream secret handling — preserve-on-save + redact-on-wire for `obsPassword` / `streamerbotPassword` |
| `self-update.js` / `semver.js` | Verified in-app self-update — Ed25519-signed `SHA256SUMS` checked against a pinned key **before** extraction (fail-closed); `update-apply.ps1` applies with snapshot/rollback |
| `actions/registry.js` | The single allowlist gate for every Deck/AI action (`openApp`, `openFile`, hotkeys, URLs/webhooks, Home Assistant, OBS, Streamer.bot…) — `run()` never throws |
| `deck-actions.ps1` | Allowlisted Deck action runner (open app/file/url, media, mute…) |

**PowerShell collectors** (`server/*.ps1`): `cpu-temp`, `gpu`, `media`, `network`, `windows`, `foreground`, `performance`, `perf-priority`, plus `install.ps1` / `uninstall.ps1`.

### Xenon Helper (`helper/`)

Optional native companion process (C#, .NET 10, self-contained single-file trimmed exe ~11MB — end users need no runtime). It replaces persistent PowerShell hosts where that is possible:

| Mode | Replaces | Extra over the PS version |
|---|---|---|
| `media-serve` | `media.ps1 -Serve` | pushes `{"event":"media-changed"}` frames on OS media events → instant dashboard updates |
| `foreground-serve [ms]` | `foreground.ps1` | emits an extra probe line the instant the foreground window changes (Win32 event hook) → instant game mode |
| `screen-serve` | *(no PS equivalent)* | Second-screen GDI capture: streams JPEG frames of the virtual monitor, composites the mouse cursor, injects mouse/keyboard input (`SendInput`), and commits the display resolution (`ChangeDisplaySettingsEx`). Capture-only — no PS fallback; the widget shows a "needs the helper" state when the exe is absent |
| `notifications` | *(PowerShell fallback)* | Reads Windows Action Center notifications (WinRT `UserNotificationListener`) and pushes them for the Notifications tile; `winnotif.js` falls back to PowerShell when the exe is absent. Helper is **v0.4.0**. |

- Build: `dotnet publish helper -c Release -o server/helper` (requires the .NET 10 SDK, dev machine only)
- Distribution: `.github/workflows/release.yml` (the atomic release pipeline, triggered by pushing the version tag) builds the exe and stages it as the `xenon-helper.exe` asset on the draft release before publish — alongside the setup exe, its stable-named copy `Xenon-Setup-x64.exe`, `latest.json` and the signed `SHA256SUMS`; `helper.yml` remains as a manual recovery tool. `server/install.ps1` (`Install-XenonHelperIfNeeded`) downloads it from the latest release and refreshes it when outdated — bump `$minVersion` there together with the csproj `<Version>` whenever the stdio protocols change
- `server.js` / `gamedetect.js` spawn the exe when present, else the PowerShell host — the helper is optional by design, every module keeps its PS fallback, and an exe that dies young gets pinned out in favour of PS
- Protocols are byte-compatible with the PS hosts (`XEMED ` base64 frames for media; bare JSON lines for foreground); retire the **media** host gracefully via stdin close, never hard-kill first (it holds WinRT/SMTC broker handles)
- Trimmed build: JSON output is written with the hand-rolled `JsonOut` (reflection-based `JsonSerializer.Serialize` throws in trimmed builds)
- SMTC quirk: requests must run on threadpool threads (`Task.Run`) — called synchronously from the console main thread, a cached session manager returns zero sessions
- **Sensors (cpu-temp/gpu/network) deliberately stay in `pwsh-worker.ps1`**: the user-installed `LibreHardwareMonitorLib.dll` is a .NET Framework build that cannot load on modern .NET (it calls a `Mutex` ctor overload that no longer exists), and bundling the NuGet build is forbidden — it embeds the Defender-flagged WinRing0 driver. PowerShell 5.1 *is* .NET Framework, which makes it the only clean host.

### Client (`server/js/`)

ES modules loaded directly by the browser. `main.js` is the entry point and owns the SSE `EventSource` (with a fallback poll). `state.js` is a shared reactive store.

| Area | Modules |
|---|---|
| AI | `ai.js` (Gemini, voice session, screen capture, function dispatch), `audio-feedback.js` |
| Layout / pages | `dashboard-layout.js`, `dashboard-grid.js`, `dashboard-pager.js`, `dashboard-pages.js`, `dashboard-palette.js`, `dashboard-tabgroups.js`, `dashboard-instances.js`, `dashboard-presets.js` |
| Deck | `deck.js`, `deck-model.js`, `deck-editor.js`, `deck-actions.js`, `deck-icons.js` |
| Lighting | `lighting-page.js` |
| Remote / performance | `remote-control.js`, `performance.js`, `performance-actions.js`, `context-profiles.js` |
| Browser / Second screen | `browser-tile.js`, `second-screen-tile.js` (canvas render, visibility-gated streaming over their loopback WS, input forwarding) |
| Widget SDK | `custom-widget.js` (sandboxed iframe host + permission dialog + message bridge client — also hosts fullscreen Ambient scene frames) |
| Ambient mode | `ambient-mode.js` (screensaver orchestrator: builtin scene = `lockscreen.js`, SDK `surface:'ambient'` scenes, configurable idle auto-start) |
| Community gallery | `community-gallery.js` (Discover overlay; catalog via `GET /api/community/catalog`, install through `PresetShare.openImport`) |
| Notifications | `notifications-widget.js`, `discord-widget.js` (Notifications tab) |
| Streaming widgets | `discord-widget.js`, `spotify-widget.js`, `obs-widget.js`, `youtube-widget.js`, `streamerbot-widget.js` |
| Sharing | `preset-share.js` (export/import + `sanitizeDeckProfile` for shared Deck profiles; kinds incl. `ambient` scenes) |
| History | `guardian-history.js` (System-tile History tab: sparkline charts + screen-time viewer) |
| Productivity | `calendar.js`, `tasks.js`, `timer.js`, `notes` |
| Misc | `album-theme.js`, `lockscreen.js`, `tab-switcher.js`, `custom-select.js`, plus `audio`, `clock`, `i18n`, `media`, `mic`, `network`, `picker`, `settings`, `status`, `system`, `utils`, `volume` |

CSS lives in `server/components/` (per-panel) and `server/styles/` (global + breakpoints).

### Modern web platform

The client targets Chromium (Edge/Chrome/Xeneon Edge WebView) and uses these without polyfills:

- `CSS @property` + `:root` transition for animated `--accent` / `--bg` theme cross-fade (`styles/global.css`)
- `document.startViewTransition()` for animated layout changes (`dashboard-layout.js`), with a direct-call fallback
- `EventSource` (SSE) instead of polling for real-time data (`main.js` + `server.js`)
- `requestAnimationFrame` for the lockscreen clock (`lockscreen.js`)
- `will-change`, CSS Container Queries, `color-mix()` where appropriate

Prefer `EventSource` over `setInterval`+`fetch`, wrap layout mutations in `startViewTransition()`, and add `will-change` to elements with running `@keyframes`.

---

## HTTP API (loopback only)

All endpoints are served from `127.0.0.1:3030`. The server validates the `Host`/`Origin` headers and rejects anything that isn't loopback (DNS-rebinding / CSRF protection).

### Core

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/` | Serve the widget HTML. |
| `GET`  | `/status` | Mic mute state. |
| `POST` | `/toggle` | Toggle mic mute. |
| `GET`  | `/sse` | Server-Sent Events stream (see below). |
| `POST` | `/lock` | Lock the workstation. |

### Audio

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/audio` | Devices, default speaker/mic, volumes. |
| `POST` | `/volume/set` | `{ level: 0–100 }` set speaker volume. |
| `POST` | `/mic/volume` | `{ level: 0–100 }` set mic volume. |
| `POST` | `/speaker/set` | `{ id }` change default speaker. |
| `POST` | `/mic/set` | `{ id }` change default mic. |
| `POST` | `/speaker/mute` | Toggle speaker mute. |
| `POST` | `/audio/app/volume` | `{ id, level: 0–100 }` set one app session's volume. |
| `POST` | `/audio/app/mute` | `{ id }` toggle one app session's mute. |

### Media

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/media` | Currently playing track. |
| `POST` | `/media/playpause`, `/media/next`, `/media/previous` | Transport. |

### System & data

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/system` | CPU, GPU, RAM, disks, temps. |
| `GET`  | `/network` | Ping, latency, bandwidth. |
| `GET`  | `/weather` | Current + 3-day + hourly (cached 10 min, wttr.in). |
| `GET`  | `/windows` | List visible top-level windows. |
| `POST` | `/windows/focus` | `{ id }` bring a window to the foreground. |
| `GET`/`POST` | `/notes` | Read / save the notepad. |
| `GET`/`POST` | `/events` | Read / save calendar events. |
| `GET`/`POST` | `/tasks` | Read / save task list (max 100). |

### Timers

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/timers` | List active timers. |
| `POST` | `/api/timers` | Create. Body: `{ label, duration_secs }`. |
| `PATCH` | `/api/timers/:id` | `{ action: "pause" \| "resume" \| "reset" }`. |
| `DELETE` | `/api/timers/:id` | Delete. |

### Xenon AI

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/ai` | Send a message to Gemini with function-calling. |
| `GET` | `/api/screenshot` | Capture a screenshot (optional `?x=&y=&w=&h=`). |
| `POST` | `/api/chime` | Play a chime. Body: `{ kind: "wake" \| "deactivate" }`. |
| `POST` | `/api/volume/duck` | Duck master volume to 20% for a voice session. |
| `POST` | `/api/volume/restore` | Restore master volume after ducking. |
| `POST` | `/api/ai-local/scan` | Hardware scan; recommend a local model. |
| `GET` | `/api/ai-local/status` | Live status of Ollama / Whisper / Edge voice. |
| `POST` | `/api/ai-local/pull` | Download a local model (progress). |

### Remote Control

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/remote/status` | Aggregated status (tools, Tailscale IP, Sunshine, clients). Never returns secrets. |
| `POST` | `/remote/install` | `{ tool: "sunshine" \| "tailscale" }` install via winget. |
| `POST` | `/remote/tailscale/login` | Start Tailscale sign-in. |
| `POST` | `/remote/sunshine/configure` | Configure Sunshine with locally generated credentials. |
| `POST` | `/remote/pin` | `{ pin }` pair a phone. |
| `POST` | `/remote/kill` | Kill-switch: disconnect all paired devices. |
| `POST` | `/remote/enable`, `/remote/disable` | Enable / disable the feature. |

### Background media

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/background` | Upload an image/video (multipart, max 200 MB; JPG/PNG/WebP/GIF/MP4/WebM). MP4 → WebM when FFmpeg is present. Returns `{ url, type, conversion }`. |
| `GET`  | `/uploads/<file>` | Serve an uploaded background (byte-range for video). |

### Second screen

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/second-screen/requirements` | Capability probe: helper present, winget/driver installed, virtual display active. |
| `POST` | `/second-screen/install` | Install the signed virtual-display driver (elevated, idempotent). |
| `POST` | `/second-screen/create-display` | `{ mode }` create the virtual monitor (elevated; remove-then-install, never spams monitors). |
| `POST` | `/second-screen/apply-resolution` | `{ mode?, soft? }` commit the resolution live (no UAC). `soft:true` is the silent auto-restore — the server reads the saved resolution from `settings.json` and never falls back to the elevated re-create. |
| `POST` | `/second-screen/remove-display` | Remove the virtual monitor (elevated). |

### WebSocket relays (loopback only)

Both upgrade on the same server and are rejected unless the request passes the loopback `Host`/`Origin` check.

| Path | Purpose |
|---|---|
| `/second-screen/ws` | Second-screen relay. Client → `{type:'start'\|'stop'\|'input'\|'list'}`; server → `{type:'frame', data(base64 jpeg), w, h, seq}`. One shared capture host; a second client takes over the sink. |
| `/embedded-browser/ws` | Browser relay. Per-tile open/navigate/resize/input/close; server pushes screencast frames and nav updates. Edge shuts down when the last tile closes. |

> Lighting, Deck, OBS, Streaming (Twitch/YouTube/OBS/Discord/Spotify/Streamer.bot), Smart Home, the Widget SDK (`/widgets/*`), Notifications, sensor history, and self-update also expose endpoints; see their server modules for the current routes.

### SSE events

`GET /sse` pushes named events: `status`, `media`, `system`, `audio`, `wake_word`, `timer_update`, `timer_done`, `stop_session`, plus integration streams such as `homeassistant`, `streamerbot_event`, and notification events for the Notifications tile. Do not remove or rename `/sse` without updating `main.js` and the broadcast timers at the end of `server.js`.

---

## File layout

```
Xenon/
├── INSTALL.bat              ← One-click installer
├── UNINSTALL.bat           ← Removes startup entry and stops the server
├── package.json
├── README.md  FEATURES.md  DEVELOPER.md  CHANGELOG.md  AGENTS.md  LICENSE
│
├── docs/
│   ├── images/             ← Screenshots used in the docs
│   ├── WIDGET_SDK.md       ← Widget SDK guide (package format, sandbox, bridge protocol)
│   └── streaming-setup.md  ← Twitch & YouTube setup guide
│
├── server/                 ← Node.js web widget (port 3030)
│   ├── server.js           ← HTTP/API server
│   ├── index.html          ← Modular UI entry point (served)
│   ├── lighting*.js        ← RGB hub, effects, discovery, external + providers/
│   ├── ai-local.js         ← Local AI (Ollama + Whisper.cpp + Edge TTS)
│   ├── ics-feeds.js        ← External calendar .ics parser/merger
│   ├── fpsmon.js           ← PresentMon FPS reader
│   ├── gamedetect.js       ← Foreground-fullscreen game detection
│   ├── embedded-browser.js ← Headless-Edge (CDP) host for the Browser widget
│   ├── second-screen.js    ← Virtual-display driver lifecycle
│   ├── screen-capture.js   ← Second-screen capture host manager (Xenon Helper screen-serve)
│   ├── *.ps1               ← PowerShell collectors + deck-actions.ps1
│   ├── js/                 ← Frontend ES modules
│   ├── components/         ← Per-panel CSS
│   ├── styles/             ← Global CSS + breakpoints
│   ├── test/               ← Unit tests (node:test) — `npm test`
│   ├── soundvolumeview-x64/← SoundVolumeView.exe (NirSoft, freeware)
│   ├── presentmon/         ← PresentMon (downloaded by INSTALL.bat)
│   ├── whisper/            ← Whisper.cpp engine + model (downloaded on demand)
│   ├── helper/             ← xenon-helper.exe build output (optional, gitignored)
│   └── data/               ← ALL runtime user data (auto-created, gitignored)
│
├── server/data/            ← Centralized runtime data (do not edit by hand)
│   ├── settings.json       ← User settings (geminiApiKey, aiProvider, lighting, …)
│   ├── events.json  tasks.json  timers.json  deck.json  notes.txt
│   ├── stream-config.json  ← Twitch/YouTube client ids (owner-specific secret)
│   ├── stream-tokens.json  ← OAuth tokens (server-only secret)
│   ├── widgets/            ← Installed community widgets (Widget SDK packages)
│   └── uploads/            ← User-uploaded backgrounds
│
├── helper/                 ← Xenon Helper sources (C#/.NET 10, optional native companion)
│   ├── XenonHelper.csproj  Program.cs  MediaHost.cs  ForegroundHost.cs
│   ├── ScreenHost.cs  NotificationHost.cs  WindowsTool.cs  JsonOut.cs
│
└── widget/                 ← Native iCUE widget (in development)
    ├── manifest.json  index.html  translation.json
    ├── modules/  components/  common/plugins/  styles/  resources/
```

### Runtime data files (auto-created, gitignored — do not edit by hand)

All user data lives in **`server/data/`**: `settings.json` (incl. `geminiApiKey`, `aiProvider`, `lighting`, `remoteControl`), `events.json`, `tasks.json`, `timers.json`, `deck.json`, `notes.txt`, `stream-config.json`, `stream-tokens.json`, and `uploads/`.

Paths are centralized via the `DATA_DIR` constant in `server.js`. On startup a one-time migration moves any legacy loose files (from earlier versions that stored them directly in `server/`) into `server/data/`, skipping any file that already exists in the new location so it never clobbers current data.

Tool binaries are **not** user data and stay in their own folders: `whisper/` (downloaded STT engine + model), `presentmon/`, `openrgb/`, `vendor/` (iCUE SDK), `soundvolumeview-x64/`.

---

## Settings & persistence

- Client settings live under `xeneonedge.settings.v1` in `localStorage` and sync through `/settings`.
- Settings carry a monotonic `rev`; on hydrate the newer copy wins, so a restart never clobbers a newer local change.
- Validate any value loaded from `localStorage` or a JSON file before applying it, with a sensible default and a reset path.
- When adding a settings field that both sides persist, add normalization on **both** the client and the server. Server normalization changes require a manual Node restart to take effect.
- Preserve backward compatibility; migrate layouts cleanly on upgrade.

---

## Security

- Binds to `127.0.0.1` only and validates `Host`/`Origin` — public sites can't reach it via DNS rebinding. No CORS wildcards (same-origin only).
- Inputs to `/windows/focus`, `/notes`, `/events`, uploads, etc. are validated and capped.
- The Deck runs only **allowlisted** actions through a single dispatcher — never arbitrary commands.
- Secrets (Gemini key, stream tokens, Tailscale auth) stay on the local machine and are never sent to the browser or logged.
- Uploads are constrained by extension, MIME type, size (200 MB), and safe local paths.
- The RGB bridge must **never call the iCUE SDK synchronously on the event loop** — a sync FFI call inside the SDK callback can deadlock and freeze the whole server. Run SDK calls off-thread (`.async`) with a hard timeout, and never re-enter the SDK from its own callback.
- **Self-update is verified, fail-closed, before extraction** — `self-update.js` refuses to unzip a download unless the release's Ed25519-signed `SHA256SUMS` verifies against the pinned public key and the zip hash matches. Never make the signature optional or move verification after extraction.
- **Widget SDK isolation** — community widgets get no network and no DOM/data access; every data stream and action goes through the versioned bridge in `sdk-widgets.js`, gated by the user's approved permissions and re-checked server-side per action. See [WIDGET_SDK.md](docs/WIDGET_SDK.md).
- **Server-only secrets** — `obsPassword`/`streamerbotPassword` (via `stream-creds.js`), the Home Assistant token, and remote-control credentials are preserved on save and redacted on the wire; never send them to the browser or a backup export.

---

## Conventions

- `const` by default, `let` only when reassigning, never `var`. `async`/`await` with explicit `try`/`catch`.
- Prefer small, single-purpose modules and existing helpers/patterns over new abstractions.
- Use `textContent` for user-visible text unless the markup is trusted and static. No `eval`, dynamic `Function`, `document.write`, or string timers.
- Validate external/persisted data at the boundary where it enters the app.
- Degrade gracefully — keep loading/empty/offline/error states deliberate; don't hide real failures behind silent no-ops.
- Update `CHANGELOG.md` (and the relevant docs) for every user-visible change.
- Comments explain **why**, not the obvious mechanics.
- **Announcing a release to users** — for an *important* release, curate `server/whatsnew.json`: bump `id` (the dismissal key) so the "What's New" card reappears to everyone, and write 4–6 highlights (each `title`/`body` may be a plain string or a `{ it, en, … }` map; `media` must be a GitHub-hosted attachment URL with `mediaType` `"image"`/`"video"`). For a pure bugfix release, **leave `id` unchanged** (or empty) so the card doesn't re-nag. It's served, normalised, at `GET /whatsnew`; the client (`js/update.js`) shows it every startup until dismissed. This is separate from the "update available" nudge (`GET /update/check`).

See **[AGENTS.md](AGENTS.md)** and `.claude/CLAUDE.md` for the full project rules.

---

## Native iCUE widget (`widget/`)

A separate, in-development native widget package. Consult the offline SDK mirror before relying on web docs: `WidgetBuilder/docs/`, `WidgetBuilder/references/`, `WidgetBuilder/skill.md`. Many features (mic mute, audio, network, app switcher) require the companion server and aren't available via native SDK plugins alone. Keep the widget identity stable; package with `npm run icue:package`.
