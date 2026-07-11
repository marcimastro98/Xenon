//! Per-user preferences for the native shell, persisted across launches.
//!
//! The display placement pair (`fullscreen`, `monitor`) is only meaningful when
//! there is NO Xeneon Edge attached — on the Edge the kiosk always owns the
//! panel. Off the Edge the user can, from the tray, switch the window to
//! full-screen and pick which monitor it lives on; those choices are remembered
//! here so the next launch reopens exactly as they left it. `cursor_guard`
//! applies everywhere (it matters most ON the Edge — see `cursor_guard.rs`).
//!
//! Stored as a tiny JSON file in the app config dir (e.g.
//! `%APPDATA%/com.marcimastro98.xenon/display.json`). Every read/write degrades to
//! the default silently — a missing or unreadable file is simply "windowed".

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct DisplayPrefs {
    /// Open full-screen (on `monitor`, or the primary display) instead of windowed.
    pub fullscreen: bool,
    /// Best-effort key of the chosen monitor (its OS name); `None` = primary.
    /// Monitor identity is not perfectly stable across replug/reboot, so a saved
    /// name that no longer matches falls back to the primary display.
    pub monitor: Option<String>,
    /// Put the mouse back on the monitor it was on after a touch on the kiosk
    /// (Windows teleports the cursor to every touch). Defaults to on; the
    /// `serde` default keeps prefs files written before this field valid.
    #[serde(default = "default_true")]
    pub cursor_guard: bool,
    /// While a game runs, stop touches on the kiosk from stealing the game's
    /// focus (see `focus_guard.rs`). Same default/compat shape as above.
    #[serde(default = "default_true")]
    pub focus_guard: bool,
    /// Swipe-up-to-desktop gesture: whether to block Windows' own bottom-edge
    /// swipe (taskbar reveal) so the gesture reaches the dashboard. The source
    /// of truth is the dashboard's Settings toggle, which signals every change
    /// over `xenon-home:gesture-on/off`; it is mirrored here so a launch that
    /// never reaches the dashboard still applies the user's last choice.
    #[serde(default = "default_true")]
    pub swipe_home: bool,
    /// Hide the kiosk while a Windows Remote Desktop (Terminal Services) session
    /// is active, so the borderless full-screen window doesn't cover the desktop
    /// the user is remoting into; the window returns when the session ends. This
    /// is about the user's OWN `mstsc`/RDP connection — NOT our Sunshine/Moonlight
    /// remote control, which streams the local console session and is not an RDP
    /// session, so it never triggers this. Opt-in (default off), mirrored from the
    /// dashboard's Settings toggle over `xenon-home:rdp-on/off`. `serde` default
    /// (false) keeps prefs files written before this field valid.
    #[serde(default)]
    pub hide_on_rdp: bool,
}

fn default_true() -> bool {
    true
}

impl Default for DisplayPrefs {
    fn default() -> Self {
        Self {
            fullscreen: false,
            monitor: None,
            cursor_guard: true,
            focus_guard: true,
            swipe_home: true,
            hide_on_rdp: false,
        }
    }
}

fn prefs_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("display.json"))
}

/// Load the saved preference, or the default (windowed, primary) if absent/invalid.
pub fn load(app: &AppHandle) -> DisplayPrefs {
    prefs_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Persist the preference. Best-effort: failures are ignored (the app still runs,
/// it just won't remember the choice next launch).
pub fn save(app: &AppHandle, prefs: &DisplayPrefs) {
    let Some(path) = prefs_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(prefs) {
        let _ = std::fs::write(path, json);
    }
}

/// Serializes the whole load→mutate→save cycle so two writers can't both read the
/// same baseline and clobber each other's field on save (a lost update). Several
/// independent triggers write this one file — the dashboard's swipe-home and RDP
/// toggles each on a spawned thread, plus the tray cursor/focus/full-screen/monitor
/// toggles on the main thread — so a bare `load()`→mutate→`save()` from two of them
/// at once could drop one change.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Atomically load, mutate, and persist the prefs under a process-wide lock. Every
/// read-modify-write of the prefs file MUST go through here rather than calling
/// `load()`/`save()` by hand, or the lock can't protect against a concurrent writer.
pub fn update<F: FnOnce(&mut DisplayPrefs)>(app: &AppHandle, mutate: F) {
    // A poisoned lock only means a previous writer panicked mid-update; the prefs
    // are still readable, so recover the guard and carry on rather than panicking.
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut prefs = load(app);
    mutate(&mut prefs);
    save(app, &prefs);
}
