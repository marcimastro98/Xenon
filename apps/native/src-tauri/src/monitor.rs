//! Screen targeting + kiosk watchdog.
//!
//! Where the window goes is decided in ONE place — `resolve()` — from the user's
//! saved `placement` and the live monitor list. Three outcomes:
//!
//!   * `Auto` (default): the Xeneon Edge if one is attached (it reports its
//!     native panel size, in either orientation, which is how we find it),
//!     otherwise an ordinary window on the preferred/primary display. A watchdog
//!     upgrades to the kiosk the moment an Edge appears, and re-pins after
//!     display reorders, replug or resume from standby.
//!   * `Screen`: the user NAMED a display and it wins, Edge attached or not. If
//!     that display is gone the window HIDES rather than reappearing somewhere
//!     the user did not ask for; the watchdog restores it when the screen is back.
//!   * `Phone`: nothing on this PC at all.
//!
//! Before v4.11 the Edge always won and the choice did not exist, which is why
//! the tray's monitor picker was greyed out on every machine that had one.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::Instant;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, LogicalSize, Manager, Monitor, PhysicalSize, WebviewWindow};

use crate::memory_level;
use crate::prefs;
use crate::prefs::Placement;

mod driver;
mod screens;
mod ids;
mod pick;
mod target;
mod reveal;
mod home;
mod placement;
mod watch_notes;
mod watchdog;

pub use driver::{end_visit, opened_to_nothing, seed_driver, set_driver, started_by_hand};
pub(crate) use driver::pointer_monitor;
pub use home::{enter_home, exit_home};
use ids::{display_ids, find_by_id, id_of};
use pick::{chosen_monitor, pick_in};
pub use placement::{move_to_named_monitor, push_display_state, set_fullscreen_pref, set_placement};
pub use reveal::{backend_port, note_startup, open_dashboard, reveal, show_now};
use screens::{current_of, monitors_of, on_main, placement_cache, PlacementCache, primary_of};
pub(crate) use screens::{app_monitors, app_primary, layer_monitor, monitors_with_primary};
pub use screens::{allow_show_this_session, set_placement_cache};
pub(crate) use target::{in_home_mode, owns_its_screen};
pub use target::place_now;
pub use watchdog::start_watchdog;

// This module is shared by every target, but two of the things it consults —
// the virtual-display list and the game-mode guard — are implemented with Win32
// APIs and so live in `#[cfg(windows)]` modules. Referring to them directly
// made the whole crate fail to resolve on macOS/Linux. These shims keep the
// logic below platform-agnostic, and the non-Windows values are the behaviour
// this file had before either feature existed.

/// Names of virtual/phantom displays to avoid when several monitors match the
/// Edge signature. Only Windows can present one (the second-screen driver, see
/// gpu.rs), so elsewhere the list is empty and `find_edge` keeps its plain
/// first-match behaviour.
#[cfg(windows)]
fn virtual_display_names() -> Vec<String> {
    crate::gpu::virtual_display_names()
}
#[cfg(not(windows))]
fn virtual_display_names() -> Vec<String> {
    Vec::new()
}

/// Whether a game currently holds the foreground. Tracked by focus_guard, which
/// is Windows-only; elsewhere the watchdog re-pins unconditionally, exactly as
/// it did before the guard was added.
#[cfg(windows)]
fn game_mode() -> bool {
    crate::focus_guard::game_mode()
}
#[cfg(not(windows))]
fn game_mode() -> bool {
    false
}

/// Whether the GPU this process pinned WebView2 to at launch is still the one
/// driving the screen the kiosk is on. Only Windows pins anything (see gpu.rs), so
/// elsewhere the answer is always "no disagreement".
#[cfg(windows)]
fn gpu_mismatch(window: &WebviewWindow) -> bool {
    let presenting = current_of(window).and_then(|m| m.name().cloned());
    crate::gpu::mismatch(presenting.as_deref())
}
#[cfg(not(windows))]
fn gpu_mismatch(_window: &WebviewWindow) -> bool {
    false
}

/// Native resolution of the CORSAIR Xeneon Edge 14.5" panel.
const EDGE_WIDTH: u32 = 2560;
const EDGE_HEIGHT: u32 = 720;

/// True when a reported size IS the Edge panel, in EITHER orientation.
///
/// The OS reports the rotated mode, so a panel the user has mounted vertically
/// answers 720×2560 and an ordered comparison stops recognising it. That was not
/// a cosmetic loss: `is_edge_panel` has no name fallback, so a vertical Edge fell
/// out of the kiosk path entirely and opened as a decorated window at 88% of the
/// screen, with the "(Xeneon Edge)" chip gone from the picker that would have let
/// the user say otherwise. Reported by a user who wanted a vertical mount.
///
/// A monitor genuinely 720 wide and 2560 tall that is NOT an Edge gets the kiosk
/// treatment under `Auto`, which is the same bet the landscape signature already
/// makes on 2560×720, and the screen picker is there to override it.
fn is_edge_size(size: PhysicalSize<u32>) -> bool {
    (size.width == EDGE_WIDTH && size.height == EDGE_HEIGHT)
        || (size.width == EDGE_HEIGHT && size.height == EDGE_WIDTH)
}

/// Diameter (physical px) of the round floating "return to Xenon" button the
/// kiosk shrinks to when the user swipes up to the desktop: a small, centred,
/// always-on-top circle that is comfortable to hit by finger (a full-width strip
/// proved both awkward to tap and visually heavy). Pinned near the *top* edge so
/// the Windows taskbar (bottom of the screen) stays fully reachable behind it.
const HOME_BTN_DIAMETER: u32 = 84;
/// Gap (physical px) between the very top of the monitor and the round button, so
/// it reads as floating rather than notched into the edge.
const HOME_BTN_TOP_MARGIN: i32 = 8;

/// True while the kiosk is collapsed to the home-bar strip (user swiped up to the
/// Windows desktop). The watchdog checks this and leaves the window alone so it
/// does not immediately re-pin it back to full-screen. Set by `enter_home`,
/// cleared by `exit_home`.
pub static HOME_MODE: AtomicBool = AtomicBool::new(false);

/// Mirror of `prefs.hide_on_rdp` so the watchdog can read the user's choice each
/// tick without touching disk. Set at startup from prefs and updated live by the
/// `xenon-home:rdp-on/off` signal (see lib.rs).
pub static HIDE_ON_RDP: AtomicBool = AtomicBool::new(false);

/// True while the kiosk is hidden because a Windows Remote Desktop session is
/// active, so we hide/show only on the transition (and restore placement once the
/// session ends) instead of every 3-second tick.
static RDP_HIDDEN: AtomicBool = AtomicBool::new(false);

/// True while the window is hidden because the screen the user CHOSE is not
/// connected. Same transition-only shape as `RDP_HIDDEN`.
static NO_SCREEN: AtomicBool = AtomicBool::new(false);

