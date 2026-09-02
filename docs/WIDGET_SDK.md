# Xenon Widget SDK — build your own dashboard widget

**API version 1 · beta**

Anyone can build a widget for the Xenon dashboard: a small folder with a
manifest and an HTML page. Widgets run inside a **sandboxed iframe with no
network access** — everything they can see or do goes through a small,
versioned message bridge, and the user explicitly approves each widget's
permissions before it renders.

## Quick start

1. In Xenon, open **Settings → Widgets & sharing** and enable third-party widgets.
2. Add the **Custom widget** tile from the "+" palette and tap
   **Install example** — that installs `hello-xenon`, the reference widget this
   guide is based on (source in `server/sdk-example/hello-xenon/`).
3. To develop your own: create a folder under `server/data/widgets/<your-id>/`
   with a `manifest.json` and an `index.html`, then **Rescan** from the tile.

After editing a widget's files, use the tile's **Reload** button (↻ in the tile
header) — or **Rescan** — to reload the changed files. Each reload cache-busts the
widget's assets, so the edit shows up even on a surface you can't hard-refresh
(e.g. a touchscreen you cannot reach a keyboard on); reload on each surface you want updated.

A package folder looks like:

```text
server/data/widgets/
  my-widget/
    manifest.json
    index.html
    widget.js
    widget.css
    (images, fonts, …)
```

One filename is reserved: `__xenon-perf.js`. The host serves its own small
performance probe under that name inside every package (it measures long tasks
and frame rate and reports them to the dashboard, so users can see which widget
is using resources). A file with that name inside your package is ignored. The
probe never touches your DOM or globals beyond `window.__xenonPerf`, and you do
not need to do anything to support it.

## manifest.json

