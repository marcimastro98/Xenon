# Xenon — Roadmap to v4.0

The theme of v4.0 is a single, deliberate shift: **from a very good dashboard to a
platform.** By July 2026 the feature count already exceeds anything else built for a
desktop touchscreen — a programmable Stream Deck, full system monitoring, a voice/vision
AI assistant, Spotify, Home Assistant, Discord, Streamer.bot and an embedded browser, all
in one local hub. The next leap is not another integration. It is the three things that
turn an impressive product into one the industry envies: **trust, ecosystem, and proactive
intelligence** — backed by data over time and everyday utility.

This file is the durable plan. `CHANGELOG.md` remains the source of truth for what has
actually shipped; nothing here is shipped until it moves into the changelog under a real
version. Keep this document honest: when a v4 item lands, mark it done here and describe it
for users in the changelog.

Current released baseline: **v3.7.1** (2026-07-03).

---

## The five pillars of v4.0

1. **Trust & Distribution** — the boring, decisive layer an OEM checks first.
2. **Platform & Ecosystem** — shareable presets and a third-party widget SDK.
3. **Proactive Intelligence** — an assistant that anticipates instead of only reacting.
4. **Data Over Time** — "Screen Time for your PC": lightweight history of everything already measured.
5. **Daily Utility** — a Windows notification hub that makes the panel a second brain.

Effort is sized S / M / L / XL. "Foundation" items should ship first because everything
downstream inherits their credibility.

---

## Model guidance for implementation

Each item is tagged with the model to build it with. The split is about **risk, not
prestige** — where doing it *slightly* wrong is expensive, use the stronger model.

- **Opus** — well-scoped work that follows an existing pattern/template, mechanical
  config, or UI over already-settled plumbing. Low blast radius; a mistake is easy to
  catch and cheap to fix.
- **Fable** — security-critical paths (anything that gates code execution, validates
  untrusted input, or handles secrets), genuinely novel architecture, native / interop
  code, or anything where a subtle error is costly and hard to notice.
- **Split** — the item has both halves: build the mechanical / UI part with Opus and the
  risky core (schema, security boundary, native layer) with Fable.

Rule of thumb when unsure: anything touching the **trust boundary**, the **action
registry**, **secrets**, or **spawned / native processes** is Fable work.

### At a glance

| Item | Effort | Model |
|------|--------|-------|
| 1.1 Code signing | L | Opus |
| 1.2 Self-update integrity ✅ | M | **Fable** |
| 1.3 Update rollback completeness | M | **Fable** |
| 1.4 Secret redaction ✅ | M | Opus |
| 1.5 PresentMon gating ✅ | S | Opus |
| 1.6 `winget` distribution | M | Opus |
| 2.1 Shareable preset gallery ✅ | L | Split (Opus UI ✅ · **Fable** schema/validation ✅) |
| 2.2 Third-party widget SDK ✅ (beta) | XL | **Fable** |
| 3.1 Local wake word ✅ | L | **Fable** |
| 3.2 Contextual briefings & alerts ✅ | L | Split (Opus alerts · **Fable** engine) |
| 3.3 Smart context switching ✅ | L | Opus |
| 4.1 Sensor history ✅ | M | Opus |
| 4.2 History views ✅ | M | Opus |
| 5.1 Notification mirroring ✅ | L | Split (**Fable** helper/WinRT · Opus tile) |
| 5.2 Discord notifications (via RPC) ✅ | M | Opus |

---

## Pillar 1 — Trust & Distribution (foundation, ship first)

The least glamorous pillar and the one that most separates a hobby project from something
CORSAIR can point people to. Every new user meets this layer before any feature.

### 1.1 Code signing — **L**
- **Model:** Opus — CI / release-config integration; mechanical once the certificate exists.
- **What:** sign the installer, `xenon-helper.exe`, the updater and any spawned binaries
  with a real certificate (Azure Trusted Signing is now inexpensive, ~$10/month, and issues
  OV certificates suitable for this).
- **Why it matters:** today nothing is signed, so Windows SmartScreen warns on the very
  first double-click of the installer and the helper. That warning is the single biggest
  trust cliff for a new user and the first box an OEM contact expects ticked.
- **Approach:** integrate signing into `.github/workflows/helper.yml` and the release build;
  sign the helper exe, the packaged installer, and `update-apply.ps1`'s payload. Document
  the thumbprint publicly.
- **Depends on:** obtaining the certificate. Everything else in the release should be signed
  once this is in place.

