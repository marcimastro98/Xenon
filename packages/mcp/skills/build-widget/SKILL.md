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
3. Ask the person only what changes the result: what it shows, roughly how it should look, which tile size.
4. `new_widget` into a new folder named like the id (a-z, 0-9, dashes), then edit those files.
5. `check_widget`, fix what it reports, then `install_widget`.
6. `widget_issues`, then `widget_screenshot`. Look at the picture. Fix, install again, look again, until it works
   and reads well at a glance.
7. Say what it does and what permissions it asks for. To share it, `share_widget` gives a code anyone can paste
   into Xenon; the Store takes it from xenon-app.com/submit.

## Rules that save a round trip

- No inline code: `<script>` blocks and `onclick=` never run. Scripts are files, events use `addEventListener`.
- No remote scripts, styles or fonts. Ship them in the folder. Network calls go through the SDK `fetch` message to
  hosts listed in the manifest.
- Say `hello` first, then wait for `init` before reading data.
- Fill the tile at every size: `container-type: size` on the root and `cqmin` units, no fixed pixel layout.
- Put text on the page with `textContent`, never `innerHTML`.
- Read `theme` and follow its colours, and declare a `color-scheme`, or the tile can turn white.
- Keep it light: no busy loops, pause work while the `visibility` message says hidden.

## When something is wrong

- Thrown errors arrive as "Script error." because of the sandbox. Wrap code in `try`/`catch` and `console.error`
  the message: those arrive in full in `widget_issues`.
- `approved: false` means the person has not allowed its permissions yet. Ask them to press Allow on the tile.
- `blocked` lists what the sandbox refused, by kind and host.
- The screenshot is that part of the screen: a window over the dashboard shows in it. On Linux under Wayland it
  is not available, so rely on `widget_issues`.

You never approve permissions and can only change the person's own widgets, not ones from the Store.