```json
{
  "api": 1,
  "id": "my-widget",
  "name": "My Widget",
  "version": "1.0.0",
  "author": "You",
  "description": "One or two sentences shown in the picker and permission dialog.",
  "entry": "index.html",
  "streams": ["system", "media"],
  "actions": ["media", "volume", "mic"],
  "hosts": ["api.example.com"],
  "userHosts": [{ "id": "nas", "label": "NAS address", "scope": "private" }],
  "hooks": ["my-event"],
  "storage": true,
  "storageGroup": "my-widget-set",
  "secrets": true,
  "shape": { "preset": "hexagon" },
  "deck": {
    "actions": [
      { "id": "quiet", "name": "Quiet mode",
        "steps": [
          { "action": { "type": "volume", "mode": "mute" } },
          { "action": { "type": "micMute", "mode": "mute" }, "delayMs": 200 }
        ] }
    ],
    "states": [{ "id": "alert", "name": "Alert active" }]
  }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `api` | yes | Must be `1`. The bridge protocol is versioned; future hosts stay compatible with declared versions. |
| `id` | no | If present, must equal the folder name. Folder name rules: `^[a-z0-9][a-z0-9-]{1,40}$`. |
| `name` | yes | ≤ 60 chars. |
| `version`, `author`, `description` | no | Shown to the user (description ≤ 200 chars). |
| `entry` | no | HTML entry document, defaults to `index.html`. Must live in the package root. |
| `streams` | no | Data streams you request: `status`, `system`, `media`, `audio`, `audioLevels`, `wavelink`, `voicemeeter`, `stocks`, `football`, `news`, `claude`, `obs`, `discord`, `discordChannels`, `discordSoundboard`, `discordNotifications`, `streamerbot`, `homeassistant`, `twitchWatch`, `twitchChat`, `youtubeLive`, `tasks`, `notes`, `agenda`, `weather`, `battery`. *Capability reference* below is generated from the code and is the list that cannot go stale. See *Hardware sensors* for fans/power/battery. |
| `surface` | no | `"tile"` (default) or `"ambient"` — an ambient package renders fullscreen as an Ambient/screensaver scene instead of a dashboard tile (see *Ambient scenes*). |
| `actions` | no | Action categories you request: `media`, `volume`, `audioDevice`, `mic`, `lighting`, `chroma`, `wavelink`, `voicemeeter`, `spotify`, `steam`, `obs`, `discord`, `homeassistant`, `twitch`, `youtube`, `streamerbot`, `url`, `browser`, `watch`, `tasks`, `soundboard`. *Capability reference* below is generated from the code and is the list that cannot go stale. |
| `hosts` | no | Up to 8 exact hostnames the widget may reach **through the host-mediated fetch proxy** (see *Network*). Loopback/link-local names are rejected at install time. |
| `userHosts` | no | Up to 4 addresses **the user types in**, for servers you can't know in advance (a NAS, Docker, a printer). Each is `{ id, label, scope }` — `id` (`^[a-z0-9][a-z0-9-]{0,40}$`) is what you read the value back under, `label` (≤ 60 chars) is the text above the field, `scope` is `"private"` (default — LAN only) or `"any"`. See *User-supplied addresses*. |
| `hooks` | no | Up to 8 hook ids (`^[a-z0-9][a-z0-9-]{0,40}$`) the widget may receive local webhook events on (see *Local webhooks*). |
| `deck` | no | Deck contributions: up to 8 `actions` (macros of ≤ 10 steps, each step restricted to the same low-risk action set as `actions`), up to 8 `states` the widget publishes, and up to 8 `handlers` — Deck keys answered by your own code, with up to 4 declared params each (see *Deck integration* and *Handler actions*). |
| `background` | no | `true` + declared `deck.handlers`, `badge`, and/or `island: { "dynamic": true }` or `island: { "full": true }` → the host may run your package in a hidden **service frame** so its Deck keys, badge or Dynamic Island activity keep working with no tile on screen. Ignored without one of those capabilities. |
| `storage` | no | `true` → your widget may keep a small persistent key/value store on this PC (its settings, chosen sources, last map view). Survives updates. See *Persistent storage*. |
| `storageGroup` | no | A shared-store id (`^[a-z0-9][a-z0-9-]{0,40}$`). Every widget declaring the same group reads/writes ONE store, so a set of sibling widgets can share config/cache. Implies `storage`. |
| `secrets` | no | `true` → your widget may store API keys in a **write-only** vault and use them via `{{secret:NAME}}` in proxied requests, so a published package ships no keys. See *Secrets & API keys*. |
| `island` | no | `true` keeps the v4.6 **short plain-text line** API. `{ "dynamic": true }` requests the separate advanced permission for host-rendered Live Activities, timed takeovers and action buttons in **Full and Minimal**. `{ "full": true }` requests a third permission on top: activities that span the **whole top bar**. See *Dynamic Island*. |
| `badge` | no | `true` → your widget may show a small **always-on** text chip next to the clock, in both topbar chromes. `{ "action": true }` requests a separate permission on top: the chip becomes a **button** and tapping it tells your widget. Host-rendered, grant-gated — see *Persistent badge*. |
| `mini` | no | `true` → your widget may draw a **mini widget in the top bar's button row**, where the user placed it (Settings → Dynamic Island → bar buttons). Same host-rendered block vocabulary as the Dynamic Island, in a smaller room. See *Mini slot*. |
| `clipboard` | no | `true` → your widget may **ask** to copy text to the system clipboard. It can never copy silently and can never read the clipboard: each copy shows a Xenon confirmation the user taps. See *Clipboard*. |
| `accent` | no | `true` → your widget may tint the **dashboard accent colour** while it runs (the same channel the album-art accent uses). Accent only, never saved, released when your widget goes away. See *Dashboard accent*. |
| `expand` | no | `true` → your widget may **ask to fill the screen**, painting its tile over the whole dashboard, for content that genuinely needs the room (a board, a map, a game). Only in response to the user touching your widget; the way back out is drawn by Xenon. Ignored on an `ambient` package, which is already fullscreen. See *Filling the screen*. |
| `shape` | no | The **silhouette of your own tile**: `{ "preset": "hexagon" }` or your own closed SVG path, `{ "path": "M .5 0 L 1 .5 L .5 1 L 0 .5 Z" }`. Optional `"fit": "fit"` keeps the proportions instead of stretching, and `"inset"` (0–25) is extra safe margin in percent. Not a permission — it cannot reach past your tile — and the user's own shape for that tile always wins. Ignored on an `ambient` package. See *Tile shape*. |

An invalid entry in any of these (a loopback host, an out-of-catalog macro step,
a malformed id) rejects the **whole manifest** — the package shows up as invalid
with a reason rather than silently losing capabilities.

The user sees exactly what you request in a permission dialog and can decline.
Request only what you need — an empty `streams`/`actions` widget renders with a
"nothing" permission summary, which users trust most.

## The sandbox (what your widget can and cannot do)

- Your page runs in `<iframe sandbox="allow-scripts">` and every asset is served
  with a strict CSP. That means: **no network access of any kind** (no fetch,
  XHR, WebSocket, EventSource), no cookies/localStorage, no reach into the
  dashboard DOM, no popups, no forms, no top-navigation. (Persistence isn't lost
  — you get a host-mediated key/value store instead; see *Persistent storage*.)
- **Inline `<script>` is blocked** (`script-src 'self'`) — put all JS in files.
  Inline `<style>` is allowed.
- Images/fonts must be bundled in your package or `data:` URIs.
- **Keyboard events reach you only while your frame has focus.** A `keydown`
  listener inside the iframe hears nothing until the user has clicked or tapped
  inside your widget, and focus goes back to the dashboard as soon as they touch
  anything else. So never make a key the only way to use your widget: pointer and
  touch input must cover the same ground, which is what the touchscreen needs
  anyway.
- **You cannot render a website inside your widget**: not in an iframe, not in an
  `<embed>`, not by fetching it. If your widget's job is to put a web page in front
  of the user, ask for the `browser` action category instead: you name the address
  and the dashboard's Browser tile shows it. See *Opening a page on the dashboard*.
- All data arrives over `postMessage` from the host; all effects go back the
  same way.

## Performance (your widget shares the dashboard's CPU)

Your widget renders inside a dashboard that users keep open 24/7 on a secondary
screen — often while gaming. A widget that keeps the browser's main thread busy
raises CPU load and temperatures for the whole machine (this class of bug is
exactly what GitHub issue #99 was about). Rules of thumb:

- **Never run an `infinite` CSS animation on a non-compositable property** —
  `box-shadow`, `text-shadow`, `background-position`, `width`, `top`/`left`,
  colors. These force a style recalc + repaint on every display frame, forever.
  Animate `transform`, `opacity` or `filter` instead: they run on the GPU
  compositor at ~zero main-thread cost. A pulsing glow is a static shadow plus
  a pseudo-element whose opacity blinks.
- **Let `requestAnimationFrame` loops stop.** Run rAF only while something is
  actually moving; when the animation settles, don't schedule the next frame.
- **Don't poll with tight timers.** Data arrives as `data` pushes — re-render
  when a message arrives, not on an interval. If you must tick (a clock), tick
  once per second.
- **Batch DOM writes and update only what changed.** Rewriting text or styles
  at display rate forces continuous layout work (we've measured a widget doing
  ~150 layouts/second — that alone can spin fans on a laptop).

The host already helps from the outside: your frame receives no `data` while your
tile is off screen, and the browser throttles off-viewport frames. But the host
cannot stop a timer inside your iframe — only you can. Listen for
[`visibility`](#4c-visibility--host--widget) and stop your own work when you are
told you are hidden. While your widget is visible, its cost is entirely yours.

## The bridge protocol (v1)

Every message in both directions is an object with `xenonSdk: 1` plus a `type`.
Send to `window.parent` with target origin `'*'` (the host validates the
source, not the origin — your frame's origin is opaque by design).

> **Why `'*'`, and why your listener need not check `event.origin`.** Your frame
> is sandboxed without `allow-same-origin`, so its origin is the opaque string
> `"null"`: there is no stable origin for you to target or to compare against.
> The host does the check that matters on its side: it matches the
> `event.source` against the frame it created, so a message from any other frame
> is dropped before it is read. Nothing you receive can therefore come from
> somewhere else, and nothing you send goes anywhere but the host.
>
> What this does **not** protect is the reverse direction inside your own frame:
> if some other code ends up running in it, it can post messages your handlers
> will treat as host messages. Treat `init`/`theme`/`fetch_result` as data to
> validate, not as trusted state, the same way you would treat a network
> response. Do not build a security decision on having received an `init`.

### 1. Handshake — widget → host

```js
window.parent.postMessage({ xenonSdk: 1, type: 'hello' }, '*');
```

### 2. `init` — host → widget

Sent after `hello`. Contains what the user actually granted (which may be less
than the manifest requested):

```js
{
  xenonSdk: 1, type: 'init',
  api: 1,
  theme:  {
    appearance: 'dark'|'light',
    // Which SKIN the dashboard is wearing: 'glass' (Liquid Glass) or 'retro'
    // (Pixel Retro). The palette cannot carry this — Retro differs in SHAPE
    // language, not colour: square corners, 2px borders, hard offset shadows
    // with no blur, and a monospace face. A widget that follows only the palette
    // still renders as a glass card inside a pixel dashboard. See *Following the
    // skin* below. Also present on every `theme` refresh.
    skin: 'glass'|'retro',
    // true when the user runs a 12-hour clock. The setting is Settings → Clock →
    // Time format (auto / 12 / 24), already resolved for you: `auto` follows the
    // interface language, so you never have to guess from the locale. Use it
    // whenever your widget renders a time of day — since v4.11.7 the whole
    // dashboard honours this, so a widget that formats by locale instead is now
    // the one thing on screen disagreeing with everything around it. Also
    // present on every `theme` refresh, so a live toggle updates without a
    // reload.
    clock12: false,
    // Explicit per-tile role overrides, empty for the global palette:
    overrides: ['accent', 'panel'],
    // Flat legacy aliases remain available:
    accent: '#1ed760', background: '#070808', text: '#f0f3f1',
    // Complete, contrast-checked semantic palette:
    palette: {
      background: '#070808', surface: '#111314', surfaceAlt: '#16191a', control: '#1c2021',
      text: '#f0f3f1', muted: '#a6b1ad', dim: '#7f8a86', line: '#46504c',
      accent: '#1ed760', onAccent: '#111111',
      success: '#45d483', onSuccess: '#111111',
      warning: '#f0b84f', onWarning: '#111111',
      danger: '#ff6268', onDanger: '#111111',
      info: '#62cbea', onInfo: '#111111',
      // Optional — the nested-card surface at the user's panel opacity, and that
      // alpha as a number. null when unavailable; fall back to surfaceAlt.
      surfaceSoft: 'rgba(22, 25, 26, 0.92)', panelAlpha: 0.92
    }
  },
  lang:   'en',                       // active UI language (en/it/ko/ja/zh)
  streams: ['system', 'media'],       // granted data streams
  actions: ['media'],                 // granted action categories
  // Granted boolean capabilities you have to know about because YOU decide
  // whether to use them. See "Clipboard", "Dashboard accent", "Filling the
  // screen". `expand` is false in a service or ambient frame whatever the grant
  // says, so you can use it directly to decide whether to draw the affordance.
  clipboard: false, accent: true, expand: true,
  // Which frame you are. A package declaring `background: true` runs a hidden
  // service frame AND any mounted tile — the same code, twice. Use this to keep
  // side effects (a badge refresh, a scheduled write) in exactly one of them.
  // See "Background service frames".
  service: false,
  // Addresses the user typed into your `userHosts` slots, keyed by slot id.
  // Only slots they actually filled appear. See "User-supplied addresses".
  userHosts: {
    nas: { host: '192.168.1.50', port: 32400, scheme: 'http', base: 'http://192.168.1.50:32400' }
  }
}
```

Immediately after `init`, the host replays the latest cached payload of each
granted live stream as `data` messages, so you paint without waiting for the
next tick. The three richer Discord snapshots are loaded only when a visible
widget explicitly requests them, as described below.

### 3. `data` — host → widget

```js
{ xenonSdk: 1, type: 'data', stream: 'system', data: { …server payload… } }
```

The payloads are the dashboard's own SSE events, unmodified:

- `status` — mic mute, game mode/activity, foreground process
- `system` — `cpu` (%), `gpu` (%|null), `memory.percent`, temperatures, clock speeds, `fps`, uptime… see *Clock speeds and frame rate* below
- `media` — `title`, `artist`, `album`, playback state, source, plus `position` and `duration` in seconds. A zero/absent `duration` means the current source has no seekable timeline
- `audio` — volume, mute, output device, and `speakerApps[]` / `micApps[]`: the per-application mixer (one entry per active session, with `proc`, `volume`, `muted` and a resolved `icon`). Polled, so it updates about every 8 seconds
- `audioLevels` — **how loud each app actually is right now**: `{ "discord": 0.42, "spotify": 0.81 }`, peak per process in `0..1`, roughly 12 times a second. See *Real audio levels* below — this one has conditions
- `stocks` — the quotes/indices the user follows (same payload the Stocks tile gets)
- `football` — followed teams' fixtures, live scores and results
- `news` — merged headlines from the user's news sources
- `claude` — local Claude Code usage aggregate (the "Xenon Pulse" data)
- `obs` — OBS state (current scene, recording/streaming flags, audio sources)
- `discord` — Discord voice state (connected, mute/deafen, current channel, speaking) plus `members[]` for the channel the user is in: `{ id, name, mute, deaf, speaking, volume, localMute }`. `mute`/`deaf` are that person's own mic state; `volume` (0-200, `null` if unreported) and `localMute` are what THIS machine hears — the pair `discordUserVol` writes
- `discordChannels` — `{ ok, channels:[{ id, name, guild, members:[] }] }`; Discord voice-channel catalog merged with the live roster (same `members[]` shape)
- `discordSoundboard` — `{ ok, sounds:[{ id, guildId, name, guild }] }`; the soundboard catalog available to the connected Discord account
- `discordNotifications` — `{ ok, enabled, hide, state, items:[...] }`; private DM/mention notifications, with the user's privacy setting preserved. Request this grant only when the widget genuinely displays notification content
- `streamerbot` — Streamer.bot connection state, globals, and activity events
- `twitchWatch` — `{ ok, connected, error, live:[…], playing:{…}|null }`; the channels the user follows that are on air, and the one playing in the Twitch tile. See *Watching Twitch and YouTube* below
- `twitchChat` — `{ ok, channel, connected, messages:[…] }`; the chat of the channel being watched, already split into text and emotes. Push-only, see below
- `youtubeLive` — `{ ok, error, live, title, health, privacy, viewers, totalViews, likes }`; the user's own YouTube broadcast
- `homeassistant` — Home Assistant device/entity states (privacy note: this exposes your smart-home state — grant it deliberately)
- `tasks` — `{ tasks: [...] }`, the user's to-do list; pushed on every change
- `notes` — `{ v, activeId, notes: [...] }`, the user's notes (privacy note: this is your private scratchpad text — grant it deliberately); pushed on save
- `agenda` — `{ events: [...] }`, the user's calendar events; pushed on every change. **Every event, not the slice the Upcoming tile shows.** That tile has its own count and horizon in Settings → Calendar, and they are display settings for the tile alone: what reaches you here is unfiltered, so filter and sort it yourself rather than assuming a window
- `battery` — wireless peripheral battery levels (see *Hardware sensors*)
- `processes` — **which apps are using the CPU, memory and GPU right now**. See *Which apps are busy* below; like `audioLevels`, this one has conditions

`wavelink` and these last four are read-only data feeds; you also get the latest
cached payload replayed right after `init`, so you paint without waiting.

### Real audio levels (`audioLevels`)

This is the only stream that measures the sound itself rather than a setting.
Peak per process, `0..1`, about 12 times a second:

```js
if (m.type === 'data' && m.stream === 'audioLevels') {
  // { discord: 0.42, spotify: 0.81 } — only apps currently making sound
  for (const [proc, peak] of Object.entries(m.data)) drawMeter(proc, peak);
}
```

Four things to design around, or your widget will look broken on someone else's
machine:

1. **It can be absent, and that is normal.** It needs Xenon Helper, the optional
   native companion, and Windows has no way to read peak levels without it — so
   there is no fallback to degrade to. There is no separate switch to turn it on:
   the user granting your package this stream is what starts the measurement, and
   it stops when no granted package is left (or under safe mode / package pause).
   Treat "no `audioLevels` data" as the ordinary case and draw something sensible
   without it.
2. **Silence sends nothing.** Apps at digital silence are omitted from the map
   instead of being sent as `0`, so a process that vanishes from one tick to the
   next has gone quiet — it has not closed. Decay your meters toward zero rather
   than dropping them.
3. **The keys are process names**, lower-case and without `.exe` (`discord`,
   `chrome`). They match the `proc` field in the `audio` stream, which is how you
   pair a level with the app's name, icon and volume.
4. **It re-renders you continuously.** Twelve payloads a second is a lot of work
   to hand a widget. Keep the paint cheap, and remember the host stops sending
   `data` while your tile is off-screen (see §4c) — resume from the visibility
   message rather than assuming the feed was uninterrupted.

Peak is the same measure the Windows volume mixer draws, already scaled by the
app's own volume: a quiet app reads quiet.

When the measurement is wanted but cannot run — practically always a helper older
than the one that introduced it — the host sends one payload of the shape
`{ peaks: {}, problem: 'helper-too-old', minVersion: '0.7.0' }` on this same
stream. Handle it if you want to explain yourself to the user; ignore it and you
simply get no data, which is the case you already handle.

### Which apps are busy (`processes`)

The per-application view of the machine — the data behind a task-manager widget.
One payload every 2 seconds:

```js
if (m.type === 'data' && m.stream === 'processes') {
  const { apps, cpu, cores, totalMB, usedMB, gpuAvail, gpus } = m.data;
  // apps: [{ n: 'chrome', c: 2.1, m: 1840, g: 3.4, gs: { 1: 3.4 } }, …]
  //   n = process name, lower-case, no .exe   c = CPU %   m = RAM in MB
  //   g  = GPU % on the app's BUSIEST adapter
  //   gs = GPU % per adapter, keyed by its index in `gpus` (absent when idle)
  // gpus: [{ i: 0, id: '<luid>', name: 'NVIDIA GeForce RTX 5080', t: 12.4 }, …]
  // cpu = total across EVERY process, not just the rows in `apps`
  for (const app of apps) addRow(app);   // app.n is TEXT: use textContent
}
```

Six things to design around:

1. **Nothing runs until you are granted it.** There is no setting and no
   collector running in the background waiting to be asked: the server starts
   sampling because your package holds this grant and a dashboard is open, and
   stops the moment that stops being true (including under safe mode and package
   pause). That is also why you should not request it "just in case" — an unused
   grant here is real CPU on someone else's machine.
2. **`g` is zero on macOS and Linux, and `gpuAvail` tells you so.** Per-process
   GPU exists on Windows through the WDDM performance counters. It does not exist
   on macOS outside private APIs, and on Linux it covers one vendor at a time.
   When `gpuAvail` is `false`, **hide the GPU column** rather than drawing zeros:
   a column of zeros reads as "nothing is using the GPU", which is worse than no
   column at all.
2b. **A PC can have several graphics adapters, and a process runs on ONE of
   them.** `gpus` lists them (busiest first, stable order, named where Windows
   can name them) and `app.gs` gives that app's load per adapter. On a hybrid
   machine this is not a detail: measured on a laptop-style desktop,
   `msedgewebview2` sat at 14.6% on the **integrated** Radeon while the discrete
   RTX genuinely read 0%, so a widget folding the adapters together shows a
   number belonging to no chip and openly contradicting the dashboard's own GPU
   tile, which reads one card. If `gpus.length > 1`, say which adapter your
   figure is for, and let the user pick. `g` is the app's busiest adapter, never
   a sum.
3. **One row per app, not per process.** Twenty `chrome` processes arrive as one
   `chrome` row with their RAM summed, the way a task manager shows them.
4. **You get the union of the top 8 of each metric, not a single top list** —
   typically ~15 rows. A memory hog that uses no CPU is in there, and so is a
   GPU-only process. Sort client-side for whichever column you are drawing;
   the rows arrive sorted by CPU.
5. **`c` is a real delta, and a just-launched app reads 0%.** CPU is measured
   between one poll and the next rather than sampled, which is what makes the
   stream cheap. A process that appeared inside the window contributes its memory
   but no CPU, because charging it its whole lifetime's CPU in one tick would make
   every app you just opened look like it was pinning a core.

6. **Show `cpu` if you show a truncated list.** It is the total across every
   process, including the ones that did not make the cut. Without it your rows
   add up to visibly less than the machine's own CPU figure and the widget reads
   as wrong, when the difference is only the long tail. It is also the number to
   compare against the `system` stream's `cpu`, which additionally counts kernel
   and interrupt time and so runs a little higher.

`totalMB`/`usedMB` are system-wide RAM, so a widget showing this needs no second
grant for the memory total. If the data cannot be collected at all (the sensor
host is down), the host sends `{ problem: 'unavailable', apps: [] }` once on this
stream — say so in your empty state instead of rendering an idle-looking machine.

The rich Discord streams are **lazy snapshots**, not polling feeds. Request one
only while its UI is visible:

```js
window.parent.postMessage({
  xenonSdk: 1,
  type: 'refresh',
  id: 7,
  stream: 'discordChannels'
}, '*');
```

The host replies with the usual `data` message and then a
`{ type:'refresh_result', id:7, stream:'discordChannels', ok:true }` result.
Only fixed stream names are accepted: a widget cannot provide a
URL or endpoint. Refreshes require the matching user grant, are rate-limited,
and are rejected for hidden tiles and background service frames. The channel
and notification snapshots are cached for 5 seconds; Soundboard is cached for
60 seconds. `twitchWatch` and `youtubeLive` (below) refresh the same way, at 60
seconds.

Treat every string in them as untrusted display text: render with
`textContent`, never `innerHTML`.

### 3a. Watching Twitch and YouTube (v4.11)

Three streams and one action category cover the Twitch and YouTube tiles. The
rule behind all of them: **the SDK never gets its own connection to Twitch or
YouTube, it gets a copy of the one the builtin tile already has.** When that tile
is on the dashboard your widget costs nothing at all; when it is not, the two
snapshot streams fall back to a same-origin read, and the chat simply has nothing
to give you.

**`twitchWatch`** — who is live and what is playing:

```js
{
  ok: true, connected: true, error: '',
  live: [ { login, name, title, game, viewers, image, live } ],  // channels the user follows
  playing: { login, name, title, game, viewers, image } | null   // in the Twitch tile right now
}
```

`live` is only ever the **Followed** list, and it is empty until the user's Twitch
account has been connected with the follows permission — `connected: false` is a
normal state to draw, not an error. Refreshable (60 s).

**`twitchChat`** — the chat of the channel being watched:

```js
{
  ok: true, channel: 'somechannel', connected: true,
  messages: [ { seq, name, text, color, parts: [ … ] } ]
}
```

`parts` is the message already split for you: `{ type:'text', text }` and
`{ type:'emote', id, name, url }` in reading order, so you can draw emotes without
parsing Twitch's index format (which counts code points, not characters, and is a
reliable way to be off by one). `url` points at Twitch's emote CDN, which the
sandbox will not let you load directly — declare `static-cdn.jtvnw.net` in your
manifest `hosts` and fetch it through the proxy (§6), which hands binary back as
base64 for a `data:` URI. Or just draw `name`.

Four things about this stream specifically:

- It is **push-only**. There is no loader behind it: a `refresh` answers
  `not_refreshable`, on purpose. A widget must not be able to make Xenon hold a
  socket open to Twitch on a dashboard nobody is watching.
- It arrives **only while the Twitch tile is playing a channel and its chat card
  is switched on**. No tile, no chat.
- It is a **snapshot, not events**: up to 40 messages, coalesced to about two
  payloads a second. Use `seq`, which only ever increases, to tell what you have
  already drawn. This is deliberate — the host stops feeding off-screen frames
  (§4c), and a snapshot lets you come back to the current conversation instead of
  a hole.
- `connected: false` with messages still in the list means the feed stopped (a
  reconnect, the card switched off). Keep drawing them, do not clear.

Every name, message and colour here was typed by a stranger in a public chat.
`textContent`, always.

**`youtubeLive`** — the user's own broadcast: `live`, `title`, `health`,
`privacy`, `viewers`, `totalViews`, `likes`. Refreshable (60 s), and this one has
a real cost: reading it spends YouTube API quota, so the fallback path is slower
than the tile's own poll and you should not hammer it. The live chat of that
broadcast is deliberately not exposed.

Nothing here lets a widget write: no sending a chat message, no starting or
configuring a broadcast, no stream key. Writing in someone's chat publishes text
in public under the user's name, and that needs a human tap in the tile that owns
it.

### 3b. Hardware sensors — fans, power draw, device battery (v4.5.3)

Fan RPM and power draw need **no extra grant**: they ride the `system` payload
you already get from `streams: ["system"]`.

```js
{ // …the rest of the system payload…
  fans: [
    { name: 'Fan #1', kind: 'mb', rpm: 980 },        // a motherboard fan header
    { name: 'Kraken X63 Pump', kind: 'ctrl', rpm: 2680 }, // an AIO/fan-hub controller channel
    { name: 'GPU Fan 1', kind: 'gpu', rpm: 1450 },   // one entry per fan on the card
    { name: 'GPU Fan 2', kind: 'gpu', rpm: 1470 },
    { name: 'Case', kind: 'psu', rpm: 0 },           // the PSU's own fan, when it reports one
  ],
  power: { cpu: 68.4, gpu: 142.1, psu: 260, total: 210.5 },  // watts; any field may be null
  sensorAccess: 'ok',                          // 'ok' | 'needs_admin' | 'missing'
}
```

Four rules that will bite you if you skip them:

- **A fan carries `rpm` OR `pct`, never both.** LibreHardwareMonitor reports real
  RPM; a card LHM cannot read falls back to nvidia-smi's percentage. Check which
  field is present and label the unit accordingly — never print a percentage as RPM.
- **`name` may be the USER's name, not the hardware's.** A board only ever says
  "Fan #3", so Xenon lets people rename a fan in the Fans widget and forwards that
  name to you — treat it as the label to show, and as your only clue that a header
  drives a pump (match `/pump/i` and scale it against ~4800 RPM, not a fan's
  ~2200, or a healthy AIO pump paints permanent redline). It is still untrusted
  display text: `textContent`, never `innerHTML`.
- **Identify fans by `kind`, not by `name`.** `'mb'` is a motherboard header,
  `'ctrl'` is a channel on an AIO/fan-hub controller (NZXT Kraken, Aquacomputer
  Octo/Quadro, MSI CoreLiquid…), `'psu'` is the power supply's own fan, `'gpu'`
  is on the graphics card. Names come from the hardware, and a motherboard
  header can literally be called "GPU". Treat an unknown `kind` as a motherboard
  header rather than dropping it.
- **`fans` is what the hardware exposes, not every fan in the case.** Fans report
  through a motherboard header or a supported hub/AIO controller: a fan on an
  unsupported controller (e.g. Corsair iCUE Link) bypasses both, and two fans on
  a splitter report as one. Never present the list as a complete inventory —
  users will count their case fans and find fewer here.
- **Every number is nullable, and `Number(null)` is `0`.** A missing sensor must
  render as an empty state, not a confident `0 W`. Guard with `v != null` BEFORE
  `Number.isFinite(Number(v))`, or you will invent readings that don't exist.

`power.total` is strictly CPU+GPU (present only when both are known) — it is not
a whole-system estimate. `power.psu` is the PSU's **measured output** — every
rail, so the real whole-PC draw — and appears only when a PSU that connects over
USB (Corsair HXi/RMi and similar) is present; treat it as absent on most
machines. It is **not** the wall-socket figure: conversion losses put that
roughly 10% higher, and no PSU here reports it, so never label `power.psu` as
"from the wall".

**`psu` already contains `cpu` and `gpu`** — it is the total, not a fourth
component. Adding them together counts the processor and the graphics card
twice and produces a number that describes nothing. Show `psu` as the total and
`cpu`/`gpu` as its parts; `psu - cpu - gpu` is everything else the supply feeds
(motherboard, RAM, drives, fans), and it is worth showing precisely because it
makes the parts add up to the total. Guard it: the PSU's registers are read one
at a time, so a bouncing load can briefly make the parts out-total the whole —
drop the remainder when it comes out `<= 0` rather than rendering a negative
watt. Next to a `psu` reading, `total` is redundant by construction.

`sensorAccess` tells you **why** `fans`/`power.cpu`/`power.psu` are empty, so your
empty state can name the real fix: `needs_admin` means LibreHardwareMonitor is
installed but the host isn't elevated, so its kernel driver never loaded —
telling that user to "install LHM" sends them in circles. `missing` means no LHM
at all. GPU watts come from nvidia-smi and are unaffected by either.

The `battery` stream is separate — it broadcasts on its own ~90s tick:

```js
{ devices: [{ id: 'k100 air', name: 'K100 AIR', percent: 62, charging: null, source: 'corsair' }],
  sources: { corsair: true, bluetooth: true } }
