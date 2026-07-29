use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
mod cursor_guard;
#[cfg(windows)]
mod edge_swipe;
#[cfg(windows)]
mod focus_guard;
#[cfg(windows)]
mod gpu;
mod monitor;
mod prefs;
mod spotlight_window;
mod tray;

/// WebView2 browser arguments shared by EVERY webview in this process.
///
/// WebView2 requires all webviews on the same user-data folder to be created
/// with IDENTICAL environment options: a second webview created with different
/// `additional_browser_args` fails its (asynchronous) creation SILENTLY — the
/// OS window appears, the web content never does. That was exactly the blank
/// Spotlight bar. Any new `WebviewWindowBuilder` in this app MUST pass
/// `.additional_browser_args(&browser_args(...))` with the same flag set.
///
/// The switches: wry's default `--disable-features` set (replaced wholesale by
/// this override, so it is re-included), the three anti-throttling switches
/// that keep the unfocused kiosk renderer alive, and the hybrid-GPU pin from
/// `gpu::webview_gpu_flag()`.
#[cfg(windows)]
pub(crate) fn browser_args(gpu_flag: Option<&str>) -> String {
    let mut args = String::from(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows",
    );
    if let Some(flag) = gpu_flag {
        args.push(' ');
        args.push_str(flag);
    }
    args
}

/// Injected into every page the kiosk webview loads (the splash and, after it
/// hands over, the loopback dashboard). In a Tauri webview a `target="_blank"`
/// link — and `window.open()` — spawns a new *webview* window instead of the OS
/// browser, and both bypass the Rust `on_navigation` hook below. This funnels
/// those external opens into a top-level navigation so the hook can catch the
/// URL and redirect it to the default browser, keeping the kiosk on the
/// dashboard. Internal/loopback and relative links are left untouched.
const EXTERNAL_LINK_SHIM: &str = r#"
(function () {
  // Let the shared dashboard know it is running inside the native shell (used to
  // offer app updates here, and to hide the "install the native app" promo that
  // the browser/iCUE surfaces show).
  try { window.__XENON_NATIVE__ = true; } catch (e) {}
  // What this shell build understands, so the dashboard never sends a signal an
  // older shell would misread (an unknown xenon-home path used to mean "go home",
  // which collapsed the kiosk to the desktop strip on load). Runtime-only caps
  // (shellVersion, updateEvents, lowPowerGpu) are merged in by the second init
  // script built in setup() — keep this literal so old-shell semantics stay
  // greppable.
  try { window.__XENON_NATIVE_CAPS__ = { homeGestureToggle: true, rdpToggle: true }; } catch (e) {}
  function isExternal(u) {
    try {
      var url = new URL(u, location.href);
      if (url.protocol === 'mailto:' || url.protocol === 'tel:') return true;
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      var h = url.hostname;
      // tauri.localhost is the app's own origin on Windows (bundled assets).
      return h !== '127.0.0.1' && h !== 'localhost' && h !== '::1' && h !== '[::1]' && h !== 'tauri.localhost';
    } catch (e) { return false; }
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var t = (a.target || '').toLowerCase();
    if ((t === '_blank' || t === '_new') && isExternal(a.href)) {
      e.preventDefault();
      e.stopPropagation();
      window.location.href = a.href;
    }
  }, true);
  var nativeOpen = window.open;
  window.open = function (u) {
    if (isExternal(u)) { window.location.href = u; return null; }
    return nativeOpen.apply(window, arguments);
  };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'F11') {
      e.preventDefault();
      window.location.href = 'xenon-fullscreen:toggle';
    }
  });
})();
"#;

/// Guards the one-shot update check so it fires once per launch, when the
/// loopback dashboard first loads (not on the splash).
#[cfg(desktop)]
static UPDATE_CHECK_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Build the tiny JS that asks the dashboard to show its localized "update
/// available — tap to install" toast. Retries briefly in case the dashboard's
/// scripts have not finished loading yet. The version is JSON-encoded so it is
/// always a safe string literal.
#[cfg(desktop)]
fn update_prompt_js(version: &str) -> String {
    let v = serde_json::to_string(version).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(function(v){{var n=0;function go(){{if(window.XenonNative&&window.XenonNative.showUpdatePrompt){{try{{window.XenonNative.showUpdatePrompt(v);}}catch(e){{}}}}else if(n++<50){{setTimeout(go,200);}}}}go();}})({v});"
    )
}

/// Check GitHub for a newer signed release; if one exists, surface the in-dashboard
/// prompt. Never installs on its own — the user taps to update (see the
/// `xenon-update:` navigation below).
#[cfg(desktop)]
fn spawn_update_check(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(u) => u,
            Err(_) => return,
        };
        if let Ok(Some(update)) = updater.check().await {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval(update_prompt_js(&update.version));
            }
        }
    });
}

/// Build the tiny JS that reports a shell-update event into the dashboard
/// (XenonNative.onShellUpdateEvent — progress overlay or error toast). Retries
/// briefly in case the dashboard's scripts have not finished loading. The event
/// is serde-encoded, so it is always a safe JS literal.
#[cfg(desktop)]
fn update_report_js(event: &serde_json::Value) -> String {
    format!(
        "(function(e){{var n=0;function go(){{if(window.XenonNative&&window.XenonNative.onShellUpdateEvent){{try{{window.XenonNative.onShellUpdateEvent(e);}}catch(err){{}}}}else if(n++<50){{setTimeout(go,200);}}}}go();}})({event});"
    )
}

/// Eval a shell-update event into the dashboard, best effort (no window → drop).
#[cfg(desktop)]
fn report_update_event(app: &tauri::AppHandle, event: serde_json::Value) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval(update_report_js(&event));
    }
}

/// Build the JS that hands the dashboard the current monitor list and placement.
///
/// Deliberately NOT the retry loop the update helpers use: that carries an
/// EVENT, which must arrive, while this carries STATE, and re-firing a snapshot
/// that a later push has already superseded would be wrong. The assignment works
/// whether or not the page's scripts have run yet, and the callback is a
/// best-effort nudge for a page that is already listening.
///
/// This is also why the shell needs no Tauri command for the screen picker. A
/// `#[tauri::command]` would mean granting IPC to the `127.0.0.1:3030` origin —
/// the same document that hosts sandboxed third-party widgets and that is served
/// to paired phones — and `capabilities/default.json` says in as many words that
/// the dashboard needs no IPC. One-way state in, one-way intent out.
pub(crate) fn display_state_js(state: &serde_json::Value) -> String {
    format!(
        "(function(s){{try{{window.__XENON_NATIVE_CAPS__=Object.assign(window.__XENON_NATIVE_CAPS__||{{}},s);}}catch(e){{}}\
         try{{if(window.XenonNative&&window.XenonNative.onDisplaysChanged)window.XenonNative.onDisplaysChanged(s);}}catch(e){{}}}})({state});"
    )
}

