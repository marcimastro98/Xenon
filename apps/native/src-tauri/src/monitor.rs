//! Screen targeting + kiosk watchdog.
//!
//! Where the window goes is decided in ONE place — `resolve()` — from the user's
//! saved `placement` and the live monitor list. Three outcomes:
//!
//!   * `Auto` (default): the Xeneon Edge if one is attached (it reports its
//!     native 2560×720, which is how we find it), otherwise an ordinary window
//!     on the preferred/primary display. A watchdog upgrades to the kiosk the
//!     moment an Edge appears, and re-pins after display reorders, replug or
//!     resume from standby.
//!   * `Screen`: the user NAMED a display and it wins, Edge attached or not. If
//!     that display is gone the window HIDES rather than reappearing somewhere
//!     the user did not ask for; the watchdog restores it when the screen is back.
//!   * `Phone`: nothing on this PC at all.
//!
//! Before v4.11 the Edge always won and the choice did not exist, which is why
//! the tray's monitor picker was greyed out on every machine that had one.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{
    AppHandle, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow,
};

use crate::prefs;
use crate::prefs::Placement;

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
fn gpu_mismatch() -> bool {
    crate::gpu::mismatch()
}
#[cfg(not(windows))]
fn gpu_mismatch() -> bool {
    false
}

/// Native resolution of the CORSAIR Xeneon Edge 14.5" panel.
const EDGE_WIDTH: u32 = 2560;
const EDGE_HEIGHT: u32 = 720;

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

#[derive(Clone)]
struct PlacementCache {
    mode: Placement,
    monitor: Option<String>,
    fingerprint: Option<String>,
    fullscreen: bool,
}

