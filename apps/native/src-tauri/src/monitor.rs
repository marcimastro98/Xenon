//! Xeneon Edge monitor targeting + kiosk watchdog.
//!
//! The Edge reports its native panel resolution of 2560×720. We find the monitor
//! with that physical size and pin the borderless kiosk window to it, then keep a
//! lightweight watchdog running so the window returns to the Edge after Windows
//! reorders displays, the panel is unplugged/replugged, or the PC resumes from
//! standby. If the Edge is not present, we degrade gracefully to an ordinary
//! resizable desktop window (usable on any laptop or monitor) and upgrade it to
//! the full kiosk the moment the Edge appears.

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use tauri::{
    AppHandle, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow,
};

use crate::prefs;

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

/// Widest the windowed dashboard opens; the actual size is capped to fit the
/// monitor so it never spills off a small screen. The window keeps the Edge's
/// 3.556:1 aspect so the wide dashboard layout is never distorted.
const MAX_WINDOW_WIDTH: f64 = 1600.0;
const WINDOW_ASPECT: f64 = EDGE_WIDTH as f64 / EDGE_HEIGHT as f64;

/// How often the watchdog re-checks the window is on the Edge.
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(3);

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
    let candidates: Vec<Monitor> = window
        .available_monitors()
        .ok()?
        .into_iter()
        .filter(is_edge)
        .collect();
    if candidates.len() < 2 {
        return candidates.into_iter().next();
    }
    let virtual_names = crate::gpu::virtual_display_names();
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
    let _ = window.set_fullscreen(true);
    if focus {
        let _ = window.set_focus();
    }
}

/// A window size that fits inside the given monitor (never wider or taller than
/// the screen), keeping the Edge's wide aspect so the dashboard is not distorted.
fn windowed_size_for(monitor: &Monitor) -> LogicalSize<f64> {
    let scale = monitor.scale_factor();
    let mon_w = monitor.size().width as f64 / scale;
    let mon_h = monitor.size().height as f64 / scale;
    let mut w = (mon_w * 0.92).min(MAX_WINDOW_WIDTH);
    let mut h = w / WINDOW_ASPECT;
    let max_h = mon_h * 0.9;
    if h > max_h {
        h = max_h;
        w = h * WINDOW_ASPECT;
    }
    // Never ask for less than the window's own minimum (640×240).
    LogicalSize::new(w.max(640.0), h.max(240.0))
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

/// Find a connected monitor by its OS name (best-effort; `None` if it is gone).
fn monitor_by_name(window: &WebviewWindow, name: &str) -> Option<Monitor> {
    window
        .available_monitors()
        .ok()?
        .into_iter()
        .find(|m| m.name().map(|n| n.to_string()).as_deref() == Some(name))
}

/// The monitor a saved preference points at, falling back to the primary display.
fn preferred_monitor(window: &WebviewWindow, prefs: &prefs::DisplayPrefs) -> Option<Monitor> {
    prefs
        .monitor
        .as_deref()
        .and_then(|n| monitor_by_name(window, n))
        .or_else(|| primary_or_first(window))
}

/// True when a Xeneon Edge is connected right now.
pub fn edge_present(window: &WebviewWindow) -> bool {
    find_edge(window).is_some()
}

/// No Edge connected: open per the user's saved display preference (windowed by
/// default, or full-screen on their chosen monitor), fitted to whatever screen
/// this PC has. The watchdog still upgrades to the Edge kiosk if one appears.
pub fn apply_prefs(window: &WebviewWindow) {
    let prefs = prefs::load(window.app_handle());
    match preferred_monitor(window, &prefs) {
        Some(monitor) if prefs.fullscreen => place_fullscreen_on(window, &monitor),
        Some(monitor) => place_windowed_on(window, &monitor),
        None => {
            // No monitor info at all — fall back to a plain windowed state.
            let _ = window.set_fullscreen(false);
            let _ = window.set_decorations(true);
            let _ = window.set_skip_taskbar(false);
        }
    }
}

/// Place the window on the Edge now if it is connected; otherwise present it per
/// the saved display preference. Called once at startup.
pub fn place_now(window: &WebviewWindow) {
    match find_edge(window) {
        Some(edge) => place_on_edge(window, &edge, true),
        None => apply_prefs(window),
    }
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
    HOME_MODE.store(true, Ordering::SeqCst);
    let target = find_edge(window)
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
    HOME_MODE.store(false, Ordering::SeqCst);
    #[cfg(windows)]
    clip_round(window, false, 0);
    let _ = window.set_always_on_top(false);
    // Restore the default window shadow the round button turned off (harmless when
    // fullscreen on the Edge; keeps a normal shadow if we fall back to windowed).
    let _ = window.set_shadow(true);
    let _ = window.set_min_size(Some(LogicalSize::new(640.0, 240.0)));
    place_now(window);
    let _ = window.set_focus();
}

/// Human-readable labels for each connected monitor, in enumeration order — used
/// to build the tray's "show on which display" picker.
pub fn monitor_labels(window: &WebviewWindow) -> Vec<String> {
    window
        .available_monitors()
        .ok()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(i, m)| {
            let s = m.size();
            format!("Display {} — {}×{}", i + 1, s.width, s.height)
        })
        .collect()
}

