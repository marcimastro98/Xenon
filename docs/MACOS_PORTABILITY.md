# Xenon — macOS Portability Report

> **Scope.** A feature-by-feature audit of the whole Xenon codebase, assessing what
> can realistically run on **macOS** and the effort it would take. Grounded in the
> actual code (each row cites the file/function and the exact Windows mechanism),
> not guesswork.
>
> **TL;DR.** The core — dashboard, the Widget SDK, and everything that is
> network/browser-based — already runs on macOS with **no code changes**
> (~55–60% of the app). "Light" system control is a set of targeted small swaps.
> Only a handful of features are intrinsically Windows-only and are lost or need a
> native helper rewrite.

## Legend

**Feasibility**

- **Full** — already cross-platform, or a drop-in equivalent exists.
- **Partial** — works, but needs a macOS-specific implementation, a permission
  grant (Accessibility / root), or loses fidelity (e.g. Apple Silicon temps).
- **None** — no macOS equivalent, or requires a full native rewrite.

**Effort** — S: < 1 day · M: 2–4 days · L: 1–2 weeks · XL: > 2 weeks / research /
native rewrite.

---

## 1. Verdict by tier (what to do, and the cost)

### 🟢 Free — already cross-platform, zero code (just ungate it)
Weather · Stocks · News · Football · Calendar (ICS/Outlook/Google via published
URLs) · Claude Code usage · UniFi Protect · Community catalog · Tasks/Notes/
Timers/Agenda · **Widget SDK (store, secrets, tile proxy, fetch proxy)** ·
Themes/Pages/Ambient/Settings/Share-Import · Cloud AI (Claude, OpenAI incl. cloud
STT/TTS, Gemini turn + Live, AI memory) · Network RGB (WLED, Hue, Nanoleaf, Govee,
LIFX, Yeelight, Home Assistant, **OpenRGB**) + the whole lighting engine · OBS
control, Twitch, YouTube, Streamer.bot · Spotify (Web API) · **Wave Link** (native
mac app) · CPU load/name, RAM, free disk · Guardian (sensor history, alerts,
screen-time) · game-mode state machine · Tauri kiosk window, tray, **autostart
(already `MacosLauncher::LaunchAgent`)**, updater, single-instance, monitor
placement, external-link opener.

> The Widget SDK gallery — the growing asset around community/DGM widgets — sits
> entirely in this free tier.

### 🟡 Easy — S swaps (< 1 day each)
Lock PC · `run_pc_command` · open file/app/script · master + mic volume · idle
presence · process priority · TTS playback · **Discord voice (one function)** ·
Tailscale · foreground-app (S–M). The Windows-only Tauri guards (cursor/edge/
focus/RDP) are moot on mac and stay `#[cfg(windows)]`.

### 🟠 Moderate — M (2–4 days each)
Audio output-device switch · true mic mute · media now-playing + transport
(fragile on macOS 15.4+) · STT mic capture (unblocks wake word) · vision
screenshot · Ollama install/detect/autostart/VRAM · network/disk/per-process
collectors · embedded browser (retarget Chromium) · Deck action dispatcher · logon
auto-open · Sunshine · tool installer (winget→brew) · **Tauri macOS bundle + notarization**.

### 🔴 Hard — L (1–2 weeks each)
Window management + hotkey/type injection (Accessibility) · CPU/GPU temps + GPU
load (`powermetrics`/sudo or private IOKit; weak on Apple Silicon) · the
`runCollector` seam replacing all `.ps1` collectors · local Whisper.cpp · backend
self-update applier.

### ⛔ Blockers — lost, or native rewrite (None / XL)
- **FPS (PresentMon)** — no system-wide frame capture on macOS. **Lost.**
- **Per-app volume mixer** — macOS has no per-process volume API. **Lost** (or XL
  via a virtual-audio driver).
- **High-performance power plans** — don't exist on macOS (only inverse Low Power
  Mode). **Reframe.**
- **iCUE / Razer Chroma / SignalRGB** — Windows-only local SDKs/exe; route Corsair/
  Razer gear through **OpenRGB** instead. Already degrade to clean no-ops.
