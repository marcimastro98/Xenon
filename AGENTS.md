# Codex Workspace Instructions - XenonEdge Hub

> Local workspace guidance for AI-assisted development.
> Keep this file focused on project-wide rules, production safety, and code quality.

---

## Project Context

XenonEdge Hub is a production dashboard project for the CORSAIR Xeneon Edge 14.5" LCD touchscreen display.

The project matters beyond local experimentation: it is public-facing, used as a real widget, has an active user base on Reddit and GitHub, and is of direct interest to CORSAIR (the Head of R&D has been in contact with the author). Treat every change as production work that could be reviewed by users, maintainers, or CORSAIR contacts.

There are two related implementations:

| Area | Location | Purpose | Status |
|------|----------|---------|--------|
| Server/Web Widget | `server/` | Node.js backend plus browser dashboard UI | Production |
| Native iCUE Widget | `widget/` | Elgato/iCUE widget package for Marketplace-style distribution | Active development |

Do not assume a request targets `widget/` only. If the user says "server", "web", "browser widget", "local widget", or "production widget", work in `server/`. If the user says "iCUE", "native widget", "Marketplace", or "Elgato SDK", work in `widget/` and consult the SDK docs.

---

## Current Version and Roadmap

**Current stable version: v1.3.0**

### What is implemented (v1.0 → v1.3)

- System monitor: CPU, GPU, RAM, network, disk stats with LibreHardwareMonitor integration
- Media panel: now-playing via Windows SMTC, album art, playback controls
- Microphone: mute/unmute toggle, live level meter, device picker
- Audio: speaker/output device picker, master volume slider, mute toggle
- Calendar: event management with reminder toasts
- Notes: inline scratchpad with auto-save
- App switcher: open windows list with focus-on-tap, favorite shortcuts
- Weather: current conditions, 3-day forecast, 8-hour hourly timeline, auto-detect or manual city input
- Focus Lock Screen: distraction-free overlay with animated clock, now playing, upcoming events, weather summary
- Settings: color themes (Xenon, Ocean, Ember, Violet, Mono), hex color personalization, 12h/24h clock, custom image/video background up to 32MB, lock screen widget toggles, language (EN/IT)
- Dashboard customization: panels can be reordered, resized, hidden, restored, and reset without editing code — persistent across reloads
- Bilingual UI: Italian / English, switchable on the fly

### Planned / in roadmap

- **Smart context switching (Multi-page smart)**: auto-switch layout based on foreground process (gaming mode, dev mode, stream mode). Detect fullscreen apps + Steam library + user-defined rules.
- **Discord integration**: mute/deafen controls, voice channel status, notifications
- **OBS integration**: scene switching, stream status, recording controls via OBS WebSocket
- **Manual layout builder**: drag-and-drop panel positioning (beyond current reorder buttons)
- **Touch UX improvements**: swipe gestures, larger touch targets, quick actions

---

## Core Priorities

1. Preserve production stability.
2. Keep the code clean, readable, and organized.
3. Follow the existing architecture and naming style.
4. Make minimal, focused changes that solve the real problem.
5. Avoid speculative rewrites or broad refactors unless explicitly requested.
6. Update public-facing documentation or `CHANGELOG.md` when behavior changes.
7. Validate changes before handing them back.

---

## Versioning Policy

- `v1.x.y` patch (y): bug fixes and minor tweaks only — no new user-visible features
- `v1.x.0` minor (x): new features or meaningful UX improvements
- `v2.0.0` major: architectural changes or breaking changes to settings/API contracts

Do not bump minor or major versions for bug fixes alone.

---

## Repository Map