/// Tray action: switch the (non-Edge) window between full-screen and windowed and
/// remember the choice. A no-op while the Edge kiosk owns the panel.
pub fn set_fullscreen_pref(app: &AppHandle, on: bool) {
    let Some(window) = app.get_webview_window("main") else { return };
    if edge_present(&window) {
        return;
    }
    let mut snapshot = prefs::DisplayPrefs::default();
    prefs::update(app, |p| {
        p.fullscreen = on;
        snapshot = p.clone();
    });
    if let Some(monitor) = preferred_monitor(&window, &snapshot) {
        if on {
            place_fullscreen_on(&window, &monitor);
        } else {
            place_windowed_on(&window, &monitor);
        }
    }
}

/// Tray action: move the (non-Edge) window onto the monitor at `index` (matching
/// `monitor_labels`), preserving the current full-screen/windowed choice, and
/// remember it. A no-op while the Edge kiosk owns the panel.
pub fn move_to_monitor(app: &AppHandle, index: usize) {
    let Some(window) = app.get_webview_window("main") else { return };
    if edge_present(&window) {
        return;
    }
    let Some(monitor) = window
        .available_monitors()
        .ok()
        .and_then(|list| list.into_iter().nth(index))
    else {
        return;
    };
    let name = monitor.name().map(|n| n.to_string());
    let mut fullscreen = false;
    prefs::update(app, |p| {
        p.monitor = name;
        fullscreen = p.fullscreen;
    });
    if fullscreen {
        place_fullscreen_on(&window, &monitor);
    } else {
        place_windowed_on(&window, &monitor);
    }
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
        loop {
        thread::sleep(WATCHDOG_INTERVAL);

        let window = match app.get_webview_window("main") {
            Some(w) => w,
            None => break, // window destroyed → stop the watchdog
        };

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
                let _ = window.show();
                place_now(&window); // back at the console — restore the kiosk
            }
        } else if RDP_HIDDEN.swap(false, Ordering::SeqCst) {
            // Toggled off while hidden (rare) — reveal it again.
            let _ = window.show();
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

        if let Some(edge) = find_edge(&window) {
            // Re-pin when the window drifted off the Edge OR the display topology
            // changed. The latter covers "monitor turned off": the window itself
            // hasn't moved, but Windows relocated the taskbar onto the Edge above
            // the kiosk — re-asserting fullscreen (place_on_edge drops and re-enters
            // it) puts the borderless window back over the taskbar. Only fires on a
            // real change (not the first tick), so there's no idle-time flicker.
            let topology = topology_signature(&window);
            // An empty signature means monitors couldn't be read this tick — treat it
            // as "unknown", not a change, and keep the previous baseline so the next
            // valid read still compares against real data.
            let topology_changed =
                !last_topology.is_empty() && !topology.is_empty() && topology != last_topology;
            if !topology.is_empty() {
                last_topology = topology;
            }
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
            if !crate::focus_guard::game_mode()
                && (topology_changed || !window_is_on(&window, &edge))
            {
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