- **Second screen (virtual display via VDD/devcon)** — Windows driver. **Rewrite.** XL.
- **Native `.exe` helper (.NET)** — a mac helper (UNUserNotificationCenter +
  ScreenCaptureKit + Accessibility) would unblock **OS notifications + second-screen
  capture + app-switcher window enumeration**. The single biggest lift. XL.

---

## 2. Effort roll-up & phased plan

| Phase | What | Result | Effort |
|---|---|---|---|
| **0** | Drop `os: win32`; add `capabilities.platform`; clean degradation of Windows-only actions | ~60% of the app live on mac (dashboard, SDK, all data widgets, cloud AI, network RGB, streaming, Spotify/Wave Link) | days |
| **1** | `runCollector` abstraction + S/M swaps (lock, volume, media, foreground/idle, Deck dispatch, Discord pipe, embedded browser) | "Light" system control | 1–2 weeks |
| **2** | Tauri macOS target + autostart/auto-open + Tailscale/Sunshine + Ollama/Whisper + STT/wake/vision (avfoundation) | Installable native mac app, local voice | weeks |
| **3** *(optional)* | Native mac helper | OS notifications + second-screen capture + app-switcher backend | XL |
| **never** | FPS, per-app mixer, power plans, virtual display, iCUE/Chroma/SignalRGB | — | lost / use OpenRGB |

**Bottom line:** ~60% free immediately, another ~25% with targeted Phase 1–2
work, ~15% lost or too costly.

The two architectural levers that make this cheap already exist:

1. **The core runs cross-platform.** The Node HTTP server + dashboard + Widget SDK
   are pure Node/JS.
2. **Actions self-disable.** The deck registry does
   `if (typeof d.X !== 'function') return { error: 'unavailable' }`, and the
   `capabilities` object hides unavailable actions from the editor — so a missing
   platform dep degrades to a clean, reduced UI instead of an error. macOS support
   is largely "provide mac deps where possible, leave the rest undefined."

---

## 3. Detailed matrix

### 3.1 Data / network widgets & platform — **Full across the board**

| Feature | Implementation | Feasibility | macOS work | Effort |
|---|---|---|---|---|
| Weather | `server.js` → Open-Meteo/met.no/wttr.in/air-quality (`https`) | Full | none | S |
| Stocks | `stocks.js` → Yahoo/TwelveData/Finnhub (`https`) | Full | none | S |
| News | `news.js` → RSS/Atom + Google News + NewsData.io | Full | none | S |
| Football | `football.js` → TheSportsDB (`https`) | Full | none | S |
| Calendar (ICS/Outlook/Google) | `ics-feeds.js` — conditional GET of published ICS URLs; TZ via `Intl` | Full | none (subscription, not OAuth/CalDAV) | S |
| Claude Code usage | `claude-usage.js` → `~/.claude/projects/**/*.jsonl` via `os.homedir()`; honours `CLAUDE_CONFIG_DIR` | Full | **none — no hardcoded `%USERPROFILE%`** | S |
| UniFi Protect | `unifi-events.js` — `ws` + `zlib` | Full | none | S |
| Community catalog | `community-catalog.js` — `https` | Full | none | S |
| Widget SDK (validate/assets) | `sdk-widgets.js` — `fs`+`path`, `path.sep`/`normalize` guard | Full | none | S |
| Widget SDK (store/secrets) | `sdk-store.js` — pure logic | Full | none | S |
| Widget SDK (fetch proxy) | `sdk-proxy.js` — `http`/`https`/`dns`/`net`, SSRF guard | Full | none | S |
| Briefing / greeting | `briefing.js` — passive engine fed by SSE | Full | none | S |
| Tasks / Notes / Timers / Agenda | JSON persistence (`atomic-write.js`) + DOM | Full | none | S |
| Themes / Pages / Ambient / Settings / Share-Import | Browser-only + JSON | Full | none | S–M |

*Confirmed via grep: zero `.exe`/`.ps1`/`%USERPROFILE%`/`child_process` in any data module.*