/// True while the tray's "Show Xenon" has deliberately overridden a hidden state
/// for this session. The user asked to see it now; that is not a change of mind
/// about where it lives, so nothing is written to prefs and the next topology
/// change re-evaluates from scratch.
static SHOW_OVERRIDE: AtomicBool = AtomicBool::new(false);

/// True while the main window holds the "widgets only" driver page
/// (server/shell-driver.html): the user chose no dashboard on this PC, the
/// widgets live in the layer windows and the driver only keeps them in sync.
/// Like `Phone`, nothing is shown and nothing is re-pinned; unlike `Phone` it is
/// not a placement but follows the page. Seeded at startup from the mirror in
/// prefs (`widgets_only`) so the watchdog does not bring the splash up first.
static DRIVER: AtomicBool = AtomicBool::new(false);

/// The path the server redirects the main window to in "widgets only" mode.
pub const DRIVER_PATH: &str = "/shell-driver";

/// True while someone in "widgets only" looks at the dashboard (`full=1`: the
/// menu, the tray, a Deck key). It is a visit, not a change of mode: the dashboard
/// opens as an ordinary window on the screen the user is on, wherever the saved
/// placement points (an Edge they do not want it on, say), the mirror in prefs
/// stays, and closing the window goes back to the driver instead of quitting.
static VISIT: AtomicBool = AtomicBool::new(false);

/// The user opened Xenon by hand and the main window has not loaded a page yet.
/// With "widgets only" that page is the driver, which hides the window, and an app
/// that opens and shows nothing reads as broken: the first load opens the Xenon
/// menu instead, the same as double-clicking it while it runs.
static STARTED_BY_HAND: AtomicBool = AtomicBool::new(false);

/// The OS name of the screen the visit opened on.
static VISIT_SCREEN: Mutex<Option<String>> = Mutex::new(None);

/// Mirror of the placement triple, so the watchdog can read the user's choice on
/// every 3-second tick without touching disk — the same reason `HIDE_ON_RDP`
/// exists. Seeded at startup (see lib.rs) and updated by every writer.
///
/// Copy the value out before calling any window API: holding this across a call
/// that can re-enter (a tray handler, a signal thread) would deadlock.
static PLACEMENT: Mutex<PlacementCache> = Mutex::new(PlacementCache {
    mode: Placement::Auto,
    monitor: None,
    fingerprint: None,
    fullscreen: false,
});

/// Whether the window is allowed to be visible right now.
///
/// Three independent reasons can hide it, and before this predicate existed the
/// RDP branch called `window.show()` unconditionally — so ending a remote session
/// would reveal a window that phone mode, or a missing screen, still wanted
/// hidden. Every `show()` outside the deliberate tray override goes through here.
fn may_show() -> bool {
    if SHOW_OVERRIDE.load(Ordering::SeqCst) || VISIT.load(Ordering::SeqCst) {
        return true;
    }
    !RDP_HIDDEN.load(Ordering::SeqCst)
        && !NO_SCREEN.load(Ordering::SeqCst)
        && placement_cache().mode != Placement::Phone
        && !DRIVER.load(Ordering::SeqCst)
}

/// Show the window only if nothing else wants it hidden.
fn show_if_allowed(window: &WebviewWindow) {
    if may_show() {
        show_window(window);
    }
}

/// Shows the window, leaving the keyboard where it is unless `focus` asks for it.
/// Windows and macOS do that by themselves; on X11 the window manager hands a
/// window the focus as it maps, unless the window says not to.
fn show_for(window: &WebviewWindow, focus: bool) {
    #[cfg(target_os = "linux")]
    focus_on_map(window, focus);
    #[cfg(not(target_os = "linux"))]
    let _ = focus;
    show_if_allowed(window);
    #[cfg(target_os = "linux")]
    focus_on_map(window, true);
}

// Queued on the main thread, in order with the show between the two calls.
#[cfg(target_os = "linux")]
fn focus_on_map(window: &WebviewWindow, on: bool) {
    use gtk::prelude::GtkWindowExt;
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        // Redundant here, as in `gdk_fullscreen_on`, for check-platform-apis.
        #[cfg(target_os = "linux")]
        if let Ok(gtk_win) = target.gtk_window() {
            gtk_win.set_focus_on_map(on);
        }
    });
}

/// Every hide and show of the main window goes through these two, so a hidden
/// dashboard (phone mode, widgets only, Remote Desktop, the tray) hands its
/// memory back and a shown one asks for it first (see `memory_level.rs`).
pub fn hide_window(window: &WebviewWindow) {
    let _ = window.hide();
    memory_level::set_low(window, true);
}

fn show_window(window: &WebviewWindow) {
    memory_level::set_low(window, false);
    let _ = window.show();
}

/// Whether this process is running inside a Windows Remote Desktop / Terminal
/// Services session. `SM_REMOTESESSION` is true ONLY for a genuine `mstsc`/RDP
/// login — a Sunshine/Moonlight stream of the physical console session reports
/// false, so our own remote-control feature never trips the RDP hide.
#[cfg(windows)]
fn is_remote_session() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetSystemMetrics(index: i32) -> i32;
    }
    const SM_REMOTESESSION: i32 = 0x1000;
    unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 }
}

#[cfg(not(windows))]
fn is_remote_session() -> bool {
    false
}

/// Apply the Remote-Desktop hide immediately (not on the next watchdog tick), so a
/// launch that begins inside an RDP session doesn't flash the kiosk over the remote
/// desktop for a full watchdog interval before the loop's first check hides it.
/// No-op unless the pref is on AND we're currently in a remote session; the watchdog
/// then owns the show-again-at-console transition as usual.
pub fn apply_rdp_hide_now(window: &WebviewWindow) {
    if HIDE_ON_RDP.load(Ordering::SeqCst) && is_remote_session() && !RDP_HIDDEN.swap(true, Ordering::SeqCst) {
        hide_window(window);
    }
}

/// How much of the host screen a windowed dashboard fills. Large enough to read
/// as "Xenon opened on this screen", short of the edges so it is still visibly a
/// window: the title bar is reachable, the desktop shows around it, and nothing
/// is hidden behind a taskbar or a menu bar.
///
/// It used to be `min(92% of the width, 1600px)` at the EDGE's 3.556:1 aspect,
/// which is why a fresh install on an ordinary monitor opened a 1600×450 letter
/// slot: the shape of a CORSAIR Xeneon Edge on a screen that is not one. The
/// dashboard lays out for the window it is given, so there was never anything to
/// protect by keeping that aspect — only a panel size copied onto every machine.
const WINDOW_SCREEN_FRACTION: f64 = 0.88;

/// Floor for the windowed size, matching the window's own minimum (640×240).
const MIN_WINDOW_WIDTH: f64 = 640.0;
const MIN_WINDOW_HEIGHT: f64 = 240.0;

/// How often the watchdog re-checks the window is on the Edge.
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(3);

