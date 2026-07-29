# "What's New" — shot list (screenshot & video)

This is the capture guide for the curated **What's New** modal (`server/whatsnew.json`),
the card users see at startup after an important release. One entry per highlight: what to
capture, and exactly which field to fill.

Current shot list: **v4.11.0**, 7 highlights. Six carry media; highlight 7 (macOS and Linux)
ships **text-only** on purpose — a port photographs as "a dashboard, again", and an
unconvincing screenshot is worse than none. The assets live in `docs/images/` and are wired
into `server/whatsnew.json`.

---

## Where the images go

**Put the file in `docs/images/<name>.png` and push it to `main`.** The URL is then:

```
https://raw.githubusercontent.com/marcimastro98/Xenon/main/docs/images/<name>.png
```

It only resolves once the file is on **main** — a branch URL 404s.

⚠️ **Do not use `github.com/user-attachments/assets/…` for images**, even though the
allowlist accepts it and it is tempting (drag into an issue, copy the link). Those URLs are
gated behind a GitHub **session cookie** the dashboard's `<img>` does not have — worst of
all they load fine in your logged-in browser and 404 in the native WebView, so the modal
silently falls back to the "open on GitHub" link and you only find out from a user. This
guide used to recommend exactly that; it was wrong.

**Videos are the exception**: they are opened via the fallback link, not rendered inline, so
the cookie gate does not apply. For a clip, drag it into a draft release or issue box (you
do not need to publish), copy the `user-attachments` URL, and set `mediaType: "video"`.

The allowlist lives in `server/js/update.js` (`isAllowedMediaUrl`) and is mirrored in
`server/server.js` — https plus `*.githubusercontent.com`, or `github.com/user-attachments/assets/`.
Anything else is dropped without a word.

---

## When the images actually reach users

`whatsnew.json` **ships inside the build** and is read from disk (`WHATSNEW_FILE`), so it
always matches the running version and works offline. It is **not** fetched from GitHub.

That means filling `media` on `main` does nothing for people already on the released build —
the images travel with the **next** build. Fill them in whenever they are ready; they will
ship with whatever comes next. If you want them to reach users of the current version, a
patch release that **keeps the same `id`** delivers them to everyone who has not dismissed
the card yet, without re-nagging those who have.

---

## Where to capture: the demo build, not your own dashboard

`node tools/build-demo.mjs` writes `docs/demo/` (gitignored), which is the **same dashboard
code** with a curated dense layout, simulated data and **English** strings on the brand-green
theme — which is what the v4.10 and v4.11 assets are. Serve it on a spare port and shoot
there. It costs one command and it buys three things your own dashboard cannot: no personal
data in the frame (no calendar entries, no notes, no file names), a layout that is full
rather than whatever you were testing that day, and the same accent in every asset.

Three things must be suppressed in every shot, best done by injecting a `<style>` that hides
them: `#demo-badge`, `.gc-pill` (the "Live demo" pill), and `[class*="discord-invite"]`. Also
turn `dynamicAlbumTheme` off in the demo's stored settings, or the accent follows the album
art of whatever the simulator is playing and the set comes out in three different colours.

What the demo **cannot** shoot, and where to go instead:

- **the share card with a real screenshot** — the demo has no screen to capture and honestly
  says so, so it draws the fallback card. Shoot this one on the real dashboard.
- **the file-transfer tile with files in it** — the demo has no transfer backend at all.
- **the incoming-call card** — needs `/api/calls/test`, which only exists when the server was
  started with `XENON_CALLS_TEST=1` in its environment (`XENON_CALLS_TEST=1 node tools/dev.mjs`).
  It synthesises a notification and feeds it to the real classifier, so what you photograph is
  the real card and not a hand-made one. Put the server back without the flag afterwards.

