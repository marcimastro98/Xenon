# Streaming setup — Twitch, YouTube, Discord & Spotify

The Twitch, YouTube, Discord and Spotify integrations (Deck keys, the
Twitch/YouTube/OBS widgets, Discord voice control, and the Spotify queue/playlists
widget) connect to **your own** account using credentials from an app **you**
register. You do this once per service, then paste the credentials into
**Settings → Streaming** in the dashboard and tap **Connect**.

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

## Discord (≈ 2 minutes)

Discord voice control (the Deck's **Discord** actions and the **Discord dashboard
widget** — mute, deafen, push-to-talk, join/leave a voice channel, mic & output
volume, audio processing) is driven through Discord's **local desktop app** over
its private RPC channel. There is no cloud API for this, so — exactly like Twitch —
you register your **own** free Discord app and use it with your **own** account (no
Discord approval needed for your own account).

**You need the Discord desktop app installed and running** while you use these
actions (the browser version won't work — the control channel is local).

1. Open the **Discord Developer Portal**:
   <https://discord.com/developers/applications> (log in with your Discord
   account) → **New Application**, give it any name (e.g. `XenonEdge`), and create.
2. Open the app → **OAuth2** → under **Redirects** add exactly:
   `http://localhost` → **Save Changes**. (The redirect is only matched during the
   token exchange; nothing is hosted there.)
3. Still on **OAuth2**, copy the **Client ID**, then **Reset/Copy** the
   **Client Secret**.
4. In the dashboard: **Settings → Streaming → Discord**, paste the **Client ID**
   and **Client Secret**, tap **Save**, then **Connect**.
5. Discord pops up a consent dialog — click **Authorize**. The card shows
   "Connected as <you>", the Deck editor's **Discord** action category unlocks, and
   the **Discord** widget (add it from the dashboard's "+" palette → Streaming)
   becomes live.

That's it — no verification, no test users. Your token stays on your PC and is
never sent to the browser.

> **Soundboard?** Playing a Discord soundboard sound *as you* isn't something
> Discord exposes to apps, so it isn't a Discord action. Map a Deck
> **keyboard-shortcut** key to your soundboard app (Soundpad, Voicemod…) or use a
> **Streamer.bot** action instead.

---

## Spotify (≈ 2 minutes)

The Spotify integration adds what the Media tile (Windows now-playing) can't show:
the live **Up Next** queue, your **playlists** (tap to play), your **Spotify
Connect devices** (tap to move playback), plus Deck keys for save-to-Liked,
shuffle, play-a-playlist and switch-device. It uses the **Authorization Code +
PKCE** flow — **no client secret**, just a Client ID, like Twitch.

> **Premium note:** reading the queue, playlists and devices works on any account;
> **playback control** (play a playlist, shuffle, switch device) requires **Spotify
> Premium** — a Spotify API limitation, not a dashboard one.

1. Open the **Spotify Developer Dashboard**:
   <https://developer.spotify.com/dashboard> (log in with your Spotify account) →
   **Create app**. Give it any name (e.g. `XenonEdge`).
2. **Redirect URI** — add exactly:
   `http://127.0.0.1:3030/stream/spotify/callback` → **Save**. (Spotify requires the
   loopback IP `127.0.0.1`, not `localhost`. If you changed the server port, use that
   port here.)
3. Under **APIs used**, tick **Web API**. Save.
4. Open the app's **Settings** and **copy the Client ID** (PKCE apps have no
   secret).
5. In the dashboard: **Settings → Spotify** (its own section), paste the **Client
   ID**, tap **Save**, then **Connect**. A Spotify tab opens — approve access, and it
   redirects back with "Spotify connected". (The exact redirect URI is shown with a
   **Copy** button right in that section.)
6. Add the **Spotify** widget from the dashboard's "+" palette → Streaming (or tab-
   group it with the Media tile), and the Deck editor's **Spotify** action category
   unlocks.

That's it — no verification, no test users. Your token stays on your PC and is
never sent to the browser.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Google: **"Access blocked: … has not completed verification … Error 403: access_denied"** | Add your Google account under **OAuth consent screen → Test users**, then retry. |
| Card says **"… app not set up"** | Paste the credentials in Settings → Streaming and tap Save (or set the `TWITCH_CLIENT_ID` / `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` env vars before starting the server). |
| YouTube disconnects after a few days | Expected in Testing mode (7-day refresh-token expiry) — just tap **Connect** again. |
| Twitch login won't start | Confirm the Twitch app **Client Type is Public** and you pasted the **Client ID** (not a secret). |
| Discord: **"Discord desktop app not detected"** | Start the **Discord desktop app** (not the browser version) and try **Connect** again. |
| Discord Connect fails / no consent pop-up | Confirm you added `http://localhost` under the app's **OAuth2 → Redirects**, and pasted both the **Client ID** and **Client Secret**. |
| Discord actions still hidden in the Deck editor | They unlock only once the Discord card shows **Connected**; reopen the key editor after connecting. |
| Spotify: **"INVALID_CLIENT: Invalid redirect URI"** | The redirect URI in your Spotify app must be **exactly** `http://127.0.0.1:3030/stream/spotify/callback` (loopback IP, matching port). |
| Spotify: playlist/shuffle/device does nothing | Those need **Spotify Premium** and an **active device** — start playback on a device first, then retry. Reading the queue/playlists still works without Premium. |

## Where credentials live (advanced)

- **App credentials**: `server/stream-config.json` — keys `twitchClientId`,
  `youtubeClientId`, `youtubeClientSecret`, `discordClientId`,
  `discordClientSecret`, `spotifyClientId`. The Settings inputs write this file; you
  can also edit it directly or use the `TWITCH_CLIENT_ID` / `YOUTUBE_CLIENT_ID` /
  `YOUTUBE_CLIENT_SECRET` / `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` /
  `SPOTIFY_CLIENT_ID` environment variables (env wins).
- **Login tokens**: `server/stream-tokens.json` — managed automatically; delete it
  to force a full re-login. Both files are git-ignored and never sent to the browser.
