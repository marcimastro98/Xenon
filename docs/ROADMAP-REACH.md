# Xenon Reach Roadmap — from a niche display to a mainstream app

> **Scope note:** this document is about **reach** — how many people can run
> Xenon at all, and how they find it. It is *not* `ROADMAP-PLATFORM.md` (the
> creator-platform/marketplace ladder) and *not* an app-feature roadmap (those
> live in `CHANGELOG.md` and GitHub issues). The two roadmaps are
> complementary: the platform roadmap deepens value for the people who already
> run Xenon; this one raises the ceiling on how many people *can*.
>
> **Premise.** Xenon already delivers more value than its addressable audience
> can absorb. The bottleneck is not features — it is three hard gates between
> the app and a normal person. Every phase below removes one gate.

---

## 1. The three gates

| Gate | Who it excludes | Removed by |
|---|---|---|
| **Windows only** (`package.json` `"os": ["win32"]`) | ~40% of desktops, and most of the design/creator audience that publishes screenshots | Phase R3 (macOS) |
| **A spare screen to dedicate** | The large majority of PC owners. This is the real ceiling — an Edge, a spare monitor or an idle tablet is a minority setup | Phase R1 — **removed at home in v4.11.0** (pairing + phone layout); T2 extends it away from home |
| **A download before any value** | Every link Xenon is shared in converts at download-page rates, not product rates | Phase R0 (try it in the browser) |

Ordering principle: **R0 is the cheapest, R1 is the only one with a ceiling in
the millions.** Ship in cost order, not ambition order.

## 2. What the codebase already gives us for free

These are load-bearing for everything below and already exist — the reach work
is smaller than it looks because of them.

- **One engine, many surfaces.** The dashboard is a plain web app served by
  `server/server.js`; the native kiosk (`apps/native/`) and the iCUE iframe are
  *viewports*, not forks. A new surface inherits every feature automatically.
- ~~**Responsive down to phone size.**~~ **This was wrong, and R1.3 found out.**
  `server/styles/breakpoints.css` does carry `max-width: 360px` / `720px` /
  `orientation: portrait` rules, but they target the pre-v4
  `.dashboard-widget[data-dashboard-size]` markup that the 24-column GridStack
  replaced — so nothing reflowed and a phone got the desktop layout at
  one-sixth scale. The phone layout shipped in v4.11.0 as its own presentation
  mode (`js/phone-view.js`); see R1.3 below. Kept here rather than deleted
  because "the CSS already handles it" is a claim worth being able to re-check.
- **10 UI languages.** `server/js/i18n.js` ships `en, it, de, fr, es, pt, ru,
  ko, ja, zh`; the site carries 5. International reach is not blocked on
  translation.
- **One-file install + silent autostart + in-app updater.** `Xenon-Setup-x64.exe`
  already meets the bar stores expect.
- **Consent-gated, identity-free version ping.** The honest telemetry floor is
  in place (see the privacy page); it can grow into aggregate health metrics
  without breaking the account-free promise.

---

## Phase R0 — Try before install *(cheapest win, do first)*

**Goal:** make every shared link a product trial instead of a download page.

The dashboard is already a web app, so a **mock-data mode** can be served
statically from `xenon-app.com/demo`: the real UI, real themes, real layout
editor, with sensors/media/audio fed by a deterministic fake provider instead
of the local backend.

- **Scope (M):** a `demo` data provider that satisfies the same client-side
  contracts the SSE/poll endpoints do; a build step that publishes
  `server/` static assets to `docs/demo/`; hard-disable of everything that
  writes to the PC (Deck actions, disk cleanup, `run_pc_command`, installs).
- **Payoff:** every Reddit/TikTok/YouTube link, every catalog entry, and every
  creator's theme becomes clickable. Catalog entries gain a "preview in
  browser" that needs no install — this also feeds the platform roadmap.
- **Guardrail:** the demo must be unmistakably a demo (persistent badge, no
  local writes), or it becomes a support burden.

**Companion to R0 — "Share my setup" (S).** One tap renders a branded image of
the current dashboard plus a preset link. This is the unit of sharing for
`r/battlestations`, Shorts and TikTok. The catalog today points inward; this
points it outward.