### 3.2 RGB lighting

**Network / loopback-TCP providers — already cross-platform:**

| Provider | Mechanism | Feasibility | Effort |
|---|---|---|---|
| **OpenRGB** | `lighting-providers/openrgb.js` — `net` TCP `:6742` binary protocol | Full (mac build exists → primary local sink on mac) | None–S |
| WLED | `wled.js` — `fetch` JSON | Full | None |
| Philips Hue | `hue.js` — `fetch` CLIP v2/v1 | Full | None |
| Nanoleaf | `nanoleaf.js` — `fetch` `:16021` | Full | None |
| Govee | `govee.js` — `dgram` UDP | Full | None |
| LIFX | `lifx.js` — `dgram` UDP `:56700` | Full | None |
| Yeelight | `yeelight.js` — `dgram` SSDP + `net` `:55443` | Full | None |
| Home Assistant | `lighting-providers/homeassistant.js` — HTTP/WS runtime hooks | Full | None |
| Engine (effects/discovery) | `lighting.js`, `lighting-effects.js`, `lighting-discovery.js` | Full | None |

**Windows-native local sinks — die on mac (degrade to no-ops):**

| Provider | Mechanism | Feasibility | macOS note | Effort |
|---|---|---|---|---|
| **iCUE (Corsair)** | `lighting.js` — koffi FFI loads `iCUESDK.x64_2019.dll`, talks to iCUE service | None | No mac iCUE service; `isAvailable()` already false → route via OpenRGB | XL (replicate) / S (stub) |
| **Razer Chroma** | `chroma.js` — HTTP to local SDK server `127.0.0.1:54235` | None | No `:54235` server on mac; already no-ops | L / S (stub) |
| **SignalRGB** | `signalrgb.js` — `execFile SignalRgbLauncher.exe` | None | Windows-only launcher; already self-guards (no `LOCALAPPDATA` → hidden) | S (already degrades) |

### 3.3 Streaming & comms

| Feature | Mechanism | Feasibility | macOS work | Effort |
|---|---|---|---|---|
| OBS control | `actions/obs.js` — OBS WebSocket v5 | Full | none | S |
| OBS auto-launch | `actions/obs-launch.js` — `obs64.exe` + PS registry read | Partial | `/Applications/OBS.app` + `open -a OBS`; drop registry probe | M |
| Twitch | `stream-twitch.js` — OAuth device flow + Helix REST | Full | none | S |
| YouTube | `stream-youtube.js` — OAuth device flow + Data API v3 | Full | none | S |
| **Discord voice** | `discord-rpc.js` — local RPC over named pipe `\\?\pipe\discord-ipc-N` | Partial | **one function**: `pipePath()` → Unix socket `discord-ipc-N` under `$TMPDIR`/`/tmp` | S |
| Streamer.bot | `actions/streamerbot.js` — WebSocket | Full | none | S |

### 3.4 Audio / mic / media / Spotify / Wave Link

| Feature | Mechanism | Feasibility | macOS approach | Effort |
|---|---|---|---|---|
| Master volume | `SoundVolumeView.exe /SetVolume` | Full | `osascript -e 'set volume output volume N'` | S |
| Output device switch | SVV `/SetDefault ... all` + `/scomma` CSV | Full | `SwitchAudioSource` / CoreAudio | M |
| Mic mute / device | SVV `/Mute` on `cachedMicId` | Partial | input volume via osascript; **true mute needs CoreAudio** `kAudioDevicePropertyMute` | M |
| **Per-app volume mixer** | SVV per-process (`appVolume`/`appMute`) | **None** | macOS has no per-process volume API — needs a virtual-audio driver | **XL / cut** |
| Media now-playing | `media.ps1` — SMTC/WinRT | Partial | `nowplaying-cli` (private MediaRemote) — **fragile on macOS 15.4+** | M |
| Media transport | `media.ps1` — SMTC play/pause/next/prev | Partial | `nowplaying-cli` commands (same fragility) | M |
| Spotify control | `stream-spotify.js` — Spotify Web API (HTTPS/OAuth) | Full | none | S |
| Elgato Wave Link | `actions/wavelink.js` — local JSON-RPC WebSocket `:1824–1834` | Full | native mac Wave Link app, same WS | S |