/// How many consecutive ticks may try to move a window that will not land, before
/// the watchdog stops and waits for something to actually change.
///
/// A re-pin is a repair, not a loop. `place_on_edge` drops fullscreen, moves the
/// window and re-enters fullscreen — a real mode change for the compositor — and the
/// chase condition is "the window is not on the target", which a display that is
/// flapping (being turned off and on, a link renegotiating, a driver recovering)
/// never stops satisfying. Uncapped, that is a fullscreen transition every three
/// seconds forever, aimed at a display stack at the exact moment it is least able to
/// take it. Five attempts is fifteen seconds: far longer than a re-pin that is going
/// to work needs, and it re-arms on the next genuine topology change, so nothing that
/// legitimately needs repairing is left unrepaired.
const MAX_REPIN_ATTEMPTS: u32 = 5;

/// Ticks in which the kiosk is raised after a screen goes away: the one that sees
/// the loss and the next, for the windows Windows finishes moving late.
const RAISE_TICKS_AFTER_LOSS: u8 = 2;

/// After the quick attempts, one more full re-placement this often while the
/// window is still off its screen, instead of never again. Reported from a Mac:
/// after every wake from sleep the dashboard sat on the main screen as a small
/// window until it was moved back by hand. The quick attempts had run out while
/// the displays were still coming back, the layout then read the same as before
/// the sleep (so no "topology change" re-armed them), and nothing ever tried again.
/// Once a minute cannot thrash a display that is flapping, and it does not apply
/// in a game (see `repin_action`).
const SLOW_REPIN_EVERY: Duration = Duration::from_secs(60);

/// A gap between two watchdog ticks longer than this means the machine slept.
/// Measured on the wall clock: the monotonic clock stops during sleep on macOS,
/// so an `Instant` would see three seconds where the user saw a night.
const SLEEP_GAP: Duration = Duration::from_secs(20);

/// After a wake, how long the attempt cap is lifted: the time a display takes to
/// come back from sleep, renegotiate its link and report its real mode. The Edge
/// can be the last screen to do so.
const SETTLE_AFTER_WAKE: Duration = Duration::from_secs(30);

/// Slow retries write to the crash log at most this often, so a window that can
/// never land (a display that is gone for good) does not fill the file.
const SLOW_REPIN_LOG_EVERY: Duration = Duration::from_secs(30 * 60);

/// How long a cross-screen move on macOS may take before the window is sized. See
/// `wait_until_on`.
#[cfg(target_os = "macos")]
const LANDING_WAIT: Duration = Duration::from_millis(600);
#[cfg(target_os = "macos")]
const LANDING_POLL: Duration = Duration::from_millis(50);

/// The length of the sleep between two ticks, or `None` when there was none (an
/// ordinary tick, or a clock that was set back, which is not a sleep).
fn slept(prev: SystemTime, now: SystemTime) -> Option<Duration> {
    match now.duration_since(prev) {
        Ok(gap) if gap > SLEEP_GAP => Some(gap),
        _ => None,
    }
}

/// Whether a re-placement goes in the crash log: every quick attempt, and a slow
/// retry only when the last logged one is old enough.
fn should_log_repin(attempts: u32, since_last_slow_log: Option<Duration>) -> bool {
    attempts < MAX_REPIN_ATTEMPTS || since_last_slow_log.map_or(true, |d| d >= SLOW_REPIN_LOG_EVERY)
}

/// What one watchdog tick does about a kiosk or full-screen window.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Repin {
    Nothing,
    /// The whole re-placement: leave full-screen, move, re-enter, maybe focus.
    Full,
    /// Slide the window back onto its screen and nothing else (`move_back_quietly`).
    Quiet,
}

/// The one rule for re-placing a window that should own a whole screen.
///
/// Outside a game: re-place on a topology change, or while the window sits off
/// its screen, up to the attempt cap.
///
/// During a game, a topology change alone is left alone. It is almost always the
/// game switching resolution for exclusive full-screen, and a full re-place there
/// once bounced the game in and out of full-screen until Xenon was force-quit
/// (see the Edge branch of `start_watchdog`). But a window that has LEFT its
/// screen is still brought back, quietly. Windows moves windows off a display
/// whose mode changes under them, and a game turning HDR on does exactly that:
/// reported on Discord with Control Resonant in borderless full-screen, the
/// dashboard moved to the main display and stayed there, behind the game, until
/// Alt+Tab ended game mode. Turning HDR on from Windows settings moved it too,
/// and it came back a few seconds later, because nothing was being played.
///
/// `since_last` is the time since the previous attempt. Past the cap, a window
/// still off its screen gets one full attempt per `SLOW_REPIN_EVERY`, outside a
/// game only: in a game the quick, quiet attempts are all there is.
fn repin_action(gaming: bool, drifted: bool, topology_changed: bool, attempts: u32, since_last: Option<Duration>) -> Repin {
    let quick = drifted && attempts < MAX_REPIN_ATTEMPTS;
    let slow = drifted && since_last.map_or(false, |d| d >= SLOW_REPIN_EVERY);
    if gaming {
        if quick { Repin::Quiet } else { Repin::Nothing }
    } else if topology_changed || quick || slow {
        Repin::Full
    } else {
        Repin::Nothing
    }
}

/// Put the window back over the whole of `monitor` without activating it, without
/// changing its z-order and without a full-screen transition: a single
/// `SetWindowPos` with `SWP_NOACTIVATE`. This is what makes it safe mid-game.
/// `place_on_edge` drops and re-enters full-screen and may raise the window, and
/// either can take the foreground from the game; a plain move takes nothing.
/// The window keeps its borderless kiosk chrome while it is moved, so covering
/// the screen's rectangle looks exactly like full-screen on it. When game mode
/// ends, the ordinary re-pin is free to run again.
#[cfg(windows)]
fn move_back_quietly(window: &WebviewWindow, monitor: &Monitor) {
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    }
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_NOOWNERZORDER: u32 = 0x0200;
    restore_quietly(window);
    let Ok(hwnd) = window.hwnd() else { return };
    // Physical pixels on both sides: Monitor reports them, and the process is
    // per-monitor DPI aware, which is what SetWindowPos then takes.
    let p = monitor.position();
    let s = monitor.size();
    unsafe {
        SetWindowPos(
            hwnd.0 as isize,
            0,
            p.x,
            p.y,
            s.width as i32,
            s.height as i32,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
    }
}

/// Game mode only exists on Windows (see `game_mode`), so this never runs elsewhere.
#[cfg(not(windows))]
fn move_back_quietly(_window: &WebviewWindow, _monitor: &Monitor) {}

/// True when a monitor's physical size matches the Edge panel. Some hubs also let
/// us confirm via the device name, but the exact panel size is the reliable
/// signal across DisplayPort/USB-C connections.
fn is_edge(monitor: &Monitor) -> bool {
    if is_edge_size(*monitor.size()) {
        return true;
    }
    // Secondary hint: a name containing "Xeneon" / "Edge" (best-effort only).
    matches!(monitor.name(), Some(name)
        if { let n = name.to_lowercase(); n.contains("xeneon") || n.contains("edge") })
}