---

## Phase R1 — Xenon Companion: the phone as the second screen *(the real unlock)*

**Goal:** turn "you need a spare screen" into "you already own the screen."

Market proof that this scales: Deckboard, Touch Portal and Unified Remote are
million-install Play Store apps, and Stream Deck Mobile is a paid subscription.
Xenon arrives free, open source, with far more surface and better design.

### R1.0 — The key architectural fact

**Nothing is rebuilt.** The phone renders the *same* dashboard from the *same*
engine. Almost every feature runs server-side on the PC (see §5), so the phone
is a viewport with a network hop, exactly like the iCUE iframe is today. The
work is **reachability, trust and polish** — not a port.

### R1.1 — Reachability (the security decision) — **shipped in v4.11.0**

Before this, the phone **could not reach Xenon at all**. `isAllowedRequest()`
enforces loopback at three layers — socket IP, `Host` header, and `Origin` — and
that guard is correct and was not weakened.

What shipped is a **separate, opt-in, authenticated door beside it**
(`server/remote-access.js`, unit-tested in
`server/test/remote-access.test.mjs`):

- Off by default. With `remoteAccess.enabled` false the module is never
  consulted and a non-loopback request gets the byte-identical 403 it always
  got — a LAN scanner cannot tell the feature exists.
- **Device pairing, not a password.** The dashboard mints a one-time 8-character
  code (3-minute TTL, burned after 5 wrong guesses) and shows it as a QR; the
  phone redeems it for a per-device token. Tokens are stored only as SHA-256
  hashes, compared in constant time, and are listed, named, individually
  revocable and killable in one tap — and revoking drops the device's live
  sockets rather than letting an open SSE stream keep feeding it.
- A **distinct request path**: the `Host` must be an IP *literal* this machine
  currently owns (a name is always refused, which removes DNS rebinding rather
  than mitigating it), `Origin` must be exactly ours (`null` is refused, unlike
  on the loopback door), the cookie is `SameSite=Strict`, no GET on this door
  mutates anything, and both the pre-auth surface and each device have their own
  rate limits. The loopback fast-path is untouched, so the Edge, the native app
  and the iCUE iframe are unaffected.

  **One correction worth recording**, because it was shipped wrong and found on
  real hardware: the first version also *required* `Sec-Fetch-Site: same-origin`.
  Browsers append `Sec-Fetch-*` only to potentially trustworthy URLs, so on plain
  HTTP to a LAN address those headers never arrive — the check refused every
  legitimate request, and a paired iPhone could only ever load the refusal page.
  It now enforces the header when present (T2/HTTPS brings it back) and accepts
  its absence, with the CSRF weight carried by SameSite + Origin + the POST-only
  control endpoints. The lesson generalises to the whole T1 tier: **anything
  gated on a secure context is unavailable until T2**, and a check that cannot
  fire is not a layer.
- **A paired device IS the dashboard.** It does what the dashboard on the PC
  does — Deck keys fire, settings save, the Store installs, the AI answers —
  except a short deny list, every entry of which needs a person standing at that
  PC: the UAC prompt, the updater, the installers. Plus Claude Code's own
  token-gated ingest, and the pairing admin (so a phone cannot enrol another
  phone or revoke the device that would kick it off). No GET may change state,
  which is what keeps a top-level navigation harmless on a transport with no
  fetch-metadata. `server/test/remote-access.test.mjs` pins the REFUSED set
  against the real route list in `server.js`.

  **This is the second correction found on real hardware**, and the more
  important one. The first version was much narrower — read-only plus
  media/audio/mic — on the reasoning that a LAN device deserves less trust. Tried
  on an actual tablet it was plainly wrong: the dashboard arrived whole and then
  refused almost every control on it, which is the "looks alive, does nothing"
  failure this project avoids everywhere else. "Add device" is not a request to
  watch Xenon from a distance; it is the user saying this screen is one of mine.
  The trade that comes with it is stated in the Settings panel rather than
  designed around: a lost paired device is a way into the PC until it is
  revoked.