fn placement_cache() -> PlacementCache {
    PLACEMENT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Mark this session as a deliberate, user-initiated launch, so phone mode does
/// not hide a window the user just asked for by double-clicking the app. Set at
/// startup when the process was NOT started by the login entry. Session-only:
/// nothing is written, and the next login is hidden again as chosen.
pub fn allow_show_this_session() {
    SHOW_OVERRIDE.store(true, Ordering::SeqCst);
}

/// Refresh the in-memory mirror. Every writer of the placement triple calls this
/// in the same breath as `prefs::update`, or the watchdog keeps acting on the
/// previous choice until the next launch.
pub fn set_placement_cache(prefs: &prefs::DisplayPrefs) {
    let mut guard = PLACEMENT.lock().unwrap_or_else(|e| e.into_inner());
    guard.mode = prefs.placement;
    guard.monitor = prefs.monitor.clone();
    guard.fingerprint = prefs.monitor_fingerprint.clone();
    guard.fullscreen = prefs.fullscreen;
}

/// Whether the window is allowed to be visible right now.
///
/// Three independent reasons can hide it, and before this predicate existed the
/// RDP branch called `window.show()` unconditionally — so ending a remote session
/// would reveal a window that phone mode, or a missing screen, still wanted
/// hidden. Every `show()` outside the deliberate tray override goes through here.
fn may_show() -> bool {
    if SHOW_OVERRIDE.load(Ordering::SeqCst) {
        return true;
    }
    !RDP_HIDDEN.load(Ordering::SeqCst)
        && !NO_SCREEN.load(Ordering::SeqCst)
        && placement_cache().mode != Placement::Phone
}

/// Show the window only if nothing else wants it hidden.
fn show_if_allowed(window: &WebviewWindow) {
    if may_show() {
        let _ = window.show();
    }
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
        let _ = window.hide();
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

/// True when a monitor's physical size matches the Edge panel. Some hubs also let
/// us confirm via the device name, but the exact 2560×720 size is the reliable
/// signal across DisplayPort/USB-C connections.
fn is_edge(monitor: &Monitor) -> bool {
    let size = monitor.size();
    if size.width == EDGE_WIDTH && size.height == EDGE_HEIGHT {
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
    find_edge_in(window.available_monitors().ok()?)
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
    match window.current_monitor() {
        Ok(Some(current)) => current.position() == monitor.position(),
        _ => false,
    }
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
    let origin: PhysicalPosition<i32> = *edge.position();
    let _ = window.set_fullscreen(false);
    // Enforce the kiosk chrome: borderless and hidden from the taskbar/Alt-Tab, so
    // that upgrading a windowed session (no Edge → Edge plugged in) becomes a full
    // kiosk, not just a full-screen window with a title bar.
    let _ = window.set_decorations(false);
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_position(origin);
    enter_borderless_fullscreen(window, edge);
    if focus {
        let _ = window.set_focus();
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
    let _ = window.set_size(*monitor.size());
    // Position again AFTER the resize: growing a window near a screen edge can
    // let AppKit nudge it back inside the previous frame.
    let _ = window.set_position(*monitor.position());
}

#[cfg(not(target_os = "macos"))]
fn enter_borderless_fullscreen(window: &WebviewWindow, _monitor: &Monitor) {
    let _ = window.set_fullscreen(true);
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
    let monitors = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten();
    // (target screen, kiosk-or-fullscreen), mirroring `resolve`.
    let (target, fullscreen) = match prefs.placement {
        // Nothing on this PC. A deliberate launch still shows an ORDINARY window
        // (see `apply_target`), so size it like one and never full-screen.
        Placement::Phone => (primary, false),
        Placement::Screen => {
            let chosen = prefs
                .monitor
                .as_deref()
                .and_then(|id| find_by_id(&monitors, id))
                .or_else(|| {
                    prefs.monitor_fingerprint.as_deref().and_then(|fp| {
                        monitors.iter().position(|m| fingerprint(m) == fp)
                    })
                })
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
    let target = target.or_else(|| monitors.into_iter().next());
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

/// Ordinary, controllable desktop window on the given monitor: a title bar, a
/// taskbar entry, sized to fit that screen and centred on it. Used off the Edge —
/// the kiosk chrome would trap the user in a borderless fullscreen with no way out.
fn place_windowed_on(window: &WebviewWindow, monitor: &Monitor) {
    let _ = window.set_fullscreen(false);
    let _ = window.set_decorations(true);
    let _ = window.set_skip_taskbar(false);
    let _ = window.set_size(windowed_size_for(monitor));
    // Sit on the target monitor, then centre within it.
    let _ = window.set_position(*monitor.position());
    let _ = window.center();
    let _ = window.set_focus();
}

/// Full-screen on the given monitor, but still reachable on an ordinary PC: it
/// stays in the taskbar / Alt-Tab and a title bar returns if the user leaves
/// full-screen from the tray. (This is the non-Edge "fullscreen" choice — distinct
/// from the borderless, taskbar-hidden Edge kiosk in `place_on_edge`.)
fn place_fullscreen_on(window: &WebviewWindow, monitor: &Monitor) {
    let _ = window.set_fullscreen(false);
    let _ = window.set_decorations(true);
    let _ = window.set_skip_taskbar(false);
    let _ = window.set_position(*monitor.position());
    let _ = window.set_fullscreen(true);
    let _ = window.set_focus();
}

/// The primary monitor, or the first available one if the primary is unknown.
fn primary_or_first(window: &WebviewWindow) -> Option<Monitor> {
    window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.available_monitors().ok().and_then(|m| m.into_iter().next()))
}

/// Prefix marking a display id that is a PLACE, not an OS name (see `display_ids`).
const FP_ID_PREFIX: &str = "fp:";

/// The id every surface uses to name a screen — the tray menu, the first-run
/// picker, Settings → Screen and `display.json` alike. Computed for the WHOLE
/// list at once, because whether a name identifies a screen is a fact about the
/// other screens, not about that one.
///
/// An OS name is used only when it is non-empty AND unique among what is attached
/// right now. Otherwise the screen is identified by its shape and its origin:
/// `fp:2560x1440@1+1920,0`.
///
/// Both halves of that rule are load-bearing, and each covers a platform:
///
///   * Linux/GTK returns `None` for an output it has no model string for. Those
///     displays used to get a `null` id, which the tray menu skipped outright and
///     the picker drew as a button that could not be pressed — listed, and
///     refusing to be chosen.
///   * macOS NEVER returns `None`: tao builds the name from the display's MODEL
///     NUMBER (`Monitor #123`), so two identical monitors — an ordinary dual-screen
///     Mac — report the same name and the same shape. Under a name-only id they
///     shared one identity: both were flagged primary, the tray offered two menu
///     items that did the same thing, and a saved choice of the second could only
///     ever resolve back to the first.
///
/// The origin is what breaks that tie: no two monitors can share one, by
/// definition. It moves when displays are rearranged, which is exactly why
/// `DisplayPrefs::monitor_fingerprint` stays SHAPE-ONLY — the two keys have to be
/// able to fail independently, or the fallback is not a fallback.
fn display_ids(monitors: &[Monitor]) -> Vec<String> {
    let names: Vec<Option<&String>> = monitors.iter().map(|m| m.name()).collect();
    monitors
        .iter()
        .enumerate()
        .map(|(i, m)| match names[i] {
            Some(name)
                if !name.is_empty()
                    && names.iter().filter(|n| **n == Some(name)).count() == 1 =>
            {
                name.to_string()
            }
            _ => {
                let p = m.position();
                format!("{FP_ID_PREFIX}{}+{},{}", fingerprint(m), p.x, p.y)
            }
        })
        .collect()
}

/// The id of one specific monitor, computed in the context of every monitor
/// attached with it. Matched by ORIGIN, the one property no two screens share.
fn id_of(window: &WebviewWindow, target: &Monitor) -> Option<String> {
    let monitors = window.available_monitors().ok()?;
    let i = monitors
        .iter()
        .position(|m| m.position() == target.position())?;
    display_ids(&monitors).into_iter().nth(i)
}

/// Resolve an id from `display_ids` back to a live monitor.
///
/// Recomputed rather than parsed, so the two can never drift apart. The trailing
/// name match is for ids saved by an OLDER build (and by this one, whenever the
/// name was unique at the time): a plain OS name that has since stopped being
/// unique still finds its screen instead of falling through to "not connected".
fn monitor_by_id(window: &WebviewWindow, id: &str) -> Option<Monitor> {
    let monitors = window.available_monitors().ok()?;
    let i = find_by_id(&monitors, id)?;
    monitors.into_iter().nth(i)
}

/// The same lookup over a list read from anywhere — used before a window exists
/// (see `initial_window`), which is why it returns an INDEX and not a `Monitor`.
fn find_by_id(monitors: &[Monitor], id: &str) -> Option<usize> {
    let ids = display_ids(monitors);
    ids.iter()
        .position(|candidate| candidate == id)
        .or_else(|| monitors.iter().position(|m| m.name().map(|n| n.as_str()) == Some(id)))
}

/// The monitor a saved preference points at, falling back to the primary display.
/// Used in `Auto` only, where the saved name is a *preference*; an explicit
/// choice must never silently land somewhere else (see `chosen_monitor`).
fn preferred_monitor(window: &WebviewWindow, prefs: &prefs::DisplayPrefs) -> Option<Monitor> {
    prefs
        .monitor
        .as_deref()
        .and_then(|n| monitor_by_id(window, n))
        .or_else(|| primary_or_first(window))
}

/// A shape-based key for a monitor, used to recover an explicit choice when the
/// OS name has shifted under it (see `DisplayPrefs::monitor_fingerprint`). Two
/// identical panels produce identical fingerprints; that is accepted, because the
/// alternative — landing on a monitor the user did not choose — is worse than
/// landing on the wrong one of two screens that look the same.
fn fingerprint(monitor: &Monitor) -> String {
    let s = monitor.size();
    format!("{}x{}@{}", s.width, s.height, monitor.scale_factor())
}

fn monitor_by_fingerprint(window: &WebviewWindow, fp: &str) -> Option<Monitor> {
    window
        .available_monitors()
        .ok()?
        .into_iter()
        .find(|m| fingerprint(m) == fp)
}

/// Resolve the screen the user explicitly chose: by name first, then by shape.
/// `None` means it is genuinely not connected right now.
fn chosen_monitor(window: &WebviewWindow, cache: &PlacementCache) -> Option<Monitor> {
    if let Some(found) = cache.monitor.as_deref().and_then(|n| monitor_by_id(window, n)) {
        return Some(found);
    }
    cache.fingerprint.as_deref().and_then(|fp| monitor_by_fingerprint(window, fp))
}

/// True when this monitor IS the Edge panel, judged on size alone.
///
/// Deliberately not `is_edge`: that one also matches any display whose OS name
/// merely contains "edge" or "xeneon", which is a fine hint for the auto-pin and
/// a trap here. Under "an explicit choice wins", a false positive would drop the
/// user's chosen monitor into a borderless, undecorated, taskbar-hidden window
/// with no title bar and no way out.
fn is_edge_panel(monitor: &Monitor) -> bool {
    let size = monitor.size();
    size.width == EDGE_WIDTH && size.height == EDGE_HEIGHT
}

/// True when a Xeneon Edge is connected right now.
pub fn edge_present(window: &WebviewWindow) -> bool {
    find_edge(window).is_some()
}

/// What the shell should do right now, given the saved choice and the live
/// monitor list. The single source of the placement rule.
pub enum Target {
    /// Borderless kiosk owning the whole panel (the Edge treatment).
    Kiosk(Monitor),
    /// Ordinary window, or reachable full-screen, on this monitor.
    Windowed(Monitor, bool),
    /// Nothing on this PC: phone mode, or the chosen screen is unplugged.
    Nothing(NoScreen),
}

pub enum NoScreen {
    Phone,
    ChosenMissing,
}

fn resolve(window: &WebviewWindow, cache: &PlacementCache) -> Target {
    match cache.mode {
        Placement::Phone => Target::Nothing(NoScreen::Phone),
        Placement::Screen => match chosen_monitor(window, cache) {
            // Choosing the Edge is legal and means "the Edge, deliberately" —
            // and there is no windowed Edge: that panel IS the kiosk.
            Some(m) if is_edge_panel(&m) => Target::Kiosk(m),
            Some(m) => Target::Windowed(m, cache.fullscreen),
            // No fallback to primary on purpose. Putting the kiosk on a screen
            // the user did not pick, because the one they did pick is switched
            // off, is the "Xenon is covering my desktop" complaint.
            None => Target::Nothing(NoScreen::ChosenMissing),
        },
        Placement::Auto => match find_edge(window) {
            Some(edge) => Target::Kiosk(edge),
            None => {
                let prefs = prefs::DisplayPrefs {
                    monitor: cache.monitor.clone(),
                    ..Default::default()
                };
                match preferred_monitor(window, &prefs) {
                    Some(m) => Target::Windowed(m, cache.fullscreen),
                    None => Target::Nothing(NoScreen::ChosenMissing),
                }
            }
        },
    }
}

/// Apply a resolved target to the window.
fn apply_target(window: &WebviewWindow, target: Target, focus: bool) {
    match target {
        Target::Kiosk(m) => {
            NO_SCREEN.store(false, Ordering::SeqCst);
            show_if_allowed(window);
            place_on_edge(window, &m, focus);
        }
        Target::Windowed(m, true) => {
            NO_SCREEN.store(false, Ordering::SeqCst);
            show_if_allowed(window);
            place_fullscreen_on(window, &m);
        }
        Target::Windowed(m, false) => {
            NO_SCREEN.store(false, Ordering::SeqCst);
            show_if_allowed(window);
            place_windowed_on(window, &m);
        }
        Target::Nothing(NoScreen::Phone) => {
            // SHOW_OVERRIDE is what a DELIBERATE launch sets: the user chose
            // their phone, then double-clicked Xenon anyway, and an app that
            // opens and shows nothing reads as broken.
            if !SHOW_OVERRIDE.load(Ordering::SeqCst) {
                let _ = window.hide();
            } else {
                // Showing it is not enough: this arm used to leave the window with
                // whatever chrome it was BUILT with, which is the kiosk's —
                // undecorated and hidden from the taskbar and Alt-Tab. A window with
                // no title bar, no taskbar button and no way to move or close it is
                // not a dashboard somebody asked to see, it is a panel stuck to the
                // desktop. Give it the same ordinary window every other non-Edge
                // placement gets. (Same repair `exit_home` already performs for this
                // mode, and safe to do here: the watchdog `continue`s on `Phone`, so
                // this runs on deliberate placements only, never every tick.)
                if let Some(m) = window
                    .current_monitor()
                    .ok()
                    .flatten()
                    .or_else(|| primary_or_first(window))
                {
                    place_windowed_on(window, &m);
                }
            }
        }
        Target::Nothing(NoScreen::ChosenMissing) => {
            if !NO_SCREEN.swap(true, Ordering::SeqCst) && !SHOW_OVERRIDE.load(Ordering::SeqCst) {
                let _ = window.hide();
            }
        }
    }
}

/// Place the window where the user's choice says it belongs. Called at startup,
/// after every choice, and whenever the watchdog decides a repair is due.
pub fn place_now(window: &WebviewWindow) {
    let cache = placement_cache();
    apply_target(window, resolve(window, &cache), true);
}

/// Tray "Show Xenon": reveal the window now even when a rule wants it hidden
/// (phone mode, or the chosen screen unplugged). Writes nothing — the user asked
/// to see it, not to move house — so the next topology change re-evaluates.
pub fn show_now(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    SHOW_OVERRIDE.store(true, Ordering::SeqCst);
    let cache = placement_cache();
    match resolve(&window, &cache) {
        Target::Nothing(_) => {
            // Nowhere legitimate to put it: land on the primary, this session only.
            let _ = window.show();
            if let Some(m) = primary_or_first(&window) {
                place_windowed_on(&window, &m);
            }
        }
        target => apply_target(&window, target, true),
    }
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Clip the OS window to a circle (or clear the clip). The kiosk window is a
/// plain opaque rectangle, so to get a genuinely round button — not a rounded
/// rectangle — we hand Windows an elliptic region the size of the window; it
/// clips everything outside the circle away, desktop showing through. Clearing
/// the region (null) restores the normal rectangular window. Windows takes
/// ownership of the region handle, so we never free it ourselves. Best-effort.
///
/// We also tell DWM **not to round the window's corners** while it is round:
/// Windows 11 draws its own rounded-corner backdrop (with a faint light border)
/// around the window's *rectangular* frame, and that arc bleeds past the elliptic
/// region as a pale rounded-rectangle ghost peeking out behind the button. Forcing
/// square corners removes that backdrop so only the clean circle remains; the
/// default rounding is restored when the clip is cleared.
#[cfg(windows)]
fn clip_round(window: &WebviewWindow, round: bool, diameter: i32) {
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateEllipticRgn(x1: i32, y1: i32, x2: i32, y2: i32) -> isize;
    }
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowRgn(hwnd: isize, hrgn: isize, b_redraw: i32) -> i32;
    }
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: isize,
            attr: u32,
            value: *const core::ffi::c_void,
            size: u32,
        ) -> i32;
    }
    // DWMWA_WINDOW_CORNER_PREFERENCE (33): DWMWCP_DEFAULT=0, DWMWCP_DONOTROUND=1.
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_DEFAULT: u32 = 0;
    const DWMWCP_DONOTROUND: u32 = 1;

    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as isize;
    unsafe {
        let corner: u32 = if round { DWMWCP_DONOTROUND } else { DWMWCP_DEFAULT };
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &corner as *const u32 as *const core::ffi::c_void,
            core::mem::size_of::<u32>() as u32,
        );
        if round {
            // +1: CreateEllipticRgn's bottom/right bounds are exclusive.
            let rgn = CreateEllipticRgn(0, 0, diameter + 1, diameter + 1);
            SetWindowRgn(hwnd, rgn, 1);
        } else {
            SetWindowRgn(hwnd, 0, 1);
        }
    }
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

/// Swipe-up-to-desktop: collapse the kiosk to a small, round, always-on-top
/// "return" button centred near the top edge of the Edge (or, off the Edge, the
/// monitor it currently sits on), revealing the Windows desktop behind it. It
/// sits at the *top* on purpose: near the bottom it would sit over the Windows
/// taskbar and block it, and the whole point of dropping to the desktop is to
/// reach the taskbar. The dashboard draws the button face inside it (see
/// `native-bridge.js`); here we only reshape and round the OS window. The
/// watchdog is paused via `HOME_MODE` so it will not yank the window back to
/// full-screen while the user is on the desktop.
pub fn enter_home(window: &WebviewWindow) {
    let cache = placement_cache();
    // Nothing to collapse when this PC shows nothing.
    if cache.mode == Placement::Phone {
        return;
    }
    HOME_MODE.store(true, Ordering::SeqCst);
    // The chosen screen comes first: with a monitor picked AND an Edge attached,
    // asking find_edge first would drop the round return button on the Edge —
    // a different screen from the one the dashboard was just filling.
    let target = chosen_monitor(window, &cache)
        .or_else(|| find_edge(window))
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| primary_or_first(window));
    // The kiosk carries a 640×240 minimum; drop it so the button can be this small.
    let _ = window.set_min_size(None::<LogicalSize<f64>>);
    let _ = window.set_fullscreen(false);
    let _ = window.set_decorations(false);
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_always_on_top(true);
    // Drop the DWM window shadow: with the window clipped to a circle (below) the
    // shadow is still drawn around the window's *rectangular* bounds, leaving a
    // dark rounded-rectangle ghost peeking out behind the round button. Only an
    // undecorated window can turn its shadow off on Windows — which this is.
    let _ = window.set_shadow(false);
    let mut diameter = HOME_BTN_DIAMETER;
    if let Some(monitor) = target {
        let origin: PhysicalPosition<i32> = *monitor.position();
        let size = monitor.size();
        diameter = HOME_BTN_DIAMETER.min(size.width).min(size.height);
        let _ = window.set_size(PhysicalSize::new(diameter, diameter));
        // Centred horizontally, a small gap below the top, so the taskbar at the
        // bottom stays uncovered and the round button reads as floating.
        let x = origin.x + ((size.width - diameter) / 2) as i32;
        let _ = window.set_position(PhysicalPosition::new(x, origin.y + HOME_BTN_TOP_MARGIN));
    }
    // Clip to a circle only AFTER the window is sized, so the region matches.
    #[cfg(windows)]
    clip_round(window, true, diameter as i32);
    let _ = window.set_focus();
}

/// Return from the desktop: restore the kiosk to its normal placement (Edge kiosk
/// if the Edge is connected, otherwise the saved windowed/full-screen preference),
/// clear the circular clip, re-arm the minimum size, drop always-on-top, and let
/// the watchdog run again.
pub fn exit_home(window: &WebviewWindow) {
    // The undo runs for EVERY placement. It used to return early on `Phone`,
    // leaving the window as the 84px always-on-top circle with HOME_MODE still
    // set — and that is reachable from shipping UI, not a corner: swipe home,
    // then tray → "On my phone/tablet", which records the mode and deliberately
    // keeps the window this session already has. From there the round button did
    // nothing, "Show Xenon" could not rescue it (place_windowed_on never clears
    // the clip), the watchdog skips `Phone`, and the only way out was killing
    // the app.
    HOME_MODE.store(false, Ordering::SeqCst);
    #[cfg(windows)]
    clip_round(window, false, 0);
    let _ = window.set_always_on_top(false);
    // Restore the default window shadow the round button turned off (harmless when
    // fullscreen on the Edge; keeps a normal shadow if we fall back to windowed).
    let _ = window.set_shadow(true);
    let _ = window.set_min_size(Some(LogicalSize::new(640.0, 240.0)));
    // Only the RE-PLACEMENT depends on the mode. Under `Phone`, place_now means
    // "this PC shows nothing", which would take away the window set_placement
    // just promised the current session it could keep — so give it back as an
    // ordinary desktop window on the screen it is already on.
    if placement_cache().mode == Placement::Phone {
        if let Some(monitor) = window.current_monitor().ok().flatten() {
            place_windowed_on(window, &monitor);
        }
    } else {
        place_now(window);
    }
    let _ = window.set_focus();
}

/// One entry per connected monitor, shared by the tray picker and the dashboard's
/// Settings → Screen list so the two can never disagree about what is attached.
pub struct DisplayInfo {
    /// Never empty — see `display_id`. An unnamed output is identified by shape.
    pub id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
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
    let primary = window.primary_monitor().ok().flatten();
    let monitors = window.available_monitors().ok().unwrap_or_default();
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
    let primary = app.primary_monitor().ok().flatten();
    let monitors = app.available_monitors().unwrap_or_default();
    describe(monitors, primary)
}

fn describe(monitors: Vec<Monitor>, primary: Option<Monitor>) -> Vec<DisplayInfo> {
    let ids = display_ids(&monitors);
    // Which entry is the primary is decided by its ORIGIN, not by its id: two
    // same-model monitors on macOS report the same name, and matching on that
    // flagged both of them primary.
    let primary_origin = primary.as_ref().map(|m| *m.position());
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
                width: s.width,
                height: s.height,
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
        "id": d.id, "label": d.label, "width": d.width, "height": d.height,
        "scale": d.scale, "primary": d.primary, "edge": d.edge,
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
    let active = window
        .current_monitor()
        .ok()
        .flatten()
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
            "gpuMismatch": gpu_mismatch(),
        }
    })
}

