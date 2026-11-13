// macOS: waking an engine that does not answer, or offering to set it up in a Terminal window.

use crate::engine_install;
use crate::backend_child_macos::{backend_entry, start_backend_child};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::backend_probe::backend_answers;

/// Open a script in Terminal.app and, when `marker` is given, make sure it
/// actually ran.
///
/// macOS cannot hand a command to Terminal. `open -a Terminal <file>` starts a
/// window, starts a shell in it, and TYPES the file's path at that shell — so
/// the install depends on a race it cannot see: if the shell is still sourcing
/// its startup files, the typed text arrives corrupted. Observed on a first
/// launch as `o cer/Users/.../xenon-bootstrap.sh`, answered by zsh with
/// "command not found: o". The window was there, the user watched it do
/// nothing, and the splash waited for a backend that was never being installed.
///
/// There is no API that avoids the typing (Terminal's own `do script` is the
/// same mechanism, plus an Automation prompt), so the fix is to VERIFY instead:
/// the bootstrap touches `marker` on its first line, and a window that never
/// gets there is opened once more. The retry is the cheap half — the second
/// attempt meets a Terminal that is already running, which is the state the
/// garbling was never reproducible in (measured: 1/1 warm, 3/3 cold-started
/// here, so this is a rare race and not a certainty).
///
/// One retry, never a loop: two windows is a wart, an endless stack of them is
/// a worse bug than the one being fixed.
#[cfg(target_os = "macos")]
fn open_bootstrap_terminal(script: &std::path::Path, marker: Option<&std::path::Path>) {
    use std::os::unix::fs::PermissionsExt;
    // Tauri copies resources without the executable bit, and `open -a Terminal`
    // on a non-executable file opens it in an editor instead of running it.
    let _ = std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755));
    for _ in 0..2 {
        if let Some(m) = marker {
            // A marker from an earlier run would answer for this one.
            let _ = std::fs::remove_file(m);
        }
        let _ = std::process::Command::new("open")
            .args(["-a", "Terminal"])
            .arg(script)
            .status();
        let Some(m) = marker else { return };
        // Generous on purpose: the window has to appear, a login shell has to
        // source the user's startup files, and only then does line one run.
        for _ in 0..40 {
            if m.exists() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
}

/// The file `xenon-bootstrap.sh` touches as it starts, on macOS. Built from
/// `$HOME` alone, with no environment lookup, because the script and this app
/// must agree on it exactly — a path either could resolve differently would
/// make every launch open a second window.
#[cfg(target_os = "macos")]
fn bootstrap_marker(home: &std::path::Path) -> std::path::PathBuf {
    home.join("Library/Application Support/Xenon/.bootstrap-started")
}

#[cfg(target_os = "macos")]
pub(crate) fn spawn_backend_nudge(app: &tauri::AppHandle, port: u16) {
    use tauri::path::BaseDirectory;
    use tauri::Manager;
    let script = app
        .path()
        .resolve("posix/xenon-bootstrap.sh", BaseDirectory::Resource)
        .ok();
    let home = app.path().home_dir().ok();
    let handle = app.clone();
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
            if start_backend_child(&entry) {
                if let Some(root) = entry.parent().and_then(|p| p.parent()) {
                    engine_install::ensure_login_item(root);
                }
                return;
            }
            if let Some(installer) = entry
                .parent()
                .map(|p| p.join("install.sh"))
                .filter(|p| p.exists())
            {
                // An install is present but no node is visible to this GUI
                // process. Doing nothing here left the splash waiting forever
                // with no error anywhere, on every launch. install.sh resolves
                // node in a real shell and can install it with Homebrew, so
                // hand the problem to it in a Terminal the user can read.
                // No marker: install.sh is not the bootstrap and does not write
                // one, so this window is opened without the verify-and-retry.
                open_bootstrap_terminal(&installer, None);
            }
            return;
        }
        // Nothing installed here at all. A build that carries the engine sets it
        // up itself, with progress on the splash; an older one opens the
        // bootstrap in Terminal so the install has a UI and an exit.
        if engine_install::packaged(&handle).is_some() {
            engine_install::spawn(&handle, port);
            return;
        }
        let Some(script) = script else { return };
        if !script.exists() {
            return;
        }
        let marker = home.as_deref().map(bootstrap_marker);
        open_bootstrap_terminal(&script, marker.as_deref());
    });
}

/// The current user id, via `id -u` — launchctl addresses its domains by uid and
/// there is no std API for it (and no libc dependency in this crate).
#[cfg(target_os = "macos")]
pub(crate) fn current_uid() -> Option<String> {
    let out = std::process::Command::new("id").arg("-u").output().ok()?;
    let uid = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if uid.is_empty() || !uid.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(uid)
}
