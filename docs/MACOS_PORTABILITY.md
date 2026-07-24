# Xenon — macOS Portability Report

> **Scope.** A feature-by-feature audit of the whole Xenon codebase, assessing what
> can realistically run on **macOS** and the effort it would take. Grounded in the
> actual code (each row cites the file/function and the exact Windows mechanism),
> not guesswork.
>
> **Revised 2026-07-24.** Every row was re-verified against the code (three
> independent verification passes with file:line evidence) and against the July
> 2026 macOS platform state. This revision corrects six verdicts that were stale
> or too pessimistic, adds the v4.6–v4.10 features the original audit predated
> (§3.8), and rewrites the strategy around a seam that already exists in the code
> (`linux-collectors.js`).
>
> **TL;DR.** The core — dashboard, the Widget SDK, and everything that is
> network/browser-based — runs on macOS with only ~3 small boot gates
> (~55–60% of the app). "Light" system control is a set of targeted small swaps
> through choke points that already exist (`svvExec`, `runCollector`,
> `linux-collectors.js`). A native Swift helper (one binary, same stdio
> protocols as the .NET helper) unlocks most of the rest, including things the
> original report wrote off: per-app volume/peaks (Core Audio process taps,
> macOS 14.4+), Apple Silicon temps without sudo (IOReport), and a partial FPS
> readout (Metal HUD logging). Genuinely lost: PresentMon-parity FPS,
> high-performance power plans, and direct SignalRGB/Chroma control.

## Legend

**Feasibility**

- **Full** — already cross-platform, or a drop-in equivalent exists.
- **Partial** — works, but needs a macOS-specific implementation, a permission
  grant (Accessibility / Screen Recording / System Audio Recording), or loses
  fidelity.
- **None** — no macOS equivalent, or requires a full native rewrite.

**Effort** — S: < 1 day · M: 2–4 days · L: 1–2 weeks · XL: > 2 weeks / research /
native rewrite.

---

## 1. Verdict by tier (what to do, and the cost)

### 🟢 Free — already cross-platform (needs only the Phase 0 boot gates)
Weather · Stocks · News · Football · Calendar (ICS/Outlook/Google via published
URLs) · Claude Code usage · **Claude Code live bridge (claude-bridge/link/
statusline — verified pure Node)** · UniFi Protect · Community catalog + ratings +
limited editions + supporter redeem · Tasks/Notes/Timers/Agenda · **Widget SDK
(store, secrets, tile proxy, fetch proxy)** · Icon/sound packs ·
Themes/Pages/Ambient/Settings/Share-Import · browser-surface-sync · Cloud AI
(Claude, OpenAI incl. cloud STT/TTS, Gemini turn + Live socket, AI memory) ·
Network RGB (WLED, Hue, Nanoleaf, Govee, LIFX, Yeelight, Home Assistant,
**OpenRGB**) + the whole lighting engine · OBS control, Twitch, YouTube,
Streamer.bot · Spotify (Web API) · **Wave Link** (native mac app) · CPU load/name,
RAM, free disk · Guardian (sensor history, alerts, screen-time) · game-mode state
machine · Tauri kiosk window, tray, **autostart (already
`MacosLauncher::LaunchAgent`, lib.rs:388)**, updater plugin, single-instance,
monitor placement, external-link opener.

> Caveat the original report glossed: "free" is not literally zero code. The
> server boots and serves HTTP on macOS, but three boot-time spawns are not
> platform-gated today — `getAudioInfo()` → SoundVolumeView.exe (logged error;
> macOS falls into the Windows branch because only `linux` is special-cased at
> server.js:16), `_initSttDevice()` → ffmpeg wasapi/dshow (silent), and the
> legacy `schtasks /Delete` cleanup (silent). Phase 0 = those gates + a darwin
> branch, not "no code changes".

### 🟡 Easy — S swaps (< 1 day each)
Lock PC · `run_pc_command` · open file/app/script · master + mic volume ·
output-device switch · idle presence · process priority · TTS playback (`afplay`)
· **Discord voice (one function — `pipePath()` at discord-rpc.js:216; the
`net.connect({path})` call takes a Unix socket unchanged)** · Tailscale ·
foreground-app (S–M) · peripheral battery (S–M). The Windows-only Tauri guards
(cursor/edge/focus/RDP) are moot on mac and stay `#[cfg(windows)]`.

> Cheaper than the original report stated: master/mic/output/per-app volume all
> funnel through ONE choke point — `svvExec()` (server.js:3950), which already
> translates the same argv to `wpctl` on Linux. A macOS audio backend is one
> darwin branch in that seam, not per-call-site edits.

### 🟠 Moderate — M (2–4 days each)
True mic mute (CoreAudio) · media now-playing + transport (**via
`mediaremote-adapter` — see §3.4**) · STT mic capture (`-f avfoundation`; single
choke point `_sttInputArgs`, unblocks wake word too) · vision screenshot · Ollama
install/detect/autostart/VRAM · **the `darwin-collectors.js` twin of
`linux-collectors.js` (network/disk/per-process/foreground/idle — the seam
already exists, see §2)** · **CPU/GPU temps + GPU load on Apple Silicon (sudoless
via IOReport/SMC — see §3.6)** · embedded browser (retarget Chromium) · Deck
action dispatcher · logon auto-open (LaunchAgent) · Sunshine · tool installer
(winget→brew) · **Disk widget scan + Trash-backed cleanup** · **Spotlight popup
window + global hotkey** · **Tauri macOS bundle + notarization (plus a required
compile fix, see §3.7)**.