When you must shoot the real dashboard and its language is not the one you want, switch it
**for that browser only**: `window._langSelectSyncing = true; setLang('en')` re-renders
without persisting, so the Edge and every other surface stay in the user's language. A fresh
page load is required for widget labels that are written once at creation (the transfer
tile's title and its two buttons are re-labelled only on load).

Sizes: shoot at the exact CSS viewport you want the asset to be (Playwright's
`scale: "css"`), 2560x720 for a full panel, 1024x768 for the tablet layout, 390x844 for a
phone. **Avoid shipping a 2560x720 asset as-is**: in the card it renders about 460px wide,
so a 3.5:1 strip is 130px tall and unreadable. Crop to roughly 2:1 or squarer.

---

## The 7 highlights (in order)

| # | Highlight | `mediaType` | Asset in `docs/images/` | What it shows |
|---|-----------|-------------|-------------------------|---------------|
| 1 | **Your phone or tablet can be the second screen** | image | `tablet-dashboard.png` | The tablet layout (two columns, 1024x768): topbar, media, tasks, system. The tablet reads better than the phone, which is a single narrow column. |
| 2 | **Photos and files from the phone to this PC** | image | `transfer.png` | The File transfer tile with a full list: thumbnails, up/down arrows, "from iPhone" and "from the PC", and the drop row underneath. |
| 3 | **A widget does not have to be a rectangle** | image | `tile-shapes.png` | Two tiles wearing different silhouettes (a hexagon and a ticket), cropped to 1700x720 so both read. |
| 4 | **A widget can fill the screen when you tap it** | image (gif) | `widget-expand.gif` | Tile → fullscreen → back, as a two-state cross-fade. The transition is the point, so a clip beats a still. |
| 5 | **Share your setup as a picture** | image | `share-card.png` | The share modal with the real screenshot on and **Blur personal details** on, so the asset shows the privacy control doing its job. |
| 6 | **When someone calls you, the dashboard rings** | image | `calls.png` | The call card taking the screen: app chip, caller, Answer / Decline / Silence / Open app. |
| 7 | **Xenon runs on macOS and on Linux** | text-only | — (`media: ""`) | Deliberately text-only. |

Extras captured in the same pass, for the **release body** rather than the card:
`tile-shape-picker.png` (the shape grid open next to the tile it changed),
`dashboard-widgets.png` (a full 2560x720 panel with two SDK widgets and the transfer tile),
`screen-choice.png` (the first-run "Where do you want Xenon?" dialog).

For a clip use **`Win + G`** (Xbox Game Bar → Record) or OBS; keep it **10–20s**, no audio needed.
`ffmpeg -f gdigrab` against a screen region works too and is scriptable — give it `-t <seconds>`
so it ends on its own, because a killed ffmpeg never writes the mp4's moov atom and the file is
unreadable. A `.gif` goes straight into `media` as `mediaType: "image"` (the host allowlist is
host-based, not extension-based, and an `<img>` animates it). Keep a gif under ~2 MB:
`palettegen`/`paletteuse` at 900px wide and 14fps lands around there.

---

## Where each goes in `server/whatsnew.json`

Highlights are an array, in the same order as the table. For each one, set:

```jsonc
{
  "title": { "it": "…", "en": "…", "ko": "…", "ja": "…", "zh": "…" },
  "body":  { "it": "…", "en": "…", "ko": "…", "ja": "…", "zh": "…" },
  "media": "https://raw.githubusercontent.com/marcimastro98/Xenon/main/docs/images/<name>.png",
  "mediaType": "image"
}
```

Leave `media` as `""` for a text-only highlight. Titles and bodies carry all five
languages (it/en/ko/ja/zh) — swap only `media`/`mediaType` when you have the assets.

### Reminders

- Bump the top-level **`id`** only for an *important* release you want re-announced; keep it
  unchanged for a pure bugfix release so the card doesn't re-nag.
- Every text field is truncated at **2000 characters** server-side (`WHATSNEW_TEXT_MAX`).
  The v4.11 bodies run 368–679 in English and 160–315 in Japanese, so there is room, but a
  long CJK body can creep up on you.
- The card already invites users to open **Settings** and read the **full release notes**
  (the "All the changes" button → GitHub release). Keep `url` pointing at the release.