/// Register or remove the kiosk's own login entry to match the user's choice.
///
/// Called at startup and again whenever the placement changes, because the choice
/// is only honoured if the autostart entry follows it. Note this touches ONLY the
/// app's entry (`Xenon`); the backend has its own login mechanism on every
/// platform — the "Xenon Edge Widget" scheduled task, the
/// `com.marcimastro98.xenon.backend` LaunchAgent, `xenon-backend.service` — and
/// none of them is affected. In phone mode the backend keeps starting, hidden,
/// which is the whole point.
#[cfg(desktop)]
pub(crate) fn sync_autostart(app: &tauri::AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    // macOS is the exception and not a compromise: there the login item starts
    // the APP, and the app is what spawns the backend so it inherits Full Disk
    // Access (see spawn_backend_nudge). Not launching it would either leave the
    // backend down or hand it a far smaller view of the disk.
    let want = prefs::load(app).shows_on_this_pc() || cfg!(target_os = "macos");
    let manager = app.autolaunch();
    if want {
        // Idempotent, and it REWRITES the entry — which is what migrates an
        // existing registration onto the new `--autostart` argument.
        let _ = manager.enable();
    } else if manager.is_enabled().unwrap_or(false) {
        // Gated on is_enabled: the underlying crate's Windows `disable()` deletes
        // a registry value and returns an error when it is already absent.
        let _ = manager.disable();
    }
}

#[cfg(not(desktop))]
pub(crate) fn sync_autostart(_app: &tauri::AppHandle) {}

/// Handle one `xenon-display:` signal. Runs on a spawned thread — never on the
/// WebView UI thread the navigation hook is called from.
fn apply_display_signal(app: &tauri::AppHandle, path: &str, query: Option<&str>) {
    // Tiny query reader: the dashboard sends at most two params and encodes the
    // monitor id with encodeURIComponent.
    let param = |key: &str| -> Option<String> {
        let q = query?;
        q.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            if k != key {
                return None;
            }
            Some(percent_decode(v))
        })
    };
    match path {
        "auto" => monitor::set_placement(app, prefs::Placement::Auto),
        "phone" => monitor::set_placement(app, prefs::Placement::Phone),
        "screen" => {
            // Bounded before the lookup so a hostile page cannot make us allocate
            // on an id that was never going to resolve.
            let Some(id) = param("id").filter(|s| !s.is_empty() && s.len() <= 256) else { return };
            if let Some(on) = param("fullscreen") {
                let want = on == "1";
                let mut snapshot = prefs::DisplayPrefs::default();
                prefs::update(app, |p| {
                    p.fullscreen = want;
                    snapshot = p.clone();
                });
                monitor::set_placement_cache(&snapshot);
            }
            // Validation lives here: an id that does not resolve against the live
            // monitor list is never written. It reconciles autostart itself, so
            // every caller — this one and the tray — gets it.
            monitor::move_to_named_monitor(app, &id);
        }
        "fullscreen" => {
            let Some(on) = param("on") else { return };
            monitor::set_fullscreen_pref(app, on == "1");
        }
        _ => {}
    }
}

/// Percent-decode a query value. `tauri::Url` hands us the raw query, and the
/// monitor ids we round-trip are Windows device names full of backslashes.
fn percent_decode(raw: &str) -> String {
    let bytes = raw.replace('+', " ").into_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// First ~200 chars of an updater error, safe to embed via serde. Full errors
/// can carry URLs/paths the toast has no room for.
#[cfg(desktop)]
fn short_err(e: &dyn std::fmt::Display) -> String {
    e.to_string().chars().take(200).collect()
}

/// Download and install the pending update, then relaunch. Triggered by the user
/// tapping the update toast (which navigates to `xenon-update:install`).
///
/// EVERY exit path reports an event into the dashboard — a failed check,
/// download or install used to die in silence here, which read as "Updating
/// Xenon… and nothing happens" (the bug real users hit). Progress is throttled
/// to ~5% steps so the eval channel never floods the webview.
#[cfg(desktop)]
fn spawn_update_install(app: tauri::AppHandle) {
    use serde_json::json;
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        report_update_event(&app, json!({ "phase": "checking" }));
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                report_update_event(
                    &app,
                    json!({ "phase": "error", "code": "check_failed", "message": short_err(&e) }),
                );
                return;
            }
        };
        let update = match updater.check().await {
            Ok(Some(u)) => u,
            Ok(None) => {
                report_update_event(&app, json!({ "phase": "uptodate" }));
                return;
            }
            Err(e) => {
                report_update_event(
                    &app,
                    json!({ "phase": "error", "code": "check_failed", "message": short_err(&e) }),
                );
                return;
            }
        };
        let progress_app = app.clone();
        let done_app = app.clone();
        let mut received: u64 = 0;
        let mut last_pct: u64 = u64::MAX; // sentinel → the first chunk always reports
        let mut last_bytes_report: u64 = 0;
        let result = update
            .download_and_install(
                move |chunk, total| {
                    received += chunk as u64;
                    let Some(t) = total.filter(|t| *t > 0) else {
                        // No usable content length (chunked CDN response): still
                        // emit byte-count heartbeats — the dashboard's watchdog
                        // treats silence as a wedged updater. First chunk, then
                        // every ~2 MB.
                        if last_bytes_report == 0 || received - last_bytes_report >= 2_000_000 {
                            last_bytes_report = received;
                            report_update_event(
                                &progress_app,
                                json!({ "phase": "downloading", "received": received }),
                            );
                        }
                        return;
                    };
                    let pct = received * 100 / t;
                    if last_pct != u64::MAX && pct < last_pct.saturating_add(5) && pct < 100 {
                        return;
                    }
                    last_pct = pct;
                    report_update_event(
                        &progress_app,
                        json!({ "phase": "downloading", "received": received, "total": t }),
                    );
                },
                move || {
                    report_update_event(&done_app, json!({ "phase": "installing" }));
                },
            )
            .await;
        match result {
            Ok(()) => {
                report_update_event(&app, json!({ "phase": "restarting" }));
                // restart() execs: the run loop's Exit arm may never run, so the
                // backend we own is stopped here rather than orphaned.
                stop_owned_backend();
                app.restart();
            }
            Err(e) => {
                report_update_event(
                    &app,
                    json!({ "phase": "error", "code": "install_failed", "message": short_err(&e) }),
                );
            }
        }
    });
}