### 🔴 Hard — L (1–2 weeks each)
Window management + hotkey/type injection (Accessibility) · local Whisper.cpp
(Metal build + darwin installer branch) · backend self-update (extraction AND
applier are PowerShell today) · file search (mdfind/NSMetadataQuery re-plumb;
ranking is already pure JS) · Living Index host (FSEvents).

### 🟣 The Swift helper — XL, one project, many unlocks
A single mac helper binary (Swift), speaking the same stdio protocols as
`xenon-helper.exe`, unlocks: OS notification mirroring (UNUserNotificationCenter)
· second-screen capture (ScreenCaptureKit) · **per-app volume mixer AND per-app
peak meters (Core Audio process taps, macOS 14.4+ — no driver, no kext; prior
art: VolumeHub, SoundDial, Fader)** · global hotkey (RegisterEventHotKey) ·
app-switcher window enumeration (Accessibility) · Living Index (FSEvents) ·
Trash-backed deletion. The single biggest lift, and the highest-value one.

### ⛔ Lost or deferred
- **FPS (PresentMon parity)** — no system-wide frame capture on macOS. A
  *partial* readout exists (§3.6): Metal HUD logging covers Metal games only.
- **High-performance power plans** — don't exist on macOS (only inverse Low
  Power Mode). **Reframe.**
- **SignalRGB / Razer Chroma** — Windows-only local exe/SDK server. Already
  degrade to clean no-ops.
- **iCUE direct SDK** — nuanced, see §3.2: iCUE for macOS exists (device
  subset), CUE SDK v3 shipped mac builds; verify the v4 dylib before writing
  this off. OpenRGB remains the recommended route, with its own mac coverage
  caveat.
- **Second screen (virtual display)** — no supported API, but feasible via the
  private `CGVirtualDisplay` API (prior art: BetterDisplay, DeskPad,
  FreeDisplay; notarized direct distribution is accepted). XL, deferred, no
  longer "impossible".

---

## 2. Effort roll-up & phased plan

| Phase | What | Result | Effort | Status |
|---|---|---|---|---|
| **0** | Gate the 3 ungated boot spawns; drop the advisory `os: win32` field; add `capabilities.platform` (real work — see lever 2 caveat); verify `npm install` on mac (koffi ships darwin prebuilds and is lazy-loaded) | ~60% of the app live on mac (dashboard, SDK, all data widgets, cloud AI, network RGB, streaming, Spotify/Wave Link, Claude bridge) | days | **done** |
| **1** | `darwin-collectors.js` (twin of `linux-collectors.js`) + S/M swaps: audio via the `svvExec` seam, disks `/Volumes`, foreground/idle, lock, priority, Deck dispatch, Discord socket, media via mediaremote-adapter, `_playWavFile` → afplay | "Light" system control | 1–2 weeks | **done** |
| **2** | Tauri macOS target (fix the monitor.rs compile break, add dmg/app bundle, new CI job + Apple signing/notarization + multi-platform latest.json) + LaunchAgent install story + Ollama/Whisper-Metal + STT/wake/vision (avfoundation) + self-update extract/applier port | Installable native mac app, local voice, self-updating | weeks | **done**, except: signing/notarization is wired but OFF (no Apple certificate yet), and the wake word waits on Whisper being installed |
| **3** | Native Swift helper (one binary, same stdio protocols) | Notifications, second-screen capture, per-app mixer + peaks, global hotkey, app switcher, Living Index, Trash cleanup | XL | open |
| **deferred / lost** | PresentMon-parity FPS, power plans, SignalRGB/Chroma; virtual display (XL via private CGVirtualDisplay) | — | — | open |

**What Phase 2 actually shipped** (`macos-port` branch): `tauri.macos.conf.json`
(app+dmg, universal binary), a `native-macos` CI job whose `platforms-macos.json`
fragment publish merges into a multi-platform `latest.json`,
`server/install.sh` + `uninstall.sh` (per-user LaunchAgent),
`apps/native/src-tauri/macos/xenon-bootstrap.sh` (first-launch backend install,
Ed25519-verified before extraction), `server/update-apply.sh`, and the macOS
branches of `ai-local.js`. Apple signing is opt-in and currently inert: the
workflow exports the variables only when the secrets exist, because Tauri reads
an EMPTY `APPLE_CERTIFICATE` as "sign with this" and fails on the empty `.p12`.

**Now-playing** closed the last Phase 1 gap. `server/darwin-media.js` holds one
`mediaremote-adapter` stream child and answers the same `info` / `playpause` /
`next` / `previous` requests the SMTC hosts do, in the same shape and the same
units — so `js/media.js` needed no change. The adapter (BSD-3-Clause) is not in
this repository: the release workflow builds it from a pinned commit and
`install.sh` downloads it into the gitignored `server/mediaremote/`, exactly the
arrangement `xenon-helper.exe` already has. Its absence is a supported state —
the tile shows "nothing playing" and nothing is spawned or retried — which is
why the workflow step is `continue-on-error` and why the Deck's media keys are
gated on a `media` capability rather than on the OS.

