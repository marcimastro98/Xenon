# "What's New" — shot list (screenshot & video)

This is the capture guide for the curated **What's New** modal (`server/whatsnew.json`),
the card users see at startup after an important release. One entry per highlight: what to
capture, and exactly which field to fill.

Current shot list: **v4.10.0**, 7 highlights. Six carry media (search + disk, the two tentpoles);
highlight 1 (the living index, an invisible engine) ships **text-only** on purpose. The assets live
in `docs/images/` and are wired into `server/whatsnew.json`.

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

## The 7 highlights (in order)

| # | Highlight | `mediaType` | Asset in `docs/images/` | What it shows |
|---|-----------|-------------|-------------------------|---------------|
| 1 | **A living index of your files** | text-only | — (`media: ""`) | The engine is invisible (an in-RAM index), and an absence photographs badly. Deliberately text-only. |
| 2 | **Search your PC from the dashboard** | image (gif) | `search.gif` | Pull the top bar down, type a plain phrase, watch the removable interpretation chips appear and the results land. The gesture is the point, so a clip beats a still. |
| 3 | **The same search anywhere, in your theme** | image | `search-spotlight.png` | The frameless Alt+Space search pill on the main monitor, in the user's theme. A clean hero still. |
| 4 | **Search has an AI mode, one key away** | image | `search-ai.png` | The bar in its Xenon AI look (accent light running around it), a natural-language query typed in, chips derived from it. |
| 5 | **See what is eating your disk, no scan button** | image (gif) | `disk.gif` | Tap a drive chip, the treemap of where the space went is simply there and stays live. Shows drives-as-chips → map → drill-down. |
| 6 | **Explore the biggest files and verified duplicates** | image | `disk-explore.png` | The Explore view (largest files/folders) or the Duplicates view with byte-verified groups. |
| 7 | **Protected cleanup + Storage Advisor** | image | `disk-cleanup.png` | The Cleanup view with its closed category list and the formatted Advisor report (headings/tables), no delete button on unclassified items. |

For a clip use **`Win + G`** (Xbox Game Bar → Record) or OBS; keep it **10–20s**, no audio needed.
A `.gif` goes straight into `media` as `mediaType: "image"` (the host allowlist is host-based, not
extension-based, and an `<img>` animates it). To swap a gif for a real video, drag the clip into a
draft release/issue box and use the `user-attachments` URL with `mediaType: "video"`.

Note on 1: it is a fix-adjacent engine feature, and those photograph badly. Text-only is the right
answer — an unconvincing screenshot is worse than none.

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

Leave `media` as `""` for a text-only highlight. Titles and bodies already carry all five
languages (it/en/ko/ja/zh) — swap only `media`/`mediaType` when you have the assets.

### Reminders

- Bump the top-level **`id`** only for an *important* release you want re-announced; keep it
  unchanged for a pure bugfix release so the card doesn't re-nag.
- Every text field is truncated at **2000 characters** server-side (`WHATSNEW_TEXT_MAX`).
  The v4.6.0 bodies run 683–839, so there is room, but a long CJK body can creep up on you.
- The card already invites users to open **Settings** and read the **full release notes**
  (the "All the changes" button → GitHub release). Keep `url` pointing at the release.
