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
| `npm run icue:package` | Package the native iCUE widget (`widget/`). |
| `npm run icue:validate` | Validate the native iCUE widget. |

`INSTALL.bat` is the full user setup (Node, FFmpeg, sensors, PresentMon, silent Windows startup task). Use `server/start.bat` to launch manually when Node is already installed. If you use `npm start` instead of `INSTALL.bat`, install FFmpeg yourself if you want automatic MP4 → WebM background conversion.

### Validation before handing back

```powershell
git diff --check
node --check server/server.js
node --check server/js/<changed-file>.js   # for each changed JS module
npm run icue:package                        # only for widget/ changes
```

For UI changes, also inspect the affected markup/CSS for responsive behavior and overflow at supported sizes (Xeneon Edge short screen, portrait, large desktop).

---

## Architecture

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
| `ics-feeds.js` | External calendar `.ics` feed parser/merger |
| `fpsmon.js` | PresentMon ETW FPS reader |
| `gamedetect.js` | Foreground-fullscreen game detection (game mode) |
| `deck-actions.ps1` | Allowlisted Deck action runner (open app/file/url, media, mute…) |

**PowerShell collectors** (`server/*.ps1`): `cpu-temp`, `gpu`, `media`, `network`, `windows`, `foreground`, `performance`, `perf-priority`, plus `install.ps1` / `uninstall.ps1`.

### Client (`server/js/`)

ES modules loaded directly by the browser. `main.js` is the entry point and owns the SSE `EventSource` (with a fallback poll). `state.js` is a shared reactive store.

| Area | Modules |
|---|---|
| AI | `ai.js` (Gemini, voice session, screen capture, function dispatch), `audio-feedback.js` |
| Layout / pages | `dashboard-layout.js`, `dashboard-grid.js`, `dashboard-pager.js`, `dashboard-pages.js`, `dashboard-palette.js`, `dashboard-tabgroups.js`, `dashboard-instances.js` |
| Deck | `deck.js`, `deck-model.js`, `deck-editor.js`, `deck-actions.js`, `deck-icons.js` |
| Lighting | `lighting-page.js` |
| Remote / performance | `remote-control.js`, `performance.js`, `performance-actions.js` |
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

> Lighting, Deck, OBS, and Streaming also expose endpoints; see their server modules for the current routes.

### SSE events

`GET /sse` pushes named events: `status`, `media`, `system`, `audio`, `wake_word`, `timer_update`, `timer_done`, `stop_session`. Do not remove or rename `/sse` without updating `main.js` and the broadcast timers at the end of `server.js`.

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
│   └── streaming-setup.md  ← Twitch & YouTube setup guide
│
├── server/                 ← Node.js web widget (port 3030)
│   ├── server.js           ← HTTP/API server
│   ├── index.html          ← Modular UI entry point (served)
│   ├── widget.html         ← Legacy single-file UI (reference)
│   ├── lighting*.js        ← RGB hub, effects, discovery, external + providers/
│   ├── ai-local.js         ← Local AI (Ollama + Whisper.cpp + Edge TTS)
│   ├── ics-feeds.js        ← External calendar .ics parser/merger
│   ├── fpsmon.js           ← PresentMon FPS reader
│   ├── gamedetect.js       ← Foreground-fullscreen game detection
│   ├── *.ps1               ← PowerShell collectors + deck-actions.ps1
│   ├── js/                 ← Frontend ES modules
│   ├── components/         ← Per-panel CSS
│   ├── styles/             ← Global CSS + breakpoints
│   ├── soundvolumeview-x64/← SoundVolumeView.exe (NirSoft, freeware)
│   ├── presentmon/         ← PresentMon (downloaded by INSTALL.bat)
│   ├── whisper/            ← Whisper.cpp engine + model (downloaded on demand)
│   └── data/               ← ALL runtime user data (auto-created, gitignored)
│
├── server/data/            ← Centralized runtime data (do not edit by hand)
│   ├── settings.json       ← User settings (geminiApiKey, aiProvider, lighting, …)
│   ├── events.json  tasks.json  timers.json  deck.json  notes.txt
│   ├── stream-config.json  ← Twitch/YouTube client ids (owner-specific secret)
│   ├── stream-tokens.json  ← OAuth tokens (server-only secret)
│   └── uploads/            ← User-uploaded backgrounds
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

---

## Conventions

- `const` by default, `let` only when reassigning, never `var`. `async`/`await` with explicit `try`/`catch`.
- Prefer small, single-purpose modules and existing helpers/patterns over new abstractions.
- Use `textContent` for user-visible text unless the markup is trusted and static. No `eval`, dynamic `Function`, `document.write`, or string timers.
- Validate external/persisted data at the boundary where it enters the app.
- Degrade gracefully — keep loading/empty/offline/error states deliberate; don't hide real failures behind silent no-ops.
- Update `CHANGELOG.md` (and the relevant docs) for every user-visible change.
- Comments explain **why**, not the obvious mechanics.

See **[AGENTS.md](AGENTS.md)** and `.claude/CLAUDE.md` for the full project rules.

---

## Native iCUE widget (`widget/`)

A separate, in-development native widget package. Consult the offline SDK mirror before relying on web docs: `WidgetBuilder/docs/`, `WidgetBuilder/references/`, `WidgetBuilder/skill.md`. Many features (mic mute, audio, network, app switcher) require the companion server and aren't available via native SDK plugins alone. Keep the widget identity stable; package with `npm run icue:package`.