**First-install integrity applies here too.** The adapter is fetched over HTTPS
from our own release with TLS-only trust, like the helper exe and for the same
reason: a fresh install has no pinned key to anchor to. The signed path the
updater and the app bootstrap use is untouched.

**Not yet verified on real hardware.** Everything above is written against each
tool's documented behaviour and unit-tested where it is pure; nothing in the
macOS path has been run on a Mac. The adapter build in CI has never executed
either — it runs for the first time on the next tag push.

**Bottom line:** ~60% free immediately, ~30% more with Phase 1–3 work, and only
~5–8% genuinely lost — the original report's "~15% lost" included per-app audio,
Apple Silicon temps, FPS and the virtual display, all of which have real macOS
paths in 2026.

The architectural levers that make this cheap already exist — one more than the
original report counted:

1. **The core runs cross-platform.** The Node HTTP server + dashboard + Widget
   SDK are pure Node/JS.
2. **Actions self-disable.** The deck registry does
   `if (typeof d.X !== 'function') return { error: 'unavailable' }`, and the
   `capabilities` object hides unavailable actions from the editor. *Caveat:*
   today capabilities only hide **integration** actions (OBS, Twitch, Discord,
   Spotify, HA, lighting…). The system actions (hotkey, typeText, windowMove,
   lock, volume, media) are **not** hidden by any platform flag — on mac they
   would appear in the editor and fail at runtime. `capabilities.platform` is
   real Phase 0 work, not machinery that already exists.
3. **The multi-platform seam is already shipped.** `runCollector`
   (server.js:1876) is the dispatch layer, and `linux-collectors.js` (v4.7,
   experimental Linux collectors) is a working non-Windows implementation with
   branches already wired for disks (server.js:3447), the windows tool
   (server.js:1705) and audio (`svvExec`, server.js:3950 → wpctl). macOS is a
   `darwin-collectors.js` twin, not a new abstraction. The original report
   costed this seam as future L-effort work; it exists.

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
| Claude Code usage | `claude-usage.js` → `~/.claude/projects/**/*.jsonl` via `os.homedir()`; honours `CLAUDE_CONFIG_DIR` | Full | **none — no hardcoded `%USERPROFILE%`** (claude-usage.js:124) | S |
| Claude Code live bridge | `claude-bridge.js` / `claude-link.js` / `claude-statusline.js` — pure Node; statusline spawns the user's own command via the platform shell | Full | none | S |
| UniFi Protect | `unifi-events.js` — `ws` + `zlib` | Full | none | S |
| Community catalog / ratings / limited / redeem | `community-*.js`, `supporter-redeem.js` — `https` | Full | none | S |
| Widget SDK (validate/assets) | `sdk-widgets.js` — `fs`+`path`, `path.sep`/`normalize` guard (sdk-widgets.js:673 — per-platform `path.sep`, correct on both) | Full | none | S |
| Widget SDK (store/secrets) | `sdk-store.js` — pure logic | Full | none | S |
| Widget SDK (fetch proxy) | `sdk-proxy.js` — `http`/`https`/`dns`/`net`, SSRF guard | Full | none | S |
| Icon / sound packs | `icon-packs.js` / `sound-packs.js` — fs/path/validation only | Full | none | S |
| Briefing / greeting | `briefing.js` — passive engine fed by SSE | Full | none | S |
| Tasks / Notes / Timers / Agenda | JSON persistence (`atomic-write.js` — the win-only rename retry is a harmless no-op on POSIX) + DOM | Full | none | S |
| Themes / Pages / Ambient / Settings / Share-Import | Browser-only + JSON | Full | none | S–M |
| Second-screen sync planner | `browser-surface-sync.js` — side-effect-free planner | Full | none | S |

*Confirmed via three-pass verification: zero `.exe`/`.ps1`/`%USERPROFILE%`/`child_process` in any of these modules.*

### 3.2 RGB lighting

**Network / loopback-TCP providers — already cross-platform:**

| Provider | Mechanism | Feasibility | Effort |
|---|---|---|---|
| **OpenRGB** | `lighting-providers/openrgb.js` — `net` TCP `:6742` binary protocol | Full — mac build exists, **but** mac OpenRGB coverage is itself limited (mostly USB-HID devices; SMBus/RAM access is restricted). Primary local sink on mac, with expectations set | None–S |
| WLED | `wled.js` — `fetch` JSON | Full | None |
| Philips Hue | `hue.js` — `fetch` CLIP v2/v1 | Full | None |
| Nanoleaf | `nanoleaf.js` — `fetch` `:16021` | Full | None |
| Govee | `govee.js` — `dgram` UDP | Full | None |
| LIFX | `lifx.js` — `dgram` UDP `:56700` | Full | None |
| Yeelight | `yeelight.js` — `dgram` SSDP + `net` `:55443` | Full | None |
| Home Assistant | `lighting-providers/homeassistant.js` — HTTP/WS runtime hooks | Full | None |
| Engine (effects/discovery) | `lighting.js`, `lighting-effects.js`, `lighting-discovery.js` | Full | None |

**Windows-native local sinks — degrade to no-ops on mac:**