```text
server/                  Production server/browser widget
server/server.js          Local Node.js HTTP/API server, port 3030
server/index.html         Modular production UI entry point served by the server
server/widget.html        Legacy/single-file dashboard reference
server/js/                Client-side modules for the web widget
server/components/        Component CSS for the web widget
server/styles/            Global and responsive web widget CSS

widget/                  Native iCUE widget source
widget/index.html         iCUE entry point and property declarations
widget/modules/           iCUE runtime modules
widget/components/        iCUE HTML partials
widget/styles/main.css    iCUE styling

WidgetBuilder/            Offline iCUE Widget Builder documentation mirror
tools/                    Build and packaging scripts
CHANGELOG.md              Public-facing change log
README.md                 Public project documentation
```

---

## Production Safety

- The server widget is production software with real users. Do not casually restructure `server/`.
- Do not start, stop, or replace the user's manually managed local server unless they ask.
- Preserve user data files and runtime settings such as notes, events, uploaded backgrounds, and settings.
- Do not change storage keys, endpoint contracts, widget IDs, or package names unless explicitly requested.
- Do not remove fallback behavior without checking the user-visible impact.
- Do not hide real failures behind silent no-ops. Degrade gracefully and keep errors understandable.

---

## Code Quality Standards

Write code as if it will be reviewed externally — including by CORSAIR contacts.

- Prefer small modules and single-purpose functions.
- Use existing helpers and patterns before introducing new abstractions.
- Keep data validation close to the boundary where external or persisted data enters the app.
- Use `const` by default and `let` only when reassignment is needed.
- Avoid `var` in new JavaScript.
- Prefer `async`/`await` with clear `try`/`catch` handling for asynchronous code.
- Use `textContent` for user-visible text unless markup is trusted and static.
- Do not use `eval`, dynamic `Function`, `document.write`, or string-based timers.
- Avoid inline styles in new UI code unless the existing code requires it for the specific feature.
- Keep comments useful and concise. Explain why, not the obvious mechanics.
- Do not add dependencies unless the benefit is clear and the user agrees.

---

## UI and UX Standards

- The dashboard must feel polished, practical, and reliable on the Xeneon Edge display.
- Preserve dense, glanceable layouts. Avoid marketing-page UI inside the dashboard.
- Make controls discoverable without adding noisy explanatory text inside the app.
- Keep touch targets comfortable — the Xeneon Edge is a touchscreen, design accordingly.
- State changes must be obvious and immediate.
- Prevent text overflow, clipping, and overlapping at supported sizes.
- When adding customization, persist user choices and provide a reset path.
- Keep loading, empty, offline, and error states deliberate and friendly.

---

## Modern Web Platform (2025–2026 baseline)

The server widget targets Chromium-based browsers (Edge, Chrome, Xenon Edge WebView). All of these APIs are considered stable and available — use them without polyfills or feature flags.

### APIs in active use (do not re-implement manually)

| API | Where used | Purpose |
|-----|-----------|---------|
| `CSS @property` | `server/styles/global.css` | Registers `--accent` and `--bg` as `<color>` so they can animate |
| `:root { transition: --accent ... }` | `server/styles/global.css` | Smooth theme colour cross-fade on settings change |
| `document.startViewTransition()` | `server/js/dashboard-layout.js` | Animated panel show/hide/reorder. Falls back to direct call if unavailable |
| `Server-Sent Events (EventSource)` | `server/js/main.js` + `server/server.js` | Replaces client-side polling for status, media, system, audio. Endpoint: `GET /sse` |
| `requestAnimationFrame` | `server/js/lockscreen.js` | Lockscreen clock tick — updates only when the second changes, zero wasted frames |
| `will-change: transform / opacity` | MicPanel, WeatherModal, Topbar, LockScreen, MediaPanel CSS | GPU layer promotion for all long-running CSS animations |
| CSS Container Queries (`container-type: size`) | `MicPanel.css` | Component-scoped responsive sizing |
| CSS `color-mix()` | Available — not yet used in component CSS | Use instead of rgba manual mixing for new colour utilities |

### Rules for new code

