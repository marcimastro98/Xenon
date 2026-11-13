// Puts the window on a screen: its rectangle, borderless fullscreen per system, and the size of an ordinary window.

#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::Instant;
use tauri::{LogicalSize, Monitor, WebviewWindow};
#[cfg(not(target_os = "macos"))]
use tauri::PhysicalSize;
#[cfg(target_os = "linux")]
use tauri::Manager;
use super::{MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, WINDOW_SCREEN_FRACTION};
#[cfg(target_os = "macos")]
use super::{LANDING_POLL, LANDING_WAIT};
use super::edge::restore_quietly;
#[cfg(target_os = "macos")]
use super::edge::window_is_on;
#[cfg(target_os = "linux")]
use super::screens::on_main;

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
pub(super) struct MonitorRect {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) w: f64,
    pub(super) h: f64,
}

pub(super) fn monitor_rect(monitor: &Monitor) -> MonitorRect {
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
pub(super) fn point(x: f64, y: f64) -> tauri::Position {
    tauri::Position::Logical(tauri::LogicalPosition::new(x, y))
}
#[cfg(not(target_os = "macos"))]
pub(super) fn point(x: f64, y: f64) -> tauri::Position {
    tauri::Position::Physical(tauri::PhysicalPosition::new(
        x.round() as i32,
        y.round() as i32,
    ))
}

#[cfg(target_os = "macos")]
pub(super) fn extent(w: f64, h: f64) -> tauri::Size {
    tauri::Size::Logical(LogicalSize::new(w.max(1.0), h.max(1.0)))
}
#[cfg(not(target_os = "macos"))]
pub(super) fn extent(w: f64, h: f64) -> tauri::Size {
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
pub(super) fn place_on_edge(window: &WebviewWindow, edge: &Monitor, focus: bool) {
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
pub(super) fn wait_until_on(window: &WebviewWindow, monitor: &Monitor) -> bool {
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
pub(super) fn windowed_size_for(monitor: &Monitor) -> LogicalSize<f64> {
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
