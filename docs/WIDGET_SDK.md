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
(e.g. the Xeneon Edge panel); reload on each surface you want updated.

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
| `streams` | no | Data streams you request: `status`, `system`, `media`, `audio`, `wavelink`, `stocks`, `football`, `news`, `claude`, `obs`, `discord`, `discordChannels`, `discordSoundboard`, `discordNotifications`, `streamerbot`, `homeassistant`, `tasks`, `notes`, `agenda`, `weather`, `battery`. See *Hardware sensors* for fans/power/battery. |
| `surface` | no | `"tile"` (default) or `"ambient"` — an ambient package renders fullscreen as an Ambient/screensaver scene instead of a dashboard tile (see *Ambient scenes*). |
| `actions` | no | Action categories you request: `media`, `volume`, `mic`, `lighting`, `chroma`, `wavelink`, `spotify`, `obs`, `discord`, `homeassistant`, `twitch`, `youtube`, `streamerbot`, `url`, `tasks`, `soundboard`. |
| `hosts` | no | Up to 8 exact hostnames the widget may reach **through the host-mediated fetch proxy** (see *Network*). Loopback/link-local names are rejected at install time. |
| `userHosts` | no | Up to 4 addresses **the user types in**, for servers you can't know in advance (a NAS, Docker, a printer). Each is `{ id, label, scope }` — `id` (`^[a-z0-9][a-z0-9-]{0,40}$`) is what you read the value back under, `label` (≤ 60 chars) is the text above the field, `scope` is `"private"` (default — LAN only) or `"any"`. See *User-supplied addresses*. |
| `hooks` | no | Up to 8 hook ids (`^[a-z0-9][a-z0-9-]{0,40}$`) the widget may receive local webhook events on (see *Local webhooks*). |
| `deck` | no | Deck contributions: up to 8 `actions` (macros of ≤ 10 steps, each step restricted to the same low-risk action set as `actions`), up to 8 `states` the widget publishes, and up to 8 `handlers` — Deck keys answered by your own code, with up to 4 declared params each (see *Deck integration* and *Handler actions*). |
| `background` | no | `true` + declared `deck.handlers` and/or `badge` → the host may run your package in a hidden **service frame** so its Deck keys answer, and its badge keeps refreshing, with no tile on screen (see *Handler actions* and *Persistent badge*). Ignored without either. |
| `storage` | no | `true` → your widget may keep a small persistent key/value store on this PC (its settings, chosen sources, last map view). Survives updates. See *Persistent storage*. |
| `storageGroup` | no | A shared-store id (`^[a-z0-9][a-z0-9-]{0,40}$`). Every widget declaring the same group reads/writes ONE store, so a set of sibling widgets can share config/cache. Implies `storage`. |
| `secrets` | no | `true` → your widget may store API keys in a **write-only** vault and use them via `{{secret:NAME}}` in proxied requests, so a published package ships no keys. See *Secrets & API keys*. |
| `island` | no | `true` → your widget may project **one short plain-text line** into the minimal topbar's dynamic island (the floating clock pill). Host-rendered, grant-gated — see *Island projection*. |
| `badge` | no | `true` → your widget may show a small **always-on** text chip next to the clock, in both topbar chromes. Host-rendered, grant-gated — see *Persistent badge*. |

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

The host already helps from the outside: your frame receives no `data` while
the dashboard tab is hidden or your tile's page is off-screen, and the browser
throttles off-viewport frames. But while your widget is visible, its rendering
cost is entirely yours.

## The bridge protocol (v1)

Every message in both directions is an object with `xenonSdk: 1` plus a `type`.
Send to `window.parent` with target origin `'*'` (the host validates the
source, not the origin — your frame's origin is opaque by design).

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
      info: '#62cbea', onInfo: '#111111'
    }
  },
  lang:   'en',                       // active UI language (en/it/ko/ja/zh)
  streams: ['system', 'media'],       // granted data streams
  actions: ['media'],                 // granted action categories
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
- `system` — `cpu` (%), `gpu` (%|null), `memory.percent`, temperatures, uptime…
- `media` — `title`, `artist`, `album`, playback state, source…
- `audio` — volume, mute, output device…
- `stocks` — the quotes/indices the user follows (same payload the Stocks tile gets)
- `football` — followed teams' fixtures, live scores and results
- `news` — merged headlines from the user's news sources
- `claude` — local Claude Code usage aggregate (the "Xenon Pulse" data)
- `obs` — OBS state (current scene, recording/streaming flags, audio sources)
- `discord` — Discord voice state (connected, mute/deafen, current channel, speaking)
- `discordChannels` — `{ ok, channels:[{ id, name, guild, members:[] }] }`; Discord voice-channel catalog merged with the live roster
- `discordSoundboard` — `{ ok, sounds:[{ id, guildId, name, guild }] }`; the soundboard catalog available to the connected Discord account
- `discordNotifications` — `{ ok, enabled, hide, state, items:[...] }`; private DM/mention notifications, with the user's privacy setting preserved. Request this grant only when the widget genuinely displays notification content
- `streamerbot` — Streamer.bot connection state, globals, and activity events
- `homeassistant` — Home Assistant device/entity states (privacy note: this exposes your smart-home state — grant it deliberately)
- `tasks` — `{ tasks: [...] }`, the user's to-do list; pushed on every change
- `notes` — `{ v, activeId, notes: [...] }`, the user's notes (privacy note: this is your private scratchpad text — grant it deliberately); pushed on save
- `agenda` — `{ events: [...] }`, the user's calendar events; pushed on every change
- `battery` — wireless peripheral battery levels (see *Hardware sensors*)