/// Legacy rescue: un-strand existing installs whose DASHBOARD predates the
/// orchestrated update flow. Their old update.js never updates the Node backend
/// on native (it only ever triggered the shell updater), so after this shell
/// self-updates, the backend would stay old forever. This self-contained script
/// no-ops on new dashboards (they expose XenonUpdate.nativeOrchestrate and own
/// the flow); on old ones, when the backend version is older than this shell,
/// it offers a persistent toast that drives the backend's own signed
/// prepare/apply endpoints and reloads when the new version serves. English
/// only by design — it exists precisely because the old dashboard's i18n has no
/// keys for it, and it turns into dead code once the user base is current.
#[cfg(desktop)]
fn legacy_rescue_js(shell_version: &str) -> String {
    let v = serde_json::to_string(shell_version).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(function (shellVer) {{
  try {{
    if (window.XenonUpdate && typeof window.XenonUpdate.nativeOrchestrate === 'function') return;
    if (window.__xenonLegacyRescue) return;
    window.__xenonLegacyRescue = true;
  }} catch (e) {{ return; }}
  function newer(a, b) {{
    a = String(a || '').replace(/^v/i, '').split('.');
    b = String(b || '').replace(/^v/i, '').split('.');
    for (var i = 0; i < 3; i++) {{
      var x = parseInt(a[i], 10) || 0, y = parseInt(b[i], 10) || 0;
      if (x !== y) return x > y;
    }}
    return false;
  }}
  function toast(opts) {{
    try {{
      if (window.XenonToast && typeof window.XenonToast.show === 'function') window.XenonToast.show(opts);
    }} catch (e) {{}}
  }}
  fetch('/version').then(function (r) {{ return r.json(); }}).then(function (j) {{
    if (!j || !j.version || !newer(shellVer, j.version)) return;
    fetch('/update/self-status').then(function (r) {{ return r.json(); }}).then(function (st) {{
      if (!st || !st.supported) return;
      toast({{
        type: 'info', duration: 0,
        title: 'Dashboard update available',
        message: 'Tap to install the latest dashboard (v' + String(shellVer).replace(/^v/i, '') + ').',
        onClick: function () {{
          toast({{ type: 'info', title: 'Updating the dashboard…', message: 'The page reloads by itself when it is done.' }});
          fetch('/update/prepare', {{ method: 'POST' }}).then(function (r) {{ return r.json(); }}).then(function (res) {{
            if (!res || !res.ok) {{
              toast({{ type: 'error', title: 'Update failed', message: 'Could not prepare the update' + (res && res.error ? ' (' + res.error + ')' : '') + '.' }});
              return;
            }}
            fetch('/update/apply', {{ method: 'POST' }}).catch(function () {{}});
            var tries = 0;
            var poll = setInterval(function () {{
              if (++tries > 144) {{
                clearInterval(poll);
                // The applier rolled back or stalled (this old backend writes no
                // result file to consult) — say so instead of dying silently.
                toast({{ type: 'error', title: 'Update failed', message: 'The dashboard update did not complete and the previous version is still running. Restart the app to try again.' }});
                return;
              }}
              fetch('/version', {{ cache: 'no-store' }}).then(function (r) {{ return r.json(); }}).then(function (v) {{
                if (v && v.version && !newer(shellVer, v.version)) {{ clearInterval(poll); location.reload(); }}
              }}).catch(function () {{}});
            }}, 2500);
          }}).catch(function () {{
            toast({{ type: 'error', title: 'Update failed', message: 'Could not reach the dashboard backend.' }});
          }});
        }}
      }});
    }}).catch(function () {{}});
  }}).catch(function () {{}});
}})({v});"#
    )
}

/// Guards the one-shot legacy-rescue injection so it fires once per launch.
#[cfg(desktop)]
static LEGACY_RESCUE_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Self-heal for a missing backend: the kiosk is only a shell for the local
/// dashboard, so if nothing answers on 127.0.0.1:3030 shortly after launch the
/// splash would spin forever (reported in the wild as "stuck on waiting for the
/// Xenon service"). Nudge the widget's per-logon scheduled task ("Xenon Edge
/// Widget", registered by the widget installer) once, best-effort — it covers a
/// backend that crashed or whose logon start never fired. The probe MUST come
/// first: the task's start-hidden.vbs kills whatever listens on 3030 before
/// starting node, so nudging while a healthy server runs would restart it.
/// If the task does not exist (widget never installed) this is a no-op and the
/// splash's own hint tells the user what to install.
#[cfg(windows)]
fn spawn_backend_nudge(_app: &tauri::AppHandle, port: u16) {
    std::thread::spawn(move || {
        if backend_answers(port) {
            return; // backend is up — nothing to heal
        }
        if port == 3030 {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = std::process::Command::new("schtasks")
                .args(["/Run", "/TN", "Xenon Edge Widget"])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
    });
}

/// Absolute path of the bundled backend bootstrap, when this build actually
/// carries it (`bundle.resources` in tauri.conf.json). `None` doubles as
/// "don't offer setup here".
///
/// Debug builds are excluded deliberately, and the exclusion is NOT redundant:
/// `tauri-build` stages resources next to the debug exe too, so the file really
/// is resolvable under `tauri dev` — and running it there would perform a full
/// production install into `%LOCALAPPDATA%\Programs\Xenon` on the developer's
/// own machine. The bootstrap is a release-install path only.
#[cfg(windows)]
fn bootstrap_script(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }
    let path = app
        .path()
        .resolve(
            "windows/xenon-bootstrap.ps1",
            tauri::path::BaseDirectory::Resource,
        )
        .ok()?;
    path.is_file().then_some(path)
}

/// The bootstrap console this app started, kept so a second press of the splash
/// button can tell "still installing" from "that window is gone".
///
/// A plain once-per-launch latch would be wrong: the script exits within
/// seconds whenever it decides there is nothing to do, and the splash offers
/// the button again when the backend still hasn't appeared — with a latch, that
/// retry would be a silent no-op forever.
#[cfg(windows)]
static BOOTSTRAP_CHILD: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);