- The **pre-auth surface is two paths wide** — the pairing page and the redeem
  POST — and nothing else is reachable without a token.

  **The third correction, and the one that made the other two look wrong.**
  Widening the gate is necessary but not sufficient: the CLIENT has to address
  the machine running the server. `SERVER` in `js/state.js` resolved to
  `window.location.origin` only when the page's HOSTNAME was
  `127.0.0.1`/`localhost`/`::1`, and otherwise fell back to the loopback
  literal — so on a paired phone roughly fifty call sites across fifteen modules
  dialled **the phone's own loopback**. Everything written as a relative URL
  worked (the shell, `/sse`, `/actions/run`, the app switcher), and everything
  written as `SERVER + '/x'` reached nothing: `/deck-config` (the Deck drew its
  chrome and twenty-four empty keys), `/network` and `/api/performance/stats`
  (ping, FPS and latency permanently blank), `/media/*` (transport did nothing),
  `/volume/*`, `/system`, `/events`, `/windows`. The gate was allowing requests
  that were never sent. It now keys on the PROTOCOL — any page served over
  http(s) talks back to the origin that served it, which is the same server on
  every surface we ship — and the loopback fallback remains for `file://` and
  custom-scheme surfaces, which have no origin to inherit.

  Two things follow, both cheap and both worth keeping. `server/test/
  state-server-origin.test.mjs` evaluates the real declaration out of the
  shipped source against a stubbed LAN location, and separately refuses a new
  hardcoded loopback origin anywhere in `server/js/` (with the two legitimate
  exceptions named and justified: Ollama's own port, and the Spotify redirect
  URI that must match what is registered). And "does the gate allow it" is now
  measured rather than asserted: extracting every endpoint the client calls and
  running each through `remotePathAllowed` gives 215 endpoints, 11 refused, all
  eleven deliberate.

  **The fourth correction: an audit of `fetch()` call sites cannot see an
  `<iframe src>`.** Every SDK widget rendered as a white rectangle on the
  tablet, and the reason is a property of the sandbox rather than a mistake in
  the gate. A widget frame is `sandbox="allow-scripts"` with no
  `allow-same-origin` — non-negotiable, it is what keeps widget code away from
  the local API — so its document has an OPAQUE origin, which gives it a null
  site-for-cookies, which makes every subresource it requests count as
  cross-site. A `SameSite=Strict` cookie is withheld from all of them.

  Measured rather than reasoned, with an echo server on one origin serving two
  identical iframes: the iframe DOCUMENT carried the cookie in both cases; the
  sandboxed one's `widget.css` and `widget.js` arrived with no cookie, no
  Origin, no Referer and `Sec-Fetch-Site: cross-site`, while the non-sandboxed
  control's carried the cookie and read `same-origin`. So the widget's HTML
  loaded and its stylesheet and script were refused — unstyled markup on the
  browser's white canvas.

  Neither obvious fix exists: the sandbox may not gain `allow-same-origin`, and
  the cookie may not leave `SameSite=Strict` (it is the CSRF defence on a
  cleartext transport). Serving the tree pre-auth was the third option and is
  worse than it looks — it would turn "exactly two paths without a token" into a
  whole readable tree for anyone on the Wi-Fi. So the credential moved into the
  PATH, where relative URLs inherit it for free:
  `/sdk/wk/<key>/<pkg>/<file>`. The key is per device, minted at pairing (and
  lazily for devices paired before it existed), dies on revoke, is compared in
  constant time, and buys exactly one thing — GET on static files of installed
  packages. It is visible to the widget it serves, which is acceptable only
  because it unlocks nothing else and the widget has no network to leak it over
  (`connect-src 'none'`). The gate's cross-site check has ONE exemption for that
  path, and the exemption is a statement about the transport, not a relaxation:
  an opaque-origin subresource is stamped cross-site even when it is the same
  origin, so the check can never be satisfied there.

  **The fifth correction, and why this took four rounds: an opaque origin fails
  TWO checks, not one.** The path capability was necessary and not sufficient. A
  sandboxed document also sends `Origin: null` on every subresource, and the gate
  refused `null` outright — so the keyed stylesheet came back 403 while the
  IDENTICAL url, fetched from the PARENT page with credentials omitted, returned
  200. That asymmetry is what defeated every probe: a parent page has a real
  origin and sends no Origin header at all on a same-origin GET, so nothing built
  by hand could reproduce the failing request. Chromium named it in the end —
  DevTools Issues reported "Response was blocked by CORB (Cross-Origin Read
  Blocking)" beside "failed to load a stylesheet", and the network row showed 403
  on a correctly keyed URL.

  Two things worth keeping. A refusal on that path is INVISIBLE to the widget —
  the browser blocks the body and its own console stays empty — so the path must
  never be able to fail for a procedural reason; `test/remote-access.test.mjs`
  pins that only a missing capability may refuse it. And when a hand-made request
  succeeds where the real one fails, the difference is the CONTEXT the browser
  supplies, not the URL: stop probing and read what the browser itself reports.

  The generalisable lesson is the audit's blind spot, not the cookie: an
  endpoint inventory built from `fetch()` call sites misses everything the
  BROWSER fetches on the page's behalf — iframes, stylesheets, scripts, images,
  fonts. Those are exactly the requests whose credentials follow different rules.

  **The sixth correction, and the only one that was a correction to this
  document.** "Still open on this tier: the AI key travels to paired devices,
  because the client gates on its presence in a dozen places and a blank one
  turns every AI surface on the tablet into invalid key" — deferred to T2 on the
  reasoning that the transport would stop being cleartext anyway. Both halves of
  that were wrong, and checking took twenty minutes. The client does gate on the
  key in eight places, but it never CALLS with it: nothing in `server/js/` has
  ever contacted generativelanguage.googleapis.com. Every use was either a
  presence test or a `key:` field posted to one of our own endpoints, which then
  called Google. The key was making a round trip to the browser to come straight
  back — and on this tier, across the LAN in the clear.

  So it stops travelling, with no capability lost on any surface. Server side,
  `geminiKeyFor()` substitutes the stored key whenever a request body's is empty
  (seven endpoints; `/api/performance/plan` and the `/api/ai/live` socket already
  did exactly this, which is the strongest evidence the pattern was always the
  intended one). Client side, `geminiKeyReady()` is the single readiness gate and
  reads the `geminiApiKeySet` flag the redactor exposes — the trap being that
  gating on the VALUE after redaction reports "invalid key" on a perfectly
  configured PC, which is the failure the old code comment predicted and used as
  its reason not to redact. A key already in a browser's localStorage is pushed
  to the server once on the next hydrate and never mirrored again.

  The lesson is about the shape of the claim, not the key: **"the client needs
  this secret" is a statement about call sites, so read the call sites.** A
  credential that is only ever handed back to the server that issued it was never
  travelling for a reason — and the cost of not checking was a real secret on a
  cleartext wire, deferred behind a tier of work it had nothing to do with.