### 1.2 Self-update integrity — **M** — ✅ done (v4.0.0, unreleased)
- **Model:** Fable — security-critical verification that gates executing downloaded code; this is the most serious gap and a subtle mistake defeats the whole point.
- **Shipped as:** a **mandatory, fail-closed** integrity gate in `self-update.js` `prepare()`. CI (`.github/workflows/release-integrity.yml`) attaches to every published release a `SHA256SUMS` (hash of the tag source zip, downloaded from the exact URL the updater uses) plus `SHA256SUMS.sig` — an **Ed25519 signature** over the sums file, signed with the private key held only in the repo secret `XENON_UPDATE_SIGNING_KEY`. The matching public key is **pinned in the app** (`UPDATE_PUBKEY_PEM`). `prepare()` hashes the zip as it streams down, then — **before extraction** (never feed an unverified archive to `Expand-Archive`) — requires both assets, verifies the signature against the pinned key, and compares the hash; each failure has its own reason (`integrity_missing` / `signature_invalid` / `integrity_mismatch`), the live install is untouched, and the existing UI already surfaces the code. The signature is required, not "verify if present" — a strippable signature is no signature. If the secret is missing at publish time the CI job fails loudly (an unsigned release would strand self-updaters). Covered in `server/test/self-update.test.mjs` with a throwaway keypair. Remaining sibling gap: the **first-install** path (`install.ps1`) still trusts TLS — that's 1.1 (Authenticode) territory, since a fresh install has nothing pinned yet.
- **What:** publish a SHA-256 (and ideally a signature) for each release artifact and verify
  it in `self-update.js` before `apply()` runs.
- **Why it matters:** documented residual gap — `self-update.js` and `install.ps1` currently
  download and execute code trusting TLS alone. Anyone who can MITM the download (or a
  compromised release asset) can run code on the user's machine. This is the most serious
  remaining security gap in the codebase.
- **Approach:** emit a `SHA256SUMS` file in the GitHub release; have `prepare()` fetch it,
  hash the downloaded zip, and refuse to apply on mismatch. Pairs naturally with 1.1 (verify
  signature if the certificate is available).

### 1.3 Update rollback completeness — **M** — ✅ done (v4.0.0, unreleased)
- **Model:** Fable — stateful failure-path logic in the PowerShell applier with many edge cases; getting it wrong leaves a broken half-installed tree, which is exactly the harm to avoid.
- **Shipped as:** three guarantees in `update-apply.ps1`. (1) **Exact deps snapshot** — before `npm install`, `node_modules` is snapshotted by an instant same-volume **rename** (`node_modules.xenon-rollback`) and npm rebuilds fresh (mostly links from the npm cache); a failed install is undone by renaming back — exact restore with **no dependence on npm or the network** to recover. If the rename is blocked (straggler process holding a native module) it falls back to installing in place, and the failure path then reconciles by re-running npm against the **restored old lockfile**. A leftover snapshot from a run that died mid-restore is recovered on the next start (only the unambiguous "snapshot exists, live dir gone" case). (2) **Exact-set rollback** — restore the backup, then delete every file the update had **added**, using the staged tree as the precise manifest of what the merge could have written (`Remove-UpdateAdditions`; `server\data` and `node_modules` skipped defensively) — the exact pre-update file set, without risky `/MIR`-style mirroring. (3) **Post-update verification** — success is only declared after the new server **actually answers `GET /version` with the staged version** (60s poll); until then the backup is kept, so a build that can't boot rolls back instead of stranding the user with no working install and no backup. The rollback itself is verified the same way (old version answering again, logged), and staging is kept on failure so the dashboard still offers a one-tap retry.
- **What:** make `update-apply.ps1` restore a clean tree on any failure.
- **Why it matters:** documented gap — the applier uses `robocopy` merge without `/MIR` and
  excludes `node_modules` from backup, so a failed `npm install` can leave a mixed
  old/new tree that neither fully works nor cleanly rolls back.
- **Approach:** back up (or lock) a manifest of replaced files; on failure, restore exactly
  that set. Consider snapshotting `node_modules` or pinning it so a half-finished install
  reverts. Verify the post-update server actually starts before declaring success.

### 1.4 Server-only secret redaction — **M** — ✅ done (v4.0.0, unreleased)
- **Model:** Opus — follows the existing `preserveRemoteCreds` / `redactRemoteCreds` template used for Sunshine creds; a well-worn pattern to copy.
- **Shipped as:** `server/stream-creds.js` (`preserveStreamCreds` / `redactStreamCreds`), applied at the same three settings→browser exit points as the HA token (GET `/settings`, POST `/settings` response, and preserved on save); client shows a "saved" placeholder via `obsPasswordSet` / `streamerbotPasswordSet`. Covered by `server/test/stream-creds.test.mjs`.
- **What:** stop shipping `obsPassword` and `streamerbotPassword` to the browser.
- **Why it matters:** documented gap — these are used only server-side yet still travel to
  the client in `/settings`. The clean fix needs a write-only password field (a "saved"
  placeholder plus a `*Set` flag that survives client normalization), the same pattern
  already used for Sunshine creds (`preserveRemoteCreds` / `redactRemoteCreds`).
- **Approach:** extend `normalizeHubSettings` and the Settings → Streaming UI to treat these
  like Sunshine credentials: preserve on save, redact on the wire, show "saved" in the UI.

