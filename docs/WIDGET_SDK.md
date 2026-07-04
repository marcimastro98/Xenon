# Xenon Widget SDK — build your own dashboard widget

**API version 1 · beta**

Anyone can build a widget for the Xenon dashboard: a small folder with a
manifest and an HTML page. Widgets run inside a **sandboxed iframe with no
network access** — everything they can see or do goes through a small,
versioned message bridge, and the user explicitly approves each widget's
permissions before it renders.

## Quick start

1. In Xenon, open **Settings → Widgets** and enable third-party widgets.
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
  "actions": ["media"]
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `api` | yes | Must be `1`. The bridge protocol is versioned; future hosts stay compatible with declared versions. |
| `id` | no | If present, must equal the folder name. Folder name rules: `^[a-z0-9][a-z0-9-]{1,40}$`. |
| `name` | yes | ≤ 60 chars. |
| `version`, `author`, `description` | no | Shown to the user (description ≤ 200 chars). |
| `entry` | no | HTML entry document, defaults to `index.html`. Must live in the package root. |
| `streams` | no | Data streams you request: `status`, `system`, `media`, `audio`. |
| `actions` | no | Action categories you request: `media`, `volume`, `mic`, `lighting`, `url`. |

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
| `lighting` | `{ type: 'lighting', … }` (same params as the Deck lighting action) |
| `url` | `{ type: 'openUrl', url: 'https://…' }` (http/https only) |

Actions are rate-limited to one per ~250 ms per widget instance.

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