/// Tray/Settings action: switch between full-screen and windowed, and remember it.
///
/// A no-op only when the effective target is the Edge PANEL — that one is always
/// borderless-fullscreen, so the toggle has nothing to say. It used to bail
/// whenever an Edge existed anywhere, which meant F11 and the tray checkbox did
/// nothing on a PC that had an Edge attached but whose owner had chosen another
/// screen.
pub fn set_fullscreen_pref(app: &AppHandle, on: bool) {
    let Some(window) = app.get_webview_window("main") else { return };
    let cache = placement_cache();
    if matches!(resolve(&window, &cache), Target::Kiosk(_) | Target::Nothing(_)) {
        return;
    }
    let mut snapshot = prefs::DisplayPrefs::default();
    prefs::update(app, |p| {
        p.fullscreen = on;
        snapshot = p.clone();
    });
    set_placement_cache(&snapshot);
    place_now(&window);
    push_display_state(app);
}

/// Tray/Settings action: put the window on this monitor, by display id.
///
/// Picking a display IS the explicit choice, so it also switches the mode to
/// `Screen` — and there is no longer an "a Xeneon Edge is attached, so no"
/// early-return: refusing the pick was exactly the behaviour this replaces.
pub fn move_to_named_monitor(app: &AppHandle, name: &str) {
    let Some(window) = app.get_webview_window("main") else { return };
    // An id we did not just read from the OS is not an id. Resolving before
    // writing is what stops any caller from putting an arbitrary string into
    // display.json and leaving the window unplaceable at the next launch.
    let Some(monitor) = monitor_by_id(&window, name) else { return };
    let mut snapshot = prefs::DisplayPrefs::default();
    prefs::update(app, |p| {
        // The id, not the raw OS name: an unnamed output would otherwise save a
        // `null` monitor and lean entirely on the fingerprint fallback, and a
        // name shared with another screen would save an ambiguity.
        p.monitor = id_of(&window, &monitor).or_else(|| monitor.name().cloned());
        p.monitor_fingerprint = Some(fingerprint(&monitor));
        p.placement = Placement::Screen;
        snapshot = p.clone();
    });
    set_placement_cache(&snapshot);
    SHOW_OVERRIDE.store(false, Ordering::SeqCst);
    place_now(&window);
    // Picking a screen can be the way OUT of phone mode — most obviously from
    // the tray, where it is the only control that does it. Without this the
    // window would come back now and be gone again at the next login, which is
    // the kind of half-applied setting this whole feature exists to remove.
    crate::sync_autostart(app);
    push_display_state(app);
}

