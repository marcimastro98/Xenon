# Changelog

All notable changes to XenonEdge Hub are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [v2.1.0] - 2026-06-01
### ✨ New Features
- **Per-app Audio Mixer (speaker)**: a compact App Mixer section now appears directly below the master volume slider whenever any application is producing audio. Each active app (Spotify, Discord, Chrome/YouTube, iCUE, etc.) gets its own row showing the real app icon extracted from its executable, a name resolved to a friendly label (same logic as the App Switcher), a horizontal volume slider, a percentage readout, and an individual mute toggle. Slide any row to change only that app's volume independently of the master. The section hides automatically when no apps are producing audio, so the panel stays clean.
- **Per-app Mic Mixer**: the same concept is applied to the microphone panel. When an application is actively capturing audio (e.g. Discord in a voice channel, Teams, OBS), a dedicated section appears below the master sensitivity controls, with per-app volume and mute. The section is invisible when no app is using the mic — typical during normal use — and appears the moment a voice call starts.
- **App icons in the mixer**: icons are extracted directly from the running executable via `Icon.ExtractAssociatedIcon`, the same method used by the App Switcher. Results are cached in memory so extraction only happens once per app session. Apps without a resolvable icon fall back to an accented initial-letter badge.

### 🐛 Bug Fixes
- Fixed mixer slider not changing the volume of an app when the session CLI identifier contained backslashes (e.g. `SRS-XB100\Application\Spotify`). The previous inline `oninput` handler was broken by quote escaping; replaced with event delegation reading `data-app-id` directly from the DOM.
- Apps that pause audio (Spotify paused, Chrome tab muted by browser) no longer disappear from the mixer. The filter now includes `Inactive` sessions and only excludes `Expired` ones, matching the behaviour of the Windows Volume Mixer.
- System pseudo-sessions ("Sistema operativo", "System Sounds") are excluded from the mixer list by filtering on the exe process path — sessions without a real process path are skipped at the source.
- App names sourced from poor session metadata (e.g. "Qt6" for iCUE) are resolved to their friendly name via the exe basename and the existing `prettyAppName` helper, so every row shows a recognisable label.
- SSE refresh no longer interrupts an in-progress slider drag: the mixer render is skipped for 1.5 s after any interaction so the gesture completes cleanly.

---

## [v2.0.3] - 2026-05-30
### 🐛 Bug Fixes
- Fixed a regression where all Gemini API calls (speech recognition, chat, weather search) were incorrectly using the TTS-only model (`gemini-3.1-flash-tts-preview`), causing "Audio input modality is not enabled" errors. Each endpoint now uses the correct model: `gemini-3.5-flash` for text/audio, `gemini-3.1-flash-tts-preview` for speech synthesis only.

---

## [v2.0.2] - 2026-05-30
### 🐛 Bug Fixes
- Fixed GPU temperature not showing for AMD and Intel graphics cards. Previously only NVIDIA users (via nvidia-smi) received a temperature reading; AMD and Intel users always saw a blank. The GPU script now falls back to LibreHardwareMonitor — already installed by the one-click installer — to read GPU temperature on any vendor without adding new dependencies.

---

## [v2.0.0] - 2026-05-28
### ✨ New Features / Improvements

- **Xenon AI — completely redesigned presence experience**: The assistant is no longer a chat panel over the dashboard — opening Xenon now dims the screen into a calm, deep-black ambient space built around motion, light, and large expressive typography. The voice mode centres on a living *resonance* orb: a volumetric sphere of light whose edge melts into its own glow (no hard disc, no box behind it — it truly floats in the black), filled with a slow fluid colour mesh and a bright beating core. Each state feels distinct — it leans in and pulses calm sonar rings while **listening**, an orbiting conic light scans around it while **thinking**, and energy bursts outward in brighter, faster waves while **speaking**. The chat reads as a calm transcript instead of a messaging app: Xenon speaks in borderless typography with a soft accent marker, only your messages keep a minimal tinted pill. A new abstract identity mark — a resonance aperture — replaces the old sparkle on the assistant and its topbar button. The Siri-style animated edge glow is retained and refined (calmer palette, state-reactive speed). Respects `prefers-reduced-motion`.

