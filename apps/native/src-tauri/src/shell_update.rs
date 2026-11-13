// The app updating itself: the check for a newer signed release, the install, and what it tells the dashboard.

#[cfg(desktop)]
use tauri::Manager;
#[cfg(desktop)]
use crate::{crash_log, stop_owned_backend};

/// Guards the one-shot update check so it fires once per launch, when the
/// loopback dashboard first loads (not on the splash).
#[cfg(desktop)]
pub(crate) static UPDATE_CHECK_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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
pub(crate) fn spawn_update_check(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    if !shell_self_update() {
        return;
    }
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
pub(crate) fn spawn_update_install(app: tauri::AppHandle) {
    use serde_json::json;
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        report_update_event(&app, json!({ "phase": "checking" }));
        if !shell_self_update() {
            report_update_event(&app, json!({ "phase": "error", "code": "managed_install" }));
            return;
        }
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
                crash_log::note("update", &format!("check failed: {}", short_err(&e)));
                report_update_event(
                    &app,
                    json!({ "phase": "error", "code": "check_failed", "message": short_err(&e) }),
                );
                return;
            }
        };
        // In the crash log too: the app's own update is the one half of an update
        // that a report from a machine we cannot see would otherwise say nothing
        // about (the dashboard half has update-result.json).
        crash_log::note("update", &format!("installing v{}", update.version));
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
                // Same reason the backend is stopped here: restart() execs past
                // the run loop, so the crash diary has to close its own session
                // or the update would read as a process that vanished.
                crash_log::session_end("restarting after update");
                // restart() execs: the run loop's Exit arm may never run, so the
                // backend we own is stopped here rather than orphaned.
                stop_owned_backend();
                app.restart();
            }
            Err(e) => {
                crash_log::note("update", &format!("install failed: {}", short_err(&e)));
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
pub(crate) fn legacy_rescue_js(shell_version: &str) -> String {
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
pub(crate) static LEGACY_RESCUE_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether this shell may replace its own binary. On Linux the bundler stamps an
/// AppImage, .deb or .rpm binary with its bundle type; an unstamped one (the
/// pacman package `tools/package-arch.mjs` builds, or a dev build) belongs to
/// whoever installed it, and the updater would fall back to the AppImage path
/// and try to overwrite /usr/bin/xenon-native in place. The dashboard reads this
/// as `shellSelfUpdate` and skips the app phase; the backend still updates.
pub(crate) fn shell_self_update() -> bool {
    #[cfg(target_os = "linux")]
    {
        tauri::utils::platform::bundle_type().is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}
