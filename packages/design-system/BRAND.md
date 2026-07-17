# Xenon — Brand Book

> The single source of truth for how Xenon presents itself: positioning, voice,
> colour, type and the rules that keep every surface (app, site, README,
> changelog, social) feeling like one product. When public-facing copy or design
> changes, check this file first. An interactive version lives next to this file
> at **`brand-book.html`** (open it in a browser — Bit is rendered live from the
> real sprite).
>
> Every value below is taken from the real codebase, not invented. Source
> locations are noted so the brand and the product never drift apart.

---

## 1. Positioning — the one sentence

**Xenon is a companion with personality — the living control center of your PC.**

Every competitor (iCUE, Rainmeter, the stock display widgets) is a *tool*. Xenon
has a *character*. The forty features — Deck, RGB, weather, Spotify, smart home,
browser — are the catalogue, not the brand. The brand is a promise and a
personality: a screen that knows you, talks back, and occasionally nags you into
drinking some water.

The trust promise that makes a live-in-your-home companion credible, repeated on
every surface: **everything runs 100% locally — no cloud, no telemetry, no
account.**

Direction chosen 2026-07-09: **companion with personality** (à la Claude /
Duolingo), *not* a cold pro-tool (à la Linear). Bit is the emotional heart.

---

## 2. The two faces — two registers, one world

The brand has a playful face and an adult face. They are not two brands: they are
the same character in two moments. **Never mix them in the same frame.**

| | **Bit** — the heart | **The Orb** — the presence |
|---|---|---|
| What | The pixel guardian pet: lives in a corner, mirrors your Vitals, roasts you into self-care | The Xenon AI Resonance Orb: a borderless sphere of living light with three states |
| Register | Playful, sarcastic, 8-bit | Premium, calm, adult |
| Use for | Onboarding, toasts, social, memes, the mascot moments the community shares | AI activation, splash screens, the animated logo, CORSAIR-facing and press material |
| Rule | Can be sarcastic | Never jokes — stays sober |

Golden rule: **Bit is the meme; the Orb is the signature. Same world, two voices,
never overlapping.**

Sprite source: `server/js/vitals-pet.js:34-55` (12×12 SVG, `crispEdges`).
Orb colours: `server/components/AIPanel/AIPanel.css` (`--xn-cyan`, `--xn-violet`).
Note: **in-app**, AI activation currently renders the circular equaliser
(`.ai-presence` / `.ai-eq`), not the Orb — the Orb is a video/press asset
today. An app-side Orb implementation existed in `AIPanel.css` but was
unreachable dead code (no markup ever produced it) and was removed in v4.6.0.
The public site's 3D orb hero and boot animation were retired in the 2026-07
redesign: the site now leads with the real dashboard in the Edge's 32:9 frame,
so the Orb no longer appears on xenon-app.com.

---

## 3. Voice

### The golden rule

**Funny, never genuinely mean — Bit roasts like a friend, not a bully.**
If a line actually hurts, it isn't Bit. (From `server/js/vitals-pet-core.js`.)

Overall product tone: **competent but relaxed, a little techy, never corporate.**
Short sentences. No inflated marketing. The same "person" speaks on every
surface — that consistency is what makes a voice recognizable. The voice must
survive translation into all UI languages, so it is codified here, not left to
instinct.

### Bit's three cumulative tiers

Real lines from the `EN` bank in `server/js/vitals-pet-core.js`:

- **Soft (t1)** — a gentle nudge.
  - "Posture: 0%. You are officially shrimp-shaped."
  - "+100! Keep this up and I'm out of a job. Hopefully." *(on refill)*
- **Spicy (t2)** — sarcastic.
  - "Stand up. Even sloths do. EVEN SLOTHS."
  - "ZERO FOCUS. You're staring at the screen like a fish stares at glass."
- **Savage (t3)** — merciless but absurd.
  - "ZERO WATER for 30 minutes. Raisins are juicier than you."
  - "Drink. That's not advice, it's a threat. A loving one. But a threat."

Signature close, as recognizable as the colour — use it only when Bit speaks:
**"Signed: your guilt, in 8-bit. — Bit"**

### Naming (landmine)

The product is **Xenon** — never "Xenon Edge". "Xeneon Edge" is Corsair's
display, a separate thing. Do not rename the product, the scheduled-task ID, or
any storage key while chasing brand copy.

---

## 4. Colour

### The signature — locked

