# Xenon community gallery

This folder powers the **Discover** gallery — both on the website and inside the app
(Settings → Widget e condivisione → Scopri). Everything in `catalog.json` is shown to
every Xenon user, so entries are **moderated**: they only land here when the maintainer
merges them.

## How to submit your creation

1. Build your theme, animated background, widget, Ambient scene, page or package in
   Xenon, then use **Share & Import → Export** to get its share code (or `.json` file).
2. **Easiest path (v4.4+):** tap **✨ Publish to the catalog** in the Share dialog —
   it copies your code and opens a prefilled
   [submission form](https://github.com/marcimastro98/Xenon/issues/new?template=community-submission.yml)
   on GitHub. Paste the code, attach a screenshot if you like, submit. Done.
3. Or open a pull request yourself that:
   - adds an entry to `catalog.json` (see the field reference below), and
   - if your code is longer than ~2 KB, adds it as `codes/<id>.txt` instead of inline
     (set `"codeFile": true` and leave `"code"` out), and
   - optionally adds 1–4 screenshots/GIFs as `shots/<id>.webp`,
     `shots/<id>-2.webp` … `shots/<id>-4.webp` (WebP, animated allowed) and sets
     `"shots": <count>` (or `"screenshot": true` for a single one).
4. Or share the code on the [Discord](https://discord.gg/MBVrw9kZyg) `#showcase` channel
   and ask for it to be added.

### Maintainer flow (submissions)

Triage the `community-catalog` issue → import the code in a scratch profile and check it
is what it claims → PR: entry in `catalog.json` (+ `codes/<id>.txt` for big codes,
`shots/<id>.webp` … `shots/<id>-4.webp` for up to four screenshots/GIFs, `"shots": <count>`)
→ merge → Pages deploys → the in-app gallery picks it up within its 45-minute cache window.

Keep names/descriptions short and in English (the gallery is global). One entry per
artifact. By submitting you agree the code may be redistributed through the gallery.

## Entry fields

| Field | Required | Notes |
|---|---|---|
| `id` | ✔ | Unique slug, `a-z 0-9 - _`, max 61 chars. Also the anchor `#<id>` and the `codes/<id>.txt` filename. |
| `kind` | ✔ | One of `theme`, `bg`, `page`, `deck`, `widget`, `bundle`, `ambient`. |
| `name` | ✔ | Display name, max 60 chars. |
| `author` | | Your handle, max 60 chars. |
| `authorSupporter` | | Set by the maintainer at merge time — ⭐ badge for supporters. |
| `description` | | Max 300 chars. |
| `preview` | | Themes only: `{ "accent": "#…", "bg": "#…", "text": "#…" }` hex colours for the swatch preview. |
| `code` | ✔* | The share code inline (small codes). *Either `code` or `codeFile`. |
| `codeFile` | ✔* | `true` → the code lives in `codes/<id>.txt`. |
| `locked` / `supportersOnly` | | Marks an access-code-protected (supporter-perk) entry — shown with a 🔒 badge linking to Buy Me a Coffee. |
| `addedAt` | | `YYYY-MM-DD`. |
| `appVersionMin` | | Minimum Xenon version, e.g. `"4.4.0"` for Ambient scenes. |
| `version` | | v2 — numeric-dotted (`"1.2.0"`). Powers the in-app update check for widgets. |
| `pkgId` | | v2, `widget`/`ambient` only — the installed package id this entry updates. |
| `category` | | v2 — one of `deck`, `streaming`, `media`, `smart-home`, `system`, `style`, `fun`, `tools`. |
| `tags` | | v2 — up to 5 lowercase tags (`a-z 0-9 -`, ≤20 chars each). |
| `screenshot` | | v2 — `true` when a single `shots/<id>.webp` exists (never a URL: the path is derived from the id). Legacy single-shot form of `shots`. |
| `shots` | | v2 — integer `1`–`4`: how many screenshot/GIF sidecars this entry has. Files are `shots/<id>.webp`, then `shots/<id>-2.webp` … `shots/<id>-4.webp`. Format is **WebP (animated allowed)** — never a URL, the paths are derived from the id. |
| `publisher` | | v2 — `{ "handle": "github-handle", "url": "https://github.com/…" }` (url must be on github.com). |

The app re-validates every field and every code goes through the normal import preview +
permission flow — a catalog entry can never change anything silently.