- **Xenon AI — full assistant with voice, vision, and function calling**: Powered by Google gemini-3.1-flash-tts-preview. Tap the sparkle (✦) button in the top-right corner to open a Liquid Glass chat panel. Xenon can control every dashboard component by text or voice: toggle the mic, play/pause and skip tracks, set volume, read and write notes, create calendar events and tasks, start and delete timers, lock the PC, change the colour theme, open the weather panel, app switcher, settings, and focus lock screen, and open any app, website, or file on the PC.

- **AI voice mode — button-triggered with follow-up listening**: Press the large floating voice orb button to start a voice session. Xenon listens, transcribes your command, thinks, and replies aloud. After it finishes speaking, it stays listening for a few seconds so you can ask a follow-up straight away — no need to press the button again. Ask another question and the conversation continues in the same context; stay silent and the session closes on its own with a soft chime. The microphone stays quiet while Xenon is speaking, so it never misinterprets the assistant's own voice.

- **AI voice — tap to interrupt**: During the thinking or speaking phase a **"· tap to stop"** hint is shown on the voice screen. Tapping anywhere on that screen **instantly** stops TTS playback, cancels any active server recording, and closes the voice session. This is the primary way to interrupt Xenon on the Xeneon Edge touchscreen.

- **AI voice orb — animated resonance interface**: Voice sessions are centred on a living *resonance* orb: a volumetric sphere of light whose edge melts into its own glow, filled with a slow fluid colour mesh. Each state feels distinct — it leans in and pulses calm sonar rings while **listening**, an orbiting conic light scans around it while **thinking**, and energy bursts outward in brighter, faster waves while **speaking**.

- **AI voice — natural human-like voice with short spoken replies**: Spoken answers now use Google Gemini's native neural voice — markedly more lifelike than a standard TTS — and voice replies are deliberately kept short and conversational (1-2 sentences), which also makes them faster to generate and speak.

- **AI screen vision — capture and analyse any monitor**: Ask Xenon "what's on my screen?" or "read that text" and it captures a live screenshot via NirCmd and sends it to Gemini for analysis. On multi-monitor setups, clickable monitor buttons appear directly in the dashboard so you can pick which screen to analyse without typing.

- **AI markdown rendering**: AI replies now render headings, bold/italic text, bullet lists, numbered lists, inline code, horizontal rules, and links as formatted HTML inside the chat bubbles. Plain text and emoji still display exactly as before.

- **AI audio ducking**: Master volume is automatically lowered while Xenon speaks and restored to the previous level when it finishes, so the assistant's voice is never drowned out by your music.

- **AI app control — close apps too**: Beyond opening apps, Xenon can now close them on request — say "close Spotify" during a voice session and the app terminates. Works for common apps (Spotify, Chrome, Edge, Discord, Steam, OBS, VLC, Office, Teams, and more) and any process by name.

- **AI calendar — clear all events**: Xenon can now delete every calendar event at once on request (with a confirmation first), and correctly sees past events as well as upcoming ones — previously "delete all events" could wrongly report an empty calendar when only past events remained.

- **AI — microphone sensitivity slider**: Settings → Xenon AI exposes a microphone sensitivity slider (0–100) that controls the input gain for voice recording. Useful on headsets with naturally quiet microphones, or to improve speech recognition with Bluetooth audio. Maps to 1.5× to 5× amplification on the captured audio signal.

- **Countdown timers with AI integration**: A new Timer tab sits next to Calendar and Tasks in the media panel. Create timers by typing a label and a duration (e.g. `5:00`, `1:30:00`, or a plain number of minutes). Each timer shows a live SVG ring progress arc, a countdown display, and pause / restart / delete controls. You can also say "set a timer for 10 minutes called Pasta" during a voice session and the AI creates it instantly. A toast notification and chime play when a timer finishes. Timers survive server restarts (persisted to `timers.json`).

- **AI settings panel — complete setup guide**: The Xenon AI section in Settings now shows a full explanation of capabilities, a step-by-step setup guide with a direct link to Google AI Studio, and a privacy note confirming the API key is stored only on this PC. Available in all five supported languages.

- **Voice session chimes**: Soft audio cues mark the start and end of voice sessions (8% amplitude) — noticeably softer than notification sounds.

- **Weather UI redesign**: All weather components (topbar pill, weather modal, lock screen weather card) rebuilt with an iOS Weather-inspired aesthetic — dynamic sky gradient backgrounds per condition (sun, moon, cloud, rain, storm, snow, fog), thin-weight temperatures, flat minimal icons, frosted glass metric cards, and subtle CSS animations (sun glow pulse, moon gleam, cloud drift).

