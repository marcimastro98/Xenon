// Home mode: the window shrinks to a round button and grows back.

use std::sync::atomic::Ordering;
use tauri::{LogicalSize, WebviewWindow};
use crate::prefs::Placement;
use super::{DRIVER, extent, find_edge, HOME_BTN_DIAMETER, HOME_BTN_TOP_MARGIN, HOME_MODE, monitor_rect, place_windowed_on, point, primary_or_first, VISIT};
use super::pick::chosen_monitor;
use super::screens::{current_of, placement_cache};
use super::target::place_now;

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
    // Nothing to collapse when this PC shows nothing, and a visit has a title bar.
    if cache.mode == Placement::Phone || DRIVER.load(Ordering::SeqCst) || VISIT.load(Ordering::SeqCst) {
        return;
    }
    HOME_MODE.store(true, Ordering::SeqCst);
    // The chosen screen comes first: with a monitor picked AND an Edge attached,
    // asking find_edge first would drop the round return button on the Edge —
    // a different screen from the one the dashboard was just filling.
    let target = chosen_monitor(window, &cache)
        .or_else(|| find_edge(window))
        .or_else(|| current_of(window))
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
        // Same units the placement helpers use, for the same reason: on macOS an
        // origin taken from one screen's scale factor and applied under another's
        // lands the button on the wrong display entirely.
        let rect = monitor_rect(&monitor);
        diameter = HOME_BTN_DIAMETER
            .min(rect.w.max(1.0) as u32)
            .min(rect.h.max(1.0) as u32);
        let d = diameter as f64;
        let _ = window.set_size(extent(d, d));
        // Centred horizontally, a small gap below the top, so the taskbar at the
        // bottom stays uncovered and the round button reads as floating.
        let x = rect.x + (rect.w - d) / 2.0;
        let _ = window.set_position(point(x, rect.y + HOME_BTN_TOP_MARGIN as f64));
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
        if let Some(monitor) = current_of(window) {
            place_windowed_on(window, &monitor, true);
        }
    } else {
        place_now(window);
    }
    let _ = window.set_focus();
}