```

`source` is `'corsair'` (via the iCUE bridge), `'bluetooth'`, or `'system'` (a
laptop battery pack or a USB-connected UPS, via Win32_Battery). `charging` is a
real boolean only for `'system'` entries — neither the iCUE SDK v4 nor the
Windows Bluetooth property exposes a charging state, so it stays `null` for
those. `sources` tells you whether each backend answered at all, so you can
distinguish "no devices" from "iCUE is off". Peripherals on a proprietary
2.4GHz dongle (Logitech Unifying/Lightspeed and most custom keyboards) report no
battery to Windows and cannot appear.

### 3c. Clock speeds and frame rate (v4.11.7)

Four more numbers ride the `system` payload, so `streams: ["system"]` is the
whole grant — there is nothing extra to request and nothing new to approve.

```js
{ // …the rest of the system payload…
  cpuClockMHz: 4550,     // the fastest core right now, in MHz
  gpuClockMHz: 2610,     // GPU core clock
  vramClockMHz: 10501,   // GPU memory clock
  fps: 143,              // frames per second in the game being played
}
```

- **`cpuClockMHz` is the fastest core, not an average.** An average reads low the
  moment the OS parks half the cores, which on an idle desktop is most of the
  time — so it would show a number nobody recognises. On Apple Silicon it is the
  performance cluster, for the same reason.
- **`fps` is `null` unless a game is actually being measured.** It comes from
  PresentMon on Windows and MangoHud on Linux, and there is no source on macOS,
  so `null` there always. `null` means "nothing to report", never zero.
- **Every one of them is nullable**, and on more machines than you would guess:
  a clock needs LibreHardwareMonitor with sensor access (`sensorAccess: 'ok'`),
  `vramClockMHz` has no meaning on Apple Silicon's unified memory, and a card or
  driver that answers `[N/A]` leaves the field null rather than zero. `Number(null)`
  is `0`, so guard with `v != null` before formatting or you will print a
  confident `0 MHz` where the truth is "not readable here".

**On how often they arrive.** `system` is pushed every 5 seconds by default, and
these four are on that tick like everything else. That cadence is deliberate: the
sensor reads underneath it are LibreHardwareMonitor round-trips held in a cache
of the same length, paid continuously on a machine that is often also running the
game being measured.

**The user can raise it** in Settings → Performance → *Sensor refresh rate*: 5
seconds, 2, or 1. It moves the broadcast and the caches together, so 1 second
really is 1 second rather than the same reading sent five times. Each step says
what it costs where it is chosen, because five times the hardware reads is a real
price and it is theirs to accept.

**A widget cannot ask for it, and should not need to.** Write for the default and
interpolate between ticks for a smooth-looking number; if someone has raised the
rate, the same code simply gets fresher values. Never assume an interval — read
the payload when it arrives. A widget that treats 5 seconds as a constant will be
wrong on the machines that care most about it.

### 3d. `lang` — host → widget (v4.11.8)

The `init` payload carries `lang` (the dashboard's language code). It is also
**pushed whenever the user changes the language**, so a widget already on screen
can re-render its own text:

```js
{ xenonSdk: 1, type: 'lang', lang: 'de' }
```

Handle it if your widget shows text of its own. Before v4.11.8 the code arrived
only at mount, so a widget open while its owner switched language stayed in the
old one until something reloaded it — which looked like the widget ignoring the
setting.

Xenon itself ships in eleven languages, so a widget that follows this is one
that feels native to everyone who installs it. A widget with no text of its own
can ignore the message entirely.

### 4. `theme` — host → widget

Sent whenever the dashboard theme changes: `{ type: 'theme', theme: {…} }`.
Use `theme.palette` for new widgets. `surface` is the tile/modal surface,
`surfaceAlt` is a nested row/card, and `control` is an input or button well.
Use every `on…` value on top of its matching filled colour. The host derives
missing theme roles and applies its contrast guard before this payload is sent.
The palette is computed for this widget's own tile, so per-widget overrides
already appear in these values even though the widget runs in an iframe.
`theme.overrides` lists the role keys explicitly changed on that tile; most
theme-reactive widgets can ignore the list and apply the complete palette.

**Follow the user's panel opacity (optional).** Native tiles and their inner
cards get more see-through as the user lowers **Opacità pannelli** (Settings →
Aspetto → Superficie), so a background image shows through them. Two optional
palette values let your widget match that instead of looking heavier than the
rest of the dashboard:

- `palette.surfaceSoft` — the same colour as `surfaceAlt` but already carrying
  the current panel alpha, as an `rgba(…)` string. Use it as the background of a
  card/row you want to turn glassy with the dashboard.
- `palette.panelAlpha` — that alpha as a plain `0..1` number, if you would rather
  build your own colour from it.

Both are `null` on older hosts, or when the tile's tokens can't be read — always
fall back to the solid `surfaceAlt`. Keep using the solid `surfaceAlt` for any
surface you want to stay opaque no matter what the user sets.

### The white-tile trap: declare a `color-scheme`

If your widget renders as a solid **white block** inside the dark dashboard while
every background in your CSS is `transparent`, this is why, and no amount of
staring at your own stylesheet will find it.

A sandboxed iframe is composited transparently only while its used
`color-scheme` **matches the embedding document's**. A widget that declares none
is treated as light; Xenon's dashboard is dark; the two disagree, so the engine
paints an **opaque canvas** underneath your transparent backgrounds. The widget's
own CSS is blameless and unchanged, which is what makes this so hard to spot.

Declare one, and keep it in step with the theme:

```css
:root { color-scheme: dark; }          /* sensible default */
```
```js
document.documentElement.style.colorScheme =
  theme.appearance === 'light' ? 'light' : 'dark';   // on init AND on theme
```

The same mechanism, in the opposite direction, is documented in
`server/spotlight.html` for the frameless native window: setting a scheme there
*creates* the opaque backdrop it must not have. Either way the rule is the same —
the canvas is transparent only when the scheme is what the surrounding surface
expects.

### Following the skin (`theme.skin`)

`appearance` tells you light or dark; `skin` tells you which of Xenon's two visual
languages is on. Reacting to it is what separates a widget that *matches* the
dashboard from one that merely uses its colours.

```js
document.documentElement.classList.toggle('retro', theme.skin === 'retro');
```

What Pixel Retro actually is, so you can mirror it rather than invent it (the
source of truth is `server/styles/themes-retro.css`): **zero border radius**
everywhere, **2px** borders instead of hairlines, **hard offset shadows** with no
blur (`3px 3px 0 rgba(0,0,0,.55)`), no top-light wash or glass sheen, uppercase
micro-labels, and the `'VT323', 'Courier New', monospace` stack. VT323 is loaded
by the host document and will **not** resolve inside your sandboxed frame, which
is fine: name it first and let Courier New take over, exactly as the app does on
a machine without the font. Do not bundle a pixel font for this.

Two things worth not getting wrong. Any transition or easing should be dropped or
stepped under Retro — a CRT console does not glide. And if you set sizes through a
container query, remember the query can only style **descendants** of the
container element, so `container-type` on your root plus `@container { :root {…} }`
is a silent no-op: put the container on `body` and the variables on the element
below it.

A dual-palette theme (one that ships both a light and a dark half — see
[THEME_SYSTEM.md](THEME_SYSTEM.md#dual-palette-themes)) is resolved before the
payload is built, so `appearance` and `palette` always describe the tone actually
on screen. A widget that reacts to `theme` messages needs no special handling: it
receives a fresh one when the user switches mode, and when Windows flips scheme
while they are on Auto.

```js
function applyTheme(theme) {
  const p = theme && (theme.palette || theme); // fallback for older hosts
  if (!p) return;
  const vars = {
    background: '--bg', surface: '--surface', surfaceAlt: '--surface-alt', control: '--control-bg',
    text: '--text', muted: '--muted-text', dim: '--dim-text', line: '--line',
    accent: '--accent', onAccent: '--on-accent', success: '--success',
    warning: '--warning', danger: '--danger', info: '--info'
  };
  for (const [key, cssVar] of Object.entries(vars)) if (p[key]) document.documentElement.style.setProperty(cssVar, p[key]);
  // Optional: a card surface that follows the user's panel opacity. Fall back to
  // the solid surfaceAlt when the host didn't send it.
  document.documentElement.style.setProperty('--surface-soft', p.surfaceSoft || p.surfaceAlt);
}
/* …then style your cards with it: .card { background: var(--surface-soft); } */
```

### 4b. `size` — host → widget

Your tile's current pixel box and device pixel ratio, sent right after `init`
and again on every resize (dragging the tile, or a different surface):

```js
{ xenonSdk: 1, type: 'size', width: 480, height: 120, dpr: 2 }
```

Why it matters: a widget always fills its tile (`width/height: 100%`), and it
**does not auto-scale its content**. A desktop browser, a short wide touchscreen and a phone give
the same tile a *different* pixel size and DPR, and `vw/vh` inside the sandboxed
iframe resolve against the iframe's own box — so a layout built from viewport
units **reflows** and looks different on each surface (this is the usual "it's not
1:1" surprise). The fix is to design at a **fixed reference size** and scale the
whole thing to fit, using `size`:

```html
<div id="stage"><!-- your content, laid out for exactly REF_W × REF_H --></div>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  #stage { width: 400px; height: 100px; transform-origin: top left; }
</style>
<script src="fit.js"></script>
```

```js
// fit.js
const REF_W = 400, REF_H = 100;
const stage = document.getElementById('stage');
addEventListener('message', (e) => {
  const m = e.data;
  if (m && m.xenonSdk === 1 && m.type === 'size') {
    const scale = Math.min(m.width / REF_W, m.height / REF_H);  // contain; use max() to cover
    stage.style.transform = 'scale(' + scale + ')';
  }
});
parent.postMessage({ xenonSdk: 1, type: 'hello' }, '*');
```

Now the widget renders **identically** on the browser and the Edge — same
proportions, just scaled to whatever tile it's placed in. (You can read your own
size from `window.innerWidth`/`innerHeight` too, but `size` also carries `dpr` and
fires on tile resize.) Size the tile itself by dragging its corner in layout-edit
mode — that's the only thing that sets a widget's height.

**What `dpr` is for, and what it is not.** `width` and `height` are already the
tile's real CSS pixels; `dpr` never multiplies them. It exists for one job:
sizing a `<canvas>` **backing store** so your drawing isn't blurry on a
high-density surface.

```js
const CSS_W = 600, CSS_H = 400;             // the canvas' CSS box
canvas.style.width  = CSS_W + 'px';         // CSS px, never multiplied by dpr
canvas.style.height = CSS_H + 'px';
canvas.width  = Math.round(CSS_W * dpr);    // device px, the backing store
canvas.height = Math.round(CSS_H * dpr);
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);     // keep drawing in CSS px coordinates
```

Multiply a **CSS** size by `dpr` and your content comes out 1.25× to 2× bigger
than the tile on a Windows desktop at 125–200% scaling, while looking perfectly
fine on the Edge, where `dpr` is 1. The overflow is clipped, so whatever lives at
the edges of your layout (a paddle, a sidebar, a button) is simply not there on
the browser. If a widget looks right on one surface and cropped on the other,
this is the first thing to check.

### 4c. `visibility` — host → widget (v4.9)

Whether your tile is on screen right now. Sent immediately after `init`, then
again every time the answer changes:

```js
{ xenonSdk: 1, type: 'visibility', visible: false }
```

**You cannot work this out for yourself, so do not try.** `document.hidden`
inside your iframe follows the whole *browser* tab. It stays `false` when your
tile is behind another tab in a tab group, or on a dashboard page the user has
scrolled away from — cases where nobody can see you, which on an always-on
display is most of the time.

While `visible` is `false`: you receive no `data` pushes, `refresh` is refused
with `not_visible`, and the browser has already stopped your
`requestAnimationFrame` loop. What keeps running is **every `setInterval` and
`setTimeout` you started**, and that is CPU spent on a tile nobody is looking at.
Stop them:

```js
let timer = null;
addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.xenonSdk !== 1) return;
  if (m.type === 'visibility') {
    if (m.visible) { if (!timer) timer = setInterval(tick, 1000); tick(); }
    else { clearInterval(timer); timer = null; }
  }
});
```

When you come back, the host replays the current value of every stream you were
granted, so you do not need to re-request anything — just render what arrives.
Background **service frames** never receive this message: they exist precisely to
keep running out of sight.

### 4c-bis. Tile shape — `shape` (host → widget) (v4.11)

A tile does not have to be a rectangle. Either the user gives one a silhouette
from the style editor, or your package declares one for its own tile in the
manifest:

```json
{ "shape": { "preset": "hexagon" } }
{ "shape": { "path": "M .5 0 L 1 .5 L .5 1 L 0 .5 Z", "fit": "fit", "inset": 4 } }
```

The curated presets are `squircle`, `circle`, `hexagon`, `diamond`, `cut-corner`,
`parallelogram`, `ticket`, `arch`, `shield`, `wave` and `blob`. A `path` is your
own outline **drawn in a unit square**: x and y both run 0 → 1, so the same path
fits a 2×2 tile and a 12×4 one. It must start with `M`, be closed with `Z`, and
contain nothing but path commands and numbers — anything else is dropped, and
your package still installs. `"fit": "fit"` keeps the outline's proportions
instead of stretching it with the tile.

This is **not a permission**. It changes your own tile and nothing else, so there
is no dialog and no grant. Two things follow from that: a shape the *user* picked
for that tile always wins over yours, and you cannot shape anybody else's tile.

**Your content is clipped by the silhouette, so the host tells you where the
inside is.** You cannot measure this yourself — introspection stops at the iframe
boundary — so right after `init`, and whenever the shape changes, you receive:

```js
{ xenonSdk: 1, type: 'shape', path: 'M .12 0 L .88 0 …Z', fit: 'stretch',
  safe: { t: 2, r: 13, b: 2, l: 13 } }