### ⚡ Efficiency
- **Snappier, better-synced voice turns**: Xenon now stops recording as soon as you finish talking, instead of waiting out a fixed window — so it reacts and closes the session promptly. The voice screen also stays on **"Sto pensando…" / "Thinking…"** until the spoken answer actually begins playing, rather than showing "speaking" during the brief moment the voice is still being generated.
- **Voice transcription ignores silence**: a near-silent recording (below the speech-energy floor) is no longer sent to Gemini at all, so silence or stray background noise can never be turned into a phantom command.
- **Lighter client**: removed unused voice-detection code and disabled the per-event debug network logging by default, reducing background work and network chatter on the display.

### 🐛 Bug Fixes
- Fixed weather and lock screen always showing the sun icon at night. Day/night is now determined using actual sunrise and sunset times from the weather API, instead of hardcoded hours.
- Fixed dashboard data (audio, media, system stats) freezing on the last value when the real-time stream temporarily dropped: the polling fallback now correctly schedules a periodic refresh for every panel — previously it fetched each one only once on disconnect, so the UI could stay stale until the stream reconnected. The fallback also no longer leaves orphan timers behind on reconnect, eliminating a slow build-up of duplicate background requests.

---

## [v1.3.5] - 2026-05-22
### ✨ New Features
- Added a media source selector that appears when Windows reports multiple active media sessions, letting users choose Auto, Spotify, YouTube, or another detected player instead of relying only on automatic SMTC scoring.

### 🐛 Bug Fixes
- Fixed a long-running stability issue where the media widget could freeze on the last snapshot, other SMTC-aware apps could stop receiving "now playing" updates, and Windows shutdown could stall. The PowerShell media helper now releases the WinRT thumbnail stream, input stream, and data reader after every read, applies an internal timeout to WinRT calls so a stuck system media broker can no longer hang the script, and the Node server lets the helper exit on its own instead of killing it mid-flight, which previously left dangling references on the system media broker.

---

## [v1.3.4] - 2026-05-21

### 🐛 Bug Fixes
- Forced UTF-8 JSON output in `cpu-temp.ps1`, `gpu.ps1`, `media.ps1`, `network.ps1`, and `windows.ps1` so the server reads PowerShell data consistently even when titles, names, or labels contain multibyte characters.
- Restored `server.js` to launch PowerShell scripts through the original `-File` path while keeping UTF-8 handling in the scripts themselves, reducing the risk of regressions in server-side media, system, network, and window data collection.

---

## [v1.3.3] - 2026-05-15

### ✨ New Features
- Added Korean, Japanese, and Simplified Chinese language options to the server dashboard.

### 🐛 Bug Fixes
- Remembered the user's Media/Calendar view choice, so returning to the Media widget no longer resets the panel back to full media when Calendar was selected.
- Fixed Spotify and other media metadata with Korean, Japanese, Chinese, and other multibyte characters so song titles, artists, and artwork searches no longer use corrupted text.

---
## [v1.3.2] — 2026-05-14

### 🐛 Bug Fixes

- Improved automatic CPU temperature setup: `INSTALL.bat` now asks for administrator privileges, installs LibreHardwareMonitor and PawnIO through winget when available, registers the Windows startup task with elevated privileges, restarts the local server so elevated sensor access takes effect immediately, and the server can read CPU temperatures directly from the LibreHardwareMonitor library before falling back to WMI.

## [1.3.0] — 2026-05-14

### ⚡ Performance

- **Server-Sent Events** replace client-side polling for mic status, media, system, and audio data. The dashboard now receives updates the moment the server has new data instead of waiting for the next polling cycle. A fallback to conventional polling is active if the connection drops or if an older server build is detected.
- **GPU-accelerated animations**: added `will-change: transform` and `will-change: opacity` to all long-running CSS animations — mic orbit ring, weather (blob, float, cloud drift, rain, snow, fog), clock colon blink, and status dot pulse. Animations now run on the GPU compositor thread instead of the CPU.
- **Lock screen clock** now uses `requestAnimationFrame` instead of `setInterval`. The display updates precisely when the second changes and wastes zero frames otherwise.
- **Artwork cache** is now capped at 200 entries with LRU eviction. Memory use stays bounded even after an extended session with many different tracks.
- **Media panel background layer** promoted to its own GPU layer via `translateZ(0)`, preventing the heavy `blur + saturate + brightness` filter from forcing full repaint cycles.

