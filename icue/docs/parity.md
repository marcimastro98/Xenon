# Conversion parity checklist

Living plan for converting the Xenon web dashboard (`server/`) into native iCUE widgets.
Source of scope: `report corsair/Xenon-SDK-Feasibility.html`. Faithful behavior comes from the
real client code in `server/js/` (cited per widget). Update **Status** as work moves.

**Status legend:** `todo` · `wip` · `done` · `blocked` (needs a CORSAIR capability not yet shipped)

## Build queue — native-feasible widgets

Each ships as its **own** iCUE widget (CORSAIR direction). They share a picker group
(`x-icue-widget-group: "Xenon"`) and the `common/` library, inlined at build.

| # | Widget | iCUE approach | Persistence (now → ~Aug 2026) | Status |
|---|--------|---------------|-------------------------------|--------|
| 1 | **Clock** | Pure UI + Intl; 12/24 + locale | none | `done` (browser-verified; needs in-iCUE test) |
| 2 | **System monitor** | `Sensors` plugin — CPU/GPU/RAM load+temp only (no disk/network/FPS — see note 2) | none | `done` (browser-verified; in-iCUE test blocked) |
| 3 | **Media now-playing** | `Media` plugin (title/artist + play/pause/next/prev) | localStorage (source pref) | `todo` |
| 4 | **Theme/personalization** | Shared `common/theme` + iCUE personalization props | per-widget iCUE props | `todo` |
| 5 | **Focus / lock display** | Pure UI composing clock+media+weather+events | none | `todo` |
| 6 | **Notes** | Textarea + autosave | localStorage → local file | `todo` |
| 7 | **Tasks** | To-do + priority + recurrence | localStorage → local file | `todo` |
| 8 | **Timers** | Countdown + SVG ring | localStorage → local file | `todo` |
| 9 | **Calendar (local)** | Month grid + local events + reminders* | localStorage → local file | `todo` |
| 10 | **Weather** | JSONP to wttr.in / open-meteo** | in-memory + localStorage cache | `todo` |
| 11 | **Link shortcuts** | `Link` plugin — open URLs only (see note) | localStorage | `todo` |

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
3. **Media** — `media.js`: app badge, title (`cleanTitle`), artist|album, album art (+blurred bg),
   play/pause toggle. SDK exposes only song/artist + play/pause/next/prev — **no art, no source picker**
   natively (those degrade out). Empty state = "nothing playing".
4. **Theme** — `settings.js`: tokens `--accent`(+rgb), `--bg`, `--text`, `--panel-alpha`, `--bg-dim/blur`,
   `appearance light|dark|auto`, `clockFormat`, `tempUnit`. → iCUE personalization props (canonical order:
   textColor, accentColor, backgroundColor, backgroundMedia, glassBlur, transparency, …). Becomes `common/theme`.
5. **Lock display** — `lockscreen.js`: composes clock + weather + media + upcoming events, layout-adaptive.
   Pure display; reuses widgets 1/2/3/10's render pieces.
6. **Notes** — `notes.js`: single string, autosave 500ms debounce, status saving/saved/error. → `common/storage`.
7. **Tasks** — `tasks.js`: `{id,text,priority(high|med|low),recurrence(never|daily|weekly|custom),
   recurrenceDays,completed,completedAt,createdAt}`; priority sort; recurrence reactivation on load.
8. **Timers** — `timer.js`: `{id,label,durationSecs,status,startedAt,pausedElapsed}`; SVG ring r=20,
   `dashoffset = circ·(1-rem/dur)`; parse `5` / `5:00` / `1:30:00`; chime+toast on done. Local rAF tick.
9. **Calendar** — `calendar.js`: month grid (Mon-first), local event `{id,title,notes,startsAt,reminderAt,
   notifiedAt,createdAt}`; reminders at/5/15/30/60/1440m before; upcoming list (next 5). External `.ics` = server-only.
10. **Weather** — shape in `server.js normalizeWeather`: `{tempC,feelsC,humidity,windKph,…,hourly[≤8],forecast[3]}`
    from wttr.in (`j1`) + open-meteo (AQI, geocoding). WWO codes → icon states day/night via sunrise/sunset.
11. **Link shortcuts** — NOT the server app-switcher (which lists/focuses windows = server-only). Native version
    = user-defined URL tiles opened via `Link` plugin. Reframed accordingly.

## i18n

Five languages: `it,en,ko,ja,zh` (Italian authoring base, English fallback). Web uses flat snake_case keys.
For widgets: settings labels via `tr()` + `translation.json`; **body text translated at runtime** in JS
(`common/i18n`) since `tr()` is invalid in body. Read active language from the iCUE info object.

## Recommended build order

Foundation (`common/`) → **Clock** (reference exemplar, validate the pattern) → System → Media →
Theme (extract to `common/theme`) → Notes → Tasks → Timers → Calendar → Weather → Link shortcuts →
Lock display (composes the others) → `hub/` (deferred).
