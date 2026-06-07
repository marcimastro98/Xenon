# Streaming setup — Twitch & YouTube

The Twitch and YouTube integrations (Deck keys, the Twitch widget, and — soon —
YouTube go-live/viewer count) connect to **your own** account using credentials
from an app **you** register. You do this once per service, then paste the
credentials into **Settings → Streaming** in the dashboard and tap **Connect**.

Nothing is hard-coded and nothing is committed: your credentials are stored only
in `server/stream-config.json` (git-ignored) and your login tokens only in
`server/stream-tokens.json` (git-ignored). They never leave your PC.

> **Why per-user?** These are *your* accounts. Twitch needs only a free app
> registration (one click-through). YouTube uses a Google Cloud project; Google
> requires a verified app for unrestricted public use, so for personal use we keep
> it in "Testing" mode and you add yourself as a test user (see the caveat below).

---

## Twitch (≈ 2 minutes)

1. Go to the **Twitch Developer Console**: <https://dev.twitch.tv/console/apps/create>
   (log in with your Twitch account).
2. **Register Your Application**:
   - **Name**: anything (e.g. `XenonEdge`).
   - **OAuth Redirect URLs**: `https://localhost` (required by the form; the
     device flow doesn't use it).
   - **Category**: *Application Integration* (any is fine).
   - **Client Type**: **Public** ← important. (Public clients use the Device Code
     Flow and need no client secret.)
3. Click **Create**, open the app, and **copy the Client ID**. There is no secret
   for a public client.
4. In the dashboard: **Settings → Streaming → Twitch**, paste the **Client ID**,
   tap **Save**, then **Connect**.
5. A code + a link appear. Open the link (on your phone or this PC), sign in to
   Twitch, and enter the code. Done — the card shows "Connected as <channel>".

That's it for Twitch — no verification, no test users.

---

## YouTube (Google Cloud)

YouTube is heavier because Google governs the `youtube` API scope.

1. Open the **Google Cloud Console**: <https://console.cloud.google.com/>
2. Create (or pick) a **project** (top bar → project selector → New project).
3. **Enable the API**: APIs & Services → **Library** → search **"YouTube Data API
   v3"** → **Enable**.
4. **Configure the OAuth consent screen** (APIs & Services → OAuth consent screen):
   - **User type**: **External** → Create.
   - Fill the required app name, support email, and developer email. (Logo,
     homepage, etc. are optional while in Testing.)
   - **Scopes**: you can leave them empty here (the app requests `youtube` at
     login time).
   - **Test users** → **Add users** → add **your own Google account** (the one you
     will log in with). ← **this is the step most people miss.**
   - Save. Leave **Publishing status** as **Testing**.
5. **Create the OAuth client** (APIs & Services → Credentials → **Create
   credentials → OAuth client ID**):
   - **Application type**: **TVs and Limited Input devices**.
   - Create, then **copy the Client ID and Client Secret**.
6. In the dashboard: **Settings → Streaming → YouTube**, paste **Client ID** and
   **Client Secret**, tap **Save**, then **Connect**, and authorise with the code
   + link (using the same account you added as a test user).

### ⚠️ Caveat: Testing mode token expiry

While the Google app stays in **Testing** (the normal state for personal use):

- Only accounts added under **Test users** can connect (up to 100).
- The **refresh token expires after ~7 days**, so roughly weekly the YouTube card
  will fall back to "Connect" and you just re-authorise. This is a Google policy,
  not a dashboard bug — the app handles it gracefully (no crash, no stale state).

To remove both limits you would **publish + verify** the Google app (a one-time
Google review with a privacy policy, homepage and a demo video). For a single
personal setup this usually isn't worth it; Testing mode + your own test-user
entry works fine.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Google: **"Access blocked: … has not completed verification … Error 403: access_denied"** | Add your Google account under **OAuth consent screen → Test users**, then retry. |
| Card says **"… app not set up"** | Paste the credentials in Settings → Streaming and tap Save (or set the `TWITCH_CLIENT_ID` / `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` env vars before starting the server). |
| YouTube disconnects after a few days | Expected in Testing mode (7-day refresh-token expiry) — just tap **Connect** again. |
| Twitch login won't start | Confirm the Twitch app **Client Type is Public** and you pasted the **Client ID** (not a secret). |

## Where credentials live (advanced)

- **App credentials**: `server/stream-config.json` — keys `twitchClientId`,
  `youtubeClientId`, `youtubeClientSecret`. The Settings inputs write this file;
  you can also edit it directly or use the `TWITCH_CLIENT_ID` /
  `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` environment variables (env wins).
- **Login tokens**: `server/stream-tokens.json` — managed automatically; delete it
  to force a full re-login. Both files are git-ignored and never sent to the browser.
