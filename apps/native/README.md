# @xenon/native — Xenon kiosk app (Tauri)

A borderless, full-screen (kiosk) native window for the CORSAIR Xeneon Edge that
loads the Xenon dashboard from the local backend service on
`http://127.0.0.1:3030`. It is **not** a fourth copy of the UI — it renders the
exact same `server/` dashboard as the browser and the iCUE iframe. No iCUE, no
browser to open by hand.

## Architecture

- **Shell:** Tauri 2 (WebView2 on Windows). Rust in `src-tauri/`.
- **Splash → dashboard:** the only bundled page is `splash/index.html`. It polls
  the backend and, once it answers, navigates the same webview to the real
  dashboard. Keeping one live webview at the loopback origin means SSE/WebSocket
  stay open and presence-aware features (wake word, FPS) behave like an open tab.
- **Startup race:** if the service is not up yet, the splash retries (it does not
  error out). Once the dashboard is loaded, its own offline handling takes over.
- **Single instance:** a second launch re-focuses the existing kiosk window.

Phase 5 adds Xeneon-Edge monitor targeting + a reposition watchdog; Phase 6 adds
optional swipe-to-page gestures; Phase 7 adds the tray icon, autostart and the
NSIS installer.

## Develop

Requires the Rust toolchain (`rustup`, stable), the WebView2 runtime (already on
Windows 11), and the backend running (`npm start` from the repo root, or the
installed service).

```bash
npm run native:dev     # from repo root  → tauri dev
npm run native:build   # from repo root  → tauri build (NSIS installer)
```

## TODO before first build

`tauri build` needs an icon set in `src-tauri/icons/`. Generate it once from a
1024×1024 source (Phase 7 wires this into the release):

```bash
npm run tauri --workspace @xenon/native -- icon path/to/xenon-1024.png
```

`Cargo.lock` is created on the first build and should be committed.
