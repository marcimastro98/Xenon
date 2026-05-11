# Changelog

All notable changes to XenonEdge Hub are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

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