/// Locate the Edge among the currently connected monitors, if present.
///
/// A virtual display can advertise 2560×720 too (Xenon's own second-screen driver
/// offers that mode), so `is_edge` alone can land the kiosk on a screen the user
/// cannot see. We therefore prefer a match that is NOT a known virtual display,
/// and fall back to the plain first match — if the virtual-display lookup is
/// wrong or unavailable, the worst case is the old behaviour rather than no Edge
/// at all.
fn find_edge(window: &WebviewWindow) -> Option<Monitor> {
    find_edge_in(monitors_of(window)?)
}

/// The same search over a list read from anywhere — the window, or the app handle
/// before a window exists (see `opens_as_kiosk`).
fn find_edge_in(monitors: Vec<Monitor>) -> Option<Monitor> {
    let candidates: Vec<Monitor> = monitors.into_iter().filter(is_edge).collect();
    if candidates.len() < 2 {
        return candidates.into_iter().next();
    }
    let virtual_names = virtual_display_names();
    let is_virtual = |m: &Monitor| {
        matches!(m.name(), Some(name) if virtual_names.iter().any(|v| v == name))
    };
    let real = candidates.iter().position(|m| !is_virtual(m));
    let pick = real.unwrap_or(0);
    candidates.into_iter().nth(pick)
}

/// Whether the window currently sits on the given monitor (compared by origin).
fn window_is_on(window: &WebviewWindow, monitor: &Monitor) -> bool {
    match current_of(window) {
        Some(current) => current.position() == monitor.position(),
        None => false,
    }
}

/// Whether the window has been minimized, by anything: Xenon itself never does it.
fn minimized(window: &WebviewWindow) -> bool {
    let w = window.clone();
    on_main(window.app_handle(), move || w.is_minimized().unwrap_or(false)).unwrap_or(false)
}

/// Whether the kiosk has left its screen: moved off it, or minimized.
///
/// A minimized window still answers for the screen it came from, so the origin
/// alone reads it as in place, and the kiosk has no taskbar button to bring it back
/// with. Windows 11 minimizes windows when a monitor goes away, its default, and a
/// KVM switch takes one away. Reported on Discord: the Edge showed the desktop
/// after every switch until "Automatic" was picked in the tray.
fn kiosk_off_screen(on_it: bool, minimized: bool) -> bool {
    !on_it || minimized
}

/// Bring a minimized window back without taking the foreground from whatever is
/// in use, a game included. `unminimize` would: it is `SW_RESTORE`, which activates.
#[cfg(windows)]
fn restore_quietly(window: &WebviewWindow) {
    #[link(name = "user32")]
    extern "system" {
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    }
    const SW_SHOWNOACTIVATE: i32 = 4;
    if !minimized(window) {
        return;
    }
    let Ok(hwnd) = window.hwnd() else { return };
    unsafe {
        ShowWindow(hwnd.0 as isize, SW_SHOWNOACTIVATE);
    }
}

#[cfg(not(windows))]
fn restore_quietly(window: &WebviewWindow) {
    if minimized(window) {
        let _ = window.unminimize();
    }
}

/// ── Monitor geometry, in the units the WINDOW will read it back in ──────────
///
/// `Monitor::position()` and `Monitor::size()` are built with the scale factor of
/// the monitor being asked about. `set_position` and `set_size` convert whatever
/// they are given with the scale factor of the display the window is on RIGHT
/// NOW. On Windows and Linux both are physical pixels and the two agree. On macOS
/// they are two different numbers the moment the screens differ — a Retina main
/// display beside a 1× Xeneon Edge — and the mismatch is silent, because nothing
/// fails: asking for the Edge's origin (1512, 0) while the window still sits on a
/// 2× screen lands it at (756, 0), which is a point INSIDE the main display. The
/// window never leaves it, and the kiosk that was supposed to own the panel stays
/// a window on the other screen.
///
/// Reported by the first person to run Xenon on a Mac with an Edge attached: the
/// panel was detected, tagged "Xeneon Edge" in the picker and chosen, and the
/// dashboard opened as a window on his main display anyway — which is what makes
/// this worth a helper rather than a cast at each call site. It is every screen,
/// not only the Edge: moving the dashboard to ANY second display with a different
/// backing scale had the same fate.
///
/// So on macOS everything is expressed in LOGICAL units, which pass through that
/// conversion unchanged and therefore mean the same thing on either display.
/// Elsewhere the physical values are already right and mixed-DPI Windows depends
/// on them, so nothing about those platforms changes.
struct MonitorRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn monitor_rect(monitor: &Monitor) -> MonitorRect {
    let p = monitor.position();
    let s = monitor.size();
    // The one line that differs per platform, kept here so every caller below is
    // written once and reads the same on all three.
    #[cfg(target_os = "macos")]
    let k = 1.0 / monitor.scale_factor().max(1.0);
    #[cfg(not(target_os = "macos"))]
    let k = 1.0;
    MonitorRect {
        x: p.x as f64 * k,
        y: p.y as f64 * k,
        w: s.width as f64 * k,
        h: s.height as f64 * k,
    }
}

#[cfg(target_os = "macos")]
fn point(x: f64, y: f64) -> tauri::Position {
    tauri::Position::Logical(tauri::LogicalPosition::new(x, y))
}
#[cfg(not(target_os = "macos"))]
fn point(x: f64, y: f64) -> tauri::Position {
    tauri::Position::Physical(tauri::PhysicalPosition::new(
        x.round() as i32,
        y.round() as i32,
    ))
}

#[cfg(target_os = "macos")]
fn extent(w: f64, h: f64) -> tauri::Size {
    tauri::Size::Logical(LogicalSize::new(w.max(1.0), h.max(1.0)))
}
#[cfg(not(target_os = "macos"))]
fn extent(w: f64, h: f64) -> tauri::Size {
    tauri::Size::Physical(PhysicalSize::new(
        w.max(1.0).round() as u32,
        h.max(1.0).round() as u32,
    ))
}