/// Runs the bundled backend bootstrap on an explicit user click (the splash's
/// "Complete setup" button, routed through `xenon-setup:run`).
///
/// This used to be an NSIS post-install hook: the moment the setup finished it
/// fired `powershell.exe -ExecutionPolicy Bypass -File …` **detached and
/// windowless**, which then downloaded a zip and executed it. Functionally
/// fine, but that is precisely the shape of a trojan dropper — unsigned
/// installer → silent LOLBin → download → execute, on top of a Run key and a
/// scheduled task — and with nothing Authenticode-signed to offset it,
/// Defender's cloud model scored the whole install as
/// `Trojan:Win32/Sonbokli.A!cl`: quarantined exe, blocked download.
///
/// Same outcome, different shape. Nothing runs unattended, the process is
/// started by a click, and the console is VISIBLE — the user is watching the
/// install they just asked for. Re-running it is harmless either way: the
/// script re-checks the scheduled task and port 3030 and exits if a backend is
/// already there.
///
/// `-ExecutionPolicy Bypass` survives only because the bundled `.ps1` is
/// unsigned. Sign the script and drop the flag once the code-signing
/// certificate lands (see the release checklist in DEVELOPER.md).
#[cfg(windows)]
fn run_backend_bootstrap(app: &tauri::AppHandle) {
    let Some(script) = bootstrap_script(app) else {
        return;
    };
    // Off the WebView UI thread: process creation blocks, and this is called
    // from the navigation hook, which runs on it.
    std::thread::spawn(move || {
        use std::os::windows::process::CommandExt;
        let Ok(mut slot) = BOOTSTRAP_CHILD.lock() else {
            return;
        };
        // A console we started is still open: the user is watching that install
        // right now, and a second one racing it over the same install root is
        // the one thing this must never do. try_wait reaps an exited one, so a
        // closed window frees the slot for a genuine retry.
        if let Some(child) = slot.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return;
            }
        }
        // Give the console app a console of its own — this GUI process has
        // none, and the visible window IS the install progress UI.
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        // PowerShell by its FULL system path: an unqualified exe name resolves
        // from the process's own directory first (binary planting, CWE-427).
        let system_root =
            std::env::var("SystemRoot").unwrap_or_else(|_| String::from("C:\\Windows"));
        let powershell = std::path::Path::new(&system_root)
            .join("System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        // A failed spawn leaves the slot empty on purpose — the splash hands the
        // button back after a while, and that retry has to be able to work.
        *slot = std::process::Command::new(powershell)
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .ok();
    });
}

/// macOS twin of the Windows nudge above. The two signals differ from Windows
/// because
/// the install shapes do: the per-user LaunchAgent registered by
/// `server/install.sh` is the "backend installed" marker (the analogue of the
/// "Xenon Edge Widget" scheduled task), and a `.dmg` has no install hook at all
/// — so a first launch that finds NO agent is also the only moment this app can
/// offer to set the backend up. That is what the bundled bootstrap does, in a
/// visible Terminal window the user can read and interrupt; it is idempotent and
/// exits within a second or two when anything is already installed.
/// The backend process this app owns on macOS, so it can be stopped on exit
/// instead of being orphaned (the process invariant: nothing we spawn outlives
/// us silently).
#[cfg(target_os = "macos")]
static BACKEND_CHILD: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);

/// No-op twin so every caller can say "stop what we own" without a `cfg`. Only
/// macOS ever owns the backend process.
#[cfg(not(target_os = "macos"))]
pub fn stop_owned_backend() {}

/// Stop the backend this app started.
///
/// Called from the run loop's Exit event AND before every `restart()`. The
/// second is not belt-and-braces: `AppHandle::restart()` skips the run loop's
/// events entirely when it is called on the main thread (which the tray item and
/// the dashboard's `xenon-app:restart` both are), so the Exit arm never fires and
/// the `node` child was exec'd away from — reparented to launchd, still holding
/// port 3030. The relaunched app then found a backend answering, left
/// BACKEND_CHILD empty, and quitting later left that server running forever.
/// Idempotent: the child is taken out of the mutex, so a later Exit finds None.
#[cfg(target_os = "macos")]
pub fn stop_owned_backend() {
    let Ok(mut guard) = BACKEND_CHILD.lock() else { return };
    let Some(mut child) = guard.take() else { return };
    // SIGTERM, not kill: server.js's _gracefulShutdown stops the helper hosts,
    // the index and any running cleanup, and exits 0. Killing it outright would
    // orphan every one of those children.
    let _ = std::process::Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status();
    let _ = child.wait();
}

/// Where the backend lives.
///
/// `install.sh` writes `~/Library/Application Support/Xenon/backend.json` for
/// exactly this question, because the agent it registers now launches THIS APP
/// rather than node — so the plist no longer names server.js and there is
/// nothing else to ask. The plist is still read as a fallback: an install made
/// before that change has no pointer file, and it should keep working rather
/// than silently start nothing.
#[cfg(target_os = "macos")]
fn backend_entry(home: &std::path::Path) -> Option<std::path::PathBuf> {
    let pointer = home.join("Library/Application Support/Xenon/backend.json");
    if let Ok(text) = std::fs::read_to_string(&pointer) {
        // One key, written by us. A hand-rolled read keeps this off serde for a
        // file that will never grow a second shape.
        if let Some(rest) = text.split("\"entry\"").nth(1) {
            if let Some(open) = rest.find('"') {
                if let Some(close) = rest[open + 1..].find('"') {
                    let value = &rest[open + 1..open + 1 + close];
                    let path = std::path::PathBuf::from(value);
                    if path.exists() {
                        return Some(path);
                    }
                }
            }
        }
    }
    // Legacy: the agent that ran node named server.js as its second argument.
    let plist = home.join("Library/LaunchAgents/com.marcimastro98.xenon.backend.plist");
    let text = std::fs::read_to_string(plist).ok()?;
    for chunk in text.split("<string>").skip(1) {
        let value = chunk.split("</string>").next()?.trim();
        if value.ends_with("server.js") {
            let path = std::path::PathBuf::from(value);
            if path.exists() {
                return Some(path);
            }
        }
    }
    None
}

/// The node the installer found. `install.sh` requires it on PATH, but a GUI app
/// does not inherit the shell's PATH, so the usual locations are tried first.
#[cfg(target_os = "macos")]
fn find_node() -> Option<std::path::PathBuf> {
    for candidate in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ] {
        let path = std::path::PathBuf::from(candidate);
        if path.exists() {
            return Some(path);
        }
    }
    let out = std::process::Command::new("/usr/bin/which")
        .arg("node")
        .output()
        .ok()?;
    let found = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!found.is_empty()).then(|| std::path::PathBuf::from(found))
}