| | Hex | |
|---|---|---|
| **Xenon Green** | `#1ed760` | **The brand.** Locked for every public/brand surface (site, app icon, social, GitHub, store), independent of the user-editable in-app accent. This is the "coral of Claude / purple of Linear". |

The in-app accent is user-customizable (correctly). The **brand** colour is not.

### Support palette

| Role | Hex | Notes |
|---|---|---|
| Ink (ground) | `#070808` | Real default background |
| Text | `#f0f3f1` | Real default text |
| Orb Cyan | `#7ad7ff` | `--xn-cyan` — belongs to the Orb |
| Orb Violet | `#b69dff` | `--xn-violet` — belongs to the Orb |
| Orb Ink | `#06080c` | Deep ambient black behind the Orb |

Source: `server/js/settings.js` (`SETTINGS_PRESETS`, `BUILTIN_THEMES`,
`DEFAULT_HUB_SETTINGS`) and `server/components/AIPanel/AIPanel.css`.

### Bit's moods — emotion, not decoration

These change only with the pet's state; never borrow them for UI chrome.
(`MOOD_RGB` in `server/js/vitals-pet.js`, outline `#0d1117`.)

| Mood | Hex |
|---|---|
| Happy | `#6ee787` |
| Neutral | `#ffd75e` |
| Worried | `#ffa657` |
| Angry | `#ff5a5f` |
| Ghost (dead) | `#e8f4ff` |

### Pixel Retro world

A deliberately dark CRT skin (no light mode by design): terminal ink
`#f5c518` on phosphor navy `#050510`, hard 2px borders, offset shadows, square
everything. (`server/styles/themes-retro.css`.) Keep this palette inside the
Retro skin.

The brand book commits to **dark** overall: Xenon is a glowing screen in the
dark, and both its worlds (Liquid Glass + Pixel Retro) are dark-first.

---

## 5. Typography — three faces, three jobs

| Face | Job |
|---|---|
| **Inter** | The interface, the everyday voice (Liquid Glass). |
| **VT323** | The terminal — Bit and the CRT world. |
| **Press Start 2P** | Pixel micro-labels only, never running text. |

Loaded in `server/index.html`; skin definitions in
`server/styles/global.css` and `server/styles/themes-retro.css`. Never use a
system font as the wordmark.

---

## 6. Motion — the "wow" gesture

Xenon's unfair advantage is that the product *moves*. Pick one memorable moment
and show it everywhere (Reddit, GitHub header, store, video) until people
recognize it with their eyes closed. The candidate: **press ✦ and the Orb comes
alive** — listen → think → speak. That is the animated logo, for video and
press material. The public site deliberately does NOT use it (2026-07
redesign): there the signature is the **Edge frame** — every screenshot shown
in the display's real 32:9 body at native 2560×720, with a soft green glow.
Product truth over spectacle on the site; the Orb moves in video.

---

## 7. Do / Don't

**Do**
- Use Bit to create affection — it's why people stay.
- Lock the signature green `#1ed760` on every public surface.
- Keep one voice — techy, relaxed, never corporate — across README, site, changelog, in-app.
- Treat motion as part of the logo: an Orb intro beats any written tagline.
- Repeat the "100% local" promise — it's trust, not a feature.

**Don't**
- Don't call it "Xenon Edge" — the product is **Xenon**; "Xeneon Edge" is Corsair's display.
- Bit is never genuinely mean. If it hurts, rewrite it.
- The Orb never jokes — the premium register stays sober.
- Never a system font as wordmark, and never mix Orb and Bit in the same frame.
- Don't sell the feature list — sell the companion, then show what it can do.

---

## 8. Where the brand lives in code

| Asset | Location |
|---|---|
| Bit sprite (exact) | `server/js/vitals-pet.js:34-55` — `BODY`/`EYES`/`FACES`/`MOOD_RGB`. Copy it 1:1; never invent new Bit shapes. |
| Bit voice bank | `server/js/vitals-pet-core.js` — per-language tone tiers |
| Resonance Orb | colours (`--xn-cyan`, `--xn-violet`) in `server/components/AIPanel/AIPanel.css` — video/press asset only; no longer rendered on the site |
| Colour presets | `server/js/settings.js` — `SETTINGS_PRESETS`, `BUILTIN_THEMES` |
| Reusable Bit mark | `docs/images/bit.svg` (scalable, derived from the sprite) |
| Public site | `docs/index.html` (Edge-frame hero, `p4` Bit pillar with the VT323 line, 5-language i18n dict); `docs/catalog/` and `docs/create/` share the same tokens |
| Reusable copy | `README.md`, `FEATURES.md` |
