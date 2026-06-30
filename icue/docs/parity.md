# Conversion parity checklist

Living plan for converting the Xenon web dashboard (`server/`) into native iCUE widgets.
Source of scope: `report corsair/Xenon-SDK-Feasibility.html`. Faithful behavior comes from the
real client code in `server/js/` (cited per widget). Update **Status** as work moves.

**Status legend:** `todo` · `wip` · `done` · `blocked` (needs a CORSAIR capability not yet shipped)

## Build queue — ordered by roadmap phase

**Guiding principle (from `report corsair/Xenon-Roadmap-IT.md`): a feature's native
feasibility IS its place in the roadmap.** Build order follows the phases, not a flat
list — Phase 1 ships day-one at full fidelity with no SDK changes; later phases are
gated on a CORSAIR capability and are built *fully* only once it lands (not shipped
degraded before then). Each widget is its own iCUE widget (CORSAIR direction), sharing
a picker group (`x-icue-widget-group: "Xenon"`) and the `common/` library, inlined at build.

### Phase 1 — day-one, no SDK changes, full fidelity

| # | Widget | iCUE approach | Persistence (now → ~Aug 2026) | Status |
|---|--------|---------------|-------------------------------|--------|
| 1 | **Clock** | Pure UI + Intl; 12/24 + locale | none | `done` (browser-verified; in-iCUE test blocked) |
| 2 | **System monitor** | `Sensors` plugin — CPU/GPU/RAM load+temp only (no disk/network/FPS — see note 2) | none | `done` (browser-verified; in-iCUE test blocked) |
| 3 | **FPS in-game** | `Sensors` plugin, `fps` type — `getDefaultSensorIdBlock('fps')` (see note 3a) | none | `done` (browser-verified; in-iCUE test blocked) |
| 4 | **Notes** | Textarea + autosave (debounce 500 ms) + `common/storage` | localStorage → local file (Phase 4 bridge) | `done` (browser-verified; in-iCUE test blocked) |
| 5 | **Tasks** | To-do + priority + daily/weekly/custom recurrence + `common/storage` | localStorage → local file (Phase 4 bridge) | `done` (browser-verified; in-iCUE test blocked) |
| 6 | **Timers** | Countdown + SVG ring + Web Audio chime + `common/storage` | localStorage → local file (Phase 4 bridge) | `done` (browser-verified; in-iCUE test blocked) |
| 7 | **Theme/personalization** | NOT a tile — iCUE has no cross-widget theme. Already shipped **per-widget** (Text/Accent/Background/Transparency via `applyPersonalization()` in every widget) | per-widget iCUE props | `done` (covered everywhere; no separate widget) |

> **Dropped: "Link shortcuts".** A URL speed-dial was listed here as a Phase-1 "bonus" derived from the
> SDK `Url` plugin being available — but it is **not an existing product feature**. Xenon has no
> standalone link-shortcuts grid. The real features in this space are the **Deck** (Stream-Deck keys:
> open app/file/URL + actions) and the **app switcher** (window list/focus, alt-tab style, favourites) —
> both **server-only** (need the System/Action plugin → Phase 3). Building a URL-tiles widget would
> invent a feature the user doesn't have, which breaks the faithful-conversion rule, so it was removed
> (widget + build deleted 2026-06-30). The `Url` plugin wrapper (`openLink()`) stays in `common/` for
> legitimate future use (e.g. a real Deck/app-switcher port once the SDK allows it).

### Phase 2+ — gated on a CORSAIR SDK capability (build fully once it lands)

| # | Widget | Needs first | Status |
|---|--------|-------------|--------|
| 9 | **Media now-playing** | **Richer Media plugin** (cover art, position/seek, source) for the *full* tile | `done` as a **reduced Phase-2 prototype** (title/artist + transport only; no art/source/state — see note 3). Keep as a demo; the full build waits on the richer plugin. |
| 10 | **Weather** | **Network/HTTP plugin** (allowlisted) — JSONP is not sanctioned | `blocked` (Phase 2) |
| 11 | **Calendar** | Local month grid is Phase-1-feasible; **external `.ics` sync** needs Network/HTTP | `todo` local / `blocked` sync (Phase 2) |
| 12 | **Focus / lock display** | Composes clock+media+weather+events — full version waits on Media/Weather | `todo` (Phase 2; reuses 1/2/3 render pieces) |

\* Reminders only fire while the widget is open (no background process in a widget).
\** Network is JSONP-only until CORSAIR sanctions fetch; weather langs `it,en,ko,ja,zh`.

## Not converting (server-only — stay on `server/`)

Mic · speaker volume · per-app mixer · network stats · RGB lighting · Xenon AI ·
Deck · remote PC control · browser tile · real in-game FPS · app **switcher**
(window list/focus) · self-update/backup. These need the companion server; not forced native.

