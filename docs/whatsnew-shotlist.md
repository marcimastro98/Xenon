# "What's New" — shot list (screenshot & video)

This is the capture guide for the curated **What's New** modal (`server/whatsnew.json`),
the card users see at startup after an important release. One entry per highlight: what
image to use, what a video should show, and exactly which field to fill.

> Media is loaded **only from GitHub-hosted URLs** (a security rule): either a raw repo
> file (`raw.githubusercontent.com/marcimastro98/Xenon/main/docs/images/<name>.png`) or —
> best for shipping — an immutable **release attachment** (`github.com/user-attachments/assets/…`).

---

## How to get the URL (do this once per image/video)

**Image already in the repo** (`docs/images/*.png`): the URL is just
`https://raw.githubusercontent.com/marcimastro98/Xenon/main/docs/images/<name>.png`.
⚠️ It only resolves once that file is on the **`main`** branch. v4 screenshots (minimal,
stocks, vitals, notification) are on `v4.0.0-tauri` and will 404 until you merge/release to
main; v3 ones (overview, layout-pages, topbar) already work.

**New image or a video** (recommended for shipping — immutable, never breaks):
1. Record/screenshot the feature. For video use **`Win + G`** (Xbox Game Bar → Record) or OBS; keep it **10–20s**, no audio needed.
2. Open GitHub → the repo → **Releases → "Draft a new release"** (you do **not** need to publish it). *Or* open any new Issue.
3. **Drag the file into the description box.** GitHub uploads it and writes a link like `https://github.com/user-attachments/assets/1a2b3c4d-…`.
4. Copy that link.
5. Paste it into the highlight's `media` in `server/whatsnew.json`, and set `mediaType` to `"image"` or `"video"`.

---

## The 6 highlights (in order)

| # | Highlight | `mediaType` | Screenshot to use / capture | Video idea (optional, better) |
|---|-----------|-------------|------------------------------|-------------------------------|
| 1 | **A real app — no browser, no iCUE** | image → **video** | `docs/images/overview.png` (works now) as a stand-in. Ideal: a clean full-screen shot of the **native app** on the Xeneon Edge. | 🎥 Best as video: launch the native app → branded splash → dashboard appears full-screen. ~8s. Sells "not a browser tab / not iCUE". |
| 2 | **Minimal mode** | image → **video** | `docs/images/minimal-topbar.png` (v4 — 404 until merged). Capture: the Minimal top bar with the Dynamic-Island area. | 🎥 Great as video: tap to switch **Full → Minimal**, show the bar collapse and tiles gain room. ~6s. |
| 3 | **New widgets: Stocks, Football, News** | image | `docs/images/stocks-widget.png` (v4). Alternatives already in repo: `football-widget.png`, `news-widget.png`, `stocks-chart.png`, `stocks-ticker.png`. | 🎥 Optional: scrub a stock chart + the top ticker scrolling. ~8s. |
| 4 | **Precise layout editor** | image → **video** | `docs/images/layout-pages.png` (works now). Also `layout.png`, `dashboard-customize.png`. | 🎥 Strong as video: drag a tile into place, corner-resize it, merge two into a tabbed tile. ~10s. |
| 5 | **Vitals — self-care meters** | image | `docs/images/vitals-widget.png` (v4). | 🎥 Optional: a meter ticking down and **Bit** (pixel guardian) reacting/nagging. ~8s. |
| 6 | **Whole-PC notifications + clock icons** | image → **video** | `docs/images/notification.png` or `discord-notification.png` (v4). Capture: a toast dropping from the top **and** the little app icons next to the clock. | 🎥 Best as video: a Windows/Discord notification drops in from the top; show the app icons by the clock; in Minimal, the Dynamic Island. ~8s. |

Legend: **image → video** = an image works, but a short clip sells it much better.

---

## Where each goes in `server/whatsnew.json`

Highlights are an array, in the same order as the table. For each one, set:

```jsonc
{
  "title": { "it": "…", "en": "…", "ko": "…", "ja": "…", "zh": "…" },
  "body":  { "it": "…", "en": "…", "ko": "…", "ja": "…", "zh": "…" },
  "media": "https://github.com/user-attachments/assets/…",   // ← paste your URL here
  "mediaType": "video"                                        // ← "image" or "video"
}
```

Leave `media` as `""` for a text-only highlight. Titles/bodies already carry all five
languages (it/en/ko/ja/zh) — swap only the `media`/`mediaType` when you have the assets.

### Reminders
- Bump the top-level **`id`** only for an *important* release you want re-announced; keep it
  unchanged for a pure bugfix release so the card doesn't re-nag.
- The card already invites users to open **Settings** and read the **full release notes**
  (the "All the changes" button → GitHub release). Keep `url` pointing at the release.
