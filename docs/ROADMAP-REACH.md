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
| **A spare screen to dedicate** | The large majority of PC owners. This is the real ceiling — an Edge, a spare monitor or an idle tablet is a minority setup | Phase R1 (the phone *is* the second screen) |
| **A download before any value** | Every link Xenon is shared in converts at download-page rates, not product rates | Phase R0 (try it in the browser) |

Ordering principle: **R0 is the cheapest, R1 is the only one with a ceiling in
the millions.** Ship in cost order, not ambition order.

## 2. What the codebase already gives us for free

These are load-bearing for everything below and already exist — the reach work
is smaller than it looks because of them.

- **One engine, many surfaces.** The dashboard is a plain web app served by
  `server/server.js`; the native kiosk (`apps/native/`) and the iCUE iframe are
  *viewports*, not forks. A new surface inherits every feature automatically.
- **Responsive down to phone size.** `server/styles/breakpoints.css` already
  handles `max-width: 360px`, `max-width: 720px` and `orientation: portrait`.
  The phone layout is a polish job, not a redesign.
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

### R1.1 — Reachability (the security decision)

Today the phone **cannot reach Xenon at all**. `isAllowedRequest()`
(`server/server.js:9647`) enforces loopback at three layers — socket IP, `Host`
header, and `Origin` — and that guard is correct and must not be weakened
globally.

The plan adds a **separate, opt-in, authenticated path** rather than relaxing
the existing one:

- Off by default. Enabling it is an explicit Settings action with a plain-language
  explanation of what becomes reachable.
- **Device pairing, not a password:** the dashboard shows a QR containing a
  one-time pairing code; the phone redeems it for a per-device token. Tokens are
  listed, named, and individually revocable, with a one-tap kill-switch (mirror
  the Remote-Control panel's existing pattern).
- A **distinct request path** for paired devices: token required on every
  request and on the SSE/WebSocket upgrade, its own `Host`/`Origin` allowlist,
  its own rate limits. The loopback fast-path stays untouched, so the Edge,
  the native app and the iCUE iframe are unaffected.
- **PC-only endpoints stay PC-only** even for paired devices — the destructive
  and privileged surface (disk cleanup, `run_pc_command`, startup task /
  elevation, provider credentials, installer flows) is denied by allowlist,
  not by UI hiding.

### R1.2 — The secure-context ladder

Phone-class capabilities (installable PWA, service worker, microphone via
`getUserMedia`, Web Push) require a **secure context**. `http://<lan-ip>:3030`
is *not* one — this, not the UI, is the actual technical constraint. Hence a
three-tier ladder, each tier shippable on its own:

| Tier | Transport | What the user gets | Effort |
|---|---|---|---|
| **T1 — LAN tab** | `http://<lan-ip>:3030` + paired token | Full dashboard in the phone browser, at home. No install, no mic, no push, no offline | M |
| **T2 — PWA over HTTPS** | Tailscale HTTPS/MagicDNS certs (Tailscale is *already* an integrated dependency of Remote Control) | Installable app icon, works away from home with no open ports, mic for AI, Web Push notifications | L |
| **T3 — Store presence** | Thin native wrapper (Tauri/Capacitor) around the T2 client | Play Store / App Store **discovery** — a growth channel in its own right — plus push tokens and background behaviour the web cannot do | L–XL |

Rationale for T2 over a hosted relay: a cloud relay would give the smoothest
onboarding but puts a Xenon-operated server between the user and their PC. That
contradicts the "100% local, no account" promise the product is *known* for. If
a relay is ever added it must be pure transport, opt-in, and framed honestly —
it is not the default path.

### R1.3 — Portrait polish

`breakpoints.css` already reflows; what phones additionally need is a
**phone-first default layout** (not the Edge layout squeezed), thumb-reach
placement of the primary controls, safe-area insets, and one-handed navigation.
Treat it as a preset layout shipped with the app, not a new renderer. **Effort:
M–L**, spread per widget.

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
| 1 | R0 browser demo + share-my-setup image | Download-before-value | M + S |
| 2 | R1.1 pairing & authenticated device path | — (prerequisite) | M |
| 3 | R1.2 T1 (LAN tab) + R1.3 portrait layout | Spare-screen requirement | M–L |
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