### ✨ New Features

- **Task tracker panel**: a new Tasks widget lets you manage a personal to-do list directly on the dashboard. Each task has a colour-coded priority dot — red for high, amber for medium, green for low. Action buttons follow the same palette: the complete button is green, the undo button is orange, and the delete button is red for immediate clarity. Completed tasks move to a separate section with strikethrough styling. Tasks support automatic recurrence: daily, weekly, or a custom number of days — recurring tasks reset themselves at page load once the interval has elapsed. By default the panel lives inside the Calendar view as a toggle tab; users can also restore it as a standalone widget via the dashboard customisation editor.
- **Custom dropdown controls**: all select inputs across the dashboard (task priority, recurrence, event reminder) now use a custom-styled dropdown that matches the dashboard aesthetic, replacing the plain browser-native selects.
- **Animated theme transitions**: switching colour theme (Xenon, Ocean, Ember, Violet, Mono, or custom hex) now cross-fades the accent colour and background over 380 ms instead of changing instantly. Implemented via CSS `@property` with no JavaScript.
- **View Transitions** on dashboard layout changes: hiding, restoring, reordering, and resizing panels now uses the browser's View Transitions API for a smooth cross-fade animation. Falls back silently on builds without the API.

---
## [1.2.2] — 2026-05-14
### 🐛 Bug Fixes
- Improved embedded server dashboard sizing so borderline Xeneon/WebView viewport heights no longer show stray white space or trigger unnecessary panel scrollbars.


---
## [1.2.1] — 2026-05-13

### 🐛 Bug Fixes
- Fixed manual weather display names so selected cities such as Los Angeles show the city instead of a nearby provider area.
- Moved Settings status messages to the shared footer and tightened the Settings layout so Weather sits closer to Media background.
- Fixed manual weather city typing so the first space is no longer swallowed while entering names such as `Los Angeles` or `San Francisco`.
- Fixed manual weather city lookup so ambiguous names such as `Rome` are resolved more reliably instead of drifting to the wrong city.

---

## [1.2.0] — 2026-05-13

### ✨ New Features

- Added a persistent **Customize Dashboard** mode for the server dashboard and iCUE widget. Users can reorder, resize, hide, restore, and reset dashboard widgets without editing code.
- Added persistent customization for the **System** and **Network & Gaming** cards, including card order, size, visibility, tab order, and the remembered active tab.
- Added persistent customization for the server dashboard **Audio** controls, so Volume, Speaker, and Microphone controls can be reordered, resized, hidden, restored, and reset.
- Added **Weather location settings** with automatic location detection or a manually entered city.

### 🐛 Bug Fixes

- Fixed the server dashboard customization toolbar so it no longer covers the Speaker and Microphone audio controls while editing the layout.
- Expanded the server dashboard customization toolbar so its controls wrap across the full available width instead of requiring horizontal scrolling.
- Fixed weather animations so storm lightning, rain, snow, fog, and sun rings only animate for the matching weather condition.
- Improved weather condition detection by using weather provider condition codes first, with translated condition text only as a fallback.

---

## [1.1.3] — 2026-05-12

### 🐛 Bug Fixes

- Fixed **Windows installer startup registration** on systems where `Register-ScheduledTask` rejected a plain username (`HRESULT 0x80070057`). The installer now uses the full current Windows identity and falls back to `schtasks.exe` when needed.
- Fixed **animated GIF backgrounds** that sometimes stayed invisible right after upload until the dashboard/component was reloaded. Background media now recreates a fresh image/video node when changed, which makes problematic GIFs appear immediately without a manual reload.
- Raised the **background upload limit** from 32 MB to 200 MB across server validation, UI messages, and documentation.

### 📘 Documentation

- Updated the README to reflect the current install flow, weather endpoint, custom media background support, and the revised 200 MB upload limit.

## [1.1.2] — 2026-05-11

### 🐛 Bug Fixes