| Provider | Mechanism | Feasibility | macOS note | Effort |
|---|---|---|---|---|
| **iCUE (Corsair)** | `lighting.js` — koffi FFI loads `iCUESDK.x64_2019.dll`, talks to iCUE service. koffi is **lazy-required inside the connect path** (lighting.js:167) behind a `C:\Program Files\…` path probe, so mac never loads it → clean degrade, no crash. koffi ships darwin prebuilds, so `npm install` succeeds | **Partial (verify)** | The original claim "no mac iCUE service" is imprecise: **iCUE for macOS exists** (reduced device set — peripherals, not e.g. LINK hubs), and CUE SDK v3 shipped macOS builds incl. Apple Silicon. Whether the iCUE SDK v4 dylib ships for mac needs a direct check before writing this off. Recommended route stays OpenRGB for full coverage | S (verify + stub) / M (dylib bridge if v4 ships one) |
| **Razer Chroma** | `actions/chroma.js` — HTTP to local SDK server `127.0.0.1:54235` (provider shim is a runtime-injected no-op) | None | No `:54235` server on mac; already no-ops | S (already degrades) |
| **SignalRGB** | `signalrgb.js` — `execFile SignalRgbLauncher.exe`; self-guards: no `LOCALAPPDATA` → `launcherPath()` returns `''` → hidden (signalrgb.js:34-43) | None | Windows-only launcher; already degrades | S (already degrades) |

### 3.3 Streaming & comms

| Feature | Mechanism | Feasibility | macOS work | Effort |
|---|---|---|---|---|
| OBS control | `actions/obs.js` — OBS WebSocket v5 | Full | none | S |
| OBS auto-launch | `actions/obs-launch.js` — `obs64.exe` + registry probe (`readObsInstallDir()` in server.js:4431, PowerShell `HKLM:\SOFTWARE\OBS Studio`) | Partial | `/Applications/OBS.app` + `open -a OBS`; drop registry probe | M |
| Twitch | `stream-twitch.js` — OAuth device flow + Helix REST | Full | none | S |
| YouTube | `stream-youtube.js` — OAuth device flow + Data API v3 | Full | none | S |
| **Discord voice** | `discord-rpc.js` — local RPC over named pipe `\\?\pipe\discord-ipc-N` | Partial | **one function**: `pipePath()` (discord-rpc.js:216) → Unix socket `discord-ipc-N` under `$TMPDIR`/`/tmp`; the consumer is `net.connect({ path })` (…:241), which accepts a socket path unchanged | S |
| Streamer.bot | `actions/streamerbot.js` — WebSocket | Full | none | S |

### 3.4 Audio / mic / media / Spotify / Wave Link

> All SoundVolumeView calls funnel through `svvExec()` (server.js:3950) — the
> one place that knows SVV is Windows-only, already branching to `wpctl` on
> Linux. SVV itself is **bundled in the repo** (`server/soundvolumeview-x64/`),
> a fact the original report omitted. A macOS backend = one darwin branch here.

| Feature | Mechanism | Feasibility | macOS approach | Effort |
|---|---|---|---|---|
| Master volume | SVV `/SetVolume` via `svvExec` | Full | `osascript -e 'set volume output volume N'` in the seam | S |
| Output device switch | SVV `/SetDefault ... all` + `/scomma` CSV | Full | `SwitchAudioSource` (brew) / CoreAudio | M |
| Mic mute / device | SVV `/Mute` on `cachedMicId` | Partial | input volume via osascript; **true mute needs CoreAudio** `kAudioDevicePropertyMute` | M |
| **Per-app volume mixer** | SVV per-process (`appVolume`/`appMute`) | **Partial — no longer "lost"** | **Core Audio process taps (macOS 14.4+, `CATapDescription` / `AudioHardwareCreateProcessTap`)** — per-app gain with no driver/kext, gated on the "System Audio Recording" permission. Prior art: VolumeHub, SoundDial, Fader. Lives in the Swift helper (Phase 3) | M–L (in helper) |
| **Per-app peak meters** *(v4.9 — missing from the original audit)* | `audio-levels.js` + `helper/AudioHost.cs` (`IAudioMeterInformation` COM); win32-gated (audio-levels.js:48), no PS fallback by design | **Partial** | Same Core Audio process-tap API as the mixer — compute peaks from the tapped buffers in the Swift helper | M (in helper) |
| Media now-playing | `media.ps1` (SMTC/WinRT) with helper `MediaHost.cs` preferred (server.js:1945 — helper exe if present, else `powershell -File media.ps1 -Serve`) | Partial | **MediaRemote is entitlement-blocked since macOS 15.4** — plain nowplaying-cli is dead. The proven route is **`ungive/mediaremote-adapter`** (loads MediaRemote via an entitled Apple binary; works on macOS 15 and 26, no SIP change). Private-API maintenance risk, isolate behind the media-host seam | M |
| Media transport | same hosts, play/pause/next/prev | Partial | same mediaremote-adapter route (same risk) | M |
| Spotify control | `stream-spotify.js` — Spotify Web API (HTTPS/OAuth PKCE) | Full | none | S |
| Elgato Wave Link | `actions/wavelink.js` — local JSON-RPC WebSocket `:1824–1834` | Full | native mac Wave Link app, same WS | S |

### 3.5 AI & voice

> ffmpeg is **not bundled**: `getFfmpegPath()` (server.js:6269) resolves
> `$XEH_FFMPEG` → local exe paths → winget cache → PATH. The env override is the
> clean mac seam (brew ffmpeg). The original report didn't state provenance.

