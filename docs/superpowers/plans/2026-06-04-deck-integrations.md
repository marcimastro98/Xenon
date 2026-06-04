# Deck & Widget Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Master plan / roadmap.** This document covers 6 independent subsystems. Steps 1–3 are fully specified against the existing codebase and are directly executable. Steps 4–6 require an API-research/spec + prototype phase first (Discord RPC, Teams 3rd-party API, Twitch/YouTube OAuth) and are decomposed at the design level here, to be expanded into their own detailed plans when reached. Do **not** fabricate exact API calls for 4–6 before validating them.

**Goal:** Make the XenonEdge Deck and dashboard match (and exceed) Stream Deck on communication, streaming, audio, and automation control — without breaking the one-click, no-new-dependency promise.

**Architecture:** Every new key action follows the existing pattern: a metadata entry in the shared catalog (`server/js/deck-actions.js`), a `case` in the allowlisted server dispatcher (`server/actions/registry.js`) with OS side-effects injected via `deckRegistryDeps`, and execution through `deckRegistry.run()` (server.js:3544). The Deck editor palette renders from the catalog automatically. Reuse `nircmd`, `SoundVolumeView`, and `fetch` — no new npm deps.

**Tech Stack:** Node.js (server.js, port 3030), PowerShell collectors/runners, vanilla browser JS, `nircmd.exe` (already used by `ai.js`), `SoundVolumeView.exe` (`server/soundvolumeview-x64/`), OBS WebSocket (already wired via `createObs`). Tests: Node test runner, `server/test/*.test.mjs`.

---

## Existing architecture map (read before starting)

| Concern | Location |
|---------|----------|
| Shared action catalog + validator | `server/js/deck-actions.js` (`ACTION_CATALOG`, `validateAction`, `triggerSteps`) |
| Server-side allowlisted dispatcher | `server/actions/registry.js` (`createRegistry`, deps-injected) |
| Dispatcher wiring (deps) | `server.js:1237` (`deckRegistryDeps`), `server.js:1267` (`createRegistry`) |
| Deck run endpoint | `server.js:3544` (`deckRegistry.run(action)`) |
| Capabilities probe (editor) | `server.js:3564` (reports `soundVolumeView`, `obsConfigured`, …) |
| Existing PS runner | `server/deck-actions.ps1` (currently only `open`) |
| Per-app audio endpoints | `server.js:3484` (`/audio/app/volume`), `server.js:3503` (`/audio/app/mute`) |
| SoundVolumeView path | `server.js:29` (`SVV`) |
| Per-app mixer UI helpers | `server/js/volume.js` (`buildAppMixerRow`, `wireAppMixer`, `appMixSliderBg`) |
| Foreground detection | `server/gamedetect.js` (`getForegroundProcess`, `IGNORE_PROC_RE`), `server/foreground.ps1` |
| OBS (reference: a completed integration) | `server.js:1124` (`createObs`), `server/actions/obs.js` |
| Test pattern to copy | `server/test/perf-registry.test.mjs` |

**Validation per change (project policy):**
```
git diff --check
node --check server/server.js
node --check server/js/<changed>.js
node --test server/test/<changed>.test.mjs
```
**CHANGELOG policy:** every user-visible change gets an entry under `CHANGELOG.md [v3.0.0]`.

---

## Build order & rationale

| # | Feature | Why here | One-click impact |
|---|---------|----------|------------------|
| 1 | Hotkey (prototype first) | Unblocks meetings + needed by Discord/Teams mute; biggest technical risk | ⚠️ medium |
| 2 | Per-app mixer actions + touch fader tile | Backend already exists, zero friction, differentiator | ✅ none |
| 3 | Webhook action | Tiny, huge ceiling | ✅ none |
| 4 | Discord + Teams | Depends on Step 1 for mute | ⚠️ medium |
| 5 | Twitch / YouTube Live | Streamer category, heavier | ❗ high (OAuth) |
| 6 | Soundboard | Completion | ✅ none |