/// Move the kiosk window onto the Edge and make it borderless full-screen there.
///
/// Fullscreen follows the monitor the window sits on, so we must drop fullscreen,
/// move onto the Edge origin, then re-enter fullscreen — otherwise `set_position`
/// is ignored while the window is still fullscreen on another display.
///
/// `focus` is what separates a deliberate placement from a background repair.
/// Placing the kiosk at startup, or when the user asks for it, should bring it
/// forward. A watchdog re-pin should NOT: it fires on its own schedule, and
/// `set_focus()` there yanks the foreground away from whatever the user is doing
/// — including a window they just dragged onto the Edge, which then drops behind
/// the kiosk and reads as "Xenon is pinned in front of everything". The watchdog
/// passes the answer to "was the kiosk already the foreground?", so a re-pin can
/// still re-raise the kiosk over a taskbar that Windows relocated on top of it
/// (the case the topology check exists for) without ever stealing focus from
/// another app.
fn place_on_edge(window: &WebviewWindow, edge: &Monitor, focus: bool) {
    let rect = monitor_rect(edge);
    restore_quietly(window);
    let _ = window.set_fullscreen(false);
    // Enforce the kiosk chrome: borderless and hidden from the taskbar/Alt-Tab, so
    // that upgrading a windowed session (no Edge → Edge plugged in) becomes a full
    // kiosk, not just a full-screen window with a title bar.
    let _ = window.set_decorations(false);
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_position(point(rect.x, rect.y));
    #[cfg(target_os = "macos")]
    if !wait_until_on(window, edge) {
        crate::crash_log::note("display", "the window had not reached its screen after 600 ms; sizing it anyway");
    }
    enter_borderless_fullscreen(window, edge);
    if focus {
        let _ = window.set_focus();
    }
}

/// Let a cross-screen move land before the window is sized.
///
/// tao queues `set_position` and `set_size` on the main queue, and after a wake
/// from sleep the resize could be applied while the window was still on the main
/// screen: AppKit then fitted it to that screen and it stayed there as a small
/// window. Reported from a Mac, together with the way out the reporter found by
/// hand: put the window on the Edge first, then choose the Edge. This is that,
/// automatically: wait until the window really is on the target, then size it.
///
/// Only off the main thread (the watchdog). On the main thread the queued move
/// cannot run while we wait, so waiting would only freeze the app; there the
/// sizing follows straight away, as before.
#[cfg(target_os = "macos")]
fn wait_until_on(window: &WebviewWindow, monitor: &Monitor) -> bool {
    if thread::current().name() == Some("main") {
        return window_is_on(window, monitor);
    }
    let deadline = Instant::now() + LANDING_WAIT;
    loop {
        if window_is_on(window, monitor) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(LANDING_POLL);
    }
}

/// Make a BORDERLESS window own its whole display.
///
/// Native fullscreen is the answer on Windows and Linux. It is not one on macOS:
/// `toggleFullScreen:` requires a titled window, and calling it on a borderless
/// one segfaults inside AppKit's enter-fullscreen transition (the app died on
/// every launch until this split existed). Covering the monitor's frame by
/// geometry gives the same result — the whole display, no chrome — without the
/// transition, and it keeps the kiosk on the display it was placed on instead of
/// being moved into a Space of its own.
#[cfg(target_os = "macos")]
fn enter_borderless_fullscreen(window: &WebviewWindow, monitor: &Monitor) {
    let rect = monitor_rect(monitor);
    let _ = window.set_size(extent(rect.w, rect.h));
    // Position again AFTER the resize: growing a window near a screen edge can
    // let AppKit nudge it back inside the previous frame.
    let _ = window.set_position(point(rect.x, rect.y));
}