#[cfg(target_os = "macos")]
fn spawn_backend_nudge(app: &tauri::AppHandle, port: u16) {
    use tauri::path::BaseDirectory;
    use tauri::Manager;
    let script = app
        .path()
        .resolve("posix/xenon-bootstrap.sh", BaseDirectory::Resource)
        .ok();
    let home = app.path().home_dir().ok();
    std::thread::spawn(move || {
        if backend_answers(port) {
            return;
        }
        if port != 3030 {
            return;
        }
        // THE BACKEND IS OUR CHILD ON THIS PLATFORM, and that is a privacy
        // decision, not a lifecycle preference. macOS attributes a process's
        // file-access permissions to the RESPONSIBLE process — for a child, its
        // parent. Launched by launchd the backend is responsible for itself, so
        // Full Disk Access would have to be granted to the `node` binary: an
        // interpreter, which would then carry that grant into every unrelated
        // script the user ever runs. Launched by this app it inherits Xenon's
        // own grant, which the user can see, understand and revoke.
        //
        // The measurable difference on a real machine: the launchd-run backend
        // indexed 253,519 files / 90.5 GB of the same home directory that a
        // grant-carrying process saw as 403,404 files / 103.4 GB. The Trash and
        // most of ~/Library/Caches were simply invisible, so the cleanup
        // categories were empty and the disk map under-reported by 13 GB.
        if let Some(entry) = home.as_deref().and_then(backend_entry) {
            // An older install may still have an agent that runs node itself.
            // Retire it before starting our own copy: two backends would fight
            // for the port and the winner would be whichever raced faster.
            if let Some(uid) = current_uid() {
                let _ = std::process::Command::new("launchctl")
                    .args([
                        "bootout",
                        &format!("gui/{uid}/com.marcimastro98.xenon.backend"),
                    ])
                    .status();
            }
            if let Some(node) = find_node() {
                let root = entry.parent().and_then(|p| p.parent());
                let mut cmd = std::process::Command::new(node);
                cmd.arg(&entry);
                if let Some(root) = root {
                    cmd.current_dir(root);
                }
                if let Ok(child) = cmd.spawn() {
                    if let Ok(mut guard) = BACKEND_CHILD.lock() {
                        *guard = Some(child);
                    }
                }
            }
            return;
        }
        // Nothing installed here at all. Open the bootstrap in Terminal so the
        // install has a UI and an exit.
        let Some(script) = script else { return };
        if !script.exists() {
            return;
        }
        // Tauri copies resources without the executable bit, and `open -a
        // Terminal` on a non-executable file opens it in an editor instead of
        // running it.
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
        let _ = std::process::Command::new("open")
            .args(["-a", "Terminal"])
            .arg(&script)
            .status();
    });
}

/// Linux twin. Same two signals, written by `server/install.sh`: the
/// `systemd --user` unit, or the XDG autostart entry it falls back to where
/// there is no user manager.
///
/// Neither package can install the backend for us. An AppImage has no install
/// hook at all, and a .deb's post-install script runs as ROOT — while the login
/// service, the install root and the data directory all belong to ONE user's
/// session (the same rule that keeps the Windows backend out of a session-0
/// service). First launch is the only moment that knows whose Xenon this is.
#[cfg(target_os = "linux")]
fn spawn_backend_nudge(app: &tauri::AppHandle, port: u16) {
    use tauri::path::BaseDirectory;
    use tauri::Manager;
    let script = app
        .path()
        .resolve("posix/xenon-bootstrap.sh", BaseDirectory::Resource)
        .ok();
    let config = app.path().config_dir().ok();
    std::thread::spawn(move || {
        if backend_answers(port) {
            return;
        }
        if port != 3030 {
            return;
        }
        let unit = config
            .as_ref()
            .map(|c| c.join("systemd/user/xenon-backend.service"));
        let autostart = config
            .as_ref()
            .map(|c| c.join("autostart/xenon-backend.desktop"));
        // The unit exists but nothing answers: it crashed, or its login start
        // never fired. `--user restart` is the only correct verb here; a system
        // `systemctl` would address a unit that does not exist.
        if unit.map(|p| p.exists()).unwrap_or(false) {
            let _ = std::process::Command::new("systemctl")
                .args(["--user", "restart", "xenon-backend.service"])
                .status();
            return;
        }
        // Installed, but through the autostart fallback: there is no manager to
        // ask, and that entry only fires at login. Starting a second copy from
        // here would just fight for the port, so this waits for the next login
        // exactly as install.sh said it would.
        if autostart.map(|p| p.exists()).unwrap_or(false) {
            return;
        }
        // Nothing installed → offer to set the backend up, in a terminal the
        // user can read and interrupt.
        let Some(script) = script else { return };
        if !script.exists() {
            return;
        }
        let _ = run_in_terminal(&script);
    });
}

/// Open `script` in whatever terminal emulator this desktop has, running it
/// through `bash` so neither the executable bit (Tauri copies resources without
/// it) nor the shebang has to be right.
///
/// The list is ordered by how likely the emulator is to be the session's own,
/// and every entry takes the command as SEPARATE argv elements — never a single
/// string to be re-parsed, which would break the moment a home directory has a
/// space in it. Returning false is a real outcome: a desktop with no terminal at
/// all cannot be shown an installer, and the README's manual command is then the
/// only honest answer.
#[cfg(target_os = "linux")]
fn run_in_terminal(script: &std::path::Path) -> bool {
    const TERMINALS: &[(&str, &[&str])] = &[
        ("x-terminal-emulator", &["-e"]), // Debian/Ubuntu alternatives symlink
        ("gnome-terminal", &["--"]),
        ("konsole", &["-e"]),
        ("xfce4-terminal", &["-x"]),
        ("mate-terminal", &["--"]),
        ("tilix", &["-e"]),
        ("alacritty", &["-e"]),
        ("kitty", &[]),
        ("foot", &[]),
        ("wezterm", &["start", "--"]),
        ("xterm", &["-e"]),
    ];
    for (bin, prefix) in TERMINALS {
        let Some(exe) = find_in_path(bin) else { continue };
        let ok = std::process::Command::new(exe)
            .args(*prefix)
            .arg("bash")
            .arg(script)
            .spawn()
            .is_ok();
        if ok {
            return true;
        }
    }
    false
}

/// Locate a binary on PATH. A dependency-free stand-in for `which`.
#[cfg(target_os = "linux")]
fn find_in_path(bin: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|p| p.is_file())
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn spawn_backend_nudge(_app: &tauri::AppHandle, _port: u16) {}