`wavelink` and these last four are read-only data feeds; you also get the latest
cached payload replayed right after `init`, so you paint without waiting.

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
Only the three fixed stream names above are accepted: a widget cannot provide a
URL or endpoint. Refreshes require the matching user grant, are rate-limited,
and are rejected for hidden tiles and background service frames. The channel
and notification snapshots are cached for 5 seconds; Soundboard is cached for
60 seconds.

Treat every string in them as untrusted display text: render with
`textContent`, never `innerHTML`.

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
}
```

### 4b. `size` — host → widget

Your tile's current pixel box and device pixel ratio, sent right after `init`
and again on every resize (dragging the tile, or a different surface):

```js
{ xenonSdk: 1, type: 'size', width: 480, height: 120, dpr: 2 }
```

Why it matters: a widget always fills its tile (`width/height: 100%`), and it
**does not auto-scale its content**. The desktop browser and the Xeneon Edge give
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
| `media` | `{ type: 'media', cmd: 'playpause' \| 'next' \| 'previous' }` |
| `volume` | `{ type: 'volume', mode: 'mute' \| 'up' \| 'down' }`, `{ type: 'appVolume', app, mode }`, `{ type: 'appMute', app, mode }` |
| `mic` | `{ type: 'micMute', mode: 'toggle' \| 'mute' \| 'unmute' }` |
| `lighting` | `{ type: 'lightPower', state: 'toggle' \| 'on' \| 'off' }`, `{ type: 'lightColor', color: '#rrggbb' }`, `{ type: 'lightAuto' }`, `{ type: 'lightEffect', style, color }`, `{ type: 'lightDevice', device, mode, color }` — the whole RGB system (iCUE + WLED/Hue/Nanoleaf/OpenRGB/Home Assistant lights/Chroma). `style`: `none\|solid\|breathing\|cycle\|wave\|aurora\|candle\|palette`; `mode`: `follow\|color\|animation\|temperature\|album\|off`; `color`: `#rrggbb`. `lightColor` sets a fixed colour across the whole rig, `lightAuto` clears it back to your configured lighting. Requires lighting configured in Settings → Illuminazione. |
| `chroma` | `{ type: 'chromaColor', device, color }`, `{ type: 'chromaOff', device }` — Razer Chroma per-device lighting (`device`: `all` \| `keyboard` \| `mouse` \| `mousepad` \| `headset` \| `keypad` \| `chromalink`; `color`: `#rrggbb`). Requires the user to enable Razer Chroma in Settings. |
| `wavelink` | `{ type: 'wlInputVolume', mixId, mix, value }`, `{ type: 'wlInputMute', mixId, mix }`, `{ type: 'wlOutputVolume', mix, value }`, `{ type: 'wlOutputMute', mix }`, `{ type: 'wlSwitchMonitoring' }`, `{ type: 'wlSetMonitorMix', monitorMix }` — Elgato Wave Link mixer (`mix`: `stream` \| `local` \| `all`; `value`: 0–100; `mixId` from the `wavelink` stream). Requires the user to enable Wave Link in Settings. |
| `spotify` | `spotifyPlay`, `spotifyNext`, `spotifyPrev`, `spotifySave`, `spotifyLike`, `spotifyShuffle`, `spotifyRepeat`, `spotifyVolume`, `spotifySeek`, `spotifyPlaylist`, `spotifyDevice` — control Spotify playback (params match the Deck Spotify actions; playback control needs Spotify Premium). Requires the user to connect Spotify in Settings. |
| `obs` | `obsScene`, `obsSceneNext`, `obsRecord`, `obsStream`, `obsMute`, `obsInputVolume` — OBS scenes, recording/streaming and audio. Requires OBS connected (WebSocket) in Settings. |
| `discord` | `discordMute`, `discordDeafen`, `discordPtt`, `discordJoin`, `discordLeave`, `discordInputVol`, `discordOutputVol`, `discordAudioToggle`, `discordSoundboard` — Discord voice via the local RPC. Requires Discord running and connected. |
| `homeassistant` | `haToggle`, `haLight`, `haMedia`, `haCover`, `haClimate`, `haFan`, `haVacuum`, `haLock`, `haAlarm`, `haScene`, `haScript`, `haButton` — control your Home Assistant devices (params/entity ids match the Deck HA actions). `haCallService` (arbitrary service calls) is deliberately **not** exposed to widgets. Requires HA configured. |
| `twitch` | `twitchClip`, `twitchMarker`, `twitchAd`, `twitchTitle`, `twitchGame`, `twitchChat`, `twitchShoutout`, `twitchChatMode` — control your Twitch channel. Requires Twitch connected. |
| `youtube` | `ytBroadcast` — start/stop your YouTube broadcast. Requires YouTube connected. |
| `streamerbot` | `sbDoAction`, `sbSendMessage`, `sbCodeTrigger` — trigger Streamer.bot actions, send chat, fire code triggers. Requires Streamer.bot connected. |
| `url` | `{ type: 'openUrl', url: 'https://…' }` (http/https only) |
| `tasks` | `{ type: 'taskAdd', text }`, `{ type: 'taskToggle', id }`, `{ type: 'taskDelete', id }` — add / complete-toggle / delete a to-do in the same list the Tasks tile shows (pair with the `tasks` **stream** to read the list and each task's `id`). `text` is capped at 200 chars server-side; a new task is created with default (medium) priority. No external service required. |
| `soundboard` | `{ type: 'playSound', file, mode?: 'play' \| 'toggle' \| 'stop', volume? }`, `{ type: 'soundStopAll' }` — play clips from an **installed sound pack** (the `sounds` preset kind). `file` MUST be a pack-relative reference of the exact shape `packs/<packId>/<clipId>.<mp3\|ogg\|wav>` — arbitrary local paths are rejected for widgets (that stays a Deck-key-only, user-configured privilege). Same rule applies to `playSound` steps inside manifest `deck.actions` macros (validated at install). Playback happens on the surface where your widget runs. Ship your clips as a companion sound pack, or document which pack the widget expects. |

The `wavelink` **stream** pushes the live mixer state — `{ connected, inputs: [{ mixId, name, bgColor, localVolumeIn, streamVolumeIn, isLocalInMuted, isStreamInMuted, … }], output, monitorMix, switchState }` — so a widget can render real faders and read the `mixId`s to target. Razer Chroma and the whole-system `lighting` category are write-only (no stream): fire the actions or show a static control. Since there's no lighting stream, the whole-rig `lighting` actions (`lightPower`/`lightColor`/`lightAuto`/`lightEffect`) need no ids; `lightDevice` targets a device id you already know.

> Local-hardware note: apps like Razer Synapse and Wave Link expose a **loopback** endpoint, which the sandbox and fetch proxy deliberately block. These `chroma`/`wavelink` categories are the supported path — Xenon's backend does the local talking, you request the category, the user grants it. Do **not** try to reach `127.0.0.1` from a widget; it won't work by design.

Actions are rate-limited to one per ~250 ms per widget instance.

<!-- SDK-REFERENCE:START (auto-generated by tools/gen-sdk-reference.mjs — do not edit by hand) -->
### Capability reference (auto-generated)

The exact set the SDK exposes today, generated from the code. Request
these in your manifest `streams` / `actions`; the host only forwards what
the user granted, and every action is re-validated server-side.

**Data streams** (`streams`): `agenda`, `audio`, `battery`, `claude`, `discord`, `discordChannels`, `discordNotifications`, `discordSoundboard`, `football`, `homeassistant`, `media`, `news`, `notes`, `obs`, `status`, `stocks`, `streamerbot`, `system`, `tasks`, `wavelink`, `weather`

**Action categories** (`actions`) → the action `type`s each unlocks:

| Category | Action types |
|----------|--------------|
| `chroma` | `chromaColor`, `chromaOff` |
| `discord` | `discordMute`, `discordDeafen`, `discordPtt`, `discordJoin`, `discordLeave`, `discordInputVol`, `discordOutputVol`, `discordAudioToggle`, `discordSoundboard` |
| `homeassistant` | `haToggle`, `haLight`, `haMedia`, `haCover`, `haClimate`, `haFan`, `haVacuum`, `haLock`, `haAlarm`, `haScene`, `haScript`, `haButton` |
| `lighting` | `lighting`, `lightPower`, `lightColor`, `lightAuto`, `lightEffect`, `lightDevice` |
| `media` | `media` |
| `mic` | `micMute` |
| `obs` | `obsScene`, `obsSceneNext`, `obsRecord`, `obsStream`, `obsMute`, `obsInputVolume` |
| `soundboard` | `playSound`, `soundStopAll` |
| `spotify` | `spotifyPlay`, `spotifyNext`, `spotifyPrev`, `spotifySave`, `spotifyLike`, `spotifyShuffle`, `spotifyRepeat`, `spotifyVolume`, `spotifySeek`, `spotifyPlaylist`, `spotifyDevice` |
| `streamerbot` | `sbDoAction`, `sbSendMessage`, `sbCodeTrigger` |
| `tasks` | `taskAdd`, `taskToggle`, `taskDelete` |
| `twitch` | `twitchClip`, `twitchMarker`, `twitchAd`, `twitchTitle`, `twitchGame`, `twitchChat`, `twitchShoutout`, `twitchChatMode` |
| `url` | `openUrl` |
| `volume` | `volume`, `appVolume`, `appMute` |
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

**Background service frames** (`"background": true`, top-level): normally your
code runs only while a tile is mounted. A package that declares handlers — or a
`badge` — may also ask to run **headless**: the host mounts a hidden sandboxed
frame (same CSP, same grants, capped at 4 packages) so your Deck keys answer,
and your badge stays live, even with no tile on screen. Shown to the user in the
permission dialog; meaningless (and normalized away) with neither.

### 9b. Island projection — `island` (widget → host) (v4.6)

Declare `"island": true` and — once the user grants it — your widget may show
**one short plain-text line** in the minimal topbar's dynamic island: the clock
pill recedes (the same morph a notification uses) and your line takes its spot,
expanding into a small card when it wraps. A teleprompter's current sentence, a
build status, a download percentage — anything worth a glance while the tile
itself may be on another page. An optional `next` string renders as a dimmed
follow-up row under the main line (prompter-style context).

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
- **One owner at a time.** The island is a single slot: the last granted
  package to `show` owns it, and only the owner's `clear` clears it. Design for
  sharing — show a line while you're genuinely active, clear when you stop.
- **System notifications always win.** While a toast is showing your line
  recedes; it returns when the toast dismisses. No action needed on your side.
- **Auto-clear.** When your package's last frame goes away (tile removed,
  package uninstalled) the host clears your line within a few seconds.