| Feature | Mechanism | Feasibility | macOS approach | Effort |
|---|---|---|---|---|
| Claude / OpenAI / Gemini (cloud) | `ai-anthropic.js`/`ai-openai.js` + Gemini in `server.js` — HTTPS | Full | none | S |
| AI memory | `ai-memory.js` — `fs` + atomic write | Full | none | S |
| Ollama (local LLM) | `ai-local.js` — HTTP `:11434`; `findOllamaExe` (ai-local.js:683, `%LOCALAPPDATA%`/`%ProgramFiles%`), autostart via `reg.exe` HKCU Run (…:716), all ungated but self-degrading | Partial | chat works as-is; detect via `/Applications` + `which`, autostart via LaunchAgent, VRAM via `system_profiler` (or skip on AS — unified memory) | M |
| Local STT (Whisper.cpp) | `ai-local.js` — looks only for `whisper-cli.exe` (…:578); `installWhisper` (…:1044) hard-selects the win-x64 zip and unzips via PowerShell (`_unzipWindows` …:1005) | Partial | mac whisper.cpp (Metal) binary + darwin asset branch + non-PS unzip | L |
| Mic capture | `server.js:_sttInputArgs` (…:8702) — ffmpeg `-f wasapi`/`-f dshow`. Verified single choke point: feeds the STT recorder AND the wake word (injected `getInputArgs`) | Partial | ffmpeg `-f avfoundation`; one function swap unblocks both | M |
| TTS synthesis | `ai-local.js` — `msedge-tts` (cloud, pure JS) + ffmpeg | Full | none (or `say`) | S |
| TTS playback | `server.js:_playWavFile` (…:5210) — PowerShell `SoundPlayer`. **Ducking rides SVV too**: `_duckSpeakerVolume`/`_restoreSpeakerVolume` (…:5102-5118) call `svvExec /SetVolume` — a second Windows dep the original report missed | Partial | `afplay <wav>`; ducking lands in the same `svvExec` darwin branch as the rest of audio | S–M |
| Wake word "Hey Xenon" | `wakeword.js` — home-grown VAD + Whisper + fuzzy regex; the win32 gate is one line (wakeword.js:295), everything else is pure JS on injected deps | Partial | remove the gate; reuses the mac mic + whisper deps | M |
| Voice Live (Gemini realtime) | `ai-live.js` — WSS, spawns nothing itself; the ffmpeg mic feed lives in server.js | Partial | socket portable; only the mic feed → avfoundation | M |
| Vision screenshot | `server.js:capture_screen` (…:5081, 13336) — ffmpeg `-f gdigrab` | Partial | `screencapture -x` or ffmpeg `-f avfoundation` | S–M |
| Second-screen stream | `screen-capture.js` — helper `screen-serve` (GDI + SendInput), `XSFRM`/`XSCTL` stdio protocol | None today | Swift helper: ScreenCaptureKit + CGEvent, same protocol | XL (helper) |
| Hardware scan (VRAM) | `ai-local.js:_readGpuVramGB` (…:136) — PowerShell registry/WMI; fails safe to 0 off-Windows | Partial | `system_profiler` or skip on AS | S |

### 3.6 System monitor / sensors / FPS / performance / window / game / guardian / PC control

> The System widget is a hybrid: CPU load/name and memory come from pure Node
> (`os.cpus()` delta, `os.totalmem/freemem` — portable as-is); temps, GPU and
> network come from `cpu-temp.ps1` / `gpu.ps1` / `network.ps1` hosted in the
> persistent `pwsh-worker.ps1`, dispatched through `runCollector`
> (server.js:1876). `linux-collectors.js` already implements the non-Windows
> side of this seam; macOS is a twin module, not new architecture.