/// True once the local backend accepts a connection. Polls for ~8–16s so a
/// normally-starting backend is never interfered with.
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn backend_answers(port: u16) -> bool {
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    for _ in 0..4 {
        if TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    false
}

/// The current user id, via `id -u` — launchctl addresses its domains by uid and
/// there is no std API for it (and no libc dependency in this crate).
#[cfg(target_os = "macos")]
fn current_uid() -> Option<String> {
    let out = std::process::Command::new("id").arg("-u").output().ok()?;
    let uid = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if uid.is_empty() || !uid.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(uid)
}

/// Entry point shared by the desktop `main.rs` (and a future mobile target).
///
/// The window itself — borderless, full-screen kiosk pointed at the bundled
/// splash — is built in `setup()` (so it can carry the navigation hook and link
/// shim above). The splash waits for the local backend service and then
/// navigates the same webview to
/// `http://127.0.0.1:3030/`, so the native window renders the exact same
/// dashboard as the browser and the iCUE iframe (single source of UI). Keeping
/// one live webview also means the SSE/WebSocket streams stay open, so the
/// presence-aware features (wake word, FPS) behave just like an open browser tab.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        // Only one kiosk instance may own the Edge. A second launch re-focuses
        // the existing window instead of opening a duplicate.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // Open external links (Support, Community Discord, Report a bug, …) in
        // the user's default browser instead of trapping them in the kiosk.
        .plugin(tauri_plugin_opener::init());

    // Autostart at login + self-update (desktop only).
    #[cfg(desktop)]
    {
        builder = builder
            // The argument is what lets the app tell a login launch from the
            // user double-clicking Xenon. In phone mode the first must stay
            // invisible and the second must not.
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--autostart"]),
            ))
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        // When the loopback dashboard first loads (not the splash), check once
        // for a newer signed release and, if any, surface the update toast.
        .on_page_load(|_webview, _payload| {
            #[cfg(desktop)]
            {
                use std::sync::atomic::Ordering;
                let is_dashboard = matches!(
                    _payload.url().host_str(),
                    Some("127.0.0.1") | Some("localhost")
                );
                if is_dashboard && !UPDATE_CHECK_STARTED.swap(true, Ordering::SeqCst) {
                    spawn_update_check(_webview.app_handle().clone());
                }
                // First accurate display state: the init-script snapshot is built
                // before the window exists, so it carries no `active` screen.
                if is_dashboard {
                    monitor::push_display_state(_webview.app_handle());
                }
                // Old dashboards can't update their own backend — offer it from
                // here (no-op on new dashboards; see legacy_rescue_js). Delayed
                // so the dashboard's scripts (XenonToast, t()) have settled.
                if is_dashboard && !LEGACY_RESCUE_STARTED.swap(true, Ordering::SeqCst) {
                    let app = _webview.app_handle().clone();
                    let ver = app.package_info().version.to_string();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(8));
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.eval(legacy_rescue_js(&ver));
                        }
                    });
                }
            }
        })
        .setup(|app| {
            let port = std::env::var("XENON_PORT")
                .ok()
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(3030);
            // Build the kiosk window in Rust (rather than declaratively in
            // tauri.conf.json) so it can carry an initialization script and a
            // navigation hook: external links open in the OS browser while the
            // webview itself never leaves the splash/dashboard. Props mirror the
            // former config window (borderless, full-screen, 2560×720 Edge size).
            let nav_handle = app.handle().clone();
            // Computed once, up front, so both the WebView2 launch flag below
            // (`additional_browser_args`) and the JS-facing cap just below it
            // read the SAME decision instead of enumerating displays twice.
            #[cfg(windows)]
            let gpu_flag = gpu::webview_gpu_flag();
            #[cfg(not(windows))]
            let gpu_flag: Option<&'static str> = None;
            // Runtime-only capabilities merged over the shim's literal caps: the
            // dashboard's update orchestrator needs the shell's own version (to
            // know whether the exe is outdated too) and whether this shell
            // reports update progress/errors (updateEvents). `lowPowerGpu` tells
            // the dashboard it is rendering on the weaker of two GPUs on purpose
            // (see gpu.rs) — backgroundfx.css uses it to pause the purely
            // decorative aurora/grid layers, which on this machine's iGPU can
            // combine with a busy animated theme background to drop the kiosk's
            // real presented frame rate into single digits (measured via
            // PresentMon — see the "native-app-hybrid-gpu-idle-burn" note).
            // serde-encoding keeps the injection a safe JS literal.
            // The saved screen choice, read once here: it decides the initial
            // window visibility AND seeds the watchdog's in-memory mirror, both
            // of which happen before the backend is necessarily up.
            let display_prefs = prefs::load(app.handle());
            monitor::set_placement_cache(&display_prefs);
            // `--autostart` is appended to the login entry (see the plugin init
            // above), so its presence tells a login launch from a deliberate one.
            // A user who double-clicks Xenon must always SEE it, even in phone
            // mode: an app that opens and shows nothing reads as broken.
            let autostarted = std::env::args().any(|a| a == "--autostart");
            let start_hidden = !display_prefs.shows_on_this_pc() && autostarted;
            // A deliberate launch in phone mode must SHOW the window: nothing is
            // written, so the next login is hidden again as chosen. Without this
            // the window is built visible and then hidden a moment later by
            // `place_now`, which is the same "opens and shows nothing" it is
            // meant to avoid.
            if !display_prefs.shows_on_this_pc() && !autostarted {
                monitor::allow_show_this_session();
            }
            // `displayPicker` is the hard gate for the dashboard: `xenon-display:`
            // is a NEW scheme, and on an older shell an unknown scheme falls
            // through to the OS opener, which on Windows raises a "how do you
            // want to open this?" dialog on the kiosk. The page must check this
            // before ever assigning such a URL — exactly as it already does for
            // homeGestureToggle and rdpToggle.
            //
            // `displays` is a snapshot: the window does not exist yet at this
            // point, so `display.active` is deliberately absent here and arrives
            // with the first push (on page load, on placement, on replug).
            let caps_js = format!(
                "try{{window.__XENON_NATIVE_CAPS__=Object.assign(window.__XENON_NATIVE_CAPS__||{{}},{});}}catch(e){{}}",
                serde_json::json!({
                    "shellVersion": app.package_info().version.to_string(),
                    "updateEvents": true,
                    "lowPowerGpu": matches!(gpu_flag, Some("--force_low_power_gpu")),
                    "displayPicker": true,
                    "phoneMode": !display_prefs.shows_on_this_pc(),
                })
            );
            let port_js = format!("try{{window.__XENON_PORT__={};}}catch(e){{}}", port);
            // Whether the splash may offer "Complete setup" at all: release
            // Windows builds that actually carry the bootstrap, and nothing
            // else (see bootstrap_script). Without this the button would show
            // up in `tauri dev` and on any future non-Windows target.
            #[cfg(windows)]
            let setup_available = bootstrap_script(app.handle()).is_some();
            #[cfg(not(windows))]
            let setup_available = false;
            let setup_js = format!(
                "try{{window.__XENON_SETUP_AVAILABLE__={};}}catch(e){{}}",
                setup_available
            );
            let init_script = format!("{EXTERNAL_LINK_SHIM}\n{caps_js}\n{port_js}\n{setup_js}");
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Xenon")
                .inner_size(2560.0, 720.0)
                .min_inner_size(640.0, 240.0)
                .resizable(true)
                .decorations(false)
                .always_on_top(false)
                // Built invisible rather than hidden right after: a post-build
                // `hide()` is a visible flash on macOS, which is the one platform
                // where phone mode still launches the app.
                .visible(!start_hidden)
                .focused(!start_hidden)
                .center();
            // `transparent` is not on the macOS builder at all: making a window
            // transparent there needs a private API, so Tauri hides the method
            // unless the `macos-private-api` feature is enabled. Opting into a
            // private API to declare that the window is NOT transparent would be
            // absurd — and false is the default everywhere — so this states the
            // intent only on the platforms where stating it is free.
            #[cfg(not(target_os = "macos"))]
            let builder = builder.transparent(false);
            // Borderless + native fullscreen is a combination macOS does not
            // have. `toggleFullScreen:` needs NSWindowStyleMaskTitled, and on a
            // window built with `decorations(false)` the transition dereferences
            // null and kills the process — measured, not inferred: SIGSEGV in
            // -[_NSEnterFullScreenTransitionController _performEnterFullScreen]
            // on every launch, so the app never opened once on that platform.
            // The kiosk covers its display by geometry there instead (see
            // monitor::enter_borderless_fullscreen), which is also the better
            // behaviour: native fullscreen would move the window into a Space of
            // its own, away from the display it is supposed to own.
            //
            // NOTE this is invisible to `npm run check:platform-apis`: the
            // method exists on every platform and only its RUNTIME meaning
            // differs. That check answers "does this API exist here", never
            // "does this combination work here".
            #[cfg(not(target_os = "macos"))]
            let builder = builder.fullscreen(true);
            let builder = builder
                // The kiosk lives on the Edge and is controlled from the system
                // tray (show/hide/restart/exit), so keep it out of the main
                // taskbar and Alt-Tab — it runs quietly in the background.
                .skip_taskbar(true)
                .initialization_script(&init_script)
                .on_navigation(move |url| {
                    let scheme = url.scheme();
                    // The update toast taps navigate here: install the pending
                    // update and relaunch. Never a real navigation.
                    #[cfg(desktop)]
                    if scheme == "xenon-update" {
                        spawn_update_install(nav_handle.clone());
                        return false;
                    }
                    // The Settings "Restart Xenon" button navigates here (never a
                    // real page): a full, clean relaunch — clears transient/stuck
                    // state (a wedged widget, a stalled probe) WITHOUT touching the
                    // user's saved settings, layout, backgrounds or widgets, which
                    // are all persisted and re-hydrate on launch. Same call the tray
                    // "Restart" item uses.
                    #[cfg(desktop)]
                    if scheme == "xenon-app" {
                        match url.path() {
                            // stop_owned_backend() first: this hook runs ON the
                            // event-loop thread, and restart() skips RunEvent::Exit
                            // when called from there — so nothing else would stop
                            // the backend child before the process is exec'd away.
                            "restart" => {
                                stop_owned_backend();
                                nav_handle.restart()
                            }
                            // The dashboard (this webview) relays the server's
                            // global-hotkey broadcast: open the native Spotlight
                            // window on the PRIMARY monitor. Close/expand/
                            // collapse are handled by that window's own hook.
                            // MUST run on its own thread: window creation
                            // sends a message to the event loop and BLOCKS for
                            // the reply, and this hook (like run_on_main_thread
                            // — both were proven deadlocks live) runs inside
                            // that very loop, so the reply can never arrive.
                            // From a plain thread the loop is free to serve it.
                            "spotlight-open" => {
                                let h = nav_handle.clone();
                                std::thread::spawn(move || spotlight_window::open(&h));
                            }
                            _ => {}
                        }
                        return false;
                    }
                    // The splash's "Complete setup" button navigates here (never
                    // a real page) when no backend answers and this build
                    // carries the bootstrap: install the dashboard engine, in a
                    // visible console, because the user asked for it. This
                    // deliberately replaced the installer's silent post-install
                    // spawn — see run_backend_bootstrap.
                    if scheme == "xenon-setup" {
                        #[cfg(windows)]
                        if url.path() == "run" {
                            run_backend_bootstrap(&nav_handle);
                        }
                        return false;
                    }
                    // The home-bar gesture taps navigate here (never a real page):
                    //   xenon-home:go          → collapse to the desktop strip
                    //   xenon-home:return      → restore the kiosk on the Edge
                    //   xenon-home:gesture-on  → the Settings toggle: block Windows'
                    //   xenon-home:gesture-off   edge swipe (or give it back) now,
                    //                            and remember the choice for launch.
                    //   xenon-home:rdp-on      → the Settings toggle: hide the kiosk
                    //   xenon-home:rdp-off       while a Windows Remote Desktop
                    //                            session is active (or stop), and
                    //                            remember the choice for launch.
                    if scheme == "xenon-home" {
                        match url.path() {
                            "rdp-on" | "rdp-off" => {
                                let on = url.path() == "rdp-on";
                                // The watchdog reads this atomic each tick; update it
                                // immediately so the next tick applies the choice.
                                monitor::HIDE_ON_RDP
                                    .store(on, std::sync::atomic::Ordering::SeqCst);
                                // Persist off the WebView UI thread (this hook runs on
                                // it, and file IO here can stall the page mid-load).
                                // prefs::update locks the whole load→save so it can't
                                // race the swipe-home writer below (or a tray toggle).
                                let handle = nav_handle.clone();
                                std::thread::spawn(move || {
                                    prefs::update(&handle, |p| p.hide_on_rdp = on);
                                });
                            }
                            "gesture-on" | "gesture-off" => {
                                let on = url.path() == "gesture-on";
                                // reg.exe + file IO — off the WebView UI thread:
                                // this hook runs on it, and blocking it here can
                                // stall the page mid-load.
                                let handle = nav_handle.clone();
                                std::thread::spawn(move || {
                                    prefs::update(&handle, |p| p.swipe_home = on);
                                    #[cfg(windows)]
                                    if on {
                                        edge_swipe::disable();
                                    } else {
                                        edge_swipe::restore();
                                    }
                                });
                            }
                            "return" => {
                                if let Some(win) = nav_handle.get_webview_window("main") {
                                    monitor::exit_home(&win);
                                }
                            }
                            _ => {
                                if let Some(win) = nav_handle.get_webview_window("main") {
                                    monitor::enter_home(&win);
                                }
                            }
                        }
                        return false;
                    }
                    // Settings → Schermo, and the first-run screen picker:
                    //   xenon-display:auto                    → the historical rule
                    //   xenon-display:screen?id=…&fullscreen= → this display, deliberately
                    //   xenon-display:phone                   → nothing on this PC
                    //   xenon-display:fullscreen?on=0|1       → assert (not toggle)
                    //
                    // Each verb touches disk and enumerates monitors, so each runs
                    // off the WebView UI thread this hook is called on — same
                    // reason as the two xenon-home writers above. The query is
                    // parsed inside the thread so the hook returns immediately.
                    //
                    // Unknown paths do NOTHING. That is deliberate and unlike the
                    // xenon-home catch-all above, where an unknown path collapses
                    // the kiosk: a fallback that acts is what makes an unknown
                    // path dangerous.
                    if scheme == "xenon-display" {
                        let handle = nav_handle.clone();
                        let path = url.path().to_string();
                        let query = url.query().map(|q| q.to_string());
                        std::thread::spawn(move || {
                            apply_display_signal(&handle, &path, query.as_deref());
                        });
                        return false;
                    }
                    // Touch interactions on the dashboard end here (never a real
                    // page): put the mouse back on the monitor it was on before
                    // Windows teleported it to the touched point.
                    if scheme == "xenon-cursor" {
                        #[cfg(windows)]
                        cursor_guard::restore();
                        return false;
                    }
                    if scheme == "xenon-fullscreen" {
                        // Route the F11 shortcut through the same canonical toggle the
                        // tray uses: it honours the Edge-kiosk guard (a no-op while the
                        // panel is owned), re-places the window on its monitor, and
                        // persists the choice — none of which a raw set_fullscreen does.
                        if url.path() == "toggle" {
                            if let Some(win) = nav_handle.get_webview_window("main") {
                                if let Ok(is_fullscreen) = win.is_fullscreen() {
                                    monitor::set_fullscreen_pref(&nav_handle, !is_fullscreen);
                                }
                            }
                        }
                        return false;
                    }
                    // Game-focus guard signals (never a real page): the dashboard
                    // reports game mode and text-field focus so touches don't
                    // steal the game's focus — except while the user types.
                    if scheme == "xenon-focus" {
                        #[cfg(windows)]
                        match url.path() {
                            "guard-on" => focus_guard::set_game_mode(true),
                            "guard-off" => focus_guard::set_game_mode(false),
                            "type-start" => {
                                if let Some(win) = nav_handle.get_webview_window("main") {
                                    focus_guard::type_start(&win);
                                }
                            }
                            "type-end" => focus_guard::type_end(),
                            _ => {}
                        }
                        return false;
                    }
                    // Always allow the app's own pages: the bundled splash asset
                    // and the loopback dashboard it hands over to. On Windows the
                    // bundled assets are served over `http://tauri.localhost`, not
                    // the `tauri://` custom scheme (macOS/Linux) — treating that
                    // host as external would bounce the splash itself to the OS
                    // browser and leave the kiosk black.
                    if matches!(scheme, "tauri" | "data" | "blob" | "about") {
                        return true;
                    }
                    let loopback = matches!(
                        url.host_str(),
                        Some("127.0.0.1") | Some("localhost") | Some("::1") | Some("tauri.localhost")
                    );
                    if matches!(scheme, "http" | "https") && loopback {
                        return true;
                    }
                    // Anything else (external http/https, mailto, tel, …) is handed
                    // to the default browser and the in-webview navigation cancelled.
                    use tauri_plugin_opener::OpenerExt;
                    let _ = nav_handle.opener().open_url(url.as_str(), None::<&str>);
                    false
                });

            // WebView2 browser arguments. `additional_browser_args` REPLACES wry's
            // default (`--disable-features=…`), so it's re-included below.
            //
            // 1) Keep the unfocused kiosk renderer fully alive. The Edge window never
            //    holds focus (WS_EX_NOACTIVATE) and lives on a secondary display, so
            //    Chromium would background/throttle its renderer after a while —
            //    freezing its JS timers and the SSE stream, so the dashboard silently
            //    stops updating and the Deck stops responding even though the socket
            //    stays open (reported as "the app stopped talking to the server").
            //    These three switches stop that suspension.
            // 2) Match the WebView2 render GPU to the display presenting the kiosk
            //    (the Edge, typically an iGPU over USB-C). Rendering on a different
            //    GPU than the one scanning out the window makes Chromium copy every
            //    composited frame across adapters on the CPU — ~1.5 idle cores on a
            //    hybrid-GPU machine. See gpu::webview_gpu_flag (no-op off hybrids);
            //    `gpu_flag` was already computed above, alongside the JS-facing
            //    `lowPowerGpu` cap.
            #[cfg(windows)]
            let builder = builder.additional_browser_args(&browser_args(gpu_flag));
            let window = builder.build()?;

            // Place the kiosk window on the Xeneon Edge (if connected) and keep a
            // watchdog running so it returns there after display reorders, replug
            // or resume from standby.
            monitor::place_now(&window);
            // Seed the watchdog's Remote-Desktop-hide flag from the saved pref so a
            // launch that starts inside an RDP session already knows to hide (the
            // dashboard's toggle updates it live once the page loads).
            monitor::HIDE_ON_RDP.store(
                prefs::load(app.handle()).hide_on_rdp,
                std::sync::atomic::Ordering::SeqCst,
            );
            // Hide right away if we're launching INSIDE an RDP session, so the kiosk
            // never flashes over the remote desktop for a watchdog interval first.
            monitor::apply_rdp_hide_now(&window);
            monitor::start_watchdog(app.handle().clone());

            // Remember where the desktop mouse is so it can be put back after a
            // touch on the kiosk yanks it onto the Edge (tray-toggleable).
            #[cfg(windows)]
            cursor_guard::start(&window);

            // While a game runs, stop kiosk touches from stealing its focus; if
            // an activation slips through anyway, hand the focus straight back.
            #[cfg(windows)]
            {
                focus_guard::start(&window);
                window.on_window_event(|event| {
                    if let tauri::WindowEvent::Focused(true) = event {
                        focus_guard::on_focused();
                    }
                });
            }

            // System-tray icon (show / hide / restart / exit).
            if let Err(err) = tray::build(app) {
                eprintln!("failed to build tray icon: {err}");
            }

            // If the local backend never comes up, heal it once (Windows: its
            // logon task; macOS: its LaunchAgent, or the first-run bootstrap).
            spawn_backend_nudge(app.handle(), port);

            // Register — or REMOVE — the kiosk's own login entry, to match the
            // screen the user chose. This used to enable unconditionally on every
            // launch, so someone who had chosen their phone and then opened Xenon
            // once from the Start menu silently got the window back at every login.
            sync_autostart(app.handle());

            // Stop Windows from stealing edge touch swipes (taskbar/Start reveal)
            // so the "swipe up to the desktop" gesture reaches the dashboard —
            // unless the user turned the gesture off in Settings (mirrored into
            // prefs by the xenon-home:gesture-* signals above). Best-effort: the
            // policy lives in HKLM and is normally written by the elevated
            // installer; this only takes over when the app itself runs elevated.
            // Never reverted on exit — that would undo the installer's work
            // (uninstall.ps1 is what gives Windows its edge swipes back).
            #[cfg(windows)]
            if prefs::load(app.handle()).swipe_home {
                edge_swipe::disable();
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Xenon native app")
        .run(|_app, _event| {
            // Whatever we started, we stop. On macOS the backend is this app's
            // own child (see spawn_backend_nudge), so quitting must take it with
            // us rather than leave a headless server holding port 3030.
            #[cfg(target_os = "macos")]
            if matches!(_event, tauri::RunEvent::Exit) {
                stop_owned_backend();
            }
        });
}
