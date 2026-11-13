// Windows: the bundled first-install script, run in a console when the splash's button is pressed.

use tauri::Manager;

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
pub(crate) fn bootstrap_script(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
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
pub(crate) fn run_backend_bootstrap(app: &tauri::AppHandle) {
    let Some(script) = bootstrap_script(app) else {
        return;
    };
    let handle = app.clone();
    // Off the WebView UI thread: process creation blocks, and this is called
    // from the navigation hook, which runs on it.
    std::thread::spawn(move || {
        start_bootstrap_console(&script);
        watch_bootstrap_console(&handle);
    });
}

/// Tells the splash, once a second, whether the console is still open, so it
/// never says "still not started" over an install the user is watching.
#[cfg(windows)]
fn watch_bootstrap_console(handle: &tauri::AppHandle) {
    use tauri::Manager;
    loop {
        let running = BOOTSTRAP_CHILD
            .lock()
            .ok()
            .and_then(|mut slot| slot.as_mut().map(|c| matches!(c.try_wait(), Ok(None))))
            .unwrap_or(false);
        if let Some(win) = handle.get_webview_window("main") {
            let _ = win.eval(format!("try{{window.__XENON_SETUP_RUNNING__={running};}}catch(e){{}}"));
        }
        if !running {
            return;
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}

#[cfg(windows)]
fn start_bootstrap_console(script: &std::path::Path) {
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
        .arg(script)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .ok();
}