**Also server-only inside the System tile** (no iCUE sensor/API exists): **Disk** usage/free/model,
**RAM used/total GB + module string**, **Ping / Latency / Bandwidth**, System-tile **tabs**,
**Optimize** button, **Uptime** pill. Native System shows CPU/GPU/RAM load+temp only. See note 2 below.

## Per-widget build notes (distilled from `server/js/`)

1. **Clock** — `clock.js`: split `HH` / `MM` / `AM·PM` + long localized date
   (`weekday,long · day,2-digit · month,long`). 12/24 from setting `auto|12|24`
   (auto = 12h only when locale starts `en`). Ticks 1/s. → iCUE: combobox for format, `DateFormatter`.
2. **System** — `system.js`: per metric a value, proportional fill bar, name, optional `°C`.
   CPU `%`+temp+name · RAM `%`+used/total+module · GPU `%`+temp+name · Disk `%`+free+detail (cycle drives).
   → iCUE: one `sensors-combobox` per metric (or a sensors-factory), units from the plugin.
   **Native build = card-faithful port of the web tile**: CPU/GPU/RAM cards with label +
   accent temp pill (amber ≥75 °C) + big load % + sensor name + live colour sparkline
   (green/blue/amber, ported from `utils.js renderStatSpark`). **What the web tile shows but
   native CANNOT** (Sensors plugin only exposes hardware sensors — `load`/`temperature`/`fan`/
   `pump`/`voltage`/`power`/`current`/`fps`/`battery`, no storage/network type):
   - **Disk** (used %, free GB, drive model, NTFS, cycle drives) — read from the OS filesystem
     server-side; no disk sensor type exists. **Not doable native.**
   - **RAM used/total GB + module string** (e.g. "31.1 GB", "DDR5 6000 MHz - 2×16 GB") — server-side;
     native shows RAM **load %** only (memory-load sensor). Module GB detail not available.
   - **Network & Gaming** (Ping, real FPS, Latency/jitter, Bandwidth up/down) — all server-only.
   - **Tabs** (System / Volume / Microphone), **Optimize** button, **Uptime** pill — server-only.
   Demo values in browser preview are a random walk (no plugin outside iCUE); real numbers
   appear only inside iCUE. This is expected, not a bug.
3a. **FPS in-game** (Phase 1) — own widget. `Sensors` plugin, `fps` sensor type:
   `getDefaultSensorIdBlock('fps')` seeds the picker, live updates via `sensorValueChanged`.
   A single card: "FPS" label + LIVE pill, a large **performance-coloured** reading
   (green ≥60 / amber ≥30 / red below), the source/sensor name, and a real-time graph
   (sparkline ported from `utils.js renderStatSpark`). The `fps` sensor reads 0 / disconnects
   when no game is running, so the widget shows an **idle state** ("Start a game to see FPS")
   instead of "0 FPS". Fully native today — this is the FPS the web tile reads from PresentMon,
   exposed here straight from the Sensors plugin (no companion server needed). Demo reading
   ("Cyberpunk 2077") shows only in browser preview.
3. **Media** — `media.js`: app badge, title (`cleanTitle`), artist|album, album art (+blurred bg),
   play/pause toggle. **Native build = faithful port of the web tile's now-playing view**: animated
   equalizer artwork placeholder (mirrors the web's no-cover fallback) + big bold title (`cleanTitle`
   ported from `utils.js`) + accent-tinted artist + prev/play-pause/next transport. Polls the `Media`
   wrapper every 2 s (the plugin emits no change signal) and only repaints on change. Empty state =
   "Nothing playing". **What the web tile shows but native CANNOT** (the `Media` plugin exposes only
   `getSongName`/`getArtist` + `triggerPlayPause`/`triggerNextTrack`/`triggerPreviousTrack`):
   - **Album art** + blurred cover background — no art field in the SDK. **Not doable native** (EQ
     placeholder stands in).
   - **Source picker** (Spotify / YouTube / Auto) and **app/source badge** — the SDK reports no source
     or app identity. **Not doable native.** (So no localStorage source pref either — nothing to store.)
   - **Play/pause STATE readback** — the SDK has only a *toggle* trigger, no "is playing" flag. The
     play↔pause icon (and the EQ bounce) follow an **optimistic local guess**: assume playing while a
     track is present, flip on tap. Can briefly desync if the user pauses from another app. **Not
     fixable until the SDK exposes playback state.**
   - **Progress bar / seek / position / duration** — none in the SDK. **Not doable native.**
   - **Per-app volume** of the source — server-only (per-app mixer). Stays on `server/`.
   Demo track ("Midnight City — M83") shows only in browser preview (no plugin outside iCUE); real
   now-playing appears inside iCUE. Expected, not a bug.
