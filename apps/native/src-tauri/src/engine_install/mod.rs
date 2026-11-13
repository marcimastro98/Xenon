//! First-run install of the dashboard engine from the copy this app carries.
//!
//! The installer used to ship the shell alone, and the engine came from a
//! PowerShell (or Terminal) bootstrap that downloaded the source, installed
//! Node and ran npm in a console window. Consoles opening on their own read as
//! an attack, and the download could stall. Now the engine and a pinned Node
//! travel inside the signed package (`engine/`, built by
//! tools/engine-bundle/cli.mjs), and this module only copies files, writes the
//! same markers the updater already reads, registers the same login entry the
//! old installer did and starts the engine. No script, no download, no window.
//!
//! The copy is a seed: from then on the engine updates itself exactly as
//! before (server/self-update.js), and the shell never overwrites a NEWER
//! engine with its older bundle.

mod copy;
mod progress;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(unix)]
mod posix;
#[cfg(windows)]
mod uninstall;
#[cfg(windows)]
mod uninstall_words;
#[cfg(windows)]
mod win_api;
#[cfg(windows)]
mod windows;
mod place;
mod selftest;

#[cfg(windows)]
pub use uninstall::run as uninstall;
#[cfg(windows)]
pub use windows::keep_task_for_phone;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;

use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
pub use macos::ensure_login_item;

use progress::Step;

use place::{engine_answers, place_files, placed_version, wait_for_engine};
pub use selftest::selftest;
// Only the tests read the stamp file by name.
#[cfg(test)]
use place::RUNTIME_STAMP;

/// Where the runtime goes inside the engine root. Kept out of the update
/// manifest, so the engine's own updater never deletes it.
pub const RUNTIME_DIR: &str = "node-runtime";

/// The engine and Node this app carries, as described by `engine/bundle.json`.
pub struct Bundle {
    dir: PathBuf,
    version: String,
    files: Vec<String>,
}

impl Bundle {
    /// Reads `<dir>/bundle.json`; `None` when this build carries no engine
    /// (`tauri dev`, or a package built without one).
    pub fn open(dir: &Path) -> Option<Bundle> {
        let text = std::fs::read_to_string(dir.join("bundle.json")).ok()?;
        let info: serde_json::Value = serde_json::from_str(&text).ok()?;
        let version = info.get("version")?.as_str()?.to_string();
        let files = info
            .get("files")?
            .as_array()?
            .iter()
            .filter_map(|f| f.as_str().map(str::to_string))
            .collect::<Vec<_>>();
        let complete = dir.join("app").is_dir() && dir.join(RUNTIME_DIR).is_dir() && !files.is_empty();
        complete.then(|| Bundle { dir: dir.to_path_buf(), version, files })
    }
}

/// The packaged bundle of a release build. Debug builds never install for
/// real, for the same reason `bootstrap_script` refuses them.
pub fn packaged(app: &tauri::AppHandle) -> Option<Bundle> {
    use tauri::Manager;
    if cfg!(debug_assertions) {
        return None;
    }
    let dir = app.path().resolve("engine", tauri::path::BaseDirectory::Resource).ok()?;
    let bundle = Bundle::open(&dir);
    if bundle.is_none() && dir.exists() {
        // A package that carries an engine it cannot read is a broken release,
        // not a dev build: say which part is missing, once per launch.
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let has = |p: &Path| if p.exists() { "yes" } else { "no" };
            log(&format!(
                "carried engine at {} is incomplete: bundle.json {}, app {}, runtime {}",
                dir.display(),
                has(&dir.join("bundle.json")),
                has(&dir.join("app")),
                has(&dir.join(RUNTIME_DIR)),
            ));
        });
    }
    bundle
}

/// "5.1.0" > "5.0.12": numeric, dot by dot; anything unreadable counts as 0.
pub fn version_newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim().trim_start_matches(['v', 'V']).split('.').map(|p| p.parse().unwrap_or(0)).collect()
    };
    parse(a) > parse(b)
}

fn installed_version(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join("package.json")).ok()?;
    let info: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(info.get("version")?.as_str()?.to_string())
}