**Still open on this tier:** nothing, beyond what the transport itself cannot
give (see R1.2). One operational sharp edge is worth stating rather than fixing
here: the device cookie is bound to the ORIGIN, i.e. `http://<ip>:3030`, so a PC
whose DHCP lease hands it a different address looks unpaired to every device and
has to be re-paired. It cannot be fixed client-side — localStorage is
origin-scoped too — and the `Host` must stay an IP literal, which is what removes
DNS rebinding. A DHCP reservation is the workaround; a stable name is T2.

### R1.2 — The secure-context ladder

Phone-class capabilities (installable PWA, service worker, microphone via
`getUserMedia`, Web Push) require a **secure context**. `http://<lan-ip>:3030`
is *not* one — this, not the UI, is the actual technical constraint. Hence a
three-tier ladder, each tier shippable on its own:

| Tier | Transport | What the user gets | Effort |
|---|---|---|---|
| **T1 — LAN tab** ✅ *v4.11.0* | `http://<lan-ip>:3030` + paired token | Full dashboard in the phone browser, at home. No install, no mic, no push, no offline | M |
| **T2 — HTTPS transport** ✅ *v4.11.0* | Tailscale MagicDNS + `tailscale cert`, terminated by Xenon itself on a second listener | A secure context: works away from home with no open ports, and unblocks everything below | L |
| **T2b — PWA + mic** ✅ *v4.11.0* | manifest + a deliberately timid service worker, on top of the transport above | Home-screen icon, full screen, the phone's own microphone for AI | M |
| **T2c — Web Push** | VAPID + an encrypted push payload (aes128gcm), hand-rolled to keep the zero-dependency rule | Notifications when the dashboard is not open | M |
| **T3 — Store presence** | Thin native wrapper (Tauri/Capacitor) around the T2 client | Play Store / App Store **discovery** — a growth channel in its own right — plus push tokens and background behaviour the web cannot do | L–XL |