4. **Theme** — `settings.js`: tokens `--accent`(+rgb), `--bg`, `--text`, `--panel-alpha`, `--bg-dim/blur`,
   `appearance light|dark|auto`, `clockFormat`, `tempUnit`. → iCUE personalization props (canonical order:
   textColor, accentColor, backgroundColor, backgroundMedia, glassBlur, transparency, …). Becomes `common/theme`.
5. **Lock display** — `lockscreen.js`: composes clock + weather + media + upcoming events, layout-adaptive.
   Pure display; reuses widgets 1/2/3/10's render pieces.
6. **Notes** (Phase 1, **done**) — `notes.js`: single string, autosave 500 ms debounce, status
   saving/saved/error. Native: header (title + colour-coded status dot/word) over a textarea on the
   web's dark gradient, with the **idle-blur caret-flicker guard** ported (blur after 20 s idle — the
   Xeneon Edge WebView never drops focus, and the blinking caret can flicker the panel). Persists via
   the new **`common/storage/local-store.js`** (`XenonStore`) — a try/catch localStorage wrapper shared
   by Notes/Tasks/Timers; `XenonStore.available()` drives an honest "Not saved" status if the sandbox
   blocks storage. **Native limit:** localStorage is per-widget and capped (no file/backup) until the
   Phase 4 Companion Bridge brings local-file persistence; `available()`-false degrades to in-memory.
7. **Tasks** (Phase 1, **done**) — `tasks.js`: `{id,text,priority(high|med|low),
   recurrence(never|daily|weekly|custom),recurrenceDays,completed,completedAt,createdAt}`; priority sort;
   recurrence reactivation on load. Native: faithful port — add row + priority/recurrence native `<select>`s
   + custom-days, priority-sorted list with colour-coded glow dots (red/amber/green), recurrence badge,
   tick/undo/delete, and a Completed section with strikethrough. `checkRecurrence()` on load reactivates
   due recurring tasks (daily/weekly/custom-days). Persists via `XenonStore.saveJSON`
   (`xenon.tasks.v1`) — shares the same Phase-1 localStorage limit as Notes (file/backup at Phase 4).
   **Dropdowns use the shared `common/ui/custom-select.js`** (QtWebEngine can't style native `<select>`
   popups): add `data-custom-select data-cs-fixed`, call `initAllCustomSelects()`. This styled dropdown
   is the standard for **every** Xenon widget — any future select (Timer, Calendar, Weather, Theme) must
   use it, never a bare native `<select>`.
8. **Timers** (Phase 1, **done**) — `timer.js`: `{id,label,durationSecs,status,startedAt,pausedElapsed}`;
   SVG ring r=20, `dashoffset = circ·(1-rem/dur)`; parse `5`(min) / `5:00` / `1:30:00`; chime+toast on done.
   Local rAF tick (~4 fps). Native: fully local — state in `XenonStore` (`xenon.timers.v1`), running timers
   resume correctly across reloads via absolute `startedAt` (one whose deadline passed while closed shows
   done). **Chime is Web Audio** (oscillator beeps, no external file, works offline) unlocked on the first
   tap (autoplay policy); a self-contained in-widget **toast** ("Time's up!") replaces the server toast —
   both fire only while the widget is open (no background process, as the roadmap notes). Native limits:
   same localStorage cap as Notes/Tasks; no cross-device sync (Phase 4 bridge).
9. **Calendar** — `calendar.js`: month grid (Mon-first), local event `{id,title,notes,startsAt,reminderAt,
   notifiedAt,createdAt}`; reminders at/5/15/30/60/1440m before; upcoming list (next 5). External `.ics` = server-only.
10. **Weather** — shape in `server.js normalizeWeather`: `{tempC,feelsC,humidity,windKph,…,hourly[≤8],forecast[3]}`
    from wttr.in (`j1`) + open-meteo (AQI, geocoding). WWO codes → icon states day/night via sunrise/sunset.
11. **Link shortcuts** — **DROPPED (not a real product feature).** Was prototyped as a URL speed-dial
    from the `Url` plugin, but Xenon has no such feature; removed 2026-06-30. The real adjacent features
    are the **Deck** and the **app switcher**, both server-only (Phase 3). See the dropped-note in the
    build queue above. `openLink()` wrapper kept in `common/` for a future real port.

## i18n

Five languages: `it,en,ko,ja,zh` (Italian authoring base, English fallback). Web uses flat snake_case keys.
For widgets: settings labels via `tr()` + `translation.json`; **body text translated at runtime** in JS
(`common/i18n`) since `tr()` is invalid in body. Read active language from the iCUE info object.

## Recommended build order

Foundation (`common/`) → **Clock** (reference exemplar, validate the pattern) → System → FPS →
Notes → Tasks → Timers (Phase 1 complete) → then Phase 2 as the SDK allows: Media (full) → Weather →
Calendar → Lock display (composes the others) → `hub/` (deferred). (Theme = per-widget, not a tile;
Link shortcuts dropped — not a real feature.)