- Increased **overall text readability** across the dashboard, panels, modals, and compact iCUE embed breakpoints.
- Improved **background media sharpness** by removing the fixed 105% background upscale when blur is disabled.
- Added a clearer error message when unsupported background files such as MP3/audio are selected.
- Improved uploaded **MP4/WebM background playback** reliability in browser/iCUE WebView with explicit autoplay attributes and playback retries.
- Added HTTP **byte-range streaming** for uploaded backgrounds so MP4/WebM files can be decoded correctly by browser and iCUE WebView video players.
- Added automatic **MP4 → WebM VP8 conversion** on background upload when FFmpeg is available, so users can upload common Pexels/Pixabay MP4 files without manual conversion.
- Improved **FFmpeg discovery** for winget installs that place `ffmpeg.exe` under the WinGet package directory instead of adding it to `PATH`.
- Lowered **panel opacity** minimum from 42% to 18% for lighter glass-style layouts.
- Softened panel borders, highlights, and shadows at low opacity so panels do not look overly stamped on subtle backgrounds.
- Improved topbar, weather chip, clock text, and icon readability on bright custom backgrounds with darker floating controls and text/icon shadows.

### 📘 Documentation

- Added a note that MP4/WebM backgrounds at display resolution usually look sharper than downloaded GIFs.
- Clarified that iCUE WebView may reject MP4 files that play in Chrome, so WebM VP8/VP9 is recommended for animated backgrounds inside iCUE.
- Added step-by-step background video guidance covering supported formats, automatic MP4 conversion, FFmpeg installation, server restart, and the 200 MB upload limit.

## [1.1.1] — 2026-05-11

### 🐛 Bug Fixes

- Fixed **media title clipping** in the main Media panel and Focus Lock Screen variants by increasing title line-height and adding a small bottom padding for heavy-weight glyphs.
- Fixed **theme persistence after reboot / restart** by persisting hub settings server-side in `server/settings.json` in addition to browser `localStorage`.

### 📘 Documentation

- Clarified that the current release is **not a native iCUE widget** yet.
- Corrected the iCUE setup instructions to use the full **`<iframe>` HTML tag** instead of pasting only the localhost URL.

## [1.1.0] — 2026-05-11

### ✨ New Features

#### Focus Lock Screen
- Added a full-screen **Focus Lock Screen** overlay (`id="lockscreen-overlay"`) — an internal client-side lock distinct from the Windows PC lock.
- Accessible via the **Focus** button in the topbar (lock icon).
- Escape key or tap/click anywhere on the overlay closes it; the existing `quickLock()` PC-lock shortcut is unchanged.
- The lock screen shows a live **clock** (hours : minutes, AM/PM), configurable via Settings.
- Configurable **widget tiles** on the lock screen: Clock, Weather summary, Now Playing card, Upcoming Events list — each can be individually enabled or disabled in Settings → Lock Screen.
- **Settings persistence**: lock widget preferences stored under `xeneonedge.settings.v1.lockWidgets`.

#### Animated Lock Screen Clock
- Clock digits are split into separate DOM nodes (`lock-time-h`, `lock-time-sep`, `lock-time-m`, `lock-time-ampm`) enabling per-digit animation.
- **Digit-tick animation**: each digit performs a subtle vertical bounce when its value changes.
- **Colon pulse animation**: the separator `:` fades in and out on a 2-second cycle.
- **Clock breathe animation**: the entire clock gently scales up/down for a living-display feel.

#### Lock Screen — Media Card
- Now Playing card displays song title, artist, and playback controls (previous / play-pause / next).
- Play/pause icon is kept in sync with the actual playback state using the same `playbackStatus === 'Playing'` logic as the main dashboard.
- **Media-wide state**: when the media card is visible but the events list is hidden (no upcoming events), the media card expands to fill the available width — larger album art, bigger title/artist text, and enlarged action buttons.
- **Media-only state**: when media is the sole active widget, the card expands further with a scaled cover and maximum layout.
- The card is only shown when there is genuinely active media (`title` or `artist` from the current media session).

#### Lock Screen — Upcoming Events
- Shows the next 1–3 upcoming calendar events with title, date, and time.
- Only rendered when there is at least one real upcoming event; the tile is hidden completely if the calendar is empty or all events are in the past.

#### Lock Screen — Weather Summary
- Compact weather chip showing current condition icon and temperature.
- Integrated with the existing weather data refresh cycle.

---

### 🎨 UI / UX Improvements

#### Topbar Clock
- Redesigned clock area in the topbar with improved spacing and visual hierarchy.
- Seconds display and AM/PM indicator configurable via Settings.