- Prefer `EventSource` over `setInterval` + `fetch` for any real-time data stream.
- Wrap user-visible layout mutations in `document.startViewTransition()` with a direct-call fallback.
- Add `will-change: transform` or `will-change: opacity` to any element with a running `@keyframes` animation.
- Use `requestAnimationFrame` instead of `setInterval` for visual updates that need sub-second precision.
- Do not add `@property` registrations for non-colour tokens — the syntax for numbers/lengths is less useful in this codebase.
- Do not use `color-mix()` to replace existing `rgba(var(--accent-rgb), ...)` patterns unless rewriting the whole colour system — the mixed approach would create inconsistency.

---

## Server/Web Widget Rules

Use these when working in `server/`.

- `server/index.html` is the modular UI entry point served by `server/server.js`.
- Keep `server/widget.html` as legacy/reference unless the user explicitly asks to update it.
- Client settings are stored under `xeneonedge.settings.v1` and synchronized through `/settings`.
- Server-owned data endpoints include system, network, media, audio, notes, events, windows, status, weather, background, and control routes.
- `GET /sse` is the Server-Sent Events stream. It pushes `status`, `media`, `system`, and `audio` named events. Do not remove or rename this endpoint without updating `main.js` and the SSE broadcast timers at the end of `server.js`.
- Keep the local backend at `http://127.0.0.1:3030` compatible with existing installs.
- Do not start the Node server from the agent unless the user explicitly asks.

---

## iCUE Widget Rules

Use these when working in `widget/`.

- Consult the offline SDK mirror before relying on web documentation:
  - `WidgetBuilder/docs/`
  - `WidgetBuilder/references/`
  - `WidgetBuilder/skill.md`
- Keep the widget identity stable unless the user explicitly requests a change.
- Respect iCUE SDK limitations — many features (mic mute, audio control, network, app switcher) require the companion server and are not available via native SDK plugins alone.
- Use `npm run icue:package` when validating package-level iCUE changes.
- Do not route server-only behavior into unsupported iCUE APIs.

---

## Settings and Persistence

- User settings must survive reloads and restarts.
- Validate settings loaded from localStorage or files before applying them.
- Preserve backward compatibility for existing settings whenever possible.
- When introducing a new settings field, add normalization on both client and server if both sides persist it.
- Provide a sensible default and a reset path for user-facing configuration.

---

## Security and Privacy

- Never commit secrets, tokens, local private context, or machine-specific credentials.
- Do not log sensitive user data.
- Sanitize or validate persisted JSON, localStorage values, query input, upload metadata, and external API responses.
- Use HTTPS for external requests unless the local server contract explicitly requires `127.0.0.1` HTTP.
- Keep uploaded files constrained by extension, MIME type, file size, and safe local paths.
- License is custom non-commercial — commercial use requires explicit written permission from the author.

---

## Validation Expectations

Before marking work complete, choose validation proportional to the change.

For server/browser widget changes:

```powershell
git diff --check
node --check server/server.js
node --check server/js/<changed-file>.js
```

For iCUE widget changes:

```powershell
npm run icue:package
```

For UI changes, also inspect the affected markup/CSS for responsive behavior and likely overflow. Do not claim manual browser/device testing unless it was actually performed.

---

## Change Log

Every user-visible change must be reflected in `CHANGELOG.md` under the current unreleased section.

Write changelog entries for users, not only developers:

- Say what changed.
- Say why it matters.
- Avoid internal jargon unless there is no clearer alternative.

---

## Git and Worktree Safety

- Do not commit unless the user asks.
- Do not create branches unless the user asks.
- Never use destructive git commands such as `git reset --hard` or `git checkout --` unless explicitly requested.
- The worktree may contain user changes. Do not revert unrelated files.
- If existing changes overlap with the requested work, read them carefully and build on them.

---

## Communication Style

- Be direct about risks, tradeoffs, and what was validated.
- If the target area is ambiguous, ask or infer from the user's wording and explain the choice.
- Keep final summaries concise and include the important changed files.
- Use Italian when the user writes in Italian unless there is a clear reason not to.