#[cfg(not(target_os = "macos"))]
fn enter_borderless_fullscreen(window: &WebviewWindow, monitor: &Monitor) {
    // On Wayland `set_fullscreen(true)` names no output, so the compositor keeps the
    // window on the one it was mapped on (a client cannot position itself there, so
    // the set_position before this call is ignored). Naming the output is the only
    // way to land on the Edge; on X11 the same call sets _NET_WM_FULLSCREEN_MONITORS.
    #[cfg(target_os = "linux")]
    if fullscreen_on_gdk_monitor(window, monitor) {
        return;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = monitor;
    let _ = window.set_fullscreen(true);
}

/// Fullscreen on the GDK monitor at `monitor`'s origin. False when it cannot be
/// matched (or the window has no GDK window yet), so the caller falls back to the
/// plain call. GTK is single-threaded and the watchdog calls this from its own
/// thread, so the GTK half always runs on the main thread (see `on_main`).
#[cfg(target_os = "linux")]
fn fullscreen_on_gdk_monitor(window: &WebviewWindow, monitor: &Monitor) -> bool {
    let w = window.clone();
    let target = *monitor.position();
    on_main(window.app_handle(), move || gdk_fullscreen_on(&w, target)).unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn gdk_fullscreen_on(window: &WebviewWindow, target: tauri::PhysicalPosition<i32>) -> bool {
    use gdk::prelude::MonitorExt;
    use gtk::prelude::WidgetExt;

    // Redundant inside this Linux-only fn, but check-platform-apis reads only the
    // lines just above a gated API, and a name-wide exemption would hide a later
    // ungated call.
    #[cfg(target_os = "linux")]
    let Ok(gtk_win) = window.gtk_window() else { return false };
    if !gtk_win.is_realized() {
        gtk_win.realize();
    }
    let display = gtk_win.display();
    // Tauri reports a monitor's origin in PHYSICAL pixels, GDK's logical geometry
    // times that monitor's own scale (how tao builds it), so compare in those units:
    // a logical-only compare misses every HiDPI screen and quietly falls back.
    let idx = (0..display.n_monitors()).find(|&i| {
        display.monitor(i).is_some_and(|m| {
            let (g, s) = (m.geometry(), m.scale_factor());
            g.x() * s == target.x && g.y() * s == target.y
        })
    });
    match (idx, gtk_win.window()) {
        (Some(i), Some(gdk_window)) => {
            gdk_window.fullscreen_on_monitor(i);
            true
        }
        _ => false,
    }
}

/// A window sized to the screen that HOSTS it: the monitor's own proportions, at
/// `WINDOW_SCREEN_FRACTION` of its logical size, never larger than the screen and
/// never below the window's own 640×240 minimum.
///
/// The Edge does not come through here — that panel is always the borderless
/// kiosk (`place_on_edge`), which owns the whole display.
fn windowed_size_for(monitor: &Monitor) -> LogicalSize<f64> {
    let scale = monitor.scale_factor();
    // The WORK AREA, not the whole panel: the taskbar, the dock and the menu bar
    // are not ours to sit under. `set_size` sets the INNER size while the frame
    // adds a title bar on top of it, so 88% of the full height plus that bar can
    // reach past the bottom of the screen on a small laptop display — measured at
    // 1366×768 with a 40px taskbar, where the lower resize edge ends up
    // unreachable underneath it.
    let area = monitor.work_area().size;
    let mon_w = area.width as f64 / scale;
    let mon_h = area.height as f64 / scale;
    // Clamped to the screen AFTER the minimum is applied: on a display smaller
    // than 640×240 the floor would otherwise push the window off its own screen.
    let w = (mon_w * WINDOW_SCREEN_FRACTION).max(MIN_WINDOW_WIDTH).min(mon_w);
    let h = (mon_h * WINDOW_SCREEN_FRACTION).max(MIN_WINDOW_HEIGHT).min(mon_h);
    LogicalSize::new(w, h)
}

/// How the window should be BUILT — its size, and whether it starts full-screen —
/// decided before it exists and before `place_now` can measure anything.
/// Returns `(width, height, fullscreen)`, the size in logical pixels.
///
/// The builder used to hardcode 2560×720 and `fullscreen(true)`: the Edge panel's
/// exact resolution, and the Edge's own final state, on every machine. On macOS,
/// where the window cannot be built full-screen at all (see the note in `lib.rs`),
/// that first frame was an Edge-shaped window on a machine with no Edge; elsewhere
/// it was a full-screen window that `place_now` shrank a moment later — a launch
/// that covers the whole desktop for a frame and then does not.
///
/// This mirrors `resolve`, deliberately and in the same order, because the only
/// useful question here is "what will `place_now` do a moment from now". An
/// approximation of that question is not cheaper, it is just wrong in both
/// directions: judging the Edge by SIZE ALONE misses one recognised by name only
/// (the hub case `is_edge` exists for) and, worse, matches Xenon's own virtual
/// second-screen display, which advertises 2560×720 — so a user who had chosen a
/// real monitor got the full-screen flash this is meant to remove.
pub fn initial_window(app: &AppHandle, prefs: &prefs::DisplayPrefs) -> (f64, f64, bool) {
    let (target, fullscreen) = initial_target(app, prefs);
    match target {
        Some(m) => {
            if fullscreen {
                let scale = m.scale_factor();
                let size = m.size();
                (
                    size.width as f64 / scale,
                    size.height as f64 / scale,
                    true,
                )
            } else {
                let size = windowed_size_for(&m);
                (size.width, size.height, false)
            }
        }
        // No monitor answered — the Edge's own size is as good a guess as any,
        // and `place_now` corrects it as soon as a screen can be read.
        None => (EDGE_WIDTH as f64, EDGE_HEIGHT as f64, false),
    }
}

/// The OS name of the screen the window is about to open on, for `gpu::arm`:
/// the render GPU has to be the one driving THAT screen, and it is chosen before
/// any window exists.
pub fn initial_screen_name(app: &AppHandle, prefs: &prefs::DisplayPrefs) -> Option<String> {
    initial_target(app, prefs).0.and_then(|m| m.name().cloned())
}

/// `(target screen, kiosk-or-fullscreen)` before the window exists, mirroring
/// `resolve` (see `initial_window` for why it must).
fn initial_target(app: &AppHandle, prefs: &prefs::DisplayPrefs) -> (Option<Monitor>, bool) {
    let monitors = app_monitors(app);
    let primary = app_primary(app);
    // (target screen, kiosk-or-fullscreen), mirroring `resolve`.
    let (target, fullscreen) = match prefs.placement {
        // Nothing on this PC. A deliberate launch still shows an ORDINARY window
        // (see `apply_target`), so size it like one and never full-screen.
        Placement::Phone => (primary, false),
        Placement::Screen => {
            // The same rule as `chosen_monitor`, so the first frame and the
            // first placement agree on the screen.
            let chosen = pick_in(
                &monitors,
                prefs.monitor.as_deref(),
                prefs.monitor_fingerprint.as_deref(),
            )
            .index()
            .map(|i| monitors[i].clone());
            match chosen {
                // The Edge chosen by name is the kiosk; any other screen honours
                // the saved full-screen preference.
                Some(m) => {
                    let fs = is_edge_panel(&m) || prefs.fullscreen;
                    (Some(m), fs)
                }
                // Chosen screen unplugged: the window will be hidden. Size it as a
                // plain window so that revealing it from the tray is not a surprise.
                None => (primary, false),
            }
        }
        Placement::Auto => match find_edge_in(monitors.clone()) {
            Some(edge) => (Some(edge), true),
            None => {
                let preferred = prefs
                    .monitor
                    .as_deref()
                    .and_then(|id| find_by_id(&monitors, id))
                    .map(|i| monitors[i].clone())
                    .or(primary);
                let fs = prefs.fullscreen;
                (preferred, fs)
            }
        },
    };
    (target.or_else(|| monitors.into_iter().next()), fullscreen)
}

/// Ordinary, controllable desktop window on the given monitor: a title bar, a
/// taskbar entry, sized to fit that screen and centred on it. Used off the Edge —
/// the kiosk chrome would trap the user in a borderless fullscreen with no way out.
fn place_windowed_on(window: &WebviewWindow, monitor: &Monitor, focus: bool) {
    let _ = window.set_fullscreen(false);
    let _ = window.set_decorations(true);
    let _ = window.set_skip_taskbar(false);
    let _ = window.set_size(windowed_size_for(monitor));
    // Sit on the target monitor, then centre within it.
    let rect = monitor_rect(monitor);
    let _ = window.set_position(point(rect.x, rect.y));
    let _ = window.center();
    if focus {
        let _ = window.set_focus();
    }
}

/// Full-screen on the given monitor, but still reachable on an ordinary PC: it
/// stays in the taskbar / Alt-Tab and a title bar returns if the user leaves
/// full-screen from the tray. (This is the non-Edge "fullscreen" choice — distinct
/// from the borderless, taskbar-hidden Edge kiosk in `place_on_edge`.)
fn place_fullscreen_on(window: &WebviewWindow, monitor: &Monitor, focus: bool) {
    let _ = window.set_fullscreen(false);
    let _ = window.set_decorations(true);
    let _ = window.set_skip_taskbar(false);
    let rect = monitor_rect(monitor);
    let _ = window.set_position(point(rect.x, rect.y));
    // macOS takes a window full screen on the display it is on NOW, so the same
    // wait as `place_on_edge`: the move first, then full screen.
    #[cfg(target_os = "macos")]
    if !wait_until_on(window, monitor) {
        crate::crash_log::note("display", "the window had not reached its screen after 600 ms; going full screen anyway");
    }
    let _ = window.set_fullscreen(true);
    if focus {
        let _ = window.set_focus();
    }
}

/// The primary monitor, or the first available one if the primary is unknown.
fn primary_or_first(window: &WebviewWindow) -> Option<Monitor> {
    primary_of(window).or_else(|| monitors_of(window).and_then(|m| m.into_iter().next()))
}

/// True when this monitor IS the Edge panel, judged on size alone (either
/// orientation — see `is_edge_size`).
///
/// Deliberately not `is_edge`: that one also matches any display whose OS name
/// merely contains "edge" or "xeneon", which is a fine hint for the auto-pin and
/// a trap here. Under "an explicit choice wins", a false positive would drop the
/// user's chosen monitor into a borderless, undecorated, taskbar-hidden window
/// with no title bar and no way out.
fn is_edge_panel(monitor: &Monitor) -> bool {
    is_edge_size(*monitor.size())
}

/// True when a Xeneon Edge is connected right now.
pub fn edge_present(window: &WebviewWindow) -> bool {
    find_edge(window).is_some()
}

/// True when the kiosk window currently holds the OS foreground. The watchdog
/// asks before re-focusing on a re-pin: re-asserting full-screen over a taskbar
/// Windows moved onto the Edge is worth a raise, but only when the kiosk was
/// already the window in use. If anything else has the foreground — most often a
/// window the user deliberately dragged onto the Edge — the re-pin stays silent.
#[cfg(windows)]
fn kiosk_has_foreground(window: &WebviewWindow) -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
    }
    let Ok(hwnd) = window.hwnd() else { return false };
    unsafe { GetForegroundWindow() == hwnd.0 as isize }
}

