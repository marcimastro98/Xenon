//! Per-user preferences for the native shell, persisted across launches.
//!
//! The placement triple (`placement`, `monitor`, `fullscreen`) decides which
//! screen the kiosk owns, and `placement` OUTRANKS the Edge auto-pin:
//!
//!   * `Auto` (the default, and the historical behaviour) — the Xeneon Edge if
//!     one is attached, otherwise `monitor`/primary per `fullscreen`.
//!   * `Screen` — the user NAMED a display, and that choice wins even with an
//!     Edge plugged in. Before v4.11 the Edge always won and the tray's monitor
//!     picker was greyed out on any machine that had one, so the setting could
//!     not be honoured; now it can.
//!   * `Phone` — this PC shows nothing at all; the dashboard lives on a paired
//!     phone or tablet. This also governs whether the app registers itself to
//!     start at login: on Windows and Linux it must NOT (the backend has its own
//!     login mechanism and already starts hidden), while on macOS it must still
//!     start — hidden — because the app is what launches the backend so it
//!     inherits Full Disk Access (see `spawn_backend_nudge` in `lib.rs`).
//!
//! `cursor_guard` applies everywhere (it matters most ON the Edge — see
//! `cursor_guard.rs`).
//!
//! Stored as a tiny JSON file in the app config dir (e.g.
//! `%APPDATA%/com.marcimastro98.xenon/display.json`). Every read/write degrades to
//! the default silently — a missing or unreadable file is simply "windowed".

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Which surface the user chose for Xenon. See the module doc for the rank order.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    #[default]
    Auto,
    Screen,
    Phone,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DisplayPrefs {
    /// Open full-screen (on `monitor`, or the primary display) instead of windowed.
    pub fullscreen: bool,
    /// Best-effort key of the chosen monitor (its OS name); `None` = primary.
    /// Monitor identity is not perfectly stable across replug/reboot, so a saved
    /// name that no longer matches falls back to `monitor_fingerprint`, and then
    /// (in `Auto` only) to the primary display.
    pub monitor: Option<String>,
    /// Which screen the user picked. Absent in files written before v4.11 →
    /// `Auto`, which is exactly the behaviour those files already had.
    #[serde(default, deserialize_with = "placement_or_auto")]
    pub placement: Placement,
    /// `"<width>x<height>@<scale>"` for the chosen monitor, used ONLY when
    /// `monitor` no longer resolves. On Windows `Monitor::name()` is
    /// `\\.\DISPLAY1` — an index assigned by ORDER, not by panel — so a replug
    /// can silently repoint a saved name at a different physical screen. That
    /// was survivable while the name was a mere preference; under "an explicit
    /// choice wins" it would put the kiosk on the wrong monitor.
    #[serde(default)]
    pub monitor_fingerprint: Option<String>,
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
    /// Pin the WebView2 render GPU to the adapter driving the kiosk's screen, on
    /// hybrid iGPU+dGPU machines only (see `gpu.rs`). Default on, because leaving it
    /// off costs ~1.5 CPU cores on exactly the machines the Edge is usually wired
    /// to. It exists as a switch because the pin is the one thing Xenon does that a
    /// user cannot otherwise take out of the picture while diagnosing a display
    /// problem — short of not running the app at all, which is not a test anybody
    /// should have to perform. Read once at launch: the flag is a WebView2
    /// environment option and cannot change without restarting (see `gpu::arm`).
    #[serde(default = "default_true")]
    pub gpu_pin: bool,
}

fn default_true() -> bool {
    true
}

/// Never let an unknown `placement` fail the whole file.
///
/// `load()` swallows every deserialization error and returns `Default`, which is
/// right for a missing file and dangerous for one bad field: a plain derived
/// enum rejects any string it does not know, so a `display.json` written by a
/// NEWER build (a future `"placement": "tv"`, say) would wipe `cursor_guard`,
/// `focus_guard`, `swipe_home`, `hide_on_rdp`, `gpu_pin` and the monitor choice
/// on a downgrade — and re-enable autostart for someone who chose their phone.
/// Going through `Value` accepts any JSON shape and degrades to `Auto`.
fn placement_or_auto<'de, D>(d: D) -> Result<Placement, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d).unwrap_or(serde_json::Value::Null);
    Ok(match raw.as_str() {
        Some("screen") => Placement::Screen,
        Some("phone") => Placement::Phone,
        _ => Placement::Auto,
    })
}

impl Default for DisplayPrefs {
    fn default() -> Self {
        Self {
            fullscreen: false,
            monitor: None,
            placement: Placement::Auto,
            monitor_fingerprint: None,
            cursor_guard: true,
            focus_guard: true,
            swipe_home: true,
            hide_on_rdp: false,
            gpu_pin: true,
        }
    }
}

impl DisplayPrefs {
    /// Whether the app should keep a visible window on this PC at all. One
    /// helper so the rule is not re-derived at each of its call sites.
    pub fn shows_on_this_pc(&self) -> bool {
        self.placement != Placement::Phone
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
///
/// Written temp-then-rename, like every durable store on the server side. A bare
/// `write` truncates first, so a crash or a power cut mid-write leaves a partial
/// file — and `load()` turns any unreadable file into `Default`, which here means
/// the user's screen choice is forgotten AND autostart comes back on for someone
/// who asked for their phone. The rename is atomic on both NTFS and POSIX, so a
/// reader sees either the previous file or the new one and never neither; that
/// is also why `load()` needs no lock of its own.
pub fn save(app: &AppHandle, prefs: &DisplayPrefs) {
    let Some(path) = prefs_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(json) = serde_json::to_string_pretty(prefs) else { return };
    let tmp = path.with_extension("json.tmp");
    // fsync BEFORE the rename. The rename is atomic for the directory ENTRY, not
    // for data still sitting in the page cache, so a power cut between the two
    // can leave the entry pointing at a zero-length file — the very
    // "unreadable → Default" outcome this whole dance exists to avoid.
    {
        let Ok(mut f) = std::fs::File::create(&tmp) else { return };
        if f.write_all(json.as_bytes()).is_err() || f.sync_all().is_err() {
            drop(f);
            let _ = std::fs::remove_file(&tmp);
            return;
        }
    }
    // No unlink of the destination first. `std::fs::rename` REPLACES an existing
    // file on Windows as well (MoveFileExW with MOVEFILE_REPLACE_EXISTING) —
    // the belief that it refuses to clobber was simply wrong, and acting on it
    // opened a window in which display.json did not exist at all. A crash (or an
    // app.restart()) inside that window made the next `load()` return `Default`:
    // placement `Auto` and autostart re-enabled for someone who chose "on my
    // phone", i.e. exactly the outcome the doc comment above promises to prevent.
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
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
