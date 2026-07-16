# Xenon community gallery

This folder powers the **Discover** gallery — both on the website and inside the app
(Settings → Widget e condivisione → Scopri). Everything in `catalog.json` is shown to
every Xenon user, so entries are **moderated**: they only land here when the maintainer
merges them.

## How to submit your creation

1. Build your theme, animated background, widget, Ambient scene, page, icon/sound pack
   or package in Xenon, then use **Share & Import → Export** to get its share code (or
   `.json` file).
2. **Easiest path (v4.5.3+): the publish portal.** Tap **✨ Publish to the catalog** in
   the Share dialog — it copies your code and opens
   [xenon-app.com/submit](https://xenon-app.com/submit/) prefilled. Paste the code, add
   up to 3 screenshots, submit — **no GitHub account needed**. Your submission lands in
   a moderated queue on the supporter hub; a human reviews it before anything is
   published.
3. Or use the GitHub
   [submission form](https://github.com/marcimastro98/Xenon/issues/new?template=community-submission.yml)
   (the pre-4.5.3 flow — still fully supported).
4. Or open a pull request yourself that:
   - adds an entry to `catalog.json` (see the field reference below), and
   - if your code is longer than ~2 KB, adds it as `codes/<id>.txt` instead of inline
     (set `"codeFile": true` and leave `"code"` out), and
   - optionally provides 1–4 screenshots/GIFs and sets `"shots": <count>` (or
     `"screenshot": true` for a single one). **Attach the images to your issue/PR —
     don't commit them:** screenshots live in the Cloudflare R2 bucket, not in this
     repo (the maintainer uploads them at merge time), so `docs/community/shots/` is
     gitignored. Format is WebP (animated allowed) **or PNG** — the app tries `.webp`
     first, then `.png`; WebP is smaller and the only one that can animate.
5. Or share the code on the [Discord](https://discord.gg/MBVrw9kZyg) `#showcase` channel
   and ask for it to be added.

### Maintainer flow (submissions)

**Easiest — the admin catalog manager** (supporter hub `/admin` → *Community catalog*):
web-portal submissions appear under **Web submissions** (review, publish, reject or mark
spam — publishing marks the queue row approved and cleans its temporary files), and
pending `community-catalog` GitHub submissions show up there pre-filled from the issue form. Import
the code in a scratch profile to check it, then in the manager: fix the id/category/tags,
drag or import the screenshots (they upload straight to R2), set visibility, and hit
**Publish**. That commits the `catalog.json` entry (+ `codes/<id>.txt` for big codes) in one
commit, posts it to the Discord forum, and closes the issue with a thank-you — no `wrangler`,
no hand-edited JSON, no manual PR. See `xenon-supporter-hub` for the `GITHUB_TOKEN` /
`DISCORD_CATALOG_CHANNEL_ID` setup.

**By hand** (fallback): triage the `community-catalog` issue → import the code and check it →
PR: entry in `catalog.json` (+ `codes/<id>.txt` for big codes, `"shots": <count>` for
screenshots) → merge → Pages deploys → the in-app gallery picks it up within its 45-minute
cache window.

Either way, on the resulting push the `Mirror catalog to Discord` workflow
(`.github/workflows/catalog-discord-sync.yml`) posts/updates the entry's thread in the Discord
**catalog** forum — name, description, author, kind/tags and screenshot. Editing an entry
re-edits its thread; the sync is idempotent, so nobody posts in that forum by hand. (The admin
manager commits via the GitHub API, so the same workflow fires for it too.)

Screenshots do **not** go in the PR — upload them to the R2 bucket (served from
`https://assets.xenon-app.com/community/shots/`) with the same `<id>`-derived names the
app expects (`<id>.webp`, then `<id>-2.webp` … `<id>-4.webp`; `.png` also works):

```bash
# from xenon-supporter-hub/ (wrangler is authenticated there)
npx wrangler r2 object put xenon-community-assets/community/shots/<id>.webp --file=<id>.webp --remote
```

Retiring/replacing a shot: `wrangler r2 object delete xenon-community-assets/community/shots/<id>.webp`
then re-put. The bucket is `xenon-community-assets`; the custom domain is `assets.xenon-app.com`.

Keep names/descriptions short and in English (the gallery is global). One entry per
artifact. By submitting you agree the code may be redistributed through the gallery.

## Entry fields

| Field | Required | Notes |
|---|---|---|
| `id` | ✔ | Unique slug, `a-z 0-9 - _`, max 61 chars. Also the anchor `#<id>` and the `codes/<id>.txt` filename. |
| `kind` | ✔ | One of `theme`, `bg`, `page`, `deck`, `widget`, `bundle`, `ambient`, `icons` (Deck icon pack), `sounds` (soundboard pack). |
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
| `version` | | v2 — numeric-dotted (`"1.2.0"`). Powers the in-app update check for **every kind** (v4.5.3+): installs record the entry's version, and a republish with a higher `version` shows an update badge in the gallery. Bump it whenever the entry's code changes. |
| `pkgId` | | v2, `widget`/`ambient` only — the installed package id this entry updates (the pre-4.5.3 update join; still preferred for widgets since it survives non-catalog installs). |
| `category` | | v2 — one of `deck`, `streaming`, `media`, `smart-home`, `system`, `style`, `fun`, `tools`. |
| `tags` | | v2 — up to 5 lowercase tags (`a-z 0-9 -`, ≤20 chars each). |
| `screenshot` | | v2 — `true` when a single `shots/<id>.webp` (or `.png`) exists (never a URL: the path is derived from the id). Legacy single-shot form of `shots`. |
| `shots` | | v2 — integer `1`–`4`: how many screenshot/GIF sidecars this entry has. Files are `shots/<id>.webp`, then `shots/<id>-2.webp` … `shots/<id>-4.webp`. Format is **WebP (animated allowed) or PNG** — the app tries `.webp` first, then `.png`. Never a URL, the paths are derived from the id. |
| `publisher` | | v2 — `{ "handle": "github-handle", "url": "https://github.com/…" }` (url must be on github.com). |

The app re-validates every field and every code goes through the normal import preview +
permission flow — a catalog entry can never change anything silently.