| Feature | Mechanism | Feasibility | macOS approach | Effort |
|---|---|---|---|---|
| CPU load % | `os.cpus()` delta (server.js:2094) | Full | none | S |
| CPU name | `os.cpus()[0].model` | Full | `sysctl machdep.cpu.brand_string` for AS niceties | S |
| Memory used/total/% | `os.totalmem/freemem` (server.js:3554) | Full | (optionally `vm_stat` for truer %) | S |
| RAM detail (type/speed/modules) | inline PS WMI `Win32_PhysicalMemory` (server.js:3491, ungated but fails safe) | Partial | `system_profiler SPMemoryDataType` (Intel); AS = soldered, capacity only | M |
| CPU temperature | `cpu-temp.ps1` — LibreHardwareMonitor driver (elevation via `enable-sensors.ps1`, also missing from the original audit) | **Partial — better than reported** | **Sudoless on Apple Silicon**: IOReport (private API) + SMC via IOKit — prior art macmon, mactop, Stats all read CPU/GPU temps and power without root. Intel macs: SMC keys. No per-die detail | **M** (was L) |
| GPU load % | `gpu.ps1` — nvidia-smi / perf counter | **Partial** | same IOReport route (GPU residency/power); prior art as above | **M** (was L) |
| GPU temp | `gpu.ps1` | **Partial** | same | **M** (was L) |
| GPU name / VRAM | nvidia-smi / `Win32_VideoController` | Partial | `system_profiler SPDisplaysDataType` / Metal; AS VRAM = unified | M |
| Disk free | `fs.statfs` per drive letter (server.js:3463) — **already has a Linux branch** (…:3447 `linuxCollectors.disks()`) | Full | darwin branch: scan `/Volumes` (statfs itself works) | S |
| Disk labels/FS | `Get-Volume`/`Win32_LogicalDisk` | Partial | `diskutil info -plist` / statfs fields | M |
| Network bandwidth + ping | `network.ps1` — .NET NIC stats + Ping | Partial | `netstat -ib`/`nettop` + `/sbin/ping` (delta math already in Node) | M |
| Per-process RAM/CPU | `performance.ps1` `stats` — `Get-Process` deltas | Full | `ps -axo pid,comm,rss,%cpu` | S–M |
| High-perf power plan | `performance.ps1` — `powercfg` GUIDs | None | no equivalent; expose Low Power Mode toggle instead | M |
| Process priority | `perf-priority.ps1` — `PriorityClass` | Full | `renice`/`setpriority` | S |
| Window move/snap/min/max | `deck-window.ps1` — user32 SetWindowPos | Partial | Accessibility AX (position/size/minimized) — needs permission | M–L |
| Foreground process | `foreground.ps1` / helper `foreground-serve` (gamedetect.js:161 spawns one or the other, win32-gated) | Full | `NSWorkspace.frontmostApplication` / osascript | S–M |
| Fullscreen detection | `foreground.ps1` — rect vs monitor + no caption | Partial | `CGWindowListCopyWindowInfo` / AX `AXFullScreen` | M |
| Game-mode state machine | `gamedetect.js` — matcher/state machine is pure Node; only the probe is Windows | Full | swap the probe; adjust name lists | S |
| **FPS readout** | `fpsmon.js` — **PresentMon.exe** ETW, session `XenonFps` | **Partial — no longer flatly "lost"** | No PresentMon parity. But the **Metal Performance HUD has a logging mode** that writes parsable frame data to the unified log (`metal-HUD: frame,misses,mem,present-interval,gpu-time,…`), enableable system-wide via launchctl env; read with `log stream --predicate`. Covers **Metal games only**. macOS 26 also ships a native Game Overlay (on-screen, not readable) | M–L (Metal-only reader) / parity: None |
| Sensor history / alerts / screen-time | `guardian.js` — pure Node | Full | none (inherits sensor gaps) | S |
| Idle / presence | `idle.ps1` — GetLastInputInfo (pwsh-worker hosted) | Full | `ioreg -c IOHIDSystem` HIDIdleTime | S |
| Lock workstation | `rundll32 user32.dll,LockWorkStation` (server.js:4544) | Full | `CGSession -suspend` / `pmset displaysleepnow` | S |
| `run_pc_command` | `execFile('powershell', ...)` (server.js:10990) | Full | `/bin/sh -c`; consent/nonce plumbing unchanged | S |
| Collector infra | `runCollector` + `pwsh-worker.ps1` — **the seam exists and has a shipped Linux implementation** | Partial | `darwin-collectors.js` twin of `linux-collectors.js` | **M** (was L) |
| Open file/folder/app | `deck-actions.ps1` — Start-Process (spawned from server.js:737/4571/4577, on-demand) | Full | `open` / `open -a` / `open -b` | S |
| Run user script | per-ext interpreter | Full | same map minus `.bat/.cmd/.ps1`, add `.command`/`.scpt` | S |
| Hotkey send / type text | `deck-hotkey.ps1` — SendInput | Partial | CGEvent / osascript keystroke (Accessibility) | M |
| Peripheral battery *(v4.6 — missing from the original audit)* | `battery.js` → `battery.ps1` (`Win32_PnPEntity`/`Win32_Battery`, Bluetooth DEVPKEY GUIDs); degrades to `available:false` | Partial | `system_profiler SPBluetoothDataType` / IOBluetooth + `pmset -g batt` for the laptop pack | S–M |
| Bit vitals nag popup *(missing from the original audit)* | `vitals-nag.ps1` — WinForms TopMost no-activate popup | Partial | NSPanel in the helper, or drop (dashboard-side nag still works) | M / cut |

### 3.7 Native shell & app infra

**Tauri Rust shell — good shape, with one real blocker:**

> ⚠️ **The crate does not compile for macOS today.** `monitor.rs:120` calls
> `crate::gpu::virtual_display_names()` and `monitor.rs:640` calls
> `crate::focus_guard::game_mode()` — both modules are declared
> `#[cfg(windows)]` (lib.rs:3-10), the call sites are not gated. First task of
> any mac build: cfg-gate or stub those two calls. Cargo dependencies are
> otherwise all cross-platform (no Windows-only crates; Win32 access is raw
> cfg-gated FFI).