- **Minimal chrome only.** In the full topbar there is no island: your text is
  accepted and kept, just not displayed — the tile remains the primary display.
  Don't put anything in the island the tile doesn't also show.
- An empty `text` on `show` counts as `clear`. There is no reply message.
- In a regular browser tab that's hidden, your frame's timers are throttled by
  the browser — island updates from a background tab will stall. Irrelevant on
  the always-visible Xeneon Edge kiosk.

### 9c. Persistent badge — `badge` (widget → host) (v4.6)

Declare `"badge": true` and — once granted — your widget may show a small
**always-on** text chip next to the clock, in **both** the full and minimal
topbar chromes (unlike Island, which is minimal-only). Use it for something
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
- **No tap action yet.** Badges are display-only in this version — they don't
  navigate anywhere when tapped.
- **The user owns the slot.** In the minimal topbar the badge row is an island
  segment like the clock or the weather chip: from Settings → Aspetto the user
  can reorder it or hide it outright. Treat the badge as a bonus glance, never
  as the only place your widget shows something.
- **Outliving the tile — declare `background: true`.** A badge is worth having
  precisely when the tile is *not* on screen, so a badge package may also ask to
  run headless: the host mounts a hidden service frame (same sandbox, same
  grants) that keeps your code — and therefore your chip — alive and refreshing
  with no tile anywhere. Without it your chip is dropped a few seconds after
  your last frame goes away. Note both frames run when a tile IS mounted, so
  keep polling cheap and idempotent.
- **Give the user a way out.** A badge that survives the tile can only be
  removed by uninstalling your package — unless you offer something better. The
  bundled `github-stars` example puts a *Remove badge* button in its setup view;
  do the same.
- **Auto-clear.** When your package's last frame goes away (tile removed *and*
  no service frame, package uninstalled, SDK switched off) the host drops your
  chip within a few seconds.
- An empty `text` on `set` counts as `clear`. There is no reply message.

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