/// Set the placement mode without naming a screen: "automatic" or "my phone".
///
/// `apply_now` only means anything for `Phone`, and it is the difference between
/// recording the choice and acting on it in this session. See the note below.
pub fn set_placement(app: &AppHandle, mode: Placement, apply_now: bool) {
    let Some(window) = app.get_webview_window("main") else { return };
    let mut snapshot = prefs::DisplayPrefs::default();
    prefs::update(app, |p| {
        p.placement = mode;
        snapshot = p.clone();
    });
    set_placement_cache(&snapshot);
    // A deliberate mode change ends any "show it anyway" the tray granted.
    SHOW_OVERRIDE.store(false, Ordering::SeqCst);
    if mode == Placement::Phone {
        // Recorded, NOT applied to the window that is open right now — unless the
        // caller says otherwise.
        //
        // "Nothing on this PC" is about STARTUP: it is what stops the kiosk
        // reappearing at every login once the dashboard lives on a phone. Doing
        // it the instant the choice is made takes the screen away mid-sentence —
        // the user picks "my phone", and the window carrying the pairing QR, the
        // Settings panel and the confirmation all vanish at once. So the current
        // session keeps its window, the login entry goes (see sync_autostart
        // below in the caller), and the next launch opens hidden.
        //
        // `apply_now` is the one place that is not true: the last step of the
        // phone guide, pressed with a paired device already showing the
        // dashboard, where "hide it from this PC" is the whole of what the
        // button says it does. `place_now` hides it (see apply_target's
        // Target::Nothing(NoScreen::Phone) arm); SHOW_OVERRIDE was cleared above,
        // so the tray's "Show Xenon" is still the way back.
        NO_SCREEN.store(false, Ordering::SeqCst);
        if apply_now {
            place_now(&window);
        }
    } else {
        place_now(&window);
    }
    crate::sync_autostart(app);
    push_display_state(app);
}