### 3.5 AI & voice

| Feature | Mechanism | Feasibility | macOS approach | Effort |
|---|---|---|---|---|
| Claude / OpenAI / Gemini (cloud) | `ai-anthropic.js`/`ai-openai.js` + Gemini in `server.js` — HTTPS | Full | none | S |
| AI memory | `ai-memory.js` — `fs` + atomic write | Full | none | S |
| Ollama (local LLM) | `ai-local.js` — HTTP `:11434`; `findOllamaExe`/`startOllama`/autostart/VRAM are Win-coded | Partial | chat works; install/detect via `/Applications`+`which`, autostart via LaunchAgent, VRAM via `system_profiler` (or skip on AS) | M |
| Local STT (Whisper.cpp) | `ai-local.js` — `whisper-cli.exe`; installer downloads win-x64 zip | Partial | mac whisper.cpp (Metal) binary + darwin installer asset branch | L |
| Mic capture | `server.js:_sttInputArgs` — ffmpeg `-f wasapi`/`-f dshow` | Partial | ffmpeg `-f avfoundation`; single choke point feeds STT **and** wake word | M |
| TTS synthesis | `ai-local.js` — `msedge-tts` (cloud) + ffmpeg | Full | none (or `say`) | S |
| TTS playback | `server.js:_playWavFile` — PowerShell `SoundPlayer` | Partial | `afplay <wav>`; ducking via osascript | S–M |
| Wake word "Hey Xenon" | `wakeword.js` — home-grown VAD + Whisper + fuzzy regex; gated `win32` | Partial | remove gate; reuses mac mic + whisper deps (logic is pure JS) | M |
| Voice Live (Gemini realtime) | `ai-live.js` — WSS; mic fed by ffmpeg | Partial | socket portable; only ffmpeg mic feed → avfoundation | M |
| Vision screenshot | `server.js:capture_screen` — ffmpeg `-f gdigrab` | Partial | `screencapture -x` or ffmpeg `-f avfoundation` | S–M |
| Second-screen stream | `screen-capture.js` — `Xenon Helper.exe` GDI + `SendInput` | None | native mac helper (ScreenCaptureKit + CGEvent) | XL |
| Hardware scan (VRAM) | `ai-local.js:_readGpuVramGB` — PowerShell WMI | Partial | `system_profiler` or skip on AS (unified memory) | S |

### 3.6 System monitor / sensors / FPS / performance / window / game / guardian / PC control