**Out of scope (agreed):** Home Assistant (deferred); true Wave Link-style virtual-driver audio routing (breaks one-click).

---

## Step 1 — Hotkey action (prototype, then build)

**The problem:** Tapping the touchscreen gives foreground to the dashboard window, so a synthetic keystroke (SendInput) lands on the widget, not the target app. We must target the **last real foreground window** explicitly. Only the `server/` widget can do this — the native iCUE widget is sandboxed and cannot send system input.

**Approach:** Track the last foreground window that is NOT the dashboard/iCUE (reusing `gamedetect.js` + `IGNORE_PROC_RE`), then on action: `SetForegroundWindow` (with the `AttachThreadInput` workaround) + `SendInput` for the key combo, via a new PowerShell runner.

**Files:**
- Modify: `server/foreground.ps1` (emit `hwnd` and `title` in addition to `process`/`pid`/`fullscreen`)
- Modify: `server/gamedetect.js` (track + expose `getLastAppWindow()` → `{ hwnd, process, title }`, excluding ignored procs)
- Create: `server/deck-hotkey.ps1` (given `-Hwnd` and `-Keys`, focus + send)
- Modify: `server/js/deck-actions.js` (add `hotkey` to `ACTION_CATALOG`)
- Modify: `server/actions/registry.js` (add `case 'hotkey'`)
- Modify: `server.js` (add `sendHotkey` to `deckRegistryDeps`)
- Test: `server/test/deck-hotkey.test.mjs` (validation/normalisation only — OS effect injected)

### Phase 1a — Prototype (validate before building the action)

- [ ] **Step 1: Extend `foreground.ps1` to emit HWND + title**

In `foreground.ps1`, the C# `Probe()` already has the foreground `IntPtr h`. Add a title read and include both in the JSON. Add near the other P/Invokes:
```csharp
[DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
```
Change `Json(...)` to also accept `long hwnd` and `string title`, escaping the title the same way `name` is escaped, and emit `"hwnd":<hwnd>,"title":"<title>"`. In `Probe()`, after resolving `name`, read:
```csharp
var tb = new StringBuilder(256);
GetWindowText(h, tb, tb.Capacity);
return Json(fullscreen, name, pid, h.ToInt64(), tb.ToString());
```

- [ ] **Step 2: Track last non-dashboard window in `gamedetect.js`**

In `handleLine`, capture `hwnd`/`title` into `_last`. Add a module-level `_lastApp` updated whenever the parsed window's process is NOT matched by `IGNORE_PROC_RE` and `hwnd` is non-zero. Export:
```javascript
function getLastAppWindow() {
  return _lastApp && (Date.now() - _lastApp.at) < STALE_MS ? { hwnd: _lastApp.hwnd, process: _lastApp.process, title: _lastApp.title } : null;
}
```
Add `getLastAppWindow` to `module.exports`.

- [ ] **Step 3: Write `server/deck-hotkey.ps1`**

