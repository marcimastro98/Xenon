# Xenon backend as a Windows service — RETIRED

An early v4 beta ran the backend (`server/server.js`) as an auto-starting
Windows service via WinSW. **That design is retired and must not come back.**

## Why it was retired

Windows isolates services in **session 0**, away from the user's interactive
desktop. Almost everything Xenon does needs that desktop, so under the service
these broke silently:

- **Deck "open app / open site / open file" keys** — `Start-Process` from
  session 0 launches on an invisible desktop (or fails), so taps did nothing.
- **Media (SMTC)** — the now-playing sessions belong to the user's logon
  session; from session 0 the media panel saw nothing.
- **Hotkey keys and window actions** — `SendInput`/window messages cannot reach
  another session's desktop.
- **Screen capture (Xenon AI), TTS audio playback, wake-word microphone
  capture** — all bound to the interactive session.

There is no lightweight fix: each surface would need its own user-session
delegate (`CreateProcessAsUser` shims, cross-session stdio for the media host,
an in-session input agent, …). The backend simply belongs in the user's
session.

## What replaced it

The proven v3 mechanism, re-promoted to primary in `server/install.ps1`:
a **per-logon Task Scheduler task** (interactive logon type) that runs
`start-hidden.vbs` → `node server/server.js` hidden, in the user's session.
The installer also **removes** a leftover `XenonEdgeService` from earlier beta
installs (`Remove-BackendServiceIfPresent`) before registering the task.

The trade-off is accepted: the backend starts at logon (not at boot) and has no
service-style crash auto-restart — exactly like every released v3 build. All
surfaces (browser, iCUE iframe, native kiosk) only exist after logon anyway.

## Files kept here

- `install-service.ps1` — retired; refuses to run without `-Force`.
- `uninstall-service.ps1` — still used, by `install.ps1`'s migration and by
  `server/uninstall.ps1`, to remove the service from beta machines.
- `xenon-service.xml.template` — reference only.

`xenon-service.exe` (WinSW), `xenon-service.xml` and `logs/` are git-ignored
artifacts of old installs; `uninstall-service.ps1` deletes them.