#[cfg(not(windows))]
fn kiosk_has_foreground(_window: &WebviewWindow) -> bool {
    true
}

/// True when the foreground belongs to any window of this process, the menu too.
#[cfg(windows)]
fn xenon_has_foreground(_window: &WebviewWindow) -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
        fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(GetForegroundWindow(), &mut pid) };
    pid == std::process::id()
}

// Elsewhere the windows themselves say who holds the keyboard, on X11, Wayland and macOS.
#[cfg(not(windows))]
fn xenon_has_foreground(window: &WebviewWindow) -> bool {
    window.app_handle().webview_windows().values().any(|w| w.is_focused().unwrap_or(false))
}

/// Self-heal a stuck "always on top". The only thing that legitimately makes the
/// kiosk topmost is the round home button (`enter_home`), and `exit_home` clears
/// it — but nothing clears a `WS_EX_TOPMOST` that arrives any other way (an
/// abandoned home mode, an external tool, a shell that lost the flag's bookkeeping
/// across a hide/show). Left set, every window the user moves onto the Edge lands
/// behind the dashboard with no way to bring it forward, which is a dead end for
/// them and invisible to us.
///
/// The style is READ first and only cleared when actually set: `SetWindowPos` with
/// `HWND_NOTOPMOST` also lifts the window to the top of the normal z-order, so
/// calling it unconditionally would reintroduce, once per tick, exactly the
/// jumping-to-the-front this is meant to stop. Cheap enough to check every tick.
#[cfg(windows)]
fn clear_stuck_topmost(window: &WebviewWindow) {
    #[link(name = "user32")]
    extern "system" {
        fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
        fn SetWindowPos(
            hwnd: isize,
            insert_after: isize,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_TOPMOST: isize = 0x0000_0008;
    const HWND_NOTOPMOST: isize = -2;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOACTIVATE: u32 = 0x0010;

    // Lifted over the desktop on purpose while Win+D shows it (show_desktop.rs).
    if crate::show_desktop::raised() {
        return;
    }
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as isize;
    unsafe {
        if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST == 0 {
            return; // not pinned — nothing to undo
        }
        SetWindowPos(
            hwnd,
            HWND_NOTOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
    // Keep the shell's own bookkeeping in step, so a later always-on-top toggle
    // still sees a state change and issues its SetWindowPos.
    let _ = window.set_always_on_top(false);
}

/// Put the kiosk back in front of the windows a lost screen pushed onto its own,
/// without taking the foreground.
///
/// When a monitor goes away (a KVM switch, a cable, power), Windows moves that
/// screen's windows onto the screens left, the Edge included, and stacks them above
/// the kiosk. Nothing is minimized and the kiosk has not moved, so the re-pin finds
/// it in place, and `place_on_edge` raises it only when it already had the
/// foreground. Reported with a KVM switch: the Edge showed the browser left open on
/// the main screen for as long as the switch was away, unless every window had been
/// minimized first.
///
/// HWND_NOTOPMOST does nothing to a window that is not topmost, so the window is
/// made topmost and at once ordinary again: that leaves it above every ordinary
/// window and below the taskbar, which keeps the moved windows one click away for
/// someone still at this PC. It is never left pinned (see `clear_stuck_topmost`),
/// and SWP_NOACTIVATE leaves the foreground where it was.
#[cfg(windows)]
fn raise_quietly(window: &WebviewWindow) {
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    }
    const HWND_TOPMOST: isize = -1;
    const HWND_NOTOPMOST: isize = -2;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOACTIVATE: u32 = 0x0010;
    // Lifted over the desktop on purpose while Win+D shows it (show_desktop.rs).
    if crate::show_desktop::raised() {
        return;
    }
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as isize;
    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
    unsafe {
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
        SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
    }
}

// Only Windows has been seen stacking a lost screen's windows over the kiosk.
#[cfg(not(windows))]
fn raise_quietly(_window: &WebviewWindow) {}

/// One entry per connected monitor, shared by the tray picker and the dashboard's
/// Settings → Screen list so the two can never disagree about what is attached.
pub struct DisplayInfo {
    /// Never empty — see `display_id`. An unnamed output is identified by shape.
    pub id: String,
    pub label: String,
    /// The model, as a person knows the screen. Empty when the system reports none.
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// Where it sits on the desktop, so the menu can draw the screens as they stand.
    pub x: i32,
    pub y: i32,
    pub scale: f64,
    pub primary: bool,
    pub edge: bool,
}

impl DisplayInfo {
    /// The label for a plain text menu, where "which one is the Edge" has to be
    /// spelled out because there is nowhere to put a chip.
    pub fn tray_label(&self) -> String {
        if self.edge {
            format!("{} (Xeneon Edge)", self.label)
        } else if self.primary {
            format!("{} (primary)", self.label)
        } else {
            self.label.clone()
        }
    }
}

/// Every connected monitor, in enumeration order.
///
/// The index in `Display N` is only a human hint: on Windows the OS name is
/// `\\.\DISPLAYn`, assigned by ORDER, so both the number and the name shift when
/// screens are replugged. With two identical panels the resolution alone tells
/// you nothing either, which is why `primary` and `edge` are reported as flags —
/// the dashboard renders them as chips, and the tray, which has no chips, spells
/// them into the label itself (see `tray_label`).
pub fn displays(window: &WebviewWindow) -> Vec<DisplayInfo> {
    let primary = primary_of(window);
    let monitors = monitors_of(window).unwrap_or_default();
    describe(monitors, primary)
}

/// The same list, read from the app handle instead of a window.
///
/// The screens can be enumerated before the window exists, and that is the point:
/// the caps the shell injects into the page carry the monitor list from the very
/// first render (see `lib.rs`), so the first-run picker draws its screens straight
/// away instead of waiting on `push_display_state` — a push that arrives after the
/// dashboard loads, and that a page which never gets one leaves stuck on "Reading
/// the screens on this PC…".
pub fn displays_for_app(app: &AppHandle) -> Vec<DisplayInfo> {
    let primary = app_primary(app);
    let monitors = app_monitors(app);
    describe(monitors, primary)
}

fn describe(monitors: Vec<Monitor>, primary: Option<Monitor>) -> Vec<DisplayInfo> {
    let ids = display_ids(&monitors);
    // Which entry is the primary is decided by its ORIGIN, not by its id: two
    // same-model monitors on macOS report the same name, and matching on that
    // flagged both of them primary.
    let primary_origin = primary.as_ref().map(|m| *m.position());
    let models = crate::monitor_names::model_names(&monitors);
    monitors
        .into_iter()
        .enumerate()
        .map(|(i, m)| {
            let s = m.size();
            let id = ids[i].clone();
            let edge = is_edge_panel(&m);
            let primary = primary_origin == Some(*m.position());
            DisplayInfo {
                id,
                label: format!("Display {} — {}×{}", i + 1, s.width, s.height),
                name: crate::monitor_names::display_name(&models[i], edge),
                width: s.width,
                height: s.height,
                x: m.position().x,
                y: m.position().y,
                scale: m.scale_factor(),
                primary,
                edge,
            }
        })
        .collect()
}

/// The monitor list as the dashboard consumes it, without the placement half of
/// `display_state` (which needs a window to report the ACTIVE screen honestly).
pub fn display_list_json(app: &AppHandle) -> serde_json::Value {
    serde_json::Value::Array(displays_for_app(app).iter().map(display_json).collect())
}

fn display_json(d: &DisplayInfo) -> serde_json::Value {
    serde_json::json!({
        "id": d.id, "label": d.label, "name": d.name, "width": d.width, "height": d.height,
        "x": d.x, "y": d.y, "scale": d.scale, "primary": d.primary, "edge": d.edge,
    })
}

/// The whole display state, as the dashboard consumes it. `active` is the screen
/// the window is really on — the page shows the truth, not the intent.
pub fn display_state(window: &WebviewWindow) -> serde_json::Value {
    let cache = placement_cache();
    let list: Vec<serde_json::Value> = displays(window).iter().map(display_json).collect();
    // Reported with `display_id`, the same key the list uses, so the dashboard's
    // `d.id === state.active` comparison keeps working on outputs the OS did not
    // name (where it used to compare against `null` and never match).
    let active = current_of(window)
        .and_then(|m| id_of(window, &m));
    let missing = cache.mode == Placement::Screen && chosen_monitor(window, &cache).is_none();
    serde_json::json!({
        "displays": list,
        "display": {
            "mode": match cache.mode {
                Placement::Auto => "auto",
                Placement::Screen => "screen",
                Placement::Phone => "phone",
            },
            "monitor": cache.monitor,
            "fullscreen": cache.fullscreen,
            "active": active,
            "missing": missing,
            // A display change after launch can leave the webview rendering on one
            // GPU while the kiosk is presented by another, which costs real CPU for
            // as long as the app stays up and can only be fixed by restarting it
            // (see gpu.rs). Reported here because Settings → Screen is both where
            // this becomes true and where the user is standing when it does.
            "gpuMismatch": gpu_mismatch(window),
        }
    })
}

#[cfg(test)]
mod repin_tests {
    use super::*;

    const NEVER: Option<Duration> = None;
    fn secs(n: u64) -> Option<Duration> { Some(Duration::from_secs(n)) }

    #[test]
    fn outside_a_game_a_topology_change_or_a_drift_re_places_fully() {
        assert_eq!(repin_action(false, false, true, 0, NEVER), Repin::Full);
        assert_eq!(repin_action(false, true, false, 0, NEVER), Repin::Full);
        assert_eq!(repin_action(false, false, false, 0, NEVER), Repin::Nothing);
    }

    #[test]
    fn a_game_switching_resolution_is_left_alone() {
        // The exclusive full-screen bounce: the layout changed, the window is where
        // it belongs. Nothing may run, or the game loses the foreground.
        assert_eq!(repin_action(true, false, true, 0, NEVER), Repin::Nothing);
    }

    #[test]
    fn a_window_moved_off_its_screen_mid_game_comes_back_quietly() {
        // A game turning HDR on: Windows moved the dashboard to the main display.
        assert_eq!(repin_action(true, true, true, 0, NEVER), Repin::Quiet);
        assert_eq!(repin_action(true, true, false, 2, secs(3)), Repin::Quiet);
    }

    #[test]
    fn the_attempt_cap_holds_in_and_out_of_a_game() {
        assert_eq!(repin_action(true, true, false, MAX_REPIN_ATTEMPTS, secs(3)), Repin::Nothing);
        assert_eq!(repin_action(false, true, false, MAX_REPIN_ATTEMPTS, secs(3)), Repin::Nothing);
        // A real layout change outside a game still re-places past the cap.
        assert_eq!(repin_action(false, true, true, MAX_REPIN_ATTEMPTS, secs(3)), Repin::Full);
    }

    #[test]
    fn past_the_cap_a_window_still_off_its_screen_is_retried_once_a_minute() {
        // The Mac after a wake: five quick attempts did not land, the layout reads
        // the same as before the sleep. It used to stay on the main screen for good.
        assert_eq!(repin_action(false, true, false, MAX_REPIN_ATTEMPTS, secs(59)), Repin::Nothing);
        assert_eq!(repin_action(false, true, false, MAX_REPIN_ATTEMPTS, secs(60)), Repin::Full);
        assert_eq!(repin_action(false, true, false, MAX_REPIN_ATTEMPTS + 40, secs(600)), Repin::Full);
        // Only while it is off its screen, and never in a game.
        assert_eq!(repin_action(false, false, false, MAX_REPIN_ATTEMPTS, secs(600)), Repin::Nothing);
        assert_eq!(repin_action(true, true, false, MAX_REPIN_ATTEMPTS, secs(600)), Repin::Nothing);
    }

    #[test]
    fn a_minimized_kiosk_has_left_its_screen_even_where_its_origin_still_matches() {
        assert!(kiosk_off_screen(true, true));
        assert!(kiosk_off_screen(false, false));
        assert!(!kiosk_off_screen(true, false));
    }

    #[test]
    fn a_long_gap_between_ticks_is_a_sleep_and_a_short_one_is_not() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert_eq!(slept(t0, t0 + Duration::from_secs(3)), None, "an ordinary tick");
        assert_eq!(slept(t0, t0 + SLEEP_GAP), None, "exactly the threshold is not a sleep");
        assert_eq!(slept(t0, t0 + Duration::from_secs(8 * 3600)), Some(Duration::from_secs(8 * 3600)));
        assert_eq!(slept(t0, t0 - Duration::from_secs(3600)), None, "a clock set back is not a sleep");
    }

    #[test]
    fn slow_retries_are_logged_sparingly() {
        assert!(should_log_repin(0, None));
        assert!(should_log_repin(MAX_REPIN_ATTEMPTS - 1, Some(Duration::from_secs(1))));
        assert!(should_log_repin(MAX_REPIN_ATTEMPTS, None), "the first slow retry is logged");
        assert!(!should_log_repin(MAX_REPIN_ATTEMPTS, Some(Duration::from_secs(60))));
        assert!(should_log_repin(MAX_REPIN_ATTEMPTS, Some(SLOW_REPIN_LOG_EVERY)));
    }
}
