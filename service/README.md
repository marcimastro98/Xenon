# Xenon backend as a Windows service

The Xenon backend (`server/server.js`) runs as an independent, auto-starting
Windows service so the dashboard is available at `http://127.0.0.1:3030` for
**all** surfaces — the browser, the iCUE `<iframe>` and the native Tauri app —
without anyone opening a terminal, a browser or iCUE.

## How it works

- **Host:** [WinSW](https://github.com/winsw/winsw) v2.12.0 (self-contained x64
  build, no .NET prerequisite), pinned by SHA-256 and downloaded on first install
  as `xenon-service.exe`.
- **Packaging:** none. The service runs the **unmodified** backend —
  `node server/server.js` with the working directory set to `server/` — using the
  Node LTS the main installer already provisions (pinned by absolute path, because
  a service does not inherit the user `PATH`). Every PowerShell collector, the
  vendored `soundvolumeview-x64`, `vendor/`, `presentmon/` and `server/data/`
  resolve exactly as they do under `npm start`, and the native `koffi` addon loads
  normally. Compiling to a single `.exe` (SEA / pkg) was rejected: it breaks native
  addons and `__dirname`-relative asset resolution.
- **Behavior:** starts at boot (`startmode Automatic`), auto-restarts on crash
  with backoff (`onfailure restart`), and writes rolling logs to `service/logs/`.
- **Security:** unchanged. The server still binds `127.0.0.1` only; loopback,
  Origin, CSRF and JSONP boundaries are untouched.

## Install / uninstall (elevated PowerShell)

```powershell
# Register + start the service
powershell -NoProfile -ExecutionPolicy Bypass -File service\install-service.ps1

# Stop + remove the service (leaves server/ and server/data/ intact)
powershell -NoProfile -ExecutionPolicy Bypass -File service\uninstall-service.ps1
```

From Phase 7 these are called by the unified Tauri installer; you rarely run them
by hand.

## Managing the running service

```powershell
service\xenon-service.exe status
service\xenon-service.exe stop
service\xenon-service.exe start
sc.exe query XenonEdgeService
```

## Development

The service is **optional**. For day-to-day development keep using:

```powershell
npm start        # node server/server.js — same backend, foreground
```

Don't run the service and `npm start` at the same time — they both bind port 3030.

## Not committed

`xenon-service.exe` (downloaded), `xenon-service.xml` (generated per machine) and
`logs/` are git-ignored. Only the template and these scripts are versioned.
