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
  "hooks": ["my-event"],
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
| `streams` | no | Data streams you request: `status`, `system`, `media`, `audio`, `wavelink`, `stocks`, `football`, `news`, `claude`, `obs`, `discord`, `streamerbot`, `homeassistant`, `tasks`, `notes`, `agenda`. |
| `actions` | no | Action categories you request: `media`, `volume`, `mic`, `lighting`, `chroma`, `wavelink`, `spotify`, `obs`, `discord`, `homeassistant`, `twitch`, `youtube`, `streamerbot`, `url`. |
| `hosts` | no | Up to 8 exact hostnames the widget may reach **through the host-mediated fetch proxy** (see *Network*). Loopback/link-local names are rejected at install time. |
| `hooks` | no | Up to 8 hook ids (`^[a-z0-9][a-z0-9-]{0,40}$`) the widget may receive local webhook events on (see *Local webhooks*). |
| `deck` | no | Deck contributions: up to 8 `actions` (macros of ≤ 10 steps, each step restricted to the same low-risk action set as `actions`) and up to 8 `states` the widget publishes (see *Deck integration*). |

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
  dashboard DOM, no popups, no forms, no top-navigation.
- **Inline `<script>` is blocked** (`script-src 'self'`) — put all JS in files.
  Inline `<style>` is allowed.
- Images/fonts must be bundled in your package or `data:` URIs.
- All data arrives over `postMessage` from the host; all effects go back the
  same way.

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
  theme:  { appearance: 'dark'|'light', accent: '#1ed760', background: '#070808', text: '#f0f3f1' },
  lang:   'en',                       // active UI language (en/it/ko/ja/zh)
  streams: ['system', 'media'],       // granted data streams
  actions: ['media']                  // granted action categories
}
```

Immediately after `init`, the host replays the latest cached payload of each
granted stream as `data` messages, so you paint without waiting for the next
tick.

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
- `streamerbot` — Streamer.bot connection state, globals, and activity events
- `homeassistant` — Home Assistant device/entity states (privacy note: this exposes your smart-home state — grant it deliberately)
- `tasks` — `{ tasks: [...] }`, the user's to-do list; pushed on every change
- `notes` — `{ v, activeId, notes: [...] }`, the user's notes (privacy note: this is your private scratchpad text — grant it deliberately); pushed on save
- `agenda` — `{ events: [...] }`, the user's calendar events; pushed on every change

`wavelink` and these last four are read-only data feeds; you also get the latest
cached payload replayed right after `init`, so you paint without waiting.

Treat every string in them as untrusted display text: render with
`textContent`, never `innerHTML`.

### 4. `theme` — host → widget

Sent whenever the dashboard theme changes: `{ type: 'theme', theme: {…} }`.

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

The `wavelink` **stream** pushes the live mixer state — `{ connected, inputs: [{ mixId, name, bgColor, localVolumeIn, streamVolumeIn, isLocalInMuted, isStreamInMuted, … }], output, monitorMix, switchState }` — so a widget can render real faders and read the `mixId`s to target. Razer Chroma and the whole-system `lighting` category are write-only (no stream): fire the actions or show a static control. Since there's no lighting stream, the whole-rig `lighting` actions (`lightPower`/`lightColor`/`lightAuto`/`lightEffect`) need no ids; `lightDevice` targets a device id you already know.

> Local-hardware note: apps like Razer Synapse and Wave Link expose a **loopback** endpoint, which the sandbox and fetch proxy deliberately block. These `chroma`/`wavelink` categories are the supported path — Xenon's backend does the local talking, you request the category, the user grants it. Do **not** try to reach `127.0.0.1` from a widget; it won't work by design.

Actions are rate-limited to one per ~250 ms per widget instance.

<!-- SDK-REFERENCE:START (auto-generated by tools/gen-sdk-reference.mjs — do not edit by hand) -->
### Capability reference (auto-generated)

The exact set the SDK exposes today, generated from the code. Request
these in your manifest `streams` / `actions`; the host only forwards what
the user granted, and every action is re-validated server-side.

**Data streams** (`streams`): `agenda`, `audio`, `claude`, `discord`, `football`, `homeassistant`, `media`, `news`, `notes`, `obs`, `status`, `stocks`, `streamerbot`, `system`, `tasks`, `wavelink`

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
| `spotify` | `spotifyPlay`, `spotifyNext`, `spotifyPrev`, `spotifySave`, `spotifyLike`, `spotifyShuffle`, `spotifyRepeat`, `spotifyVolume`, `spotifySeek`, `spotifyPlaylist`, `spotifyDevice` |
| `streamerbot` | `sbDoAction`, `sbSendMessage`, `sbCodeTrigger` |
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

## Versioning

`api: 1` is the contract described here. Breaking changes will ship as `api: 2`
with a migration window; hosts reject manifests whose `api` they don't support,
so your widget never half-works.

## Distribution

A widget is just a folder — zip it and share it (the preset/community channels
work fine). Users install by unzipping into `server/data/widgets/`. Remind them
they'll be shown your requested permissions on first add.

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