| Feature | Mechanism | Feasibility | macOS approach | Effort |
|---|---|---|---|---|
| App bundle / installer | `tauri.conf.json` `targets:["nsis"]` + WebView2 bootstrapper; `resources` ships `windows/xenon-bootstrap.ps1` | Full | add `dmg`/`app` target; drop NSIS/WebView2 (WKWebView built-in); exclude the PS resource; sign + notarize | M |
| Kiosk window | `lib.rs` WebviewWindowBuilder (the one win-only arg is cfg-gated) | Full | cross-platform APIs | S |
| Custom scheme routing | `on_navigation` hook; side-effect guards cfg-gated | Partial | hook portable once the monitor.rs break is fixed | S |
| External-link → browser | `tauri_plugin_opener` | Full | uses `open` | S |
| System tray | `tray.rs` (win-only menu items already cfg-gated) | Full | menubar extra works | S |
| Autostart at login | `tauri_plugin_autostart(MacosLauncher::LaunchAgent)` (lib.rs:388) | Full | **already wired for mac** | S |
| Shell self-update | `tauri_plugin_updater` wired (lib.rs:116-245, minisign key in tauri.conf.json) | Partial | **today CI is Windows-only**: release.yml builds on windows-latest and writes `latest.json` with a single `windows-x86_64` key; there is no Apple codesign/notarize step and no mac artifact anywhere. The mac path is a whole new CI job + Apple secrets, not just "emit one more file" | M–L |
| Single-instance | `tauri_plugin_single_instance` | Full | — | S |
| Monitor placement / watchdog | `monitor.rs` — Tauri APIs (portable) **after** the compile fix above | Full | Edge panel size/name logic works | S |
| Round home-button clip | `monitor.rs clip_round()` — `CreateEllipticRgn`, already `#[cfg(windows)]` | Partial | transparent window + CSS circle, or NSWindow cornerRadius | M |
| RDP-hide watchdog | `is_remote_session()` — `#[cfg(not(windows))]` stub returns false | Partial | stub already correct (off) | S |
| Cursor / edge / focus guards / gpu pinning | `cursor_guard.rs` / `edge_swipe.rs` / `focus_guard.rs` / `gpu.rs` — all `#[cfg(windows)]` | None | moot on mac; omit (but see the compile break note) | S |
| Backend health nudge | `spawn_backend_nudge()` — `schtasks /Run`, `#[cfg(windows)]` | Partial | `launchctl kickstart` of a backend LaunchAgent | M |

**Backend infra — the heavy lift:**

| Feature | Mechanism | Feasibility | macOS approach | Effort |
|---|---|---|---|---|
| Backend self-update | `self-update.js` — Ed25519 verify is pure Node (portable). **But there is no platform gate in the file**: `prepare()` extracts via `spawn('powershell', Expand-Archive)` (self-update.js:139) and `apply()` spawns `update-apply.ps1` from an absolute System32 path (…:91, :273). Extraction AND applier are Windows-bound | Partial | Node unzip (or `ditto`) + a sh/Node port of the applier, keeping all three apply guarantees | L |
| Native helper auto-refresh | `helper-update.js` — Win PE `xenon-helper.exe` + SHA asset | None today | mac helper binary + its own hashed release asset | XL (with helper) |
| OS notification mirror | `winnotif.js` — helper + WinRT `UserNotificationListener` (PS twin: `notifications.ps1`); genuinely win32-gated (winnotif.js:125, 189) | Partial | Swift helper via UNUserNotificationCenter; line protocol unchanged | L (in helper) |
| Embedded browser tiles | `embedded-browser.js` — `findEdge()` scans ProgramFiles; CDP; teardown via `taskkill`; `available()` self-disables when no Edge | Partial | retarget Chrome/Edge-for-mac paths (CDP identical); `kill`/`pgrep` | M–L |
| Second screen (virtual display) | `second-screen.js` — winget VDD + `devcon.exe` | **None today — feasible, deferred** | The Windows VDD/devcon route has no mac equivalent, but virtual displays are creatable via the **private `CGVirtualDisplay` API** (prior art: BetterDisplay, DeskPad, FreeDisplay; notarized direct distribution accepted) + ScreenCaptureKit capture | XL (deferred) |
| Second-screen capture | `screen-capture.js` — helper GDI, `XSFRM`/`XSCTL` | None today | Swift helper via ScreenCaptureKit, same protocol | L (in helper) |
| Remote control (Sunshine) | `remote-control/sunshine.js` — absolute `C:\Program Files\Sunshine\sunshine.exe` + elevated Restart-Service | Partial | mac Sunshine builds exist and are active in 2026 (VideoToolbox encoding; the mac-focused fork Lumen is also an option); `launchctl`; HTTP/pairing portable | M |
| Remote control (Tailscale) | `remote-control/tailscale.js` — absolute exe path + service | Partial | native mac Tailscale; path/service swap | S–M |
| Tool installer | `remote-control/installer.js` + `runElevated` (`Start-Process -Verb RunAs`, runner.js:35) — winget | Partial | `brew` + `osascript` admin prompt | M |
| App switcher / launcher | `/windows*` endpoints → helper `WindowsTool.cs` / `windows.ps1` — **already Linux-branched** (server.js:1705) | Partial | darwin branch: Accessibility enumeration in the helper / `open -a` | L (in helper) |
| Deck action execution | `deck-actions.ps1` via `actions/registry.js` validation | Partial | sh runner: `open`/`open -a`, drop UWP AUMID | M |
| Browser auto-open at logon | `setBrowserAutoOpen()` — schtasks + `.vbs`, gated `AUTO_OPEN_SUPPORTED = win32` (server.js:1735) | Partial | LaunchAgent that polls `/status` then `open` URL | M |
| Legacy schtasks cleanup | boot-time `schtasks /Delete` (server.js:16019, error-swallowed) | Partial | gate on win32 (Phase 0) | S |
| npm / package gate | `package.json:26` `"os":["win32"]` — **advisory for the root project**: npm enforces `os` on installed dependencies, not on the repo you run `npm install` in. koffi (lazy), msedge-tts and ws all install on darwin | Full | remove the field as cleanup; not the blocker the original report implied | S |

### 3.8 Features missing from the original audit (v4.6–v4.10)