| Feature | Mechanism | Feasibility | macOS approach | Effort |
|---|---|---|---|---|
| CPU load % | `os.cpus()` delta | Full | none | S |
| CPU name | `os.cpus()[0].model` | Full | `sysctl machdep.cpu.brand_string` for AS | S |
| Memory used/total/% | `os.totalmem/freemem` | Full | (optionally `vm_stat` for truer %) | S |
| RAM detail (type/speed/modules) | WMI `Win32_PhysicalMemory` | Partial | `system_profiler SPMemoryDataType` (Intel); AS = soldered, capacity only | M |
| CPU temperature | `cpu-temp.ps1` — LibreHardwareMonitor driver | Partial | `powermetrics --samplers smc` (sudo) / IOKit SMC; weak on AS | L |
| GPU load % | `gpu.ps1` — nvidia-smi / perf counter | Partial | `powermetrics --samplers gpu_power` (sudo) / private IOAccelerator | L |
| GPU temp | `gpu.ps1` | Partial | `powermetrics` (sudo) / SMC keys | L |
| GPU name / VRAM | nvidia-smi / `Win32_VideoController` | Partial | `system_profiler SPDisplaysDataType` / Metal; AS VRAM = unified | M |
| Disk free | `fs.statfs` per drive letter | Full | `statfs` works; replace letter-loop with `/Volumes` | S |
| Disk labels/FS | `Get-Volume`/`Win32_LogicalDisk` | Partial | `diskutil info -plist` / statfs fields | M |
| Network bandwidth + ping | `network.ps1` — .NET NIC stats + Ping | Partial | `netstat -ib`/`nettop` + `/sbin/ping` (delta math already in Node) | M |
| Per-process RAM/CPU | `performance.ps1` — `Get-Process` | Full | `ps -axo pid,comm,rss,%cpu` | S–M |
| High-perf power plan | `performance.ps1` — `powercfg` | None | no equivalent; expose Low Power Mode toggle instead | M |
| Process priority | `perf-priority.ps1` — `PriorityClass` | Full | `renice`/`setpriority` | S |
| Window move/snap/min/max | `deck-window.ps1` — user32 SetWindowPos | Partial | Accessibility AX (position/size/minimized) / yabai (needs permission) | M–L |
| Foreground process | `foreground.ps1` — GetForegroundWindow | Full | `NSWorkspace.frontmostApplication` / osascript | S–M |
| Fullscreen detection | `foreground.ps1` — rect vs monitor + no caption | Partial | `CGWindowListCopyWindowInfo` / AX `AXFullScreen` | M |
| Game-mode state machine | `gamedetect.js` — pure Node | Full | none (adjust name lists) | S |
| **FPS readout** | `fpsmon.js` — **PresentMon.exe** ETW | **None** | no system-wide capture; Metal HUD is per-app opt-in | **XL / drop** |
| Sensor history / alerts / screen-time | `guardian.js` — pure Node | Full | none (inherits sensor gaps) | S |
| Idle / presence | `idle.ps1` — GetLastInputInfo | Full | `ioreg -c IOHIDSystem` HIDIdleTime | S |
| Lock workstation | `rundll32 user32.dll,LockWorkStation` | Full | `CGSession -suspend` / `pmset displaysleepnow` | S |
| `run_pc_command` | `execFile('powershell', ...)` | Full | `/bin/sh -c`; consent/nonce plumbing unchanged | S |
| `runPowerShellScript` infra | `spawn('powershell.exe', ...)` | Partial | one `runCollector` seam re-targeting every `.ps1` | L |
| Open file/folder/app | `deck-actions.ps1` — Start-Process | Full | `open` / `open -a` / `open -b` | S |
| Run user script | per-ext interpreter | Full | same map minus `.bat/.cmd/.ps1`, add `.command`/`.scpt` | S |
| Hotkey send / type text | `deck-hotkey.ps1` — SendInput | Partial | CGEvent / osascript keystroke (Accessibility) | M |

### 3.7 Native shell & app infra

**Tauri Rust shell — in good macOS shape:**

| Feature | Mechanism | Feasibility | macOS approach | Effort |
|---|---|---|---|---|
| App bundle / installer | `tauri.conf.json` `targets:["nsis"]` + WebView2 bootstrapper | Full | add `dmg`/`app`; drop NSIS/WebView2 (WKWebView built-in); sign + notarize | M |
| Kiosk window | `lib.rs` WebviewWindowBuilder | Full | cross-platform APIs | S |
| Custom scheme routing | `on_navigation` hook | Partial | hook portable; guard side-effects stay cfg-gated; use `tauri://` host on mac | S |
| External-link → browser | `tauri_plugin_opener` | Full | uses `open` | S |
| System tray | `tray.rs` | Full | menubar extra works | S |
| Autostart at login | `tauri_plugin_autostart(MacosLauncher::LaunchAgent)` | Full | **already wired for mac** | S |
| Shell self-update | `tauri_plugin_updater` | Full | CI must emit + sign mac `.app.tar.gz` in `latest.json` | M |
| Single-instance | `tauri_plugin_single_instance` | Full | — | S |
| Monitor placement / watchdog | `monitor.rs` — Tauri APIs | Full | Edge panel size/name logic works | S |
| Round home-button clip | `monitor.rs clip_round()` — `CreateEllipticRgn` (win) | Partial | transparent window + CSS circle, or NSWindow cornerRadius | M |
| RDP-hide watchdog | `is_remote_session()` (win) | Partial | stub already returns false (off) | S |
| Cursor / edge / focus guards | `cursor_guard.rs` / `edge_swipe.rs` / `focus_guard.rs` — all `#[cfg(windows)]` | None | moot on mac; omit | S |
| Backend health nudge | `spawn_backend_nudge()` — `schtasks /Run` | Partial | `launchctl kickstart` of backend LaunchAgent | M |

