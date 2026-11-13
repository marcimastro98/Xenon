// Windows: what the app does when the engine does not answer, and how it tells the splash.

use tauri::Manager;
use crate::{engine_install, LOGON_PROBE_TRIES, system32_exe};
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
use crate::{backend_answers_once, backend_answers_within, PROBE_TRIES};
use crate::backend_task::{BACKEND_TASK, backend_task_state, TaskState};

#[cfg(windows)]
pub(crate) fn spawn_backend_nudge(app: &tauri::AppHandle, port: u16) {
    let handle = app.clone();
    std::thread::spawn(move || {
        if port != 3030 {
            return;
        }
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // The QUERY runs first, and only the query: it reads, it costs
        // milliseconds, and its answer decides which of the three situations we
        // are in. The /Run below still waits for the full probe, because that is
        // the one that must not fire at a healthy server.
        let state = backend_task_state();
        if state == TaskState::Disabled {
            // Registered but switched off: nothing is coming, and `/Run` is not
            // the answer either — the user turned this off (or something did it
            // for them) and turning it back on is a decision, not a repair we
            // make behind their back. Tell the splash, which offers the switch.
            if !backend_answers_once(port) {
                tell_splash(&handle, "try{window.__XENON_TASK_DISABLED__=true;}catch(e){}");
            }
            return;
        }
        if state == TaskState::Missing {
            // Nothing registered to start, and nothing listening: the backend was
            // never installed on this machine. One short probe rather than the
            // full ladder — there is nothing here that could still be starting,
            // and the whole point is to reach the splash before its own timer.
            // Someone running `node server/server.js` by hand answers it and is
            // left alone.
            if !backend_answers_once(port) {
                // This build carries the engine: set it up now, with progress on
                // the splash, instead of offering the old console bootstrap.
                // Not over an engine already on disk whose task went missing (a
                // cleanup tool, a failed query): that one is repaired by the
                // splash's button, on the user's click.
                if engine_install::packaged(&handle).is_some() && !engine_install::engine_on_disk() {
                    engine_install::spawn(&handle, port);
                    return;
                }
                tell_splash(&handle, "try{window.__XENON_BACKEND_ABSENT__=true;}catch(e){}");
            }
            return; // no task to nudge
        }
        // Installed and switched on. The splash must know this before its own
        // timer runs out: without it, an engine that is merely slow (or failed
        // to start) was shown as "Xenon isn't finished installing", whose setup
        // then answered "already installed, restart your PC" — round and round
        // (reported on Discord, Oct 2026). Its own thread, because the probe
        // below takes up to a minute and the splash needs this now.
        {
            let h = handle.clone();
            std::thread::spawn(move || {
                tell_splash(&h, "try{window.__XENON_BACKEND_INSTALLED__=true;}catch(e){}");
            });
        }
        // At sign-in the logon task is starting the engine at this very moment,
        // and a cold boot can keep node from listening for well over the usual
        // 16s. `/Run` then re-runs start-hidden.vbs, which stops whatever has
        // just started listening and starts a second node — a slower start, not
        // a faster one. So the app's own sign-in launch waits longer first.
        let autostarted = std::env::args().any(|a| a == "--autostart");
        let tries = if autostarted { LOGON_PROBE_TRIES } else { PROBE_TRIES };
        if backend_answers_within(port, tries) {
            return; // backend is up — nothing to heal
        }
        let _ = std::process::Command::new(system32_exe("schtasks.exe"))
            .args(["/Run", "/TN", BACKEND_TASK])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    });
}

/// How many times a flag is pushed into the splash, and how far apart. An eval
/// sent before the page has loaded is simply lost, and these flags decide which
/// panel the user sees; a lost one used to leave the splash on its timer alone.
/// Re-sending is harmless: each one only sets a property the page reads.
#[cfg(windows)]
const SPLASH_TELL_TIMES: u32 = 10;
#[cfg(windows)]
const SPLASH_TELL_EVERY: std::time::Duration = std::time::Duration::from_secs(2);

#[cfg(windows)]
fn tell_splash(handle: &tauri::AppHandle, js: &str) {
    for _ in 0..SPLASH_TELL_TIMES {
        if let Some(win) = handle.get_webview_window("main") {
            let _ = win.eval(js);
        }
        std::thread::sleep(SPLASH_TELL_EVERY);
    }
}