### 1.5 PresentMon gating — **S** — ✅ done (v4.0.0, unreleased)
- **Model:** Opus — small change following the existing SSE-timer gating pattern.
- **Shipped as:** a reversible pause/resume in `fpsmon.js` (`pauseFpsMonitor` / `resumeFpsMonitor`, distinct from the terminal `stopFpsMonitor`), driven by `_syncFpsMonitor()` on the SSE connect/disconnect path in `server.js`. Defaults paused; starts on the first client, pauses ~45s after the last leaves (grace survives Xeneon Edge reloads). Full-screen game detection is unaffected; only the windowed-game FPS hint idles while paused.
- **What:** run PresentMon only when a client is connected and a game/FPS readout is actually
  wanted, not system-wide whenever installed.
- **Why it matters:** documented gap — it currently runs regardless of client/game state,
  wasting resources and ETW sessions.
- **Approach:** gate the spawn on `sseClients.size > 0` and game-mode/FPS-widget presence,
  matching the SSE-timer gating pattern already used elsewhere.

### 1.6 `winget` distribution — **M**
- **Model:** Opus — manifest authoring and submission; mechanical.
- **What:** publish a `winget` manifest so users can `winget install Xenon`.
- **Why it matters:** grown-up, free, trusted distribution; installs and updates through a
  channel users already trust, and it reads as a serious product.
- **Depends on:** 1.1 (a signed installer makes the manifest submission far smoother).

---

## Pillar 2 — Platform & Ecosystem (the "never seen before" move)

What makes Stream Deck and Wallpaper Engine unbeatable is not their features — it is the
community that produces content for them. Xenon already has every ingredient (presets, Deck
profiles, themes, layouts, backup export/import) but they are trapped on one PC. Freeing
them is the highest-leverage, lowest-cost move in this roadmap.