/// Push the current display state into the dashboard page. Best-effort: the page
/// may not be loaded yet, and the next push will carry the same state anyway.
pub fn push_display_state(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let state = display_state(&window);
    let _ = window.eval(&crate::display_state_js(&state));
}

/// A signature of the current display layout — each monitor's origin and size,
/// order-independent. Changes when a display is added/removed/repositioned or when
/// one is turned off (which can make the Edge the primary), so the watchdog can
/// tell a genuine topology change from an idle tick. Empty if monitors can't be
/// read this tick (treated as "unknown", never a change).
fn topology_signature(window: &WebviewWindow) -> String {
    let Ok(monitors) = window.available_monitors() else { return String::new() };
    let mut parts: Vec<String> = monitors
        .iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            format!("{},{},{}x{}", p.x, p.y, s.width, s.height)
        })
        .collect();
    parts.sort();
    // Prefix WHICH display is primary — the one Windows parks the taskbar on.
    // Powering a monitor off can hand the primary role (and thus the taskbar) to the
    // Edge; the position list alone can miss that if the remaining monitors keep
    // their coordinates, so key the primary's size + name in explicitly so such a
    // change still moves the signature and re-asserts fullscreen over the taskbar.
    let primary = window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let s = m.size();
            let name = m.name().cloned().unwrap_or_default();
            format!("{}x{}@{}", s.width, s.height, name)
        })
        .unwrap_or_default();
    format!("P:{}|{}", primary, parts.join("|"))
}

