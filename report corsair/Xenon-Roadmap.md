# Xenon — Native Widget Roadmap

*Marcello Mastroeni · for CORSAIR / iCUE · June 2026*

Xenon is an all-in-one dashboard for the Xeneon Edge — system monitoring, media, audio, AI, RGB, a Stream-Deck-style key grid and more, running locally. It's a real, shipped product with active users today (web companion on the Edge), not a concept. The goal is to bring it to the Marketplace as native iCUE widgets, so that the day the Marketplace opens it already has a complete, proven dashboard inside it — giving Edge owners more reason to buy, and the Marketplace a flagship to launch with.

**The organizing idea: a feature's native feasibility is its place in the roadmap.** Some widgets can ship the day the Marketplace opens with no SDK changes; others need specific SDK capabilities first. The rollout below is ordered by what the platform can do — a shared map, for your team and me, of who builds what and when.

---

## The rollout

**Phase 1 — Marketplace launch. No SDK changes needed; these ship day one.**

| Widget | Goes native with |
|---|---|
| System monitor (CPU/GPU/RAM, temps, load) | Sensors plugin *(available today)* |
| In-game FPS | Sensors plugin, `fps` sensor type *(available today)* |
| Clock / top bar | Built-in UI |
| Timers · Tasks · Notes | Built-in UI *(storage note below)* |
| Theming & settings | Built-in settings system |

*What done looks like:* these tiles are live in the Marketplace on launch day. *On my side:* I package and submit them, with full theming and all five languages, in time for launch.

*Timers, Tasks and Notes render natively at launch; reliable storage with backup (what they have today) needs local file access, so it arrives with the Companion Bridge (Phase 4) — a launch version would use localStorage, which is size-limited and can lose data.*

**Phases 2–4 — gated on SDK capabilities. Each row goes native when CORSAIR ships the capability in the middle column; until then it stays in the web companion.**

| Widget | What CORSAIR needs to ship first | Priority |
|---|---|---|
| Media (album art, position, source) | Richer Media plugin | Phase 2 |
| Weather | Network/HTTP plugin | Phase 2 |
| Calendar sync · Focus lock screen | Network/HTTP plugin | Phase 2 |
| Microphone · Audio/volume mixer | Audio plugin | Phase 3 |
| Deck · App switcher · Performance controls | System/Action plugin | Phase 3 |
| Xenon AI · RGB lighting · Streaming · Remote control · Browser · Second screen | Local Companion Bridge | Phase 4 |

- *Phase 2 done:* Media, Weather, Calendar sync and the Focus lock screen run as native tiles. *On my side:* I build each widget against the Network/HTTP and Media plugins as they land.
- *Phase 3 done:* Microphone, the audio/volume mixer, Deck, app switcher and Performance controls run natively. *On my side:* I build them against the Audio and System/Action plugins as they land.
- *Phase 4 done:* the flagship features — AI, RGB, streaming, remote, browser, second screen — run natively through the bridge. *On my side:* I build the companion side and the widgets against the bridge's permission model.

The phases are a suggested priority order — broadly-useful capabilities first — not a calendar; the pace is set by when each capability is released to developers.

---

## What CORSAIR can unblock

| SDK addition | Unlocks | Phase |
|---|---|---|
| **Richer Media plugin** — album art, position/duration, seek, source | Full Media widget | 2 |
| **Network/HTTP plugin** — allowlisted, user-granted domains | Weather, calendar sync, lock screen | 2 |
| **Audio plugin** — mic mute/level, device list, per-app volume | Microphone, audio mixer | 3 |
| **System/Action plugin** — launch app, focus window, run allowlisted action | Deck, app switcher, performance controls | 3 |
| **Local Companion Bridge** — sanctioned widget↔local-process channel with a real permission model (consent, declared capabilities, signing, allowlists) | AI, RGB, streaming, remote, browser, second screen | 4 |
| **Runtime modernization** — accept modern JavaScript syntax | Smoother development for every Marketplace creator | — |
| **Docs with end-to-end examples** — full settings-to-render walkthroughs | Faster onboarding for every Marketplace creator | — |

The Companion Bridge is the high-leverage item: it's the single addition that makes the entire Phase 4 column possible. Pairing it with the focused plugins above keeps the simple widgets zero-install while power widgets opt into the bridge.