### 2.1 Shareable preset gallery — **L** — ✅ done (v4.0.0, unreleased; Deck sharing included)
- **Model:** Split — Opus for the export path, "Share/Import" UI and the website gallery; **Fable** for the versioned preset schema and the import-validation boundary (untrusted presets can carry Deck actions that must re-validate through the action registry — a security boundary).
- **Shipped (Opus/UI half):** `server/js/preset-share.js` — a portable versioned format (`{ xenonPreset:1, exportedAt, appVersion, kind:'theme'|'page', name, data }`, base64url code / .json file / `…/#preset=CODE` link, decode accepts all three). Export **theme** (appearance/colour subset of `hubSettings`, `backgroundMedia` excluded) and **current page** (reuses `DashboardPresets.capturePage`) from Settings → Appearance → Share & Import; import re-validates through the app's OWN normalizers (`normalizeSettings` for theme, `DashboardPresets.normalizePresets` for page — drops unknown widget ids), so NO new trust boundary and NO actions can ride along. Website gallery fills the Community Hub placeholder in `docs/index.html` from a static `docs/presets.json` (mirrors the supporters-loader pattern; 6 seed themes). Localised, tests `server/test/preset-share-logic.test.mjs`. Landmine avoided: client `hubSettings` is a shared-script-scope `let`, NOT `window.hubSettings`.
- **Shipped (Fable half — Deck sharing):** `kind:'deck'` in the same envelope. The boundary is `sanitizeDeckProfile()` in `preset-share.js`, applied on **both export and import**: the profile is rebuilt through `DeckModel.normalizeDeckConfig` (full 8×8 probe grid so nothing is truncated) and every trigger is **rebuilt from scratch** through `DeckActions.triggerSteps`/`compactTrigger` — unknown action types dropped, select params coerced onto the catalog, extra keys gone, unknown trigger names (nothing can auto-fire) and off-catalog state sources dropped, `blob:` images cleared, folder nesting depth-capped (hostile deep payloads can't stack-overflow the normalizer). Imported actions still only run on a user tap and re-validate through `server/actions/registry.js` like any local key. The import flow adds a **review step** (name, key count, per-type action summary chips + trust caution) and a target-deck picker; with no Deck tile the profile lands in the Deck preset library instead of dead-ending. Share entry points: per-profile Share button in the Deck profile menu + Export Deck profile in Settings → Share & Import. Oversized (photo-face) profiles go file-first with a "share without images" alternative; the decode cap is 4 MB. Tests in `server/test/preset-share-logic.test.mjs` (hostile payloads included).
- **What:** export any theme, page layout or Deck profile as a portable file or short link;
  browse a gallery on the website (`docs/`) and import with one tap or a QR scan.
- **Why it matters:** turns solitary customization into a network effect. Users showing off
  Decks and layouts on Reddit already; give them a one-tap way to share and import and the
  content compounds. This is what an ecosystem looks like before there is an SDK.
- **Approach:** the export format largely exists (backup export/import, Deck profile/key
  presets, dashboard presets). Define a stable, versioned, self-contained preset schema;
  add a "Share" affordance (file + copyable link) and an "Import from link/QR" path. Build a
  browsable section in `docs/index.html` (it already has the multilingual showcase and live
  demo tiles infrastructure). Host preset files statically at first — no backend needed.
- **Safety:** presets are data, not code. Validate on import against the schema
  (same boundary-validation discipline as `normalizeHubSettings`); never let an imported
  preset carry an executable action that wasn't already validated by
  `server/actions/registry.js`. A Deck profile from a stranger must re-validate every action
  through the existing single gate before anything can run.

### 2.2 Third-party widget SDK — **XL** (the flagship announcement) — ✅ done (v4.0.0, unreleased; shipped as beta)
- **Model:** Fable — the flagship: a novel sandbox, a `postMessage` security contract, a permission model, and third-party code running near the trust boundary. Highest architectural and security risk in the whole roadmap; design and core must be the strongest model.
- **Shipped as:** exactly the approach below, marked **beta**. A package = a folder under
  `DATA_DIR/widgets/<id>/` (`manifest.json` + entry HTML); `server/sdk-widgets.js` is the
  server boundary — known-key manifest rebuild (id must match the folder, `api: 1` required,
  streams/actions allowlisted), per-segment + extension-allowlisted asset resolution, and a
  strict CSP on EVERY served asset: **`sandbox allow-scripts` + `connect-src 'none'`**. The
  CSP is load-bearing: a sandboxed iframe has an opaque origin, so its fetches reach the local
  API with `Origin: null`, which `isAllowedRequest()` deliberately accepts — the CSP is what
  keeps widget code off the API (and re-sandboxes the document even when opened directly as a
  top-level page; no `allow-same-origin` anywhere). Host side (`js/custom-widget.js`): a
  duplicable **Custom widget** tile ("+" palette), per-instance package assignment, an explicit
  **permission dialog** (requested streams + action chips + trust caution) before first render,
  and the versioned `xenonSdk: 1` postMessage bridge — `hello`/`init`/`data`/`theme`/`action`/
  `action_result`; identity by `event.source` (never origin), only granted streams forwarded
  (relayed from the existing SSE listeners in `main.js`, latest payload replayed on init), only
  granted action categories dispatched (media/volume/mic/lighting/url — a deliberately
  low-blast-radius subset; `openApp`/`hotkey`/`webhook` are NOT reachable), ~250 ms per-instance
  action rate limit, every action re-validated by `/actions/run` (the registry). Settings →
  **Widgets** (`sdkWidgets` — client-normalized, server passthrough, off by default), a bundled
  reference widget (`server/sdk-example/hello-xenon/`, one-tap "Install example" via a fixed-path
  copy endpoint), full developer docs in `docs/WIDGET_SDK.md`, i18n ×5, hostile-input tests in
  `server/test/sdk-widgets.test.mjs`. Deferred to a follow-up: a browsable widget gallery on the
  website (distribution today = share the folder/zip, like presets), zip-import UI, and richer
  API surfaces (weather/calendar streams, widget-owned settings).
- **What:** let anyone build a Xenon widget — a sandboxed iframe + a manifest + a small,
  documented API (subscribe to SSE data, dispatch allowlisted Deck actions, read the theme).
  The "+" palette becomes extensible.
- **Why it matters:** this is the announcement that makes an OEM's eyebrows rise. Not "a nice
  widget" but *the ecosystem for the Xeneon Edge that they never built.* It is the difference
  between a product and a platform.
- **Approach (design carefully — do not improvise):**
  - Widgets run in a sandboxed `<iframe sandbox>` with no direct DOM/network reach into the
    host; all host interaction goes through a `postMessage` bridge with a typed, versioned
    message contract.
  - A manifest declares the widget's identity, needed data streams, and which action
    categories it may request — surfaced to the user as a permission prompt, off by default.
  - Data flows one way (host → widget) over the existing SSE model; actions flow widget →
    host and are re-validated through `server/actions/registry.js` exactly like Deck/AI
    actions. The SDK never widens the HTTP trust boundary (`isAllowedRequest`) or the JSONP
    allowlist.
  - Ship a reference widget and docs. Version the API from day one.
- **Depends on:** 2.1 (a gallery to distribute widgets through) and Pillar 1 (a trust story
  before inviting third-party code). Prototype behind a flag; this is the thing to announce,
  not to rush.

---

## Pillar 3 — Proactive Intelligence (the viral-demo pillar)

Xenon AI today is reactive: you speak, it answers. The 2026 "wow" is an environment that
anticipates you. The building blocks (GreetingSplash, game detection, PresentMon, live
sensors, the full function-calling surface) already exist — they need to be wired into
initiative.

### 3.1 Local wake word "Hey Xenon" — **L** — ✅ done (v4.0.0, unreleased)
- **Model:** Fable — an always-on native audio pipeline with privacy implications; easy to do badly (wasted resources, missed teardown, an always-listening mic mishandled). The integration and gating want the stronger model.
- **What:** hands-free activation via an on-device wake-word engine (openWakeWord or
  Porcupine — both run offline and lightweight) instead of tapping the orb.
- **Why it matters:** on a touchscreen sitting beside the monitor, wake-word is the line
  between "gadget" and "assistant." It is the most-felt single upgrade to the AI.
- **Approach:** run the detector in a small always-on listener (respecting an off-by-default
  toggle and clear privacy copy — detection is local, no audio leaves the machine until the
  wake word fires). On trigger, open the existing voice session. Must be genuinely
  lightweight and self-gating, like the rest of the audio path. Honor a global mute/pause.
- **Shipped as:** `server/wakeword.js` — **zero new dependencies**: instead of Porcupine
  (needs a per-user Picovoice AccessKey, and a custom "Hey Xenon" keyword is bound to the
  training account) or openWakeWord (needs the heavy `onnxruntime-node` native dep), the
  detector reuses the exact audio stack the voice chat already has. ffmpeg streams raw
  16 kHz PCM from the same mic the STT recorder binds (WASAPI default / dshow fallback); a
  Node-side energy VAD with an adaptive noise floor cuts out only *short* utterances
  (bursts longer than ~3 s — conversations, music — are skipped outright, so they cost
  zero CPU); each candidate clip is transcribed by the already-installed whisper.cpp and
  fuzzy-matched against "(hey) xenon" incl. accent renderings ("ehi zenon", "zenone", …).
  On match the server broadcasts an SSE `wake` event and the client opens the existing
  voice session (multi-tab races are absorbed by the STT recorder's 409 guard).
  Lifecycle follows the winnotif.js discipline: the capture child runs only while the
  toggle is on AND whisper is installed AND a dashboard is open; it suspends around every
  STT recording (dshow can't share a device) with an auto-resume backstop; it is stopped
  in `_gracefulShutdown`. Off by default; Settings → Xenon AI has the toggle with plain
  privacy copy ("everything runs on your PC, no audio leaves the machine, nothing is
  stored"), a live status line (`/api/wake/status`) and a one-tap Whisper download when
  missing. Localised ×5. Muting the mic silences the stream, so the global mute is
  honored for free. Deliberate trade-off: ~1 s wake latency (VAD close + short whisper
  run) in exchange for no accounts, no keys, no new native modules.

### 3.2 Contextual briefings & alerts — **L** — ✅ done (v4.0.0, unreleased)
- **Model:** Split — Opus for each individual alert type wired onto existing plumbing (toasts, GreetingSplash, sensors); **Fable** for the opportunity-engine design, where the judgment of *when* and *how often* to interrupt (without becoming annoying) is the hard, easy-to-get-wrong part.
- **Shipped as:** a passive server-side opportunity engine (`server/briefing.js`) fed from the
  existing status/system SSE ticks — it owns no timers, spawns nothing, does zero work with no
  dashboard connected, and needs no shutdown handling. Two server-emitted moment types over a new
  SSE `briefing` event: **game-session recap** (session follows `gameRunning` so dashboard taps
  don't split it; duration ends at the last moment the game was *seen* running; ≥ 10-minute
  sessions only; avg/max FPS sampled from PresentMon when present, peak CPU/GPU temps from the
  system samples) and **sustained thermal** ("GPU at 91°C for 16 minutes" — same thresholds as
  Guardian's instant spike alerts, but requiring 15 minutes of *continuously observed* heat: a
  sampling gap restarts the window, a 3°C hysteresis stops flapping, and a 60-minute per-metric
  cooldown stops nagging; a rolling-hour global cap backstops everything). Client renders via the
  existing toast system, with voice only when Ambient presence is on. The **morning briefing**
  ships client-side: the greeting splash gains a glass agenda card with today's first events, and
  the spoken greeting reads the day ahead. Every moment type individually toggleable under
  **Settings → Performance → Momenti proattivi** (`proactive` settings, normalized client+server,
  default ON). Calendar nudges already existed (ambient heads-up + reminders) and are unchanged.
  AI phrasing was deliberately skipped — triggers and wording stay deterministic and free.
  Tests: `server/test/briefing-logic.test.mjs`.
- **What:** proactive, glanceable moments the dashboard raises on its own:
  - **Morning briefing:** the existing day-part GreetingSplash, made intelligent — weather +
    today's agenda + now playing + anything notable, spoken or shown once.
  - **Calendar nudges:** "meeting in 5 minutes" (reminders exist; make them proactive/spoken).
  - **Thermal/health alerts:** "GPU has been at 88°C for 20 minutes" from live sensors.
  - **Gaming session recap:** on exiting a game, average FPS, session length and peak temps
    (PresentMon and game detection already provide the data).
- **Why it matters:** this is the demo nobody else has — an ambient assistant that tells you
  what you'd want to know without being asked. The kind of thing that ends up in a video.
- **Approach:** a lightweight rules/opportunity engine server-side that watches existing
  signals (clock, calendar, sensors, game state, media) and surfaces a bounded, dismissible
  moment via the toast system / GreetingSplash / voice. Every alert type individually
  toggleable; nothing nags (respect the same "snooze for the session" discipline the
  Performance optimizer already uses). Optionally route phrasing through Xenon AI for natural
  wording, but the triggers are deterministic.

### 3.3 Smart context switching / profiles — **L** — ✅ done (v4.0.0, unreleased)
- **Model:** Opus — extends the existing foreground/game-detection and Performance-Mode plumbing into a process → profile map; a well-scoped extension of settled code.
- **Shipped as:** a new client controller `server/js/context-profiles.js` driven by a new `PerfMode.onActivityChange(fn)` hook in `performance.js` — so it reuses Performance Mode's single classified-activity concept (custom app lists included), no second detector. Per-activity map (`contextProfiles.map[gaming|coding|writing|streaming|creating|meeting] = { page, lighting, deck }`) applies **page** (`DashboardPager.goToPage`), **lighting** (`POST /api/lighting/animation`) and **Deck profile** (`Deck.switchProfileByName`) on transition; snapshots a baseline on first entry and reverts on exit after a grace window (anti-flicker), politely (only if the user hasn't changed that dimension since). Settings → Performance UI (per-activity Page/Lighting/Deck dropdowns + revert-on-exit + Clear), client-owned schema (`normalizeContextProfiles`) round-tripped server-side via `sanitizeServerPassthrough`. Off by default, localised. Tests: `server/test/context-profiles-logic.test.mjs`. Audio-profile dimension deferred (no clean existing "audio profile" object).
- **What:** layout + lighting (and optionally audio profile, Deck profile) that switch
  automatically when a foreground app starts — gaming / dev / streaming.
- **Why it matters:** the last big item still on the original roadmap. Game detection already
  exists and already pauses ambient effects; this connects it to full profiles.
- **Approach:** extend the existing foreground/game detection into a mapping of
  process → profile (which page is shown, which lighting effect, which Deck profile). User
  defines the mappings; the switch is automatic but always overridable, and reverts when the
  activity ends. Reuse Performance Mode's activity-detection plumbing so there is one
  activity concept, not two.

---

## Pillar 4 — Data Over Time ("Screen Time for your PC")

Every sensor today is instantaneous — read once a second, then thrown away. Persisting a
lightweight time series unlocks a whole class of screenshot-worthy screens from data already
being collected.

### 4.1 Lightweight sensor history — **M** — ✅ done (v4.0.0, unreleased)
- **Model:** Opus — a known ring-buffer + `writeFileAtomic` pattern; just honor the no-block-the-event-loop and hard-bounded-size invariants.
- **Shipped as:** the substrate already existed in `server/guardian.js` (5-min samples → 72h hourly buckets + 90d daily rollups, bounded, `getHistory()` ready for charts) but was (a) written with a bare `fs.writeFile` — **fixed** to temp-file+rename per the durable-store invariant — and (b) gated behind the AI Guardian feature. Now **decoupled**: a dedicated `sensorHistory.enabled` opt-in (Settings → Performance, off by default, localised EN/IT/KO/JA/ZH) drives collection independently; the guardian gate is `sensorHistory.enabled || (aiFeatures.enabled && aiFeatures.guardian)`, so existing AI-Guardian users keep collecting and history works with no AI. Normalized on client + server with a default and reset path. Collection stays a single boolean check when off.
- **Shipped with 4.2** under one combined CHANGELOG entry ("Sensor history — see your PC's temperatures and load over time").
- **What:** a bounded, on-disk ring buffer of key metrics (CPU/GPU temp and load, RAM, net,
  FPS, foreground app), written cheaply and capped so it never grows unbounded.
- **Why it matters:** the substrate for everything in this pillar. The data already flows
  every second; it is simply discarded.
- **Approach:** append-only, downsampled ring buffer per metric (e.g. 1-minute rollups for
  24h, hourly for a week), written atomically via `writeFileAtomic` like every other durable
  store, in `server/data/`. Never block the event loop; batch writes. Bound total size hard.

### 4.2 History views — **M** — ✅ done (v4.0.0, unreleased; 24h/7d/30d sparklines + the "PC Screen Time" per-app/per-game view)
- **Model:** Opus — charts over the 4.1 data following the project's dataviz conventions; UI work over a settled data source.
- **Shipped as:** a **History tab in the System tile** (`setSystemTab('history')` + `sys-grid-history` pane) reusing the existing `guardian-history.js` SVG sparkline renderer (CPU/GPU temp+load, RAM; 24h/7d/30d), which was refactored to render into either the tab body or the old overlay. Tab visible when `sensorHistory.enabled || AI Guardian` (via `window.syncSystemHistoryTab`, wired into `applyHubSettings` so it syncs at boot/hydration); the old overlay button is superseded and hidden. Localised.
- **"PC Screen Time" — done.** `guardian.js` now also accumulates **foreground-app usage** (a 15s in-memory ticker that reuses `gameDetect.getForegroundProcess()`/`isGaming()` — no second probe; flushed to disk by the existing 5-min atomic `persist()`; sleep/idle gaps and lock/logon screens don't count; bounded to the busiest ~40 apps/day × 90 days). `getHistory().usage.ranges` returns top-apps + total + game share for 24h/7d/30d, rendered under the sparklines as a ranked bar list (games marked 🎮, counted separately). Tests: `server/test/guardian-usage.test.mjs`.
- **What:** 24h sparklines of temps and utilization on the System tile; a "PC Screen Time"
  view — hours per game, top apps this week, peak-load moments.
- **Why it matters:** exactly the kind of screen that ends up screenshotted on Reddit. It
  makes the panel feel like it *knows* your machine.
- **Approach:** small charts fed by 4.1 (follow the dataviz/chart conventions already in the
  project). A dedicated tile or a tab on the System panel. Keep it glanceable, not a full
  analytics suite.
- **Depends on:** 4.1.

---

## Pillar 5 — Daily Utility (the notification hub)

### 5.1 Windows notification mirroring — **L** — ✅ done (v4.0.0, unreleased)
- **Model:** Split — **Fable** for the C# / WinRT `UserNotificationListener` helper mode and its stdio protocol (native interop, error-prone, permission-gated); Opus for the SSE tile and the settings/filter UI.
- **Shipped as:** better than planned — the fallback discipline turned out to make the helper
  optional in the strongest sense. A live spike proved `RequestAccessAsync` +
  `GetNotificationsAsync` work fine for UNPACKAGED exes on Win10 1809+/Win11 (the
  `NotificationChanged` event is the only identity-gated piece → 2s polling with
  session-monotonic-id diffing). Helper 0.4.0 gained `notifications-serve` (status/seed/
  notification JSON lines, per-app logos as bounded data: URIs, stdin-EOF parent-death watch);
  `notifications.ps1` is a full-fidelity PowerShell fallback (same protocol, no icons) — so the
  feature works with NO helper at all, and a broken exe pins over to PS automatically
  (gamedetect-style young-death counting). Server: `winnotif.js` owns the child + a 30-item
  ring buffer, runs ONLY while `windowsNotifications.enabled` && SSE clients > 0 (idle = zero
  processes), re-projects every item at the boundary (length caps, `data:image/`-only icons,
  server-assigned ids), and stops in `_gracefulShutdown`. Fan-out: `windows_notification`
  (item) + `windows_notifications` (state/feed) SSE events, seed `GET /notifications/windows`
  (never JSONP). Client: a Notifications tile (palette → Productivity) hosting its own
  controls — enable, "hide content until tapped", per-app mute with an unmute manager — all
  persisted in `windowsNotifications` {enabled, hide, excluded[]} normalized on both sides;
  deliberate off/denied/unavailable/loading/empty states (denied points at the exact Windows
  setting). i18n ×5. 11 unit tests (`winnotif.test.mjs`).
- **Why it matters:** no competitor does this. It turns the Edge from "a control panel" into
  "a second brain for the PC" — something you glance at dozens of times a day. Strong daily-
  retention driver.

### 5.2 Discord notification mirroring (via local RPC) — **M** — ✅ done (v4.0.0, unreleased)
- **Model:** Opus — reuses the settled Discord RPC watch→SSE plumbing (the voice watch and the Streamer.bot activity feed are the exact template); the only new-ish surface is adding one OAuth scope, which is mechanical.
- **Shipped as:** exactly the approach below. The provider (`discord-rpc.js`) subscribes to
  `NOTIFICATION_CREATE` on the **same** watch socket as the voice events — `watchVoice(cb,
  onNotification)` — and projects each payload through a pure `normNotification()` (length-capped
  title/body, snowflake-validated channel id, **https-only** icon URL per the scheme-allowlist
  invariant). The extra `rpc.notifications.read` scope is requested at AUTHORIZE time **only when
  the user has opted in** (`wantNotifications` dep read live from settings), so an opted-out user
  never authorizes notification access; a token minted without the scope fails the subscribe and
  surfaces as `notifStatus() === 'scope_missing'`, which both the settings card and the widget
  translate into "disconnect and reconnect Discord once". Server: `discordNotifications
  { enabled, hide }` (normalized client+server, **off by default**), a bounded 30-item ring buffer
  (the Streamer.bot `pushActivity` pattern) fanned out over a new `discord_notification` SSE event
  with seed endpoint `GET /stream/discord/notifications` (never JSONP), feed health riding the
  existing `discord` SSE payload, buffer cleared on logout/disable, watch restarted on toggle.
  Client: a **Notifications tab** in the Discord widget (lazy seed, textContent-only rendering,
  deliberate off/re-link/empty states with a Settings CTA, optional **hide-content-until-tapped**),
  toggles on the Discord card in Settings → Streaming with privacy copy. Localised ×5. Tests in
  `server/test/discord-rpc.test.mjs` (projection hostile-input + scope opt-in/subscribe/
  scope_missing over the mocked pipe).
- **What:** show Discord notifications (a DM, a mention, a message in a watched channel) on the dashboard — on the existing Discord tile or as a small feed — plus a short **history** of recent ones. The lightweight cousin of 5.1: Discord-only, but with **no native helper and no WinRT**, because Discord pushes these over the same local RPC channel the voice controls already use.
- **Why it matters:** it's the single most-requested notification source (community ask on #61, with working proof-of-concept), and it lands entirely inside infrastructure that already exists — so it can ship well before the full 5.1 helper path, and complements rather than duplicates it (5.1 mirrors *all* Windows notifications; 5.2 is a richer, native-free Discord view for users who only want that).
- **Approach:** subscribe to the RPC `NOTIFICATION_CREATE` event on the **existing** `discord-rpc.js` socket, exactly like the voice watch subscribes to `VOICE_SETTINGS_UPDATE` — add an `onNotification` callback path alongside `watchVoice`, project each event to a client-safe `{ title, body, icon, channelId }` (route text through `textContent`/`escHtml`, never `innerHTML`), fan out over SSE (a new named event), and keep a bounded ring buffer for the history (mirror the Streamer.bot `pushActivity` pattern + a `…/activity` seed endpoint).
- **Efficiency (the whole point — must stay as light as the voice watch):**
  - **One socket, event-driven, no polling.** Reuse the single idle-closed IPC socket; the subscription is held **only while a dashboard is open (SSE clients > 0) and the feature is on**, and torn down otherwise — the same `refreshDiscordWatch` gating already in `server.js`. Never a second connection, never a timer.
  - **Bounded history**, server-side ring buffer (like the Streamer.bot feed), never an unbounded Map.
  - Stopped in `_gracefulShutdown` with the rest of the Discord watch; respawn with the existing backoff.
- **Cost to be honest about:** `NOTIFICATION_CREATE` needs the **`rpc.notifications.read`** scope, which the current link (`rpc`, `rpc.voice.read/write`, `identify`) doesn't have. Since each user brings their **own** Discord app, the app owner can grant it without Discord's global approval (same reason the voice scopes work today), but turning the feature on means a **one-time re-link** in Settings → Discord. Add the scope to `SCOPES` only behind this opt-in so users who don't want notifications never re-authorize. Off by default; privacy copy that says notifications are read locally and never leave the machine; optional "hide content until tapped".
- **Depends on:** nothing new — the Discord RPC integration already shipped (v3.6.0). Can land independently of 5.1.

---

## Suggested sequencing

The order matters: credibility first, then the leverage move, then the demos.

1. **Trust block** (Pillar 1: 1.1 signing, 1.2 update integrity, 1.4 secret redaction, then
   1.3 / 1.5 / 1.6). A few focused days that unlock enterprise-grade credibility and fix the
   most serious known gaps. Do this first — it is cheap and everything else is judged against it.
2. **Shareable preset gallery** (2.1). Highest community leverage for the lowest cost; the
   export format mostly exists.
3. **Proactive intelligence** (3.1 wake word + 3.2 briefings). The viral-video demo. In
   parallel, **sensor history** (4.1) since it is independent and unblocks Pillar 4.
4. **History views** (4.2), **smart context switching** (3.3), **notification hub** (5.1) —
   each self-contained, schedule by appetite.
5. **Widget SDK** (2.2). The flagship announcement. Design deliberately, prototype behind a
   flag, ship when it is genuinely solid — this is the thing that makes CORSAIR and the rest
   of the world take notice, so it must not feel improvised.

Not everything must land in a single v4.0 — but the trust block and at least one of
{preset gallery, proactive AI} should define the release, with the widget SDK as the
headline once it is ready.

---

## Cross-cutting rules for all v4 work

Every item above must respect the existing engineering invariants (see `.claude/CLAUDE.md`
→ *Engineering Invariants*). In particular:

- New persisted stores → `writeFileAtomic`, normalized on load, with defaults and a reset path.
- New actions (SDK, proactive, context profiles) → validated once through
  `server/actions/registry.js`; `run()` never throws.
- The HTTP trust boundary (`isAllowedRequest`) and the JSONP allowlist are never widened —
  a feature that seems to need a non-loopback origin is a design change, not a relaxation.
- New long-lived children (wake-word listener, notification helper mode) → stopped in
  `_gracefulShutdown`, gated on whether anyone is listening, respawn with backoff.
- Sensors stay on `pwsh-worker.ps1`. History (4.1) reads from the existing sensor stream; it
  does not add a new sensor host.
- Everything user-facing → localised (EN/IT/KO/JA/ZH), off by default where it touches
  privacy (wake word, notifications), and documented in `CHANGELOG.md` on ship.
