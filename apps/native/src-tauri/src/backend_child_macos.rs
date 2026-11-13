// macOS: the engine process this app starts and owns: where it lives, which node runs it, and stopping it on exit.

use crate::engine_install;

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
pub(crate) fn backend_entry(home: &std::path::Path) -> Option<std::path::PathBuf> {
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
    // nvm keeps node outside every fixed prefix, and a GUI process inherits
    // launchd's minimal PATH, so the `which` below cannot see it either — an
    // nvm-only machine (a very common way to have Node on macOS) used to fall
    // out of this function with None, and the backend then silently never
    // started on any launch. The layout is versioned directories; the newest
    // wins, matching what `nvm use default` would put first in a shell.
    if let Some(home) = std::env::var_os("HOME") {
        let versions = std::path::Path::new(&home).join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&versions) {
            let mut best: Option<(Vec<u64>, std::path::PathBuf)> = None;
            for e in entries.flatten() {
                let node = e.path().join("bin/node");
                if !node.is_file() {
                    continue;
                }
                let name = e.file_name().to_string_lossy().into_owned();
                let key: Vec<u64> = name
                    .trim_start_matches('v')
                    .split('.')
                    .map(|p| p.parse::<u64>().unwrap_or(0))
                    .collect();
                if best.as_ref().map(|(k, _)| key > *k).unwrap_or(true) {
                    best = Some((key, node));
                }
            }
            if let Some((_, node)) = best {
                return Some(node);
            }
        }
    }
    let out = std::process::Command::new("/usr/bin/which")
        .arg("node")
        .output()
        .ok()?;
    let found = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if !found.is_empty() {
        return Some(std::path::PathBuf::from(found));
    }
    // Last resort: ask the user's login shell, which sources the profile that
    // nvm/asdf/volta modify. One spawn, and only on the path where nothing
    // else answered.
    let out = std::process::Command::new("/bin/zsh")
        .args(["-lc", "command -v node"])
        .output()
        .ok()?;
    let found = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!found.is_empty()).then(|| std::path::PathBuf::from(found))
}

/// Start server.js as this app's child (see spawn_backend_nudge for why it must
/// be a child here). The node an install carries in `node-runtime` wins over
/// any system one: it is the version that engine was built and tested with.
#[cfg(target_os = "macos")]
pub(crate) fn start_backend_child(entry: &std::path::Path) -> bool {
    let root = entry.parent().and_then(|p| p.parent());
    let bundled = root
        .map(|r| r.join(engine_install::RUNTIME_DIR).join("bin/node"))
        .filter(|p| p.is_file());
    let Some(node) = bundled.or_else(find_node) else { return false };
    let mut cmd = std::process::Command::new(node);
    cmd.arg(entry);
    if let Some(root) = root {
        cmd.current_dir(root);
    }
    let Ok(child) = cmd.spawn() else { return false };
    if let Ok(mut guard) = BACKEND_CHILD.lock() {
        *guard = Some(child);
    }
    true
}