/// Start the background watchdog. Re-pins the window to the Edge whenever it is
/// present but the window has drifted off it (display reorder, replug, resume) or
/// the display topology changes (e.g. a monitor powered off relocates the Windows
/// taskbar onto the Edge, on top of the kiosk).
///
/// Captures the `AppHandle` (Send + Sync) and looks the window up each tick, so
/// the loop stops cleanly once the window is gone.
pub fn start_watchdog(app: AppHandle) {
    thread::spawn(move || {
        // Baseline the layout on the first tick so a genuine change is detectable
        // without re-pinning once at startup for no reason.
        let mut last_topology = String::new();
        // Consecutive ticks spent chasing a window that has not landed. Reset the
        // moment it lands or the layout changes; see MAX_REPIN_ATTEMPTS.
        let mut repin_attempts: u32 = 0;
        loop {
        thread::sleep(WATCHDOG_INTERVAL);

        let window = match app.get_webview_window("main") {
            Some(w) => w,
            None => break, // window destroyed → stop the watchdog
        };

        // Read the user's choice from memory, not disk — the same reason
        // HIDE_ON_RDP is mirrored. This runs every 3 seconds, forever.
        let cache = placement_cache();

        // Phone mode: this PC shows nothing, so there is nothing to re-pin and
        // nothing to reveal. Checked BEFORE the RDP branch, whose show() would
        // otherwise put a hidden window back on screen when a remote session ends.
        if cache.mode == Placement::Phone {
            continue;
        }

        // Remote-Desktop hide (opt-in): while the user is RDP'd into this PC, keep
        // the borderless kiosk out of the way so it doesn't cover the desktop they
        // came in to use; bring it back when the session ends. Checked before the
        // HOME_MODE / Edge re-pin logic so a remote login always reveals the
        // desktop regardless of the current placement. `RDP_HIDDEN` makes this fire
        // only on the transition, not every tick.
        if HIDE_ON_RDP.load(Ordering::SeqCst) {
            if is_remote_session() {
                if !RDP_HIDDEN.swap(true, Ordering::SeqCst) {
                    let _ = window.hide();
                }
                continue; // stay hidden — don't re-pin while the session is remote
            } else if RDP_HIDDEN.swap(false, Ordering::SeqCst) {
                // Back at the console. `place_now` shows the window itself, and
                // only if no OTHER rule still wants it hidden.
                place_now(&window); // back at the console — restore the kiosk
            }
        } else if RDP_HIDDEN.swap(false, Ordering::SeqCst) {
            // Toggled off while hidden (rare) — reveal it again.
            place_now(&window);
        }

        // The user deliberately dropped to the home-bar strip — don't fight it
        // (and leave the round button's always-on-top alone; that one is wanted).
        if HOME_MODE.load(Ordering::SeqCst) {
            continue;
        }

        // Outside home mode the kiosk must never be pinned above other windows.
        #[cfg(windows)]
        clear_stuck_topmost(&window);

        // Computed once per tick, for whichever branch runs. The ASSIGNMENT stays
        // below the HOME_MODE and RDP `continue`s on purpose: while either holds
        // the window, the baseline is deliberately left stale so that returning
        // re-pins exactly once.
        let topology = topology_signature(&window);
        // An empty signature means monitors couldn't be read this tick — treat it
        // as "unknown", not a change, and keep the previous baseline so the next
        // valid read still compares against real data.
        let topology_changed =
            !last_topology.is_empty() && !topology.is_empty() && topology != last_topology;
        if !topology.is_empty() {
            last_topology = topology.clone();
        }
        if topology_changed {
            // The list the dashboard's screen picker is showing just went stale.
            push_display_state(&app);
        }

        // The screen the user NAMED. Structurally the Edge branch below, with the
        // target swapped — including both of its guards, which have nothing to do
        // with the Edge and everything to do with re-placing at a bad moment.
        if cache.mode == Placement::Screen {
            match chosen_monitor(&window, &cache) {
                None => {
                    if !NO_SCREEN.swap(true, Ordering::SeqCst)
                        && !SHOW_OVERRIDE.load(Ordering::SeqCst)
                    {
                        let _ = window.hide();
                        push_display_state(&app);
                    }
                }
                Some(target) => {
                    if NO_SCREEN.swap(false, Ordering::SeqCst) {
                        // The chosen screen is back. Reveal and re-place once.
                        place_now(&window);
                        push_display_state(&app);
                        repin_attempts = 0;
                        continue;
                    }
                    // Only the kiosk and full-screen targets chase a window that has
                    // drifted; the windowed one re-places on a topology change only
                    // (see below). So only those two feed the attempt counter.
                    let chases = is_edge_panel(&target) || cache.fullscreen;
                    let drifted = chases && !window_is_on(&window, &target);
                    if !drifted || topology_changed {
                        repin_attempts = 0;
                    }
                    if !game_mode()
                        && (topology_changed || (drifted && repin_attempts < MAX_REPIN_ATTEMPTS))
                    {
                        if drifted {
                            repin_attempts += 1;
                        }
                        let focus = kiosk_has_foreground(&window);
                        if is_edge_panel(&target) {
                            place_on_edge(&window, &target, focus);
                        } else if cache.fullscreen {
                            place_fullscreen_on(&window, &target);
                        } else if topology_changed {
                            // Windowed: only re-place on a real topology change.
                            // Chasing `window_is_on` here would drag the window
                            // back every time the user moved it themselves.
                            place_windowed_on(&window, &target);
                        }
                    }
                }
            }
            continue;
        }

        if let Some(edge) = find_edge(&window) {
            // Re-pin when the window drifted off the Edge OR the display topology
            // changed. The latter covers "monitor turned off": the window itself
            // hasn't moved, but Windows relocated the taskbar onto the Edge above
            // the kiosk — re-asserting fullscreen (place_on_edge drops and re-enters
            // it) puts the borderless window back over the taskbar. Only fires on a
            // real change (not the first tick), so there's no idle-time flicker.
            //
            // While a game is running, a topology change is almost always the game
            // itself switching the desktop resolution for exclusive full-screen.
            // Re-pinning here calls set_focus() (see place_on_edge), which yanks the
            // foreground off the game; the game re-enters full-screen, flips the
            // resolution again, and the two bounce until Xenon is force-quit — the
            // "screen goes back and forth between Xenon and the game on launch"
            // report, seen only with resolution-CHANGING exclusive-fullscreen games
            // plus an Edge attached (a game at native resolution never moves the
            // signature, which is why it is rare). Hold the re-pin off while gaming:
            // focus_guard keeps the game foreground, and the watchdog re-pins once
            // the game exits. last_topology stays current (updated above), so the
            // resolution reverting on exit is not itself seen as a change to chase.
            let drifted = !window_is_on(&window, &edge);
            if !drifted || topology_changed {
                repin_attempts = 0;
            }
            if !game_mode()
                && (topology_changed || (drifted && repin_attempts < MAX_REPIN_ATTEMPTS))
            {
                if drifted {
                    repin_attempts += 1;
                }
                // Re-place, but only re-raise if the kiosk already had the
                // foreground — see `place_on_edge`. A window the user moved onto
                // the Edge must stay in front of the dashboard.
                let focus = kiosk_has_foreground(&window);
                place_on_edge(&window, &edge, focus);
            }
        } else {
            // Off the Edge: keep the baseline current so returning to it re-pins once.
            // Same guard as above — a failed enumeration must not wipe the baseline.
            let topology = topology_signature(&window);
            if !topology.is_empty() {
                last_topology = topology;
            }
        }
        }
    });
}
