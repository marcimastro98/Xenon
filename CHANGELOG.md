# Changelog

All notable changes to XenonEdge Hub are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.1.4] — 2026-05-13

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
