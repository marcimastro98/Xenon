---
name: build-widget
description: Build, fix or improve a widget for the Xenon dashboard with the xenon-widgets tools. Use when the person asks for a Xenon widget ("make me a Xenon widget that shows...", "my Xenon widget shows nothing", "make this widget look better"), or names the Xenon dashboard, its Widget SDK or a widget folder they are working on.
---

# Build a Xenon widget

Xenon is a dashboard for any spare screen. A widget is a small web page (manifest.json, HTML, CSS, JS) that runs in
a sandbox on a tile and gets live data from Xenon by `postMessage`. The `xenon-widgets` tools install it on the
person's own dashboard, so you can see it run and fix it.

## The loop

1. `xenon_status`. If Xenon is not running, or community widgets are off, say what to do and stop.
2. `sdk_reference` with no section for the contents, then the sections the widget needs (the manifest, the bridge
   protocol, the streams it reads, sizing). Read them: do not guess field names.
3. Ask the person only what changes the result: what it shows, roughly how it should look, which tile size, and
   where it lives: on a page, only in the top bar, or both.
4. `new_widget` into a new folder named like the id (a-z, 0-9, dashes), then edit those files.
5. `check_widget`, fix what it reports, then `install_widget`.
6. `widget_issues`, then `widget_screenshot`. Look at the picture, and at `fit` in the issues: what the tile cuts off,
   by class name and pixels. Fix, install again, look again, until it works and reads well at a glance.
7. Say what it does and what permissions it asks for. To share it, `share_widget` gives a code anyone can paste
   into Xenon; the Store takes it from xenon-app.com/submit.

## Rules that save a round trip

- No inline code: `<script>` blocks and `onclick=` never run. Scripts are files, events use `addEventListener`.
- No remote scripts, styles or fonts. Ship them in the folder. Network calls go through the SDK `fetch` message to
  hosts listed in the manifest. Size requests from `init.limits` (fetch, store and secret caps, Xenon 5.0+),
  never by probing or by a Xenon version.
- Say `hello` first, then wait for `init` before reading data.
- Where it lives is the author's choice. A page is the default. Only the top bar: a `badge`, `mini`,
  `topbarButton` or island part plus `"tile": false`, for a readout that would be an empty box on a tile (a battery
  badge). Both: that part plus `"background": true`. `check_widget` says which in `livesIn`; read sdk_reference
  section "manifest".
- Fill the tile at every size: `container-type: size` on the root and `cqmin` units, no fixed pixel layout.
- For an AIO pump's screen add `"pump": true` (round and square) or a list (`["round"]`). It is then offered as a
  pump face, and `placement` says `{ where: 'pump', shape }`. A round 480 x 480 is the common one: one big readout,
  everything inside the circle, no taps. `placement.look` brings the user's choice for that pump line (`colors`: four
  `#rrggbb`, the first leading; `warn`: the `#rrggbb` for a hot reading; `background`: the screen's `#rrggbb`;
  `size`: `normal` or `big`; `units`: `c` or `f`, only when picked for that line): draw with it. Read sdk_reference
  sections "manifest" and "placement".
- With `"pumpStyle": true` as well it can be a pump screen's whole style (beside Xenon and Gauge): it then draws every
  readings, game, music and clock line, and `placement.line` (`{ face, moment, readings }`) says which, each line a new
  frame. It may move the ring of lights with `{ type: 'pumpRing', effect, level, colors }` (any of the ring's effects
  but the two that read the sound; `heat` with `level` warms it as a reading rises), said when what it shows
  changes. `placement.look.live`, when there, is the line's colours following it, from calm to hot. Read
  sdk_reference sections "pumpRing" and "placement". `new_widget` with `pumpStyle: true` writes a starter that does all this.
- A style can take the pump's alerts its own way with `"pumpAlerts": "dots"` (the title as a lit sign) or `"plain"`:
  Xenon then draws no card over it, posts `{ type: 'pumpAlert', kind, band, seconds }` (`kind` is `notify`, `call`,
  `timer`, `discord` or `hot`, `null` when it is over; never the words) and writes the words itself in the bottom
  `band`. Keep what you draw above it. Kept only for a widget with no actions, hosts, userHosts, hooks, ai, storage,
  storageGroup, secrets or clipboard; `check_widget` says when it was dropped. Read sdk_reference section "pumpAlert".
- To draw the person's own Bit (Xenon 5.3), ask for the `bit` stream (pulled: send `{ type: 'refresh', stream: 'bit' }`
  about once a second while on screen) and copy `bit-kit.js` into the package, loaded before your script: `XenonBit.mount(el).set(data, { light })` draws it from each `bit` update, egg included, plays
  the moves it makes on the dashboard and shows the sign over its head (`signal`: done, ask, soon, bell, disk; only the
  kind; `{ signs: false }` to draw your own). The `bit` action category adds `{ type: 'bitReact', move }`. Never draw Bit by
  hand. Read sdk_reference section "bit". `new_widget` with `bit: true` writes a starter with the kit.
- For what happened at home (Xenon 5.3), the `homeEvents` stream: rings, what the cameras picked out, doors and windows
  opened, newest first, never a picture. Read sdk_reference section "homeEvents".
- Put text on the page with `textContent`, never `innerHTML`.
- Read `theme` and follow its colours, and declare a `color-scheme`: up to Xenon 4.11.13 a page with none turns the tile white.
- Follow the look too: on `theme.look === 'liquid'` (Liquid Glass, the default) cards inside the tile have no outline,
  and a frame like the tile's uses `palette.panelBorder`, never a guessed alpha. See sdk_reference sections "theme" and "skin".
- Keep it light: no busy loops, pause work while the `visibility` message says hidden.

## When something is wrong

- Thrown errors arrive as "Script error." because of the sandbox. Wrap code in `try`/`catch` and `console.error`
  the message: those arrive in full in `widget_issues`.
- `approved: false` means the person has not allowed its permissions yet. Ask them to press Allow on the tile.
- `blocked` lists what the sandbox refused, by kind and host.
- The screenshot is that part of the screen: a window over the dashboard shows in it. On Linux under Wayland it
  is not available, so rely on `widget_issues`.

You never approve permissions and can only change the person's own widgets, not ones from the Store.