/// A temp folder is cleared by Windows and cleanup tools: never the engine's home.
pub fn is_volatile(root: &Path) -> bool {
    let temp = std::env::temp_dir();
    let lower = |p: &Path| p.to_string_lossy().to_lowercase().replace('\\', "/");
    lower(root).starts_with(&lower(&temp))
}

/// The engine already on this machine, if any: the root a login entry points
/// at, then the one its "Installed apps" entry names (an engine in a folder of
/// the user's choosing whose task went missing), when it really holds an
/// engine, else the default one. A registration that points at nothing (a
/// moved or deleted folder, a path read back wrong) never decides where files go.
fn target_root() -> Result<PathBuf, Step> {
    let usable = |r: &PathBuf| !is_volatile(r) && has_engine(r);
    if let Some(root) = platform::registered_root().filter(usable).or_else(|| listed_root().filter(usable)) {
        return Ok(root);
    }
    platform::default_root().ok_or(Step::Failed("no_home"))
}

#[cfg(windows)]
fn listed_root() -> Option<PathBuf> {
    windows::listed_root()
}

/// macOS and Linux keep no second record of the engine's folder: only its
/// login entry names it.
#[cfg(not(windows))]
fn listed_root() -> Option<PathBuf> {
    None
}

/// Windows: one "Installed apps" entry for an engine this app installed (its
/// own removes both), checked off the calling thread at every start.
#[cfg(windows)]
pub fn keep_one_entry() {
    std::thread::spawn(|| {
        if target_root().is_ok_and(|r| has_engine(&r) && uninstall::is_carried(&r)) {
            windows::hide_shell_entry();
        }
    });
}

fn has_engine(root: &Path) -> bool {
    root.join("server").join("server.js").is_file()
}

/// True when an engine's files are already in the root an install would use.
/// The shell only installs on its own where there is none: an existing engine
/// whose login entry went missing is repaired on the user's click, never behind
/// their back. The one exception is phone mode on Windows, where no window is
/// there to click on (windows::keep_task_for_phone).
pub fn engine_on_disk() -> bool {
    target_root().map(|r| has_engine(&r)).unwrap_or(false)
}

/// The whole install. `port` is where the engine is expected to answer.
pub fn install(bundle: &Bundle, port: u16) -> Result<PathBuf, Step> {
    progress::set(Step::Preparing, 2);
    let root = target_root()?;
    // A slow first start that gave up on the splash is often running by now:
    // Try again must not copy over an engine that is answering.
    if engine_answers(port, std::time::Duration::from_millis(900)) {
        log("the engine is already answering: nothing to install");
        progress::set(Step::Ready, 100);
        return Ok(root);
    }
    log(&format!("installing engine {} into {}", bundle.version, root.display()));
    place_files(bundle, &root)?;
    progress::set(Step::Registering, 86);
    // The entry names the engine that is there, which may be newer than the bundle.
    let version = installed_version(&root).unwrap_or_else(|| bundle.version.clone());
    platform::register(&root, &version).map_err(fail("register"))?;
    progress::set(Step::Starting, 90);
    platform::start(&root, port).map_err(fail("start"))?;
    if !wait_for_engine(port, 60) {
        return Err(Step::Failed("no_answer"));
    }
    progress::set(Step::Ready, 100);
    log("engine answered: install done");
    Ok(root)
}

fn fail<E: std::fmt::Display>(stage: &'static str) -> impl Fn(E) -> Step {
    move |e| {
        log(&format!("{stage} failed: {e}"));
        Step::Failed(stage)
    }
}

pub(crate) fn log(line: &str) {
    crate::crash_log::note("engine-install", line);
}

static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Runs the install off the UI thread and keeps the splash told how far it got.
/// A second call while one is running is ignored; after a failure it may run again.
pub fn spawn(app: &tauri::AppHandle, port: u16) {
    use std::sync::atomic::Ordering;
    let Some(bundle) = packaged(app) else { return };
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    progress::reset();
    let handle = app.clone();
    std::thread::spawn(move || progress::push_until_done(&handle));
    std::thread::spawn(move || {
        if let Err(step) = install(&bundle, port) {
            progress::set(step, 0);
        }
        progress::finish();
        RUNNING.store(false, Ordering::SeqCst);
    });
}

#[cfg(test)]
mod tests;
