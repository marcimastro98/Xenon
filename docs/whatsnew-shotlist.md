# "What's New" — shot list (screenshot & video)

This is the capture guide for the curated **What's New** modal (`server/whatsnew.json`),
the card users see at startup after an important release. One entry per highlight: what to
capture, and exactly which field to fill.

Current shot list: **v4.6.0**, 8 highlights, all shipped **text-only** (`media: ""`).

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

## The 8 highlights (in order)

| # | Highlight | `mediaType` | What to capture | Video idea (optional, better) |
|---|-----------|-------------|-----------------|-------------------------------|
| 1 | **One theme, one palette — light half and dark half** | image → **video** | The Aspetto → Colori panel showing the semantic roles (canvas, panels, surfaces, controls, text, borders, state colours), ideally next to the dashboard they paint. | 🎥 Much stronger as video: flip Light ⇄ Dark on a theme authored with both halves and watch the whole app repaint — labels, Focus popup, Bit's bubbles, AI chat included. ~8s. |
| 2 | **Fans, Energy and Batteries** | image | The three tiles together on one page. Ideally a machine with a GPU at zero-RPM (reads *stopped*) and an AIO, so the physical grouping (Scheda madre / Hub-AIO / Scheda video / Alimentatore) is visible. | 🎥 Optional: rename a fan (tap the name, type, it sticks) — that's the bit people don't expect. ~6s. |
| 3 | **Island, badge and the Teleprompter** | image → **video** | The minimal top bar with a line projected into the clock pill, plus a badge chip or two beside it. | 🎥 Best as video: Teleprompter counts 3-2-1, scrolls with the current sentence highlighted, and the same sentence rides the island. Sells island + widget in one clip. ~10s. |
| 4 | **Icon packs and sound packs** | image | The Deck key icon picker with an imported pack's section under the built-in library, or the key editor's new Soundboard category. | 🎥 Optional: import a pack code → the icons appear in the picker → assign one to a key. ~8s. |
| 5 | **The Store's Installed tab** | image | The Installed list with a mix of kinds (widget, theme, page, Deck profile, pack), each row with its screenshot and version, filter rail visible. | 🎥 Optional: filter by kind, open a row to show what the download added and where it came from. ~8s. |
| 6 | **Star ratings and the publish portal** | image | A catalog entry with its star control and an average on the card. Alternative: the publish portal on xenon-app.com, prefilled from the ✨ button. | 🎥 Optional: tap a rating, watch the card's average update. ~5s. |
| 7 | **Your CPU back when you're idle (#99, #100)** | image | Hard to shoot — it's an absence. Best: Task Manager (or the Performance tile) beside an idle dashboard showing near-zero CPU. A before/after pair is worth more than a single shot. | 🎥 Good as video: the Fotogrammi al secondo dial on an animated background, then walk away and the scene freezes. ~8s. |
| 8 | **Settings that really stick** | image | Also an absence — nothing to photograph. Reasonable stand-in: the Settings screen after the readability pass (wider sidebar, taller rows, cards with breathing room), which shipped in the same version. Or leave text-only. | — |

Legend: **image → video** = an image works, but a short clip sells it much better.
For video use **`Win + G`** (Xbox Game Bar → Record) or OBS; keep it **10–20s**, no audio needed.

Note on 7 and 8: both are fixes, and fixes photograph badly. Text-only is a perfectly good
answer for either — an unconvincing screenshot is worse than none.

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
