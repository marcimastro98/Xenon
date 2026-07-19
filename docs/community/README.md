# Xenon community gallery

This folder powers the community catalog — both on the website and inside the app's
**Store** (Impostazioni → Community → *Apri lo Store* → **Sfoglia**). Everything in `catalog.json` is shown to
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

### Automatic limited editions

New limited editions should use the Supporter Hub inventory instead of a hand-edited
`claimed` counter. The public catalog entry contains only this projection:

```json
{
  "limited": {
    "total": 50,
    "claimed": 0,
    "fulfillment": "hub",
    "dropId": "signal-50",
    "channels": "discord",
    "numbered": true
  }
}
```

- `numbered` is opt-in. When true, every owner receives a distinct edition and bundle;
  when false, all claim slots point to the same creation.
- `channels` is `discord` for a Discord-only claim button, or `both` to also show the
  styled **Claim your copy** button on the website and in the app Store.
- `total`, `claimed`, `numbered` and `channels` are projections only. The website and app
  hydrate live inventory from the Hub, and the admin publisher overwrites these values
  from D1 so catalog JSON cannot forge stock.
- Never add a public `claimUrl`. Discord claim links are generated and signed by the Hub;
  website/app links are derived from the fixed Hub origin and only appear for `both`.

Maintainer flow:

1. Add a `limited` block to the creator source `pack.json`, then run
   `.agents/skills/xenon-creator/scripts/build-limited.mjs` (or the creation's wrapper).
2. Keep `<dropId>-limited-manifest.json` private. It contains the encrypted bundles' CEKs.
3. In Supporter Hub `/admin` → **Automatic limited drops**, import the manifest and choose
   **Discord only** or **Site/app + Discord** with the channel buttons.
4. Publish the generated public catalog fragment only after the Hub migration, OAuth and
   Turnstile configuration are live.

The claim itself always signs in with Discord and verifies membership in the Xenon server.
D1 enforces one claim per `(dropId, Discord user id)` and assigns the inventory slot with
one atomic update, so parallel requests cannot take the same copy. The resulting personal
`XL-` code unlocks only that artifact and is limited to three installation ids; reinstalling
on the same installation does not consume another device.

The app re-validates every field and every code goes through the normal import preview +
permission flow — a catalog entry can never change anything silently.

## Announcements (`messages.json`)

A second static file next to `catalog.json`, serving the app's announcement channel:
release notes, "new in the Store" nudges, and the occasional note. The app fetches it at
most once a day through `GET /api/community/messages`
(`server/community-messages.js`), which validates every field before the dashboard sees it.

**Targeting runs on the user's machine, not here.** Every install downloads the whole file
and `server/js/hub-match.js` decides locally which messages apply. Nothing about a user is
sent to receive a targeted message, so there is no way to address an individual install and
no record of who saw what. This is the same constraint `server/version-ping.js` documents
for usage counts, and it is the reason the feed is a public static file rather than an API.
Do not add a per-install query.

```jsonc
{
  "messages": [
    {
      "id": "v490-release",        // ^[a-z0-9][a-z0-9_-]{0,60}$, unique; also the "already shown" key
      "level": "toast",            // toast (default choice) | modal | banner
      "kicker": "Xenon",           // optional, ≤24 chars
      "title": "Xenon 4.9.0",      // required, ≤120 chars
      "body": "What changed.",     // optional, ≤600 chars
      "entryId": "neon-pack",      // optional catalog entry this is about
      "action": {
        "type": "url",             // url | store | dismiss
        "label": "Read more",      // required, ≤40 chars
        "url": "https://xenon-app.com/changelog"
      },
      "match": {                   // optional; omit for "everyone"
        "minVersion": "4.9.0",     // inclusive, digits and dots only
        "maxVersion": "4.9.9",     // inclusive
        "os": ["win32"],           // process.platform tokens
        "lang": ["it"],            // two-letter UI language
        "hasEntry": ["dgm-news"]   // matches anyone running ANY of these
      },
      "activeFrom": "2026-07-20",  // optional ISO date/datetime
      "activeUntil": "2026-08-01"
    }
  ]
}
```

Rules worth knowing before you write one:

- **`level: "toast"` unless it truly warrants a full stop.** A modal takes the dashboard's
  one interruption slot for the day, shared with the paid-drop card, and loses to it.
- **A `match` block that fails validation drops the message entirely**, rather than being
  ignored and shown to everyone. Same on the client: a condition it does not recognise
  matches nobody. A filter that was meant to narrow the audience must never widen it.
- **`action.url` is restricted** to `xenon-app.com`, `github.com` and Discord, https only.
  Anything else is stripped and the message renders without a button.
- **`action: "store"` needs `entryId`**, and opens the Store through the normal import
  preview — a message can never install anything.
- **`id` is permanent.** It is how a dashboard remembers it has already shown a message,
  and it shares that set with the drop card, so an announcement about an entry the drop
  card already covered will not appear twice. Reusing an id hides the new message.
- Max 50 messages; the file is capped at 512 KB.

### Polls

A message can carry a poll instead of a button. The title asks the question, the options
answer it:

```jsonc
{
  "id": "what-next",
  "level": "modal",           // forced to modal anyway: the options are buttons
  "title": "What should come next?",
  "poll": {
    "options": [              // 2 to 5, ids charset-pinned like every other id
      { "id": "deck", "label": "A bigger Deck" },
      { "id": "ai",   "label": "Smarter AI" }
    ]
  }
}
```

Answers go to `POST /feedback/poll` and land in a `(message_id, option_id) → count` table.
**Nothing identifies who answered**: no install id, no IP kept, no per-vote row and no
timestamp, so there is no way to ask what a given dashboard chose. One answer per dashboard
is enforced in the app, which remembers what it has answered — weaker than a server-side
constraint, and deliberately so, since that constraint would need exactly the identifier
this avoids. Read a result as a sense of the room, not a ballot.

An invalid poll drops the whole message rather than shipping as a plain announcement: the
title is usually a question, and a question with no way to answer it reads as broken.