**Backend infra — the heavy lift:**

| Feature | Mechanism | Feasibility | macOS approach | Effort |
|---|---|---|---|---|
| Backend self-update | `self-update.js` — Ed25519 verify (portable) + `Expand-Archive` + `update-apply.ps1` | Partial | swap unzip + port applier to sh/Node | L |
| Native helper auto-refresh | `helper-update.js` — Win PE `xenon-helper.exe` | None | needs mac helper binary + SHA asset | XL |
| OS notification mirror | `winnotif.js` — helper + WinRT `UserNotificationListener` | Partial→L | mac helper via `UNUserNotificationCenter`; line protocol unchanged; already no-ops off-win | L |
| Embedded browser tiles | `embedded-browser.js` — Edge + CDP, `taskkill`, PS sweeps | Partial | retarget Chrome/Edge-for-mac (CDP identical); `kill`/`pgrep` | M–L |
| Second screen (virtual display) | `second-screen.js` — winget VDD + `devcon.exe` | None | no VDD/devcon equivalent; rewrite | XL |
| Second-screen capture | `screen-capture.js` — helper GDI | None | mac helper via ScreenCaptureKit, same `XSFRM/XSCTL` protocol | L |
| Remote control (Sunshine) | `remote-control/sunshine.js` — exe + `sc.exe`/service | Partial | mac Sunshine build; `launchctl`; HTTP/pairing portable | M |
| Remote control (Tailscale) | `remote-control/tailscale.js` — exe + service | Partial | native mac Tailscale; path/service swap | S–M |
| Tool installer | `installer.js` + `runElevated` — winget + UAC RunAs | Partial | `brew` + `osascript`/`sudo` prompt | M |
| App switcher / launcher | `app-switcher.js` → `/windows*` — helper/PS enum | Partial | client ready; backend enum/focus via Accessibility / `open -a` | L |
| Deck action execution | `deck-actions.ps1` via `actions/registry.js` | Partial | PS→sh runner: `open`/`open -a`, drop UWP AUMID | M |
| Browser auto-open at logon | `setBrowserAutoOpen()` — schtasks + `.vbs` | Partial | LaunchAgent that polls `/status` then `open` URL | M |
| Legacy schtasks cleanup | `schtasks /Delete` | Partial | `launchctl remove` or drop | S |

---

## 4. What you lose on macOS (be explicit in the README)

- **FPS overlay** (PresentMon) — no system-wide frame capture exists.
- **Per-app volume mixer** — no macOS per-process volume API.
- **High-performance power plans** — reframe around Low Power Mode + per-process `nice`/kill.
- **iCUE / Razer Chroma / SignalRGB** direct control — route that gear through **OpenRGB**.
- **Second-screen virtual display** — Windows-driver bound.
- Full parity for **temperatures / GPU load** on **Apple Silicon** — no per-die temps,
  unified memory removes RAM-module / discrete-VRAM detail.

---

## 5. Recommended first step (Phase 0 PoC)

1. Remove the hard `"os": ["win32"]` gate in `package.json` (or make it advisory).
2. Add a `platform` field to the `capabilities` object the Deck editor already reads,
   and gate Windows-only actions on it — the registry + capability machinery already
   hides unavailable actions, so this degrades cleanly with no errors.
3. Boot the Node server on macOS and confirm the free tier renders: dashboard,
   Widget SDK, all data widgets, cloud AI, network RGB, streaming, Spotify/Wave Link.

That single PoC brings ~60% of Xenon to macOS before any per-feature porting begins.

---

*Generated from a full-codebase audit (7 parallel cluster passes). Each row was
derived by reading the cited source, not from assumptions. Effort estimates are
rough engineering guidance, not commitments.*