```

`safe` is the margin to keep clear, in **percent of the tile**, per side. A tile
with no shape reports an empty `path` and zeros. Xenon already insets your frame
by that much, so a widget that ignores the message is simply laid out inside the
safe box; read it when you want to place something against the real edge (a
background, a full-bleed image) or to change layout inside a narrow silhouette:

```js
addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.xenonSdk !== 1 || m.type !== 'shape') return;
  document.body.classList.toggle('shaped', !!m.path);
  document.body.style.setProperty('--safe-x', m.safe.l + '%');
});
```

### 4d. `notice` — host → widget (v4.10)

Whether a Xenon pop-up is on screen right now. Sent immediately after `init`,
then again every time the answer changes:

```js
{ xenonSdk: 1, type: 'notice', active: true }
```

A pop-up does not hide your tile, so `visibility` never fires for one — but it
does cover part of the screen for a few seconds. This exists for widgets where
that matters: a game, a teleprompter, anything the user is actively following.
Pause on `active: true`, carry on when it goes back to `false`.

```js
addEventListener('message', (e) => {
  const m = e.data;
  if (m && m.xenonSdk === 1 && m.type === 'notice') {
    if (m.active) game.pause(); else game.resume();
  }
});
```

**It carries no content, and it never will.** You learn that something is
showing, never what it says: Xenon mirrors Windows notifications, which means
real message text, and a sandboxed widget has no business reading it. For the
same reason there is nothing to grant here — "a pop-up is up" is UI state, like
`visibility`.

There is also no way for a widget to suppress a pop-up. Whether an interruption
is worth showing is the user's call, not a widget's, and it is theirs to make in
Settings → Notifiche → **Non disturbare**, which can hold routine pop-ups back
while a full-screen scene or game mode is running. Errors, warnings, reminders
and timers always come through, on every setting.

Background **service frames** never receive this message.

### 4e. Filling the screen — `expand` (widget → host) (v4.11)

Declare `"expand": true` and — once granted — your widget may ask to paint its
tile over the **whole dashboard**. This is for content that a tile genuinely
cannot hold: a board, a map, a full-size game. It is the same thing the Browser
tile's `expand` does, for your own package.

```js
// Inside a click/tap handler on your own button:
parent.postMessage({ xenonSdk: 1, type: 'expand', id: 1, on: true }, '*');
// → { xenonSdk: 1, type: 'expand_result', id: 1, ok: true }
//   { xenonSdk: 1, type: 'expand_result', id: 1, ok: false, error: 'no_gesture' }