Rationale for T2 over a hosted relay: a cloud relay would give the smoothest
onboarding but puts a Xenon-operated server between the user and their PC. That
contradicts the "100% local, no account" promise the product is *known* for. If
a relay is ever added it must be pure transport, opt-in, and framed honestly —
it is not the default path.

### R1.3 — Portrait polish — **shipped in v4.11.0**

The premise that `breakpoints.css` already reflows turned out to be wrong, and
it is worth recording why: those rules target the pre-v4
`.dashboard-widget[data-dashboard-size]` markup that the 24-column GridStack
replaced. Nothing reflowed. A 390px phone got a 16px column, i.e. the desktop
layout as an unreadable miniature.

What shipped (`server/js/phone-view.js` + `components/PhoneView/PhoneView.css`,
tested in `server/test/phone-view.test.mjs`):

- Below **620px** the tiles stack into one column in reading order (row-major
  over the grid coordinates), each keeping its `gs-h` as a proportion. The
  threshold sits clear of a Xeneon Edge mounted vertically (720px); a manual
  override is remembered per device and never reaches the server.
- **A phone on its side stacks too**, which the first version got wrong. It left
  landscape on the grid, reasoning that ~930px is cramped but readable — true
  horizontally, and beside the point. What runs out is HEIGHT: ~430px clips
  every tile mid-content and leaves the topbar and the edge rails sitting on
  what is left, i.e. exactly the failure this view exists to remove. So there is
  a second bound (`height <= 500 && width <= 1000`), deliberately two-sided
  because the dimensions are not interchangeable: the height identifies the
  phone, the width is what stops a short, wide DESKTOP window — or a 2560x720
  Xeneon Edge — from being claimed by it. The tile height cap moved with it:
  `80vh` is right in portrait and wrong lying down (344px against a 298px band,
  so nothing ever fit whole), and is now bounded by the scrolling band rather
  than by the viewport. Measured in a real 932x430 viewport, both directions.
- **Presentation only.** GridStack's own one-column mode was the obvious tool
  and is the wrong one: changing the column count rewrites every tile's
  coordinates and fires `change`, which `dashboard-grid.js` serializes and
  SAVES — opening the dashboard on a phone would silently rewrite the layout
  built on the PC. The phone view reorders DOM nodes and overrides positioning
  in CSS, so its worst failure is cosmetic. A test pins that it never reaches
  into the grid engine.
- A stacked tile gets a **definite** height, not `height:auto` + `min-height`.
  Every widget is built on `.grid-stack-item-content > .panel { height: 100% }`,
  and a percentage height does not resolve against an auto-height parent even
  when `min-height` has stretched it — the media tile rendered its title and
  nothing else. Also pinned by a test, because the auto-height version looks
  more natural and is the obvious thing to "simplify" back into.
- Compact top bar, **thumb dock** at the bottom (page navigation + search /
  AI / apps / settings, as forwarders to the real buttons so no state is
  duplicated and `topbar-minimal.js` keeps owning where those buttons live),
  safe-area insets, layout editing hidden.
- `?panel=` embeds and the Edge preview stage are excluded outright: both are
  narrow for reasons that have nothing to do with a phone.

---

## Phase R2 — Distribution

Reach is not only capability; it is being where people already look.

- **`winget` + Microsoft Store** — passive discovery for Windows utilities,
  and the update channel users expect. Blocked on a licence review (see §6).
- **Steam** — the audience is already gamer-shaped, wishlists give a launch
  spike, and Steam is a merchant of record if selling ever happens (it handles
  VAT). Worth a serious evaluation even shipping free.
- **Creators as a channel** — 20 active theme creators bring their own
  audiences; that is worth more than 20 new features. This is where the reach
  roadmap and `ROADMAP-PLATFORM.md` meet.

## Phase R3 — macOS