#### Settings Modal
- **Language switcher moved into Settings**: language selection is now a dedicated row inside the Settings modal instead of a floating button.
- **Removed scroll**: settings content fits in a compact grid layout — no scrollbar needed.
- **Color personalization**: replaced native `<input type="color">` pickers (broken in iCUE WebView) with a hex text input + live div preview, ensuring reliable color editing on all hosts.

#### Weather Details Modal
- Full redesign of the animated weather details modal.
- **Removed metric dots**: eliminated the decorative `::before`/`::after` pseudo-element dots from `.weather-metric` items for a cleaner look.
- **Removed blue rain bar**: removed the `box-shadow` glow under mini cloud icons in rainy conditions (`.weather-mini-icon.state-rain`) that was visually confusing.
- Improved contrast on `.weather-hero-chips em`, `.weather-metric-label`, `.weather-day-condition`, and `.weather-day-sun`.

#### Text Contrast Improvements
- Raised `--muted-text` from `#7d8784` → `#a6b1ad` (global CSS variable).
- Raised `--dim-text` from `#46504d` → `#7f8a86` (global CSS variable).
- Raised `.stat-head` color in System Panel to `#a6b1ad`.
- Raised `.stat-muted-detail` in System Panel to `#929d99`.
- Raised `.vol-title` in Audio Section to `#b8c3bf`.

---

### 🐛 Bug Fixes

- **Play/pause icon always showed Pause on lock screen**: fixed by using the same `style.display` visibility pattern as the dashboard instead of the `hidden` attribute. Introduced `syncLockMediaPlaybackIcon(playing)` helper in `media.js` called from every code path that mutates playback state (`applyMedia`, `updateCalendarMiniPlayer`, `refreshMediaEmpty`, `mediaAction('playpause')`).
- **Lock screen Events/Media tiles showing as empty**: fixed by computing real availability before deciding visibility. `eventsActive` is now only `true` when `calendarEvents` contains at least one upcoming event; `mediaActive` is only `true` when `mediaData.active` is truthy and title or artist is non-empty.
- **Lock screen overlay rendered inside weather modal**: fixed after reading DOM structure; overlay moved to correct top-level position in `index.html`.
- **Settings color pickers not firing in iCUE WebView**: replaced with hex text input + div preview (no reliance on native color-picker events).

---

### 🗑️ Removed

- **"Focus lock" label pill** on the lock screen overlay — removed for a cleaner, distraction-free look.
- **"Esc or X to exit" hint text** on the lock screen — removed; the overlay is intuitive without the label.
- Unused i18n keys: `lockscreen_open`, `lock_tap_to_exit`.

---

### 📁 Files Changed

| File | Change |
|------|--------|
| `server/index.html` | Added lock screen overlay markup at top level; split clock nodes; removed label/hint elements |
| `server/js/lockscreen.js` | New module — lock screen runtime, clock animation, widget rendering, media/events availability logic |
| `server/js/settings.js` | Lock widget settings, hex color picker, language in settings modal |
| `server/js/media.js` | `syncLockMediaPlaybackIcon()` helper; all playback paths wired to lock screen |
| `server/js/main.js` | Escape key checks lock screen first; `quickLock()` unchanged |
| `server/js/i18n.js` | Added lock screen translation keys; removed obsolete keys |
| `server/components/LockScreen/LockScreen.css` | New — full lock screen styling, digit-tick, colon-pulse, clock-breathe animations, media-wide/media-only states |
| `server/components/WeatherModal/WeatherModal.css` | Removed metric dots and rain box-shadow; contrast improvements |
| `server/components/SystemPanel/SystemPanel.css` | Raised `.stat-head` and `.stat-muted-detail` contrast |
| `server/components/AudioSection/AudioSection.css` | Raised `.vol-title` contrast |
| `server/styles/global.css` | Raised `--muted-text` and `--dim-text` CSS variables |

---

## [1.0.0] — Initial public release

- System monitor: CPU, GPU, RAM, network throughput with LibreHardwareMonitor integration
- Media panel with now-playing via Windows SMTC, album art lookup, playback controls
- Microphone mute/unmute toggle with visual indicator
- Calendar panel with event management and reminder toasts
- Notes panel with inline editing
- Audio device picker with master volume control
- App switcher panel
- Color theming with accent, text, and background color personalization
- One-click install/uninstall scripts for Windows
- Support for both browser and Corsair iCUE / Xeneon Edge display