// Give the screen back:
parent.postMessage({ xenonSdk: 1, type: 'expand', on: false }, '*');
```

And the host tells you the current state — right after `init`, and again every
time it changes, including when the **user** collapsed you:

```js
{ xenonSdk: 1, type: 'expand_state', expanded: true }
```

**Always render from `expand_state`, never from your own request.** You can be
collapsed by things you never hear about otherwise: Escape, the ✕, a swipe to
another dashboard page, the user entering layout edit mode. Your tile also
receives the usual [`size`](#4b-size--host--widget) message when the box
changes, which is what you re-lay-out against.

Rules the host enforces, and why:

- **A live user gesture is required.** A tap inside your (sandboxed) frame
  carries user activation to the host for a few seconds, and that is the signal
  Xenon checks. Without it, `ok: false, error: 'no_gesture'` — so a widget can
  never take the screen while the user is reading something else. Send the
  request straight from the tap handler, not after an `await`.
- **One at a time, tiles only.** A second package asking replaces the first.
  Service frames are refused (`not_allowed` — there is nothing to show) and so
  is an `ambient` package, which already owns the screen.
- **Off-screen widgets are refused** (`not_visible`), and so is any request
  while the user is arranging the layout (`busy`).
- **Collapsing always works.** `on: false` is never rate-limited and never
  refused, whatever state the grant is in.
- **The way out is Xenon's, not yours.** The host draws a ✕ over your
  **top-right corner** (~20 px inset, ~38 px) and closes on Escape. Keep that
  corner clear of anything interactive while expanded, the same rule Ambient
  scenes follow.
- **You are not reloaded.** The tile is expanded in place, so your page keeps
  running with everything it held in memory, both ways.

Errors: `not_allowed` (not granted, or a service/ambient frame), `no_gesture`,
`not_visible`, `busy`, `unavailable`.

### 5. `action` — widget → host, and `action_result` — host → widget

```js
window.parent.postMessage({
  xenonSdk: 1, type: 'action',
  id: 42,                                   // your correlation id
  action: { type: 'media', cmd: 'playpause' }
}, '*');
// later:
// { xenonSdk: 1, type: 'action_result', id: 42, ok: true }
// { xenonSdk: 1, type: 'action_result', id: 42, ok: false, error: 'not_allowed' | 'rate_limited' | …server error code }
```

Actions per category (validated again server-side by Xenon's action registry —
the same gate Deck keys go through):

| Category | Actions |
|----------|---------|
| `media` | `{ type: 'media', cmd: 'playpause' \| 'next' \| 'previous' }`, `{ type: 'mediaSeek', position }` — seek to an absolute position in seconds. `position` must be finite and non-negative; fractional values are rounded to the nearest whole second and the registry caps them at 24 hours before the active player may clamp them to the track. A live/non-seekable source returns `not_seekable` or `unavailable`. While dragging a timeline, preview locally and send one action on pointer release instead of fighting the bridge's 250 ms action rate limit. |
| `volume` | `{ type: 'volume', mode: 'mute' \| 'up' \| 'down' \| 'set', value }`, `{ type: 'appVolume', app, mode, value }`, `{ type: 'appMute', app, mode }` — `app` is the `proc` field from the `audio` stream. Note `appVolume` with `mode:'set'` does **not** unmute: raise a muted app and send `appMute` too, or nothing comes out. |
| `audioDevice` | `{ type: 'audioDevice', device }` — make an output device the default, i.e. move your sound to another set of speakers or headphones. `device` is the `id` of an entry in the `audio` stream's `speakers[]`; nothing else works. A **separate grant from `volume`** on purpose: approving "change the volume" is not approving "choose my speakers", and folding the two together would have widened every existing grant with no prompt. The server resolves the id against the live output enumeration before acting, so an id that is merely well-formed — or that names a microphone — is refused. There is no action to change the *input* device. |
| `mic` | `{ type: 'micMute', mode: 'toggle' \| 'mute' \| 'unmute' }` |
| `lighting` | `{ type: 'lightPower', state: 'toggle' \| 'on' \| 'off' }`, `{ type: 'lightColor', color: '#rrggbb' }`, `{ type: 'lightAuto' }`, `{ type: 'lightEffect', style, color }`, `{ type: 'lightDevice', device, mode, color }` — the whole RGB system (iCUE + WLED/Hue/Nanoleaf/OpenRGB/Home Assistant lights/Chroma). `style`: `none\|solid\|breathing\|cycle\|wave\|aurora\|candle\|palette`; `mode`: `follow\|color\|animation\|temperature\|album\|off`; `color`: `#rrggbb`. `lightColor` sets a fixed colour across the whole rig, `lightAuto` clears it back to your configured lighting. Requires lighting configured in Settings → Illuminazione. |
| `chroma` | `{ type: 'chromaColor', device, color }`, `{ type: 'chromaOff', device }` — Razer Chroma per-device lighting (`device`: `all` \| `keyboard` \| `mouse` \| `mousepad` \| `headset` \| `keypad` \| `chromalink`; `color`: `#rrggbb`). Requires the user to enable Razer Chroma in Settings. |
| `wavelink` | `{ type: 'wlInputVolume', mixId, mix, value }`, `{ type: 'wlInputMute', mixId, mix }`, `{ type: 'wlOutputVolume', mix, value }`, `{ type: 'wlOutputMute', mix }`, `{ type: 'wlSwitchMonitoring' }`, `{ type: 'wlSetMonitorMix', monitorMix }` — Elgato Wave Link mixer (`mix`: `stream` \| `local` \| `all`; `value`: 0–100; `mixId` from the `wavelink` stream). Requires the user to enable Wave Link in Settings. |
| `steam` | `{ type: 'launchSteamGame', gameId }` — start a game the user owns, by Steam AppID. `gameId` is digits only (it becomes `steam://rungameid/<id>`), so a widget names a number, never a command. Steam has to be installed for the protocol handler to exist; nothing happens otherwise. Not part of `url`: that category is http(s) links, and it stays that way. |
| `voicemeeter` | `{ type: 'vmStripMute', strip, mode }`, `{ type: 'vmStripGain', strip, mode, value }`, `{ type: 'vmStripBus', strip, bus, mode }`, `{ type: 'vmBusMute', bus, mode }`, `{ type: 'vmBusGain', bus, mode, value }`, `{ type: 'vmMacro', index, mode }` — Voicemeeter strips, buses and routing (`strip`: index; `bus`: a LABEL, `A1`…`B3`; `mode`: `toggle` \| `on` \| `off` for the flags, `set` \| `up` \| `down` for gain; gain in dB, clamped to −60…+12). Windows only, and only while Voicemeeter is running. `vmParam` is a Deck-key privilege and is **not** in this category: it names any parameter the mixer has, `Command.Shutdown` included. |
| `spotify` | `spotifyPlay`, `spotifyNext`, `spotifyPrev`, `spotifySave`, `spotifyLike`, `spotifyShuffle`, `spotifyRepeat`, `spotifyVolume`, `spotifySeek`, `spotifyPlaylist`, `spotifyDevice` — control Spotify playback (params match the Deck Spotify actions; playback control needs Spotify Premium). Requires the user to connect Spotify in Settings. |
| `obs` | `obsScene`, `obsSceneNext`, `obsRecord`, `obsStream`, `obsMute`, `obsInputVolume` — OBS scenes, recording/streaming and audio. Requires OBS connected (WebSocket) in Settings. |
| `discord` | `discordMute`, `discordDeafen`, `discordPtt`, `discordJoin`, `discordLeave`, `discordInputVol`, `discordOutputVol`, `discordUserVol`, `discordUserMute`, `discordAudioToggle`, `discordSoundboard` — Discord voice via the local RPC. Requires Discord running and connected. See [Turning one person up or down](#5d-turning-one-person-up-or-down-discorduservol-v411) for the per-user pair. |
| `homeassistant` | `haToggle`, `haLight`, `haMedia`, `haCover`, `haClimate`, `haFan`, `haVacuum`, `haLock`, `haAlarm`, `haScene`, `haScript`, `haButton` — control your Home Assistant devices (params/entity ids match the Deck HA actions). `haCallService` (arbitrary service calls) is deliberately **not** exposed to widgets. Requires HA configured. |
| `twitch` | `twitchClip`, `twitchMarker`, `twitchAd`, `twitchTitle`, `twitchGame`, `twitchChat`, `twitchShoutout`, `twitchChatMode` — control your Twitch channel. Requires Twitch connected. |
| `youtube` | `ytBroadcast` — start/stop your YouTube broadcast. Requires YouTube connected. |
| `streamerbot` | `sbDoAction`, `sbSendMessage`, `sbCodeTrigger` — trigger Streamer.bot actions, send chat, fire code triggers. Requires Streamer.bot connected. |
| `url` | `{ type: 'openUrl', url: 'https://…' }` (http/https only). Opens in the user's **default browser**, on whichever monitor Windows puts it. Use `browser` below when the page should stay on the dashboard screen. |
| `browser` | `{ type: 'browserOpen', url: 'https://…', expand?: true }` (http/https only). Shows the page in the **Browser tile** already on the dashboard. See [Opening a page on the dashboard](#opening-a-page-on-the-dashboard-browser) below. |
| `watch` | `{ type: 'twitchWatchPlay', channel }` and `{ type: 'ytWatchPlay', video }` — play a channel or a video in the **Twitch** and **YouTube** tiles already on the dashboard. Pair with the `twitchWatch` stream to know what is live. See [Playing in the Twitch and YouTube tiles](#playing-in-the-twitch-and-youtube-tiles-watch) below. |
| `tasks` | `{ type: 'taskAdd', text }`, `{ type: 'taskToggle', id }`, `{ type: 'taskDelete', id }` — add / complete-toggle / delete a to-do in the same list the Tasks tile shows (pair with the `tasks` **stream** to read the list and each task's `id`). `text` is capped at 200 chars server-side; a new task is created with default (medium) priority. No external service required. |
| `soundboard` | `{ type: 'playSound', file, mode?: 'play' \| 'toggle' \| 'stop', volume? }`, `{ type: 'soundStopAll' }` — play clips from an **installed sound pack** (the `sounds` preset kind). `file` MUST be a pack-relative reference of the exact shape `packs/<packId>/<clipId>.<mp3\|ogg\|wav>` — arbitrary local paths are rejected for widgets (that stays a Deck-key-only, user-configured privilege). Same rule applies to `playSound` steps inside manifest `deck.actions` macros (validated at install). Playback happens on the surface where your widget runs. Ship your clips as a companion sound pack, or document which pack the widget expects. |

The `wavelink` **stream** pushes the live mixer state — `{ connected, inputs: [{ mixId, name, bgColor, localVolumeIn, streamVolumeIn, isLocalInMuted, isStreamInMuted, … }], output, monitorMix, switchState }` — so a widget can render real faders and read the `mixId`s to target. Razer Chroma and the whole-system `lighting` category are write-only (no stream): fire the actions or show a static control. Since there's no lighting stream, the whole-rig `lighting` actions (`lightPower`/`lightColor`/`lightAuto`/`lightEffect`) need no ids; `lightDevice` targets a device id you already know.

The `voicemeeter` **stream** does the same for Voicemeeter: `{ type, edition, strips: [{ index, mute, gain, routes: { A1: true, B1: false, … } }], buses: [{ index, label, mute, gain }] }`, sized to the edition that is running (Voicemeeter 3 strips / 2 buses, Banana 5 / 5, Potato 8 / 8). Target a bus by its **label**, never by its index: `B1` is bus 1 on Voicemeeter, bus 3 on Banana and bus 5 on Potato, so an index stored in a widget would point at a different output on someone else's machine. The stream is polled from the mixer's own change flag and only while a dashboard is connected, so it costs nothing on a PC that has no Voicemeeter.

> Local-hardware note: apps like Razer Synapse and Wave Link expose a **loopback** endpoint, which the sandbox and fetch proxy deliberately block. These `chroma`/`wavelink` categories are the supported path — Xenon's backend does the local talking, you request the category, the user grants it. Do **not** try to reach `127.0.0.1` from a widget; it won't work by design.

Actions are rate-limited to one per ~250 ms per widget instance.

#### `openUrl` and the destination prompt (v4.8)

`hosts` governs **fetch**, not links. A widget that opens articles, maps or
profiles sends the user to addresses it never declared and, for a feed-driven
widget, never chose: the destination comes from the data. So the **host** names
it: the first time your widget opens a given domain, Xenon shows the domain and
the user approves or cancels.

Consent is remembered per (widget, domain) for as long as Xenon is running, so a
reader is asked once per outlet, not once per headline. A domain listed in your
manifest `hosts` never prompts: the user already approved it at install.

A cancel comes back as a normal result, not an error to retry:

```js
{ xenonSdk: 1, type: 'action_result', id, ok: false, error: 'declined' }
```

Treat `declined` as "the user said no": return to the idle state, do not re-post
the action, and do not present it as a failure. Two things follow for your UI:

- **Show where a click leads**: the domain, next to the link. The prompt is a
  backstop, not a substitute for the user knowing before they tap.
- **Never fire `openUrl` without a user gesture.** An open the user did not ask
  for now produces a modal they did not ask for either.

### 5b. Opening a page on the dashboard: `browser` (v4.8)

Your widget cannot render a website itself. The sandbox serves `frame-src 'none'`
and `connect-src 'none'`, so there is no iframe, no embed and no fetch to a remote
origin; that is the core of the security model and it is not negotiable.

`openUrl` was the only way out, and it hands the address to Windows: the page opens
in the default browser, on the primary monitor. For a widget whose whole point is to
put something **on** the dashboard screen, that is the wrong screen.

The `browser` category fixes that without touching the sandbox. It has exactly the
shape of `openUrl` (you name an address, you never see the page) but the
destination is the **Browser tile** the user already has on their dashboard, which
renders the page for real and forwards touch, so pans, pinches and taps work.

```js
window.parent.postMessage({
  xenonSdk: 1, type: 'action', id: 7,
  action: { type: 'browserOpen', url: 'https://mapgenie.io/…', expand: true }
}, '*');
// { xenonSdk: 1, type: 'action_result', id: 7, ok: true }
// { xenonSdk: 1, type: 'action_result', id: 7, ok: false, error: 'no_browser_tile' }
```

| Field | |
|---|---|
| `url` | Required, `http:`/`https:` only. Anything else fails with `bad_url`. Public addresses only: loopback, LAN and intranet names fail with `blocked_host`. |
| `expand` | Optional. `true` paints the tile over the whole dashboard; in the kiosk app, the whole screen. The user leaves with Escape or the collapse button. |

Declare it in your manifest like any other category:

```json
{ "actions": ["browser"] }
```

Rules worth knowing before you build on it:

- **It navigates the tile the user is looking at, and brings one into view when
  there is none.** A Browser tile is never replaced out of sight. If none is on
  screen — it is the inactive tab of a tab group, or it lives on another dashboard
  page — Xenon activates that tab or scrolls to that page first, preferring a tile
  on the current page so a tab switch is chosen over a page change. This matters
  more than it sounds: a widget and the Browser it aims at are very often two tabs
  of one tile, which is the one arrangement in which they can never be visible
  together. `no_browser_tile` now means what it says, that the dashboard has no
  Browser tile at all; handle it by telling the user to add one. (Before v4.11 it
  also came back whenever the tile was merely hidden.)
- **It replaces the tile's active tab.** Treat it as "put this on screen", not as
  "open a window I own". The user can still use the tabs, the address bar and their
  own favourites afterwards.
- **You have no read access to that page.** No URL back, no content, no scroll
  position, no events. The Browser tile is a surface Xenon owns; your widget only
  ever names a destination.
- **Not available in manifest Deck macros.** `deck.actions` steps go through the
  Deck action validator, which does not know `browserOpen`; a macro declaring one
  fails at install rather than shipping a key that does nothing.
- **The user is told where you are sending them.** A host listed in your manifest
  `hosts` opens straight away, because they approved it at install. Any other
  address shows them the domain first and they can decline, which comes back as
  `error: 'declined'`, a normal answer rather than a failure to retry. Declare the hosts
  your widget really uses and the tile stays quiet.
- **Local addresses are refused.** `127.0.0.1`, `localhost`, `192.168.x`, `10.x`,
  `172.16-31.x`, `169.254.x`, `.local` names and bare intranet names all fail with
  `blocked_host`. The tile is a real browser with real cookies, so pointing it at
  the machine's own services would be a way around the sandbox, not a feature.

The user grants this at install time like every other category, listed as "Open web
pages in the Browser tile on your dashboard".

### 5c. Playing in the Twitch and YouTube tiles: `watch` (v4.11)

The same idea as `browser`, one step narrower. Your widget names a Twitch channel
or a YouTube video and the tile that already exists on the dashboard plays it.

```js
// Twitch
action: { type: 'twitchWatchPlay', channel: 'somechannel' }
// YouTube
action: { type: 'ytWatchPlay', video: 'dQw4w9WgXcQ' }
// { ok: true } — or { ok: false, error: 'unavailable' | 'bad_channel' | 'bad_video' }
```

```json
{ "actions": ["watch"] }
```

- `channel` is a Twitch login: lowercase letters, digits and underscore, up to 25.
  It does not have to be in the user's Followed list.
- `video` is a YouTube video id. It plays as a queue of one; you cannot load a
  playlist into someone's tile.
- `unavailable` means there is no such tile on any dashboard page. Say so rather
  than failing quietly.
- There is **no confirm dialog**, unlike `browserOpen`, and the reason is the
  shape of what travels: a channel login or a video id, re-validated by the tile
  against the same pattern its own rows use, landing in a player Xenon owns. No
  address, no cookies, no arbitrary destination.
- **It can start playing on a dashboard page the user is not looking at**, if that
  is where their Twitch tile lives. That is the point (a launcher widget on page 1,
  the player on page 2), but it does mean sound can start from a tap on a different
  page. Do not fire it on a timer.
- **You have no read access to the player.** What is playing comes back through the
  `twitchWatch` stream, if the user granted it, and never as an answer to this.
- **Not available in manifest Deck macros**, for the same reason as `browserOpen`:
  the Deck action validator does not know these types, so a macro declaring one
  fails at install instead of shipping a dead key.

Listed to the user as "Play a channel or a video in the Twitch and YouTube tiles".

### 5d. Turning one person up or down: `discordUserVol` (v4.11)

Two actions in the `discord` category act on ONE member of the voice channel the
user is in, exactly like dragging that person's slider in Discord's own
right-click menu. Both are **local playback**: they change what this machine
hears, they are invisible to everyone else in the channel, and they are not
moderation — no server permissions are involved.

```js
// Absolute volume, 0-200 (Discord's own per-user range; 100 is normal)
action: { type: 'discordUserVol', user: '123456789012345678', mode: 'set', value: '60' }
// Or nudge by 10
action: { type: 'discordUserVol', user: '123456789012345678', mode: 'up' }
// Local mute — you stop hearing them, their mic keeps working for everyone else
action: { type: 'discordUserMute', user: '123456789012345678', mode: 'toggle' }
```

```json
{ "streams": ["discord"], "actions": ["discord"] }
```

- `user` is the `id` of an entry in the `discord` stream's `members[]`. There is
  no name lookup: ask for the `discord` stream, draw the roster it gives you, and
  send back the id of the row the user touched.
- The same `members[]` entries carry **`volume`** (0-200, or `null` when Discord
  did not report it) and **`localMute`**, so a slider can open where the machine
  actually is instead of at a guessed 100. Do not confuse `localMute` with
  `mute`: `mute`/`deaf` are that person's OWN microphone state, which everyone in
  the channel sees, while `volume`/`localMute` are what YOU hear.
- Errors are named, and each one means something different to your UI:
  `not_in_channel` (the user is not in a voice call), `user_not_here` (that id is
  not in the current channel), `self_not_supported` (the user's own row, whose
  levels are `discordInputVol` / `discordOutputVol` instead), `bad_user`,
  `bad_value`. Hide the control on the user's own row rather than letting them
  discover it.
- Every call reads the channel before it writes, including an absolute `set`.
  Discord accepts settings for somebody who is not there and answers OK, so
  without that read a control on a stale row would report success and change
  nothing. It is one local round trip, and host-side rate limiting already caps
  a widget at four actions a second.
- **Discord restores per-user settings when the app that changed them
  disconnects.** Xenon holds its RPC connection open while any override is
  active, so a value the user set stays set — but it also means the whole thing
  resets if Discord is closed or the account is unlinked. Treat the stream as
  the truth and re-read it rather than caching what you last sent.

Requires Discord running and connected in Settings, like every other action in
the category.

### 5e. Driving the Voicemeeter mixer: `voicemeeter` (v4.11.7)

Windows shows Voicemeeter's virtual cards like any other sound device, so the
`volume` and `audioDevice` categories could always set "Voicemeeter Output"
loudness. Everything *inside* the mixer — per-strip gain, mute, and the
A1/A2/B1/B2 routing buttons — lives behind Voicemeeter's Remote API, which is
what this category reaches.

```js
// Mute the microphone strip
action: { type: 'vmStripMute', strip: '0', mode: 'toggle' }
// Set a strip's gain, in dB (-60…+12), or nudge it by 3
action: { type: 'vmStripGain', strip: '3', mode: 'set', value: '-6' }
action: { type: 'vmStripGain', strip: '3', mode: 'down', value: '3' }
// Routing: send strip 3 to bus B1 (the buttons on the mixer)
action: { type: 'vmStripBus', strip: '3', bus: 'B1', mode: 'toggle' }
// A whole bus
action: { type: 'vmBusMute', bus: 'A1', mode: 'on' }
action: { type: 'vmBusGain', bus: 'A1', mode: 'set', value: '0' }
// One of the user's own macro buttons
action: { type: 'vmMacro', index: '3', mode: 'toggle' }
```

```json
{ "streams": ["voicemeeter"], "actions": ["voicemeeter"] }
```

- **Read the stream before you draw anything.** It reports the edition and is
  sized to it: `{ type, edition, strips: [{ index, mute, gain, routes }],
  buses: [{ index, label, mute, gain }] }`. Voicemeeter has 3 strips and 2
  buses, Banana 5 and 5, Potato 8 and 8, so a widget that hardcodes eight faders
  draws five dead ones on most machines.
- **Target a bus by `label`, never by index.** `B1` is bus 1 on Voicemeeter,
  bus 3 on Banana and bus 5 on Potato. A widget that stored the index would
  mute a different output on somebody else's edition, silently. `routes` is
  keyed by the same labels, so `strips[3].routes.B1` and
  `{ type: 'vmStripBus', strip: 3, bus: 'B1' }` are the same button.
- `mode` is `toggle` / `on` / `off` for anything that is a flag, and
  `set` / `up` / `down` for gain, where `value` is dB for `set` and the step
  size for a nudge (default 3). Gain is clamped to the fader Voicemeeter really
  has, so sending 40 stores +12 rather than being clamped invisibly later.
- Errors say which part was wrong: `voicemeeter_not_installed`,
  `voicemeeter_not_running`, `voicemeeter_windows_only`, `voicemeeter_bad_strip`,
  `voicemeeter_bad_bus`, `voicemeeter_bad_macro`, `voicemeeter_bad_value`. An
  index the running edition does not have is refused rather than written: the
  DLL does not report a write to `Strip[7]` on a 3-strip mixer as an error, it
  just goes nowhere.
- **`vmParam` is not in this category.** A Deck key can set any named parameter
  the mixer has — the EQ, the compressor, the patch, the recorder — but so can
  `Command.Shutdown`, and closing the user's audio mixer is not something the
  typed actions above imply. If your widget needs a control that is not here,
  say which parameter and it can be added as a typed action rather than as a
  blanket grant.
- The stream is polled from Voicemeeter's own change flag, only while a
  dashboard is connected, and the payload is compared before it is sent — so a
  level meter moving does not re-render your widget. On a PC without
  Voicemeeter nothing runs and the category is never offered.

Windows only, and only while Voicemeeter is running. There is no setting to
switch on: having it installed is the whole opt-in.

<!-- SDK-REFERENCE:START (auto-generated by tools/gen-sdk-reference.mjs — do not edit by hand) -->
### Capability reference (auto-generated)

The exact set the SDK exposes today, generated from the code. Request
these in your manifest `streams` / `actions`; the host only forwards what
the user granted, and every action is re-validated server-side.

**Data streams** (`streams`): `agenda`, `audio`, `audioLevels`, `battery`, `claude`, `discord`, `discordChannels`, `discordNotifications`, `discordSoundboard`, `football`, `homeassistant`, `media`, `news`, `notes`, `obs`, `processes`, `status`, `stocks`, `streamerbot`, `system`, `tasks`, `twitchChat`, `twitchWatch`, `voicemeeter`, `wavelink`, `weather`, `youtubeLive`

**Action categories** (`actions`) → the action `type`s each unlocks:

| Category | Action types |
|----------|--------------|
| `audioDevice` | `audioDevice` |
| `browser` | `browserOpen` |
| `chroma` | `chromaColor`, `chromaOff` |
| `discord` | `discordMute`, `discordDeafen`, `discordPtt`, `discordJoin`, `discordLeave`, `discordInputVol`, `discordOutputVol`, `discordUserVol`, `discordUserMute`, `discordAudioToggle`, `discordSoundboard` |
| `homeassistant` | `haToggle`, `haLight`, `haMedia`, `haCover`, `haClimate`, `haFan`, `haVacuum`, `haLock`, `haAlarm`, `haScene`, `haScript`, `haButton` |
| `lighting` | `lighting`, `lightPower`, `lightColor`, `lightAuto`, `lightEffect`, `lightDevice` |
| `media` | `media`, `mediaSeek` |
| `mic` | `micMute` |
| `obs` | `obsScene`, `obsSceneNext`, `obsRecord`, `obsStream`, `obsMute`, `obsInputVolume` |
| `soundboard` | `playSound`, `soundStopAll` |
| `spotify` | `spotifyPlay`, `spotifyNext`, `spotifyPrev`, `spotifySave`, `spotifyLike`, `spotifyShuffle`, `spotifyRepeat`, `spotifyVolume`, `spotifySeek`, `spotifyPlaylist`, `spotifyDevice` |
| `steam` | `launchSteamGame` |
| `streamerbot` | `sbDoAction`, `sbSendMessage`, `sbCodeTrigger` |
| `tasks` | `taskAdd`, `taskToggle`, `taskDelete` |
| `twitch` | `twitchClip`, `twitchMarker`, `twitchAd`, `twitchTitle`, `twitchGame`, `twitchChat`, `twitchShoutout`, `twitchChatMode` |
| `url` | `openUrl` |
| `voicemeeter` | `vmStripMute`, `vmStripGain`, `vmStripBus`, `vmBusMute`, `vmBusGain`, `vmMacro` |
| `volume` | `volume`, `appVolume`, `appMute` |
| `watch` | `twitchWatchPlay`, `ytWatchPlay` |
| `wavelink` | `wlInputVolume`, `wlInputMute`, `wlOutputVolume`, `wlOutputMute`, `wlSwitchMonitoring`, `wlSetMonitorMix` |
| `youtube` | `ytBroadcast` |
<!-- SDK-REFERENCE:END -->

### 6. Network — `fetch` (widget → host) and `fetch_result` (host → widget)

Your page still has **zero direct network** (the CSP is never relaxed). Instead,
declare the hostnames you need in `manifest.json` `hosts`, and ask the host to
fetch on your behalf:

```js
window.parent.postMessage({
  xenonSdk: 1, type: 'fetch',
  id: 7,                                       // your correlation id
  url: 'https://api.example.com/v1/data',
  method: 'GET',                               // GET/POST/PUT/PATCH/DELETE/HEAD
  headers: { 'Accept': 'application/json', 'X-Api-Key': '…' },   // allowlisted names only
  body: undefined                              // string, POST/PUT/PATCH only, ≤ 256 KB
}, '*');
// later:
// { xenonSdk: 1, type: 'fetch_result', id: 7, ok: true, status: 200,
//   contentType: 'application/json', encoding: 'utf8'|'base64', body: '…' }
// { xenonSdk: 1, type: 'fetch_result', id: 7, ok: false, error: 'host_not_allowed' | 'rate_limited' | 'timeout' | … }
```

Rules (enforced server-side against your **manifest**, not just your grant):

- `https://` to any declared host; plain `http://` only to private-network
  targets (RFC1918 IPs, `*.local`, single-label names) — LAN gear rarely has TLS.
- Loopback and link-local are unreachable, even via DNS rebinding — a hostname
  that resolves to `127.0.0.1`/`169.254.*` fails at connect time.
- Redirects are **not** followed (you get `status` + `location` and decide).
- Request headers are limited to `accept`, `accept-language`, `content-type`,
  `authorization` and custom `x-*` names.
- Responses are capped at 1 MB; textual bodies arrive as UTF-8 (`encoding:
  'utf8'`), everything else as base64 (build a `data:` URI to display images).
- Rate limit: ~1 request/s per widget instance, plus a per-package floor.

To poll an API, simply `setInterval` + `fetch` in your widget — data streams and
your visibility already gate how often you actually run.

### 6b. User-supplied addresses — `userHosts`

`hosts` works when you know the address at build time. It doesn't when the server
lives on **the user's** network — a NAS, a Docker host, a printer, a self-hosted
Plex. You can't know that address, and hard-coding your own makes the package
useless to everyone else, so such a widget could never be published.

Declare a **named blank** instead, and the user fills it in when they approve you:

```json
"userHosts": [
  { "id": "nas", "label": "NAS address", "scope": "private" }
]
```

| Key | Notes |
|-----|-------|
| `id` | What you read the value back under (`^[a-z0-9][a-z0-9-]{0,40}$`). |
| `label` | The text shown above the field — say what you want, e.g. "Plex server address". ≤ 60 chars. |
| `scope` | `"private"` (default) accepts only the user's own network — RFC1918 IPs, `*.local`, single-label names. `"any"` also accepts a public name, for a self-hosted service on its own domain. |

The address arrives in `init` (and only for slots the user actually filled), with
a `base` ready to concatenate a path onto:

```js
// { xenonSdk: 1, type: 'init', …,
//   userHosts: { nas: { host: '192.168.1.50', port: 32400, scheme: 'http',
//                       base: 'http://192.168.1.50:32400' } } }
const nas = init.userHosts.nas;
if (nas) fetchViaHost(nas.base + '/library/sections');   // normal proxied fetch
```

Notes that save you a debugging session:

- The user may type `192.168.1.50:32400`, `nas.local`, or `https://plex.example.com`
  — all three are accepted, and you always receive the parsed pieces plus `base`.
  **Use `base`**; don't rebuild it from `host` and `port` yourself.
- **Ports are not part of the allowlist**, so a slot covers any port on that host.
- `scheme` follows the same rule as the rest of the proxy: LAN keeps the user's
  choice (default `http`), a public host is always `https`.
- A slot the user left empty is **absent** from `init.userHosts`. Check before
  using it — though in practice the host won't mount you until every declared
  slot has an address, and it prompts the user for one instead.
- The address is stored with the user's grant, not in your package: it never
  travels when the widget is exported or shared, and it survives updates.
- Users can change it later from the Store's **Installed** list → *Address*.

Security, since this is the one place a widget influences where it can reach: it
still can't choose. Your manifest declares that you need an address and how wide
it may reach; the value only ever comes from the person at the keyboard. Every
value is re-validated server-side on every request against the same rules a
declared `hosts` entry passes — so loopback, link-local and `localhost` are
unreachable through a slot no matter what, `"private"` really does pin the value
to LAN space, and a name that *resolves* back to `127.0.0.1` still dies at
connect time.

### 7. Local webhooks — `hook` (host → widget)

Declare hook ids in `manifest.json` `hooks`, and any **local** process
(Streamer.bot, AutoHotkey, a script) can push you an event:

```text
POST http://127.0.0.1:3030/sdk/hook/<your-package-id>/<hook-id>
Content-Type: application/json

{ "anything": "up to 64 KB" }
```

You receive `{ xenonSdk: 1, type: 'hook', hook: '<hook-id>', data: … }` (JSON
payloads arrive parsed, anything else as a string). Delivery is **live-only**:
if no dashboard is open the event is dropped (the sender sees `delivered:
false`). Hooks are delivered to your widget even while it sits on a non-visible
dashboard page, so you can turn them into Deck states.

### 8. Deck integration — macros and published states

**Macros** (`deck.actions`): named multi-step actions your package contributes
to the Deck key editor. They appear under a "Widgets" category as
"*Your widget › Macro name*". Steps are restricted to the same low-risk action
set as bridge actions, are re-validated server-side on every key press, and run
only while the user has granted your package the categories the macro touches —
so **every category a macro step uses must also be listed in the top-level
`actions`** (otherwise the user is never asked to grant it and the macro can't
run). Per-step `delayMs` is capped at 5 s and the whole macro at ~8 s of waiting,
since it runs server-side inside one request.

**Published states** (`deck.states`): declare state ids in the manifest, then
publish values over the bridge whenever they change:

```js
window.parent.postMessage({ xenonSdk: 1, type: 'state', id: 'alert', value: true }, '*');
```

In the Deck key editor, "Reflect a widget state" lets the user bind any key to
your state — the key stays lit while the value is truthy (or equals a chosen
value), exactly like the Streamer.bot global binding. Values may be a boolean,
number, or string (≤ 200 chars); publishes are rate-limited (~6/s per instance).

**Rich key faces (v4.4)**: a state publish may additionally carry display meta
the bound key can SHOW — `label` (≤ 24 chars, rendered as a live badge via the
key's "Live value" binding), `icon` (≤ 8 chars, an emoji), and `color` (a strict
`#hex`, used as the badge tint):

```js
window.parent.postMessage({ xenonSdk: 1, type: 'state', id: 'viewers', value: 1234, label: 'LIVE 1.2k', color: '#ff3355' }, '*');
```

### 9. Handler actions — code-run Deck keys (v4.4)

Where a macro composes *built-in* actions, a **handler** is a Deck key answered
by *your own code*. Declare up to 8 in the manifest:

```json
"deck": {
  "handlers": [
    { "id": "post-message", "name": "Post a message", "params": [
      { "name": "text", "label": "Message", "kind": "text" },
      { "name": "channel", "label": "Channel", "kind": "select", "options": ["general", "alerts"] },
      { "name": "count", "label": "Times", "kind": "number", "min": 1, "max": 10 }
    ] }
  ]
}
```

Each handler appears in the Deck editor as "*Your widget › Handler name*", and
its declared `params` (≤ 4; `text` / `select` / `number`) render as a real
config form on the key — no JSON editing for the user. When the key is pressed
**exactly one** live frame of your package receives the call — the service
frame when you declared `background: true`, otherwise the first mounted one —
so a mirrored tile can never double-run your side effects:

```text
{ xenonSdk: 1, type: 'handler', handler: '<id>', args: { text: '…', channel: 'general', count: 2 }, callId: '…' }
```

Handle it (you may use your granted actions/fetch/state as usual), then ack so
the key can report success — the first ack wins; no ack within ~3 s flashes the
key red with `no_frame`:

```js
window.parent.postMessage({ xenonSdk: 1, type: 'handler_ack', callId, ok: true }, '*');
```

Handlers are granted per-id in the permission dialog (like hooks), args are
re-coerced server-side against your declared params on every press, and
dispatches are rate-limited (~4/s per handler).

**Know which frame you are.** When a package declares `background: true` and a
tile is also on the dashboard, **both frames run your code at once**. `init`
carries `service: true|false` so you can tell them apart — put anything with a
side effect (a scheduled write, a badge refresh, a webhook) behind it, and let
the tile frame do nothing but draw:

```js
if (m.type === 'init') {
  isService = m.service === true;
  if (isService) startPolling();   // exactly one frame does the work
}
```

Handler dispatch already picks one frame for you; this is for everything else.

**Background service frames** (`"background": true`, top-level): normally your
code runs only while a tile is mounted. A package that declares handlers, a
`badge`, or advanced Dynamic Island activities may also ask to run **headless**:
the host mounts a hidden sandboxed frame (same CSP, same grants, capped at 4
packages) so those contributions remain live with no tile on screen. Shown to
the user in the permission dialog; meaningless (and normalized away) without
one of those capabilities.

### 9b. Dynamic Island — `island` (widget → host) (v4.6 / v4.10)

There are three compatible levels. All are opt-in permissions, host-rendered and
available in **Full and Minimal** topbar styles. Style **None** has no island
surface, so updates are kept but not displayed.

#### Legacy short line (`"island": true`)

The v4.6 API remains unchanged. It is ideal for a teleprompter sentence, build
status or download percentage. The clock recedes and the short line takes its
place; `next` adds a dim follow-up row and `badge` adds a tiny meta column.

```js
window.parent.postMessage({ xenonSdk: 1, type: 'island', op: 'show', text: 'Rendering… 42%' }, '*');
window.parent.postMessage({ xenonSdk: 1, type: 'island', op: 'show', text: 'Current sentence.', next: 'The one after it.', badge: '1.5×' }, '*');
window.parent.postMessage({ xenonSdk: 1, type: 'island', op: 'clear' }, '*');
```

Rules the host enforces (send whatever you like — this is what survives):

- **Plain text only.** The host renders your strings via `textContent` — never
  markup, links or images. Control characters are stripped; `text` and `next`
  are each capped at **160 chars**. `text` wraps in full (never clamped);
  `next` renders as a dimmed row below it. An optional `badge` (capped at
  **16 chars**) renders as a right-hand meta column split off by a hairline —
  a ` · ` inside it stacks two rows (accent on top, dim below), so
  `badge: '1.5× · 2:40'` reads as a speed over a countdown.
- **Chained shows glide.** When a `show`'s `text` equals the previous `next`,
  the host treats it as a prompter advance: the old line dims into a single
  ellipsized history row, the block slides up and the card height eases —
  karaoke-style. Unrelated text just replaces the card content.
- **Coalesced updates.** Bursts are rate-limited (~200 ms); the LATEST text
  always lands, intermediate ones may be skipped. Sending more than a few
  updates per second buys you nothing.
- **One visible live owner at a time.** Xenon keeps the latest live state per
  package; whichever package updated most recently is shown. Clearing it restores
  the previous eligible source instead of losing everybody else's state.
- **System notifications always win.** While a toast is showing your line
  recedes; it returns when the toast dismisses. No action needed on your side.
- **Auto-clear.** When your package's last frame goes away (tile removed,
  package uninstalled) the host clears your line within a few seconds.
- **Full and Minimal.** The same content replaces the centre clock in Full or the
  floating capsule in Minimal. In None it stays cached but is not drawn.
- An empty `text` on `show` counts as `clear`. There is no reply message.
- In a regular browser tab that's hidden, your frame's timers are throttled by
  the browser — island updates from a background tab will stall. Irrelevant on
  the always-visible kiosk app.

#### Structured Live Activities (`"island": { "dynamic": true }`)

This manifest form requests a **separate, visibly broader grant**. Existing
widgets approved only for a short line never inherit it during an update. The
widget describes a small layout, but Xenon rebuilds it from fixed primitives:
guest HTML, CSS, URLs and event handlers never cross the sandbox boundary.

A persistent music activity that keeps only the time, playback bars and title:

```js
window.parent.postMessage({
  xenonSdk: 1,
  type: 'island',
  op: 'present',
  mode: 'live',
  layout: 'compact',
  accent: '#1ed760',
  blocks: [
    { type: 'builtin', value: 'time' },
    { type: 'bars', values: [0.3, 0.8, 0.55, 1, 0.4], animated: true },
    { type: 'text', text: 'Midnight City', weight: 'strong', maxLines: 1 },
    { type: 'button', id: 'pause', label: 'Pause', emphasis: true }
  ]
}, '*');
```

A goal takeover temporarily replaces whatever live/default content is present,
plays its entrance, waits, plays its exit, then restores the previous state:

```js
window.parent.postMessage({
  xenonSdk: 1,
  type: 'island',
  op: 'present',
  mode: 'takeover',
  duration: 6000,
  enter: 'pop',
  exit: 'slide',
  accent: '#e31b23',
  blocks: [
    { type: 'icon', text: '⚽' },
    { type: 'text', text: 'GOAL · Arsenal 2–1', weight: 'strong', tone: 'accent' },
    { type: 'text', text: 'Saka · 78′', tone: 'muted' }
  ]
}, '*');
```

Clear only your persistent activity, only your pending takeover, or both:

```js
window.parent.postMessage({ xenonSdk: 1, type: 'island', op: 'clear', scope: 'live' }, '*');
window.parent.postMessage({ xenonSdk: 1, type: 'island', op: 'clear', scope: 'takeover' }, '*');
window.parent.postMessage({ xenonSdk: 1, type: 'island', op: 'clear', scope: 'all' }, '*');
```

Allowed blocks (maximum **10** after validation):

| Block | Fields that survive |
|-------|---------------------|
| `text` | `text` (≤160 chars), `tone`: `primary\|muted\|accent\|success\|warning\|danger`, `weight`: `normal\|strong`, `maxLines`: `1\|2` |
| `icon` | `text` (≤8 chars; glyph/emoji), optional strict `color: "#rrggbb"` |
| `progress` | `value` from `0` to `1` |
| `bars` | `values`: up to 12 numbers from `0` to `1`; `animated: true` uses a host animation that obeys reduced motion, game/idle and GPU pause modes |
| `builtin` | `value`: `time`, `date` or `weather`; these mirror Xenon's own live readout |
| `button` | `id` (`^[a-z0-9][a-z0-9_-]{0,31}$`), `label` (≤28 chars), optional `emphasis`; maximum **2** distinct buttons |
| `spacer` | `size`: `small\|large` |

Top-level fields:

- `mode`: `live` (default) or `takeover`.
- `layout`: `compact` (default), `expanded`, or `full` (requires `island: { "full": true }` — see below). An unrecognised value falls back to `compact`.
- `accent`: optional strict `#rrggbb`; it only colours Xenon's allowed accents.
- `enter`: `morph` (default), `slide`, `pop` or `fade`.
- `exit`: `morph` (default), `slide` or `fade`.
- `duration`: takeover lifetime, clamped to **1,200–30,000 ms** (default 5s).

When a host-rendered button is tapped, the owning frame alone receives:

```js
addEventListener('message', (event) => {
  const message = event.data;
  if (message?.xenonSdk === 1 && message.type === 'island_action') {
    if (message.id === 'pause') togglePlayback();
  }
});
```

Bursts are coalesced to the latest state at roughly 200 ms. Xenon retains only
the newest takeover globally: a new goal or alert supersedes an older pending
event, then restores the live activity or normal island when it leaves. System
notifications remain above all SDK content.

#### Full-bar activities (`"island": { "full": true }`)

A third, separately approved step. It changes nothing about *what* you may draw —
the same bounded blocks, the same 10-block cap, the same host rendering — only
*how much room* the activity gets: `layout: "full"` is the widest step, for an
activity that genuinely needs it, in place of the clock, date and weather.

It stays a capsule. Xenon still sizes it to its content and only lets it grow
further than `expanded` does; it is never pinned edge to edge. Do not design for
a fixed full-screen width — you will not get one.

```json
{ "island": { "full": true } }
```

```js
parent.postMessage({
  xenonSdk: 1, type: 'island', op: 'present', mode: 'live', layout: 'full',
  blocks: [
    { type: 'icon', value: '🎧' },
    { type: 'text', text: 'Radio Nightwave', weight: 'strong' },
    { type: 'bars', values: [0.2, 0.6, 0.9, 0.5], animated: true },
    { type: 'spacer', size: 'large' },
    { type: 'button', id: 'skip', label: 'Skip' },
  ],
}, '*');
```

It is split from `dynamic` for the same reason `dynamic` was split from the
legacy line: taking the entire bar is visibly more than replacing the clock, so
an approval the user already gave must never grow into it after an update. A
package that declares `full` implies `dynamic` — there is no way to fill a bar
through the one-line text API — and both permissions are listed separately in the
install dialog.

**If the permission is missing, `full` is downgraded to `expanded`, not dropped.**
Your activity still appears, in the capsule. Design for that: a full-bar layout
must stay readable at capsule width, because a user who declined the permission
(or an older Xenon) will see exactly that. Do not rely on the extra width to make
essential information legible.

Xenon's own now-playing segment can do something similar (Settings → **Dynamic
Island** → Musica), but that is a built-in, not an SDK surface. An SDK activity
takes precedence over it while it is showing, and system notifications still win
over everything.

#### The user owns every contribution

Settings → **Dynamic Island** lists only currently installed packages that
declare an island activity or badge. The user can disable any package's entire
contribution without uninstalling it, can hide/reorder Xenon's built-in items,
and can globally turn timed takeovers off. Treat the island as enhancement, not
the only place essential information or controls exist.

### 9c. Persistent badge — `badge` (widget → host) (v4.6)

Declare `"badge": true` and — once granted — your widget may show a small
**always-on** text chip next to the clock, in **both** the full and minimal
topbar chromes. Use it for something
that's true for a long time and worth a permanent glance — a repo's star
count, an unread count, a connection status — not a one-off event.

```js
window.parent.postMessage({ xenonSdk: 1, type: 'badge', op: 'set', text: '1.2k', icon: '★', color: '#f5c518', tooltip: 'owner/repo — GitHub stars' }, '*');
window.parent.postMessage({ xenonSdk: 1, type: 'badge', op: 'clear' }, '*');
```

Rules the host enforces:

- **Plain text only**, rendered via `textContent` — never markup, links or
  images. Control characters are stripped. `text` is capped at **20
  characters** — this is a small persistent chip, not a sentence, so keep it
  tight (a star count, a short status word). An optional `tooltip` (capped at
  **48 characters**) renders as the chip's native title attribute.
- **An optional glyph in your own colour.** `icon` (capped at **8 characters** —
  a symbol or emoji) renders as the chip's leading glyph, and `color` (a strict
  `#hex`, same rule as a deck key's live badge) tints **the glyph only** — the
  value stays in the topbar's own text colour, so your chip sits in the user's
  theme while your mark stays yours (a star is gold, a battery is green).
  Anything that isn't plain hex is dropped and the glyph inherits the text
  colour. Prefer this over putting the symbol in `text`: a glyph inside `text`
  can't be tinted, and an emoji renders chunky next to the pill's typography.
- **Multiple owners, capped.** Unlike Island's single shared slot, several
  *distinct* granted packages may each hold one badge at the same time, up to
  4 concurrent chips. A package trying to claim a 5th slot is silently
  ignored — this is a cosmetic layout limit, not an error, and there's no
  reply message either way.
- **Coalesced updates.** Bursts are rate-limited (~500 ms); the latest text
  always lands.
- **Tappable, if you ask for it (v4.11.4).** `"badge": true` stays exactly what it
  has always been: a read-only chip that does nothing when pressed. Declare
  `"badge": { "action": true }` instead and the chip becomes a real button; a tap
  posts `{ type: 'badge_action' }` to your frame and your widget decides what
  happens. It is a **separate permission line** for the same reason the island's
  `dynamic` is: an approval the user gave to a number they can read must never
  grow into something they can press when your package updates. Without the
  grant, the chip renders as the plain text version and no message is sent.

  ```js
  addEventListener('message', (e) => {
    if (e.data && e.data.type === 'badge_action') refreshNow();
  });
  ```
- **The user owns the slot.** Settings → Dynamic Island can hide the badge row
  globally or disable your package's island/badge contribution specifically.
  Treat the badge as a bonus glance, never as the only place your widget shows
  something.
- **Outliving the tile — declare `background: true`.** A badge is worth having
  precisely when the tile is *not* on screen, so a badge package may also ask to
  run headless: the host mounts a hidden service frame (same sandbox, same
  grants) that keeps your code — and therefore your chip — alive and refreshing
  with no tile anywhere. Without it your chip is dropped a few seconds after
  your last frame goes away. Note both frames run when a tile IS mounted, so
  keep polling cheap and idempotent.
- **Offer an in-widget control too.** Xenon's package switch is the universal way
  out; a contextual *Remove badge* or *Stop activity* control inside your own
  setup still makes the feature easier to understand.
- **Auto-clear.** When your package's last frame goes away (tile removed *and*
  no service frame, package uninstalled, SDK switched off) the host drops your
  chip within a few seconds.
- An empty `text` on `set` counts as `clear`. There is no reply message.

### 9d. Mini slot — `mini` (widget → host) (v4.11.4)

Since v4.11.4 the user can hide the top bar's buttons they never use — Lock,
Ambient, Xenon, Search, Layout, Apps — reorder them and choose which side they
sit on. The room that frees up is not meant to stay empty, and the **mini slot**
is how a package can occupy it.

It is the third place a widget can appear outside its tile, and it is worth being
clear about which to reach for:

| | where | shape | lives for |
|---|---|---|---|
| Island | centre, replacing the clock | text, meters, buttons | an activity, transient |
| Badge | inside the clock | one chip: glyph + value | as long as you keep it |
| **Mini** | **among the bar's buttons, where the user put it** | **a small row of blocks** | **as long as you keep it** |

Declare it and send the same block payload the island takes:

```json
{ "mini": true, "background": true }
```

```js
parent.postMessage({
  xenonSdk: 1, type: 'mini', op: 'present',
  tooltip: 'Home Assistant',
  blocks: [
    { type: 'icon', text: '🌡', color: '#ffb03a' },
    { type: 'text', text: '21.4°', weight: 'strong' },
    { type: 'button', id: 'boost', label: 'Boost' },
  ],
}, '*');
```

`op: 'clear'` removes it. A tap on your button posts
`{ type: 'mini_action', id: 'boost' }` back to your frame, exactly like
`island_action`.

What differs from the island, and why:

- **4 blocks, 1 button.** The slot sits between real buttons on a bar that also
  has to hold a clock. Blocks past the fourth are dropped, as is a second button.
- **No `builtin`.** Mirroring the clock into a slot that may sit right next to the
  actual clock is a duplicate, not a feature.
- **No `mode`, no `duration`, no `layout`.** A slot in the bar is a **state**, not
  an announcement that expires. It stays until you clear it or your package goes
  away. If you want something that appears, says its piece and leaves, that is the
  island's takeover lane.
- **Long text is cut, not wrapped.** The bar has no room to give, and one package
  must never push the user's buttons off screen. Send the short form yourself
  rather than relying on the ellipsis.
- **3 packages at once.** A fourth is silently ignored, like the badge cap.

Everything else is the island's rules, unchanged: `accent` must be plain 6-digit
hex, updates are coalesced (~200 ms), every block is rebuilt by Xenon from the
allowlist — your HTML, CSS and event handlers never reach the bar — and the whole
thing is host-rendered, so the widget sandbox is untouched by any of it.

**The user owns the place, and whether it is there at all.** They choose which
side the slot sits on and its position among the buttons, they can hide the slot
entirely, and they can switch your package's contribution off on its own in
Settings → Dynamic Island. Design for it being absent: the mini slot is a glance,
never the only place your widget says something.

**Outliving the tile — declare `background: true`.** Same reasoning as the badge:
a readout the user deliberately parked in their top bar is worth having precisely
when your tile is not on screen. Without it, your slot is dropped a few seconds
after your last frame goes away.

## Persistent storage

Declare `"storage": true` and your widget gets a small key/value store that
**survives updates** — it lives in `server/data/widget-store/`, outside your
package folder, so the updater that refreshes `server/data/widgets/<id>/` never
touches it (and an exported/shared package never carries it). This is where a
widget keeps its own settings: followed teams, chosen news sources, a map's last
centre and zoom. Ask the host over the bridge:

```js
window.parent.postMessage({ xenonSdk: 1, type: 'store', id: 1, op: { op: 'set', key: 'teams', value: [64, 65] } }, '*');
window.parent.postMessage({ xenonSdk: 1, type: 'store', id: 2, op: { op: 'get', key: 'teams' } }, '*');
// later:
// { xenonSdk: 1, type: 'store_result', id: 1, ok: true }
// { xenonSdk: 1, type: 'store_result', id: 2, ok: true, value: [64, 65] }
```

Ops: `set` (`key`, `value`), `get` (`key` → `value`, `null` if absent), `delete`
(`key`), `keys` (→ `keys: [...]`), `clear`. Keys match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; values are any JSON value. Caps (enforced
server-side): ≤ 16 KB per value, ≤ 128 keys, ≤ 256 KB per store. Errors come back
as `{ ok: false, error: 'value_too_large' | 'too_many_keys' | 'store_full' | … }`.

**Writes are rate-limited: one `set`/`delete`/`clear` per 100 ms per package.**
Reads are not limited. A write that arrives inside another one's 100 ms answers
`{ ok: false, error: 'rate_limited' }` and **stores nothing** — so firing several
`set`s in the same tick keeps the first and silently loses the rest. If your
widget saves more than one key when something happens (a game saving progress
plus its stats, a settings panel saving several fields at once), queue them: one
write in flight at a time, spaced past the gate, and retry a `rate_limited` reply
instead of assuming it landed.

```js
// One write at a time, newest value per key wins, refusals retried.
const queue = new Map(); let busy = false, timer = 0;
function save(key, value) { queue.set(key, value); if (!busy && !timer) timer = setTimeout(drain, 0); }
async function drain() {
  timer = 0;
  const key = queue.keys().next().value; if (key === undefined) return;
  const value = queue.get(key); queue.delete(key);
  busy = true;
  const res = await storeSet(key, value);   // your bridge round-trip
  busy = false;
  if (!res.ok && !queue.has(key)) queue.set(key, value);   // bound the retries
  if (queue.size) timer = setTimeout(drain, 140);
}
```

**Always check `ok` on a write.** `store_result` is the only place the host can
tell you a save did not happen; a widget that ignores it will look like it saved
and come back empty on the next load.

**Sharing across widgets.** Declare the same `"storageGroup": "my-set"` in
several packages and they read/write **one shared store** — the way a suite of
sibling widgets (say a Football set: live scores, standings, a club picker) keep
one list of followed teams. Without a group, each package's store is private to
it. The user sees the group in the permission dialog.

## Secrets & API keys

A published widget must ship **no** API keys, and the sandboxed frame should
never hold one in a variable an update could log. Declare `"secrets": true` and
you get a **write-only** vault: you can save a key and later use it, but you can
never read it back.

```js
// Store it once (e.g. from a settings field the user fills in):
window.parent.postMessage({ xenonSdk: 1, type: 'secret', id: 1, op: { op: 'set', name: 'apiKey', value: userInput } }, '*');
// Check/list without ever seeing the value:
window.parent.postMessage({ xenonSdk: 1, type: 'secret', id: 2, op: { op: 'names' } }, '*');
// { xenonSdk: 1, type: 'secret_result', id: 2, ok: true, names: ['apiKey'] }
```

Ops: `set` (`name`, `value`), `delete` (`name`), `names` (→ `names: [...]`),
`has` (`name` → `has: true|false`). There is deliberately **no `get`** — a read
never returns a value. Names match the key charset; ≤ 16 secrets, ≤ 4 KB each.

**Using a secret** — reference it with a `{{secret:NAME}}` placeholder anywhere
in a proxied `fetch`'s url, headers or body. The host substitutes the real value
server-side, just before the request leaves, so the key never travels through
your frame:

```js
window.parent.postMessage({ xenonSdk: 1, type: 'fetch', id: 7,
  url: 'https://api.football-data.org/v4/matches',
  headers: { 'X-Auth-Token': '{{secret:apiKey}}' }
}, '*');
// TheSportsDB-style key-in-path works too:
//   url: 'https://www.thesportsdb.com/api/v1/json/{{secret:apiKey}}/eventsnext.php?id=133604'
```

A placeholder for a secret you haven't stored fails the request
(`error: 'unknown_secret'`) — it's never sent literally. Substitution can never
move the request to a different host than the one you declared.

## Sound

Your widget **can** make sound, which surprises people who read "no network, no
storage, sandboxed" and assume otherwise. There is no grant for it and no bridge
message: it is ordinary web audio inside your frame, and the CSP allows it.

Two ways, both needing nothing from the host:

```js
// 1. A bundled clip, or a data: URI.  media-src is 'self' data: blob:
const click = new Audio('click.mp3');   // shipped in your package
click.volume = 0.4;
click.play().catch(() => {});           // never let a rejection break your code

// 2. Synthesised — no asset to ship at all.
const ac = new (window.AudioContext || window.webkitAudioContext)();
const osc = ac.createOscillator(), gain = ac.createGain();
osc.frequency.value = 440;
gain.gain.setValueAtTime(0.05, ac.currentTime);
gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.15);
osc.connect(gain); gain.connect(ac.destination);
osc.start(); osc.stop(ac.currentTime + 0.2);
```

What you must respect:

- **A user gesture is required to start.** Autoplay policy applies inside your
  frame like anywhere else: the first sound has to come from a tap or click, and
  an `AudioContext` created earlier starts `suspended` (call `ac.resume()` from
  the tap). Sound that plays before the user has touched your widget will simply
  not play.
- **Default to silent, and offer a switch.** This dashboard lives on an
  always-on second screen next to someone who is usually doing something else.
  A widget that makes noise on arrival is a widget that gets uninstalled. Ship
  the toggle off, remember it in `storage`.
- **Go quiet when nobody is looking.** Stop sound on
  [`visibility`](#4c-visibility--host--widget) `false`.
- **Nothing is mixed for you.** Your audio is part of the browser's own output;
  it does not appear as a separate app in the `audio` stream and the user cannot
  set its level anywhere but inside your widget.

If instead you want to play the user's **installed sound packs**, that is a
different thing with a real grant: the `soundboard` action category and
`playSound` (see the action catalog). Use that for shared clips the user has
chosen; use the above for a widget's own feedback.

## Clipboard

Declare `"clipboard": true` and your widget may **ask** the host to copy text to
the system clipboard. It is deliberately not a silent write: your widget can never
put something on the clipboard on its own, and can never read the clipboard. Every
copy raises a small Xenon confirmation the user taps, so the copy is always a
visible, intentional action — the right shape for a password or a one-time code.

```js
// Ask to copy. `secret: true` masks the value in the confirmation (a password);
// `secret: false` shows it in full (a short-lived 2FA code you also want to read).
window.parent.postMessage({ xenonSdk: 1, type: 'clipboard', id: 1,
  text: 'S3cretPass!', label: 'GitHub password', secret: true }, '*');
// → { xenonSdk: 1, type: 'clipboard_result', id: 1, ok: true }
//   or { …, ok: false, error: 'declined' | 'rate_limited' | 'too_long' | 'bad_text' | 'not_allowed' }
```

- `text` is the value to copy (≤ 4096 chars). **Control characters are rejected**
  (`error: 'bad_text'`) rather than silently stripped — a scrubbed password is a
  wrong password you would not notice.
- `label` is a short, plain description shown in the confirmation ("GitHub
  password"). Display only; keep it under ~64 chars.
- `secret` (default `true`) decides whether the confirmation masks the value.
- You always get a `clipboard_result`. If the user dismisses or ignores the
  confirmation you get `ok: false, error: 'declined'` — the native clipboard
  promise would otherwise hang forever, so never assume success.
- Rate-limited to roughly one request per ~1.2s per tile (a copy needs a human
  tap anyway). `init` echoes your granted `clipboard` flag so you can render an
  honest copy affordance (or hide it) when the capability was declined.

Why the confirmation: a sandboxed iframe's tap propagates a live "user activation"
to the host for a few seconds, so a widget that copied on its own could rewrite
your clipboard off an unrelated tap. Tying every copy to a fresh host tap the user
reads removes that entirely.

## Dashboard accent

Declare `"accent": true` and your widget may tint the **whole dashboard's accent
colour** while it runs. This is the same runtime channel Xenon's album-art theme
uses, opened up for the sources Windows' media session never sees — a Plex or
Plexamp client, a console, a game overlay, anything your widget knows about and
the OS does not.

```js
// Tint everything from the artwork you just loaded.
window.parent.postMessage({ xenonSdk: 1, type: 'accent', hex: '#c94f2d' }, '*');

// Hand it back (playback stopped, nothing to theme from).
window.parent.postMessage({ xenonSdk: 1, type: 'accent', hex: null }, '*');
```

What it is, exactly:

- **The accent only.** Background, surfaces and text stay the user's. A widget
  cannot make the dashboard unreadable, by accident or otherwise.
- **Runtime only.** Nothing is written to settings. The user's saved theme is
  untouched and a reload restores it.
- **One owner.** The last widget to set a colour owns the tint. It is released
  automatically when that widget is removed, its package is suspended, safe mode
  is on, or the grant is withdrawn — so a widget that disappears can never leave
  the dashboard stuck on a colour with nothing on screen to explain it.
- **The user still has the switch.** Settings → *Tema dall'album* governs this
  too: with it off, your `accent` messages are accepted and do nothing. `init`
  echoes your granted `accent` flag, so check it before building UI around this.
- `hex` must be `#rrggbb`. Anything else — including `null` — releases the tint.

Tiles with a custom style follow the tint as well, so a themed tile and the
widget inside it stay in step with the rest of the dashboard.

## Map & radar tiles (`/sdk/tile/`)

A slippy map (Leaflet/MapLibre radar, weather overlays) needs many small image
tiles from a tile server. Base64-ing each one over the `fetch` bridge is too slow
for panning, so point the tile layer **straight at the same-origin tile proxy**,
which the widget CSP already allows (`img-src 'self'`, no relaxation):

```js
// init gives you your package id:
// { xenonSdk: 1, type: 'init', pkgId: 'weather-radar', … }
const tileUrl = (u) => `/sdk/tile/${pkgId}?u=${encodeURIComponent(u)}`;
L.tileLayer(tileUrl('https://tile.example.com/{z}/{x}/{y}.png'), { … });
// (build the concrete tile URL first, then wrap it — or template {z}/{x}/{y}
//  through the encoder in your layer.)
```

The tile host must be in your manifest `hosts` (and granted), exactly like the
fetch proxy — same allowlist, same SSRF guard (loopback/link-local unreachable),
same 1 MB size cap. Responses are **images only**, cached briefly (a bounded LRU)
so panning back doesn't re-hit the origin, and rate-limited per package. Bundle
the map library itself (Leaflet's JS/CSS/marker images) in your package as usual.

## Artwork that stays cached (`/sdk/asset/`) (v4.11.8)

Album covers, game art, video thumbnails — images that are the same next week
and are worth not fetching again. Same shape as the tile proxy above, and the
same door: declared host, granted host, SSRF guard, 1 MB cap, images only. The
one difference is where the answer is kept.

```js
const assetUrl = (u) => `/sdk/asset/${pkgId}?u=${encodeURIComponent(u)}`;
img.src = assetUrl(track.albumArtUrl);
```

**Use `/sdk/asset/` when the image does not change, `/sdk/tile/` when it does.**
Tiles are held in a small memory cache for minutes, because a radar frame is
stale almost immediately and worthless tomorrow. Assets are written to disk and
survive a restart, because a cover is not.

**Do not put images in your store.** A store value caps at 16 KB and the whole
store at 256 KB, so base64 artwork does not fit, and this exists so it never has
to. The `<img>` is same-origin, so nothing crosses the bridge at all.

What the cache guarantees, and what it does not:

- **It is bounded, and it forgets.** Per widget and in total, oldest-used first,
  with the files actually deleted. Your artwork can disappear at any time — it is
  a cache, not storage. Ask again and it comes back.
- **Seven days, then re-fetched.** An image can change behind an unchanged URL,
  and a month of showing the old one is too long to be wrong.
- **A failure is remembered for an hour**, so a render loop does not re-ask a
  dead URL every frame. Handle `onerror` and draw a placeholder.
- **It is per widget.** Two widgets caching the same URL each keep their own
  copy; neither can see the other's.
- **Misses are rate-limited** (a miss costs a download and a file). Cache hits
  never are, so painting from cache is always free. A burst of new images can
  return 429 — retry later rather than looping.

Requested by a widget author caching Steam, Spotify and YouTube artwork, who had
already hit the store ceiling doing it by hand.

## Ambient scenes (`surface: "ambient"`)

Declare `"surface": "ambient"` in the manifest and your package becomes an
**Ambient scene** — a fullscreen screensaver the user picks in
Settings → Ambient / Screensaver instead of placing it as a tile. Everything
else stays identical: same folder shape, same sandbox and CSP, same bridge,
same permission dialog (shown when the user selects your scene), same
distribution (Export/Import, access-code locking, bundles — scenes travel in a
bundle's `widgets` array and export standalone as the `ambient` preset kind).

Scene-specific notes:

- **You render the whole viewport** (landscape, watched from arm's length —
  design big, calm and dim; near-black backgrounds are kind to the always-on
  display). No scrolling; `overflow: hidden`.
- **The host draws an exit ✕ over your top-right corner** (~20 px inset) and
  closes on Escape — keep that corner clear. Pointer events otherwise reach
  your page, so tappable controls are allowed.
- **The clock is yours**: use `Date` in-frame (no stream needed). Live data
  (media, `weather`, system, …) arrives over the granted streams exactly like a
  tile, including the initial replay on `hello`.
- **Pause yourself when hidden**: gate your `requestAnimationFrame` loop on
  `document.hidden` — the scene may open right after long idle, and the mode
  is suppressed during games automatically.

## Versioning

`api: 1` is the contract described here. Breaking changes will ship as `api: 2`
with a migration window; hosts reject manifests whose `api` they don't support,
so your widget never half-works.

## Distribution

A widget is just a folder — zip it and share it (the preset/community channels
work fine). Users install by unzipping into `server/data/widgets/`. Remind them
they'll be shown your requested permissions on first add.

### Shared as a code (standalone widget or inside a "package")

Your widget can be shared as a portable code/file two ways: on its own via
**Settings → Appearance → Share & Import → Export widget**, or bundled with a
theme and page layouts in a **Xenon package** (**Export package**). Either way,
on the sender's side the widget is read through `GET /sdk/export/<id>`, and on the
recipient's side it is written through `POST /sdk/install`, which re-runs the
**exact same validation as a folder scan** — the manifest is rebuilt, every file
path and extension is re-checked, and size/count caps are enforced *before a
single byte is written*. Importing a shared widget **never** auto-grants
anything: it stays hidden and reaches no stream, action or host until the user
enables the Community-widgets switch and approves its permissions, just like a
manual install. The recipient can also protect the shared code with access codes
(encrypted locally). Nothing about authoring changes — sharing is only a
transport.

## Security model (for the curious)

- The iframe is sandboxed without `allow-same-origin`, so the document has an
  opaque origin and cannot use the dashboard's origin or storage.
- Every asset response carries
  `Content-Security-Policy: … connect-src 'none'; sandbox allow-scripts`, so
  even opening the widget URL directly in a browser keeps it sandboxed and
  offline.
- Manifest fields are re-validated server-side (unknown keys, streams and
  actions are dropped); asset paths are allowlisted per segment and extension.
- The host forwards only granted streams and dispatches only granted action
  categories; every action re-validates in `server/actions/registry.js`.
- All network goes through the host-mediated proxy: the manifest host allowlist
  is the authority, loopback/link-local is unreachable even via DNS rebinding,
  redirects aren't followed, and request/response sizes are bounded. The widget
  itself never gets a network primitive.
- Webhook events only enter from loopback (like every Xenon route), only on
  hook ids the manifest declares, and only reach widgets the user granted them
  to. Deck macro steps and published states are rebuilt/validated on both the
  manifest boundary and every use.