The original report predates v4.9/v4.10 (and skipped one v4.6 widget). Verified
rows, several already folded into the tables above:

| Feature | Windows mechanism | Feasibility | macOS approach | Effort |
|---|---|---|---|---|
| **File search (Spotlight popup backend)** | `filesearch.js` + `search.ps1` — ADODB on the Windows Search `SystemIndex` (search.ps1:40); `search-query.js`/`search-rank.js` are pure, unit-tested JS | Partial | `mdfind` / `NSMetadataQuery` (live Spotlight index, no elevation); re-plumb the query host, **reuse the parser + ranker as-is** | M–L |
| **Living Index** | `living-index.js` spawns helper `index-serve` (living-index.js:70); `helper/IndexHost.cs` = walk + FileSystemWatchers | Partial | FSEvents-backed index host in the Swift helper (same advisory-cache invariant), or lean on mdfind and skip the RAM index | L (in helper) |
| **Disk widget + guarded cleanup** | `diskspace.js` orchestrates helper `disk-scan` + `shell-delete` (`ShellDelete.cs:24` `FOF_ALLOWUNDO` → Recycle Bin); `disk-categories.js`/`disk-guard.js` are pure JS | Partial | scan is portable logic; **undo-able delete = `NSFileManager.trashItemAtURL`** (Trash, restorable); remap categories/guard prefixes to mac paths (`~/Library/Caches`, `/private/var/folders`, protect `~/Documents` etc.) | M (+ helper for Trash) |
| **Spotlight popup window + hotkey** | `openSpotlightPopupWindow` (server.js:768) spawns a **hard-coded** `C:\Program Files (x86)\...\msedge.exe --app=` + `deck-popup-top.ps1` raise; global hotkey = helper `RegisterHotKey` loop | Partial | window via `open -a` app-mode Chromium (or a WKWebView panel in the helper); hotkey via `RegisterEventHotKey` in the helper | M |
| **Per-app audio peaks** (v4.9) | `audio-levels.js` + `helper/AudioHost.cs` | Partial | Core Audio process taps — see §3.4 | M (in helper) |
| **Peripheral battery** (v4.6) | `battery.js` + `battery.ps1` | Partial | see §3.6 | S–M |
| **Claude Code live bridge** (v4.8) | `claude-bridge.js` / `claude-link.js` / `claude-statusline.js` | **Full** | none — verified pure Node (statusline `spawn(..., {shell:true})` is portable) | S |
| Windows notif mirror PS twin | `notifications.ps1` (WinRT listener, fallback when the helper is absent) | None | covered by the helper notification row (§3.7); no PS twin on mac | — |
| iCUE window sharpen | `icue-sharpen.ps1` (Qt DPI fix for iCUE.exe) | None | moot on mac | — |
| Sensor elevation | `enable-sensors.ps1` (elevates the startup task so LHM's driver loads) | None | moot — the mac temp route (IOReport/SMC) needs no elevation | — |

---

## 4. What you lose on macOS (be explicit in the README)

Shorter list than the original report — per-app audio, Apple Silicon temps, a
partial FPS readout and (eventually) the virtual display all have real 2026
paths:

- **FPS parity with PresentMon** — no system-wide frame capture exists. The
  Metal HUD log reader covers Metal games only, and needs the HUD enabled.
- **High-performance power plans** — reframe around Low Power Mode + per-process
  `nice`/kill.
- **SignalRGB / Razer Chroma** direct control — Windows-only local software.
- **iCUE SDK** — likely reduced or absent (verify the v4 mac dylib); route
  Corsair gear through OpenRGB, with reduced mac device coverage.
- Full parity for **RAM-module detail / discrete VRAM** on Apple Silicon —
  unified memory removes the concept.
- **Second-screen virtual display** — deferred (private-API route exists but is
  XL and maintenance-risky).

---

## 5. Recommended first step (Phase 0 PoC)

1. Gate the three ungated boot spawns for darwin: `getAudioInfo()`/`svvExec`
   (today macOS falls into the Windows branch — only `linux` is special-cased
   at server.js:16), `_initSttDevice()` (ffmpeg wasapi probe), and the legacy
   `schtasks /Delete` cleanup.
2. Remove the advisory `"os": ["win32"]` field from `package.json` (cleanup —
   verified non-blocking for in-repo `npm install`).
3. Add a `platform` capability and gate the **system** Deck actions on it
   (hotkey, typeText, windowMove, lock, volume, media). This is real work: the
   registry's `unavailable` degradation exists, but today only *integration*
   actions are hidden from the editor.
4. `npm install` + boot the Node server on macOS and confirm the free tier
   renders: dashboard, Widget SDK, all data widgets, cloud AI, network RGB,
   streaming, Spotify/Wave Link, Claude bridge.

Then Phase 1 is a `darwin-collectors.js` twin of `linux-collectors.js` — the
seam (`runCollector`, `svvExec`, the disks/windows branches) is already in the
code and already has a shipped non-Windows implementation to copy from.

---

*Original report generated from a full-codebase audit (7 parallel cluster
passes). Revised 2026-07-24: every row re-verified against the code (3
independent passes, file:line evidence) and against the July 2026 macOS
platform state (Core Audio process taps, mediaremote-adapter, IOReport tooling,
Metal HUD logging, CGVirtualDisplay prior art, Sunshine/OpenRGB mac status).
Effort estimates are rough engineering guidance, not commitments.*