A runner that takes `-Hwnd <long>` and `-Keys "<combo>"` (e.g. `ctrl+shift+m`), brings the window to the foreground using the `AttachThreadInput` technique, then sends the combo via `SendInput` (Add-Type C# with `keybd_event`/`SendInput` and a small virtual-key map for modifiers + A–Z/0–9/F-keys). Output `{"ok":true}` / `{"ok":false,"error":...}` JSON like `deck-actions.ps1`.

- [ ] **Step 4: Manual prototype test on the Xeneon Edge**

Open Notepad on the main display, focus the dashboard on the Xeneon, then run:
```
powershell -NoProfile -ExecutionPolicy Bypass -File server/deck-hotkey.ps1 -Hwnd <notepad-hwnd> -Keys "h"
```
Expected: the `h` lands in Notepad, not in the dashboard. If it does NOT, evaluate the `PostMessage(WM_KEYDOWN/UP)` fallback (works for normal apps, fails for raw-input games) and record the finding before proceeding.

**Decision gate:** Only proceed to Phase 1b if focus-redirect works. If it doesn't on the Xeneon's host, stop and reassess (the whole meeting category via hotkey depends on this).

### Phase 1b — Wire the action (after prototype passes)

- [ ] **Step 5: Add `hotkey` to the catalog**

In `server/js/deck-actions.js` `ACTION_CATALOG`:
```javascript
{ type: 'hotkey', group: 'system', labelKey: 'deck_act_hotkey', params: [{ name: 'keys', kind: 'text' }] },
```

- [ ] **Step 6: Write the failing validator test**

`server/test/deck-hotkey.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pkg from '../js/deck-actions.js';
const { validateAction } = pkg;

test('hotkey action keeps only keys, capped', () => {
  const a = validateAction({ type: 'hotkey', keys: 'ctrl+shift+m', junk: 1 });
  assert.deepEqual(a, { type: 'hotkey', keys: 'ctrl+shift+m' });
});
```
Run: `node --test server/test/deck-hotkey.test.mjs` → Expected: PASS (validateAction already generic; this locks the contract).

- [ ] **Step 7: Add `case 'hotkey'` in the registry**

In `server/actions/registry.js`, add a `parseKeys`/normalise helper (allow only `[a-z0-9]`, `+`, and known modifiers/keys; reject anything else) and:
```javascript
case 'hotkey': {
  if (typeof d.sendHotkey !== 'function') return { ok: false, error: 'hotkey_unavailable' };
  const keys = normalizeKeys(action.keys);
  if (!keys) return { ok: false, error: 'bad_keys' };
  const r = await d.sendHotkey(keys);
  return r && r.ok === false ? { ok: false, error: r.error || 'hotkey_failed' } : { ok: true };
}
```
Add unit tests for `normalizeKeys` (valid combo passes; `"; rm -rf"` rejected).

- [ ] **Step 8: Inject `sendHotkey` in server.js**

In `deckRegistryDeps` (server.js:1237), add `sendHotkey(keys)` that reads `getLastAppWindow()` from `gamedetect`, and if a target hwnd exists, `execFile` `deck-hotkey.ps1` with `-Hwnd` and `-Keys`. Return `{ ok:false, error:'no_target' }` when no app window is tracked.

- [ ] **Step 9: Add i18n + CHANGELOG**

Add `deck_act_hotkey` to all 5 locales in `server/js/i18n.js`. Add a `CHANGELOG.md [v3.0.0]` entry: "Deck: new Hotkey action — send a keyboard shortcut to the app you were last using (covers Zoom, Meet, Slack, and any app with a global shortcut)."

- [ ] **Step 10: Validate & commit (commit only if user asks)**
```
node --check server/server.js
node --check server/actions/registry.js
node --test server/test/deck-hotkey.test.mjs
```

---

## Step 2 — Per-app mixer (Deck actions + touch fader tile)

Backend already exists (`/audio/app/volume`, `/audio/app/mute`, SoundVolumeView). Two deliverables.

### Step 2a — Deck actions for a specific app

**Files:**
- Modify: `server/js/deck-actions.js` (add `appVolume`, `appMute`; new `kind: 'audioApp'` select)
- Modify: `server/actions/registry.js` (add cases)
- Modify: `server.js` (inject `appVolume`/`appMute` deps reusing the existing endpoint logic; expose app list to the editor near the capabilities probe at server.js:3564)
- Test: `server/test/deck-appaudio.test.mjs`

- [ ] **Step 1: Add catalog entries**
```javascript
{ type: 'appVolume', group: 'audio', labelKey: 'deck_act_appVolume', params: [{ name: 'app', kind: 'audioApp' }, { name: 'mode', kind: 'select', options: ['up', 'down'] }] },
{ type: 'appMute',   group: 'audio', labelKey: 'deck_act_appMute',   params: [{ name: 'app', kind: 'audioApp' }, { name: 'mode', kind: 'select', options: ['toggle', 'mute', 'unmute'] }] },
```
(`audioApp` validates as a plain string like `path`/`text`; the editor populates options from the live session list.)

- [ ] **Step 2: Failing test** — `validateAction` keeps `{app, mode}` and coerces bad `mode` to default. Run `node --test`.

- [ ] **Step 3: Registry cases** — `case 'appVolume'`/`case 'appMute'` calling injected `d.appVolume(app, mode)` / `d.appMute(app, mode)`; degrade to `{ok:false}` when unavailable.

- [ ] **Step 4: Inject deps in server.js** — factor the body of `/audio/app/volume` and `/audio/app/mute` into reusable functions and call them from both the HTTP route and the new deps. Targeting by SoundVolumeView CLI id with a process-name fallback (session ids change across app restarts).

- [ ] **Step 5: Editor support** — extend the capabilities/app-list endpoint so the palette can render the `audioApp` select; render in the Deck editor like `obsSource`.

- [ ] **Step 6: i18n + CHANGELOG + validate.**

### Step 2b — Touch mini-mixer tile

**Files:**
- Modify: `server/js/deck.js` / `server/js/deck-model.js` (new key kind that opens a fader panel)
- Reuse: `buildAppMixerRow`, `wireAppMixer` from `server/js/volume.js`
- Modify: relevant component CSS

- [ ] **Step 1:** Add a `miniMixer` key kind to the deck model (config: which apps to show, or "auto top N").
- [ ] **Step 2:** On tap, open a lightweight overlay rendering 3–4 `buildAppMixerRow` rows wired via the existing `wireAppMixer` delegation.
- [ ] **Step 3:** Touch-size the faders for the Xeneon (comfortable targets per UI standards).
- [ ] **Step 4:** i18n + CHANGELOG + validate.

---

## Step 3 — Webhook action

**Files:**
- Modify: `server/js/deck-actions.js` (add `webhook`)
- Modify: `server/actions/registry.js` (add `case 'webhook'`, reuse `normalizeUrl`/`isHttpUrl`)
- Test: `server/test/deck-webhook.test.mjs`

- [ ] **Step 1: Catalog entry**
```javascript
{ type: 'webhook', group: 'system', labelKey: 'deck_act_webhook', params: [{ name: 'url', kind: 'url' }, { name: 'method', kind: 'select', options: ['GET', 'POST'] }, { name: 'body', kind: 'text' }] },
```

- [ ] **Step 2: Failing test** — `validateAction` keeps `{url, method, body}`, coerces bad method to `GET`. Run `node --test`.

- [ ] **Step 3: Registry case**
```javascript
case 'webhook': {
  const url = normalizeUrl(action.url);
  if (!url) return { ok: false, error: 'bad_url' };
  const init = { method: action.method, signal: AbortSignal.timeout(5000) };
  if (action.method === 'POST' && action.body) { init.body = action.body; init.headers = { 'Content-Type': 'application/json' }; }
  try { const res = await fetch(url, init); return res.ok ? { ok: true } : { ok: false, error: 'http_' + res.status }; }
  catch (e) { return { ok: false, error: (e && e.name === 'TimeoutError') ? 'timeout' : 'fetch_failed' }; }
}
```
Reject non-http schemes (already handled by `normalizeUrl`). Add tests: bad scheme rejected, timeout maps to `'timeout'`.

- [ ] **Step 4:** i18n + CHANGELOG ("Deck: Webhook action — trigger any URL/automation, e.g. n8n, IFTTT, local smart-home endpoints") + validate.

---

## Step 4 — Discord + Teams (native APIs) — SPEC + PROTOTYPE PHASE

> Requires its own detailed plan after an API spike. Do not write exact RPC/WebSocket payloads until validated against the live clients.

**Discord (design):**
- New provider module `server/comms-discord.js` over the local RPC (named pipe `\\.\pipe\discord-ipc-0`). Register one Discord app; ship the client ID.
- Read-only (free scopes): voice channel, speaking state, self-mute/deafen → drive live indicators in a Discord tile.
- Mute/deafen **action** is whitelist-gated (`rpc.voice.write`) → use the **Step 1 hotkey** for the action; RPC only for status. Result: effectively bidirectional UI.
- Deck actions: `discordMute`, `discordDeafen` (delegating to hotkey under the hood, or RPC if the app is later whitelisted).

**Teams (design):**
- New provider `server/comms-teams.js` over the Third Party App API (local WebSocket, port 8124). Pairing handshake + token persisted in `settings.json`.
- Actions: mute, toggle camera, raise hand, leave; plus live state.
- Requires the user to enable "Manage third-party APIs" in Teams → **guided onboarding** in Settings (mirror the Sunshine/Tailscale onboarding from remote control). New Teams client only.

**Spike tasks (before the real plan):**
- [ ] Prototype Discord RPC handshake + a `SUBSCRIBE` to `VOICE_SETTINGS_UPDATE`; confirm read works with the shipped client ID.
- [ ] Prototype Teams pairing + a single `mute` command against the new client; confirm the toggle + state event.
- [ ] Write `docs/superpowers/plans/<date>-comms-discord-teams.md` with exact payloads once validated.

---

## Step 5 — Twitch / YouTube Live — SPEC PHASE

> Heaviest (OAuth + token refresh). Own detailed plan after a spike.

**Design:**
- Providers `server/stream-twitch.js` / `server/stream-youtube.js` with OAuth (tokens in `settings.json` like `geminiApiKey`); **guided onboarding** for login.
- Deck actions: create clip, stream marker, run ads, toggle (Twitch); start/stop / status (YouTube).
- Live tile (touchscreen advantage): viewer count + chat on-screen.
- Isolate well: an expired token must degrade to `{ok:false}`, never crash the dispatcher.

**Spike tasks:** validate OAuth device/app flow, scopes, and a single clip-create call before writing the executable plan.

---

## Step 6 — Soundboard

**Files:**
- Modify: `server/js/deck-actions.js` (add `playSound`, `kind: 'path'`)
- Modify: `server/actions/registry.js` (add `case 'playSound'` — play a validated local audio file on the selected output)
- Modify: `server/js/deck.js` (soundboard tile reusing the Deck grid render)

- [ ] **Step 1:** Catalog `playSound` (param: file path; validate audio extension, must exist).
- [ ] **Step 2:** Registry case playing via an allowlisted runner / existing audio output, with the same path-safety guards as `openFile` (no executables).
- [ ] **Step 3:** Soundboard tile (grid of sound keys).
- [ ] **Step 4:** i18n + CHANGELOG + validate.

---

## Self-Review

**Spec coverage:** every item discussed is mapped — hotkey (1), per-app mixer actions + touch tile (2), webhook (3), Discord+Teams (4), Twitch/YouTube (5), soundboard (6). Deferred items (Home Assistant, true Wave Link routing) are explicitly out of scope.

**Placeholder note:** Steps 1–3 and 6 contain concrete, executable code grounded in existing files. Steps 4–5 are intentionally design-level with spike tasks, because writing exact API payloads before validating Discord RPC / Teams API / Twitch OAuth would be a fabricated placeholder. Each gets its own detailed plan after its spike.

**Type/naming consistency:** action types (`hotkey`, `appVolume`, `appMute`, `webhook`, `playSound`) are unique and absent from the current `ACTION_CATALOG`; injected dep names (`sendHotkey`, `appVolume`, `appMute`) are consistent between the registry cases and `deckRegistryDeps`.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-06-04-deck-integrations.md`. Recommended first action: **Step 1 Phase 1a (hotkey prototype)** — it is the gating technical risk and several later steps depend on it.