`MACOS_PORTABILITY.md` already scopes this: ~55–60% of the app runs unchanged,
and the green + easy tiers are mostly ungating work. Beyond the raw doubling of
desktop TAM, it changes *who* uses Xenon — from Windows gamers to the
creator/designer audience that publishes screenshots, which compounds with R0's
share loop. Ship the green tier first as "macOS (early)"; never claim parity.

---

## 5. What the phone actually gets (the honest matrix)

The question "do I have to rebuild every feature for mobile?" resolves to
**no** — because of where each feature executes.

| Class | Examples | On the phone |
|---|---|---|
| **Server-side (the vast majority)** | System monitor, fans, energy, batteries, disk, media, audio, mic, RGB lighting, Deck, calendar, tasks, notes, timers, weather, stocks, news, football, Home Assistant, cameras, streaming, AI chat, catalog, themes, layout editor | ✅ Works with zero new code — the PC computes, the phone renders |
| **Client-device capabilities** | AI voice input (STT), TTS output, notifications, haptics | ⚠️ Works, but needs a phone-side path: mic capture is `getUserMedia` instead of the PC's DirectShow capture, TTS/notifications may target the phone or the PC. **Requires T2 (secure context).** |
| **PC-surface-only** | Native kiosk gestures (swipe-to-desktop), game-safe touch, Spotlight popup, Deck popup window, embedded browser, app switcher | 🚫 Hidden on phone — they are properties of a window living on the PC, and have no meaning on another device |
| **Privileged / destructive** | Disk cleanup, `run_pc_command`, open file/app, elevation & startup task, credential entry | 🔒 Deny-by-allowlist for paired devices in R1; revisit individually, each on its own merit, never as a blanket unlock |

The engineering shape is therefore: **one capability descriptor per surface**.
The server already knows which surface is asking (native / browser / iframe);
R1 adds `phone` to that set, and each widget declares whether it is available,
degraded, or hidden — the same mechanism, one more value.

---

## 6. Cross-cutting work (required before, not after, scale)

- **Onboarding wedge.** ~40 features is a retention asset and an acquisition
  liability. First run must present **three** (system monitoring · media & mic ·
  Deck) and let the rest be discovered. The "any second screen" reframing
  already done on the site must reach the app and the installer.
- **Licence review.** The current non-commercial licence needs checking against
  Microsoft Store / Steam / Play Store distribution terms **before** R2 work
  starts — it is a gating dependency, not a formality.
- **Support that scales without the author.** Searchable docs/FAQ answering the
  top install questions, and marketplace moderation that does not depend on
  one human reviewing every submission (see `ROADMAP-PLATFORM.md`).
- **Aggregate health, still identity-free.** Extend the opt-in ping into crash
  and error aggregation. At 300 users you hear about bugs; at 300k you do not.
- **Monetization stays deferred.** The three real paths — OEM/hardware
  partnership, marketplace revenue share, an optional pro tier — all require a
  legal entity first. Volume first, structure second. Nothing here depends on
  charging anyone.

## 7. Sequencing

| # | Work | Gate removed | Effort |
|---|---|---|---|
| 1 | ~~R0 browser demo + share-my-setup image~~ **shipped v4.11.0** | Download-before-value | M + S |
| 2 | ~~R1.1 pairing & authenticated device path~~ **shipped v4.11.0** | — (prerequisite) | M |
| 3 | ~~R1.2 T1 (LAN tab) + R1.3 portrait layout~~ **shipped v4.11.0** | Spare-screen requirement | M–L |
| 4 | R1.2 T2 (PWA over Tailscale HTTPS) | Away-from-home, phone capabilities | L |
| 5 | R2 winget / Microsoft Store (after licence review) | Discovery | S–M |
| 6 | R3 macOS green tier | Windows-only | L |
| 7 | R1.2 T3 mobile store wrapper | Discovery at phone scale | L–XL |

## 8. Explicit non-goals for this cycle

Deferred until R0 and R1 are live, because each raises value for current users
and none raises the ceiling: **L3 native plugins**, new vertical integrations
(more sports/finance/camera providers), and app features generally. The test for
any proposed work during this cycle is simply: *does it remove a gate, or does
it deepen the current one?*
