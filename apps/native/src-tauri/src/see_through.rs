//! The see-through dashboard window: the kiosk built transparent, so whatever is
//! on the desktop under it (a Wallpaper Engine scene, the Windows wallpaper)
//! shows behind the tiles, as much as Settings → Appearance → Panel opacity lets
//! it. Asked for on Discord (Oct 2026) by someone running Wallpaper Engine.
//!
//! Three things make this more than a builder flag:
//!
//!   * **It is fixed at creation.** On Windows the transparency is a DWM
//!     blur-behind set up when tao creates the window, and WebView2's transparent
//!     background is set when wry creates the controller. So the choice is read
//!     once at launch (`decide`) and changing it restarts the app (`set_from_dashboard`),
//!     the same way the GPU pin works.
//!   * **It can render nothing.** A transparent webview composed across GPU
//!     adapters comes out BLANK — measured on Spotlight (spotlight_window.rs) and
//!     the reason the widget layers keep their own profile (layers/mod.rs). A blank
//!     kiosk is worse than an opaque one, so the window is only built see-through
//!     when the adapter that draws it is the one that shows it
//!     (`drawn_where_shown`), and the watchdog restarts the app if a display
//!     change breaks that later (`watch`): the relaunch re-pins to the new screen.
//!   * **Every platform has its own "can it be drawn here".** Windows: the GPU
//!     rule above. macOS: always (the window server composes every window, and
//!     `macOSPrivateApi` is already on for the window backing, which is what
//!     unlocks a transparent WKWebView). Linux: only with a compositor, which a
//!     Wayland session always has and an X11 one may not; without one the
//!     transparent pixels come out BLACK, so the window stays solid and the
//!     dashboard says why (`Launch::why`).
//!
//! The dashboard side: server/js/native-bridge.js reads the caps and sends the
//! switch, syncSeeThroughControl() in server/js/settings.js draws it, and
//! server/styles/backgroundfx.css takes the page's own ground away.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

use crate::prefs;

/// The main window was built see-through in this process.
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// At launch, a see-through window could be drawn where it is shown.
static READY: AtomicBool = AtomicBool::new(false);
/// The watchdog has seen the see-through window drawn where it is shown at least
/// once. A restart is only ever for a change AFTER that: if a fresh launch is
/// already in the wrong place, restarting again would only repeat it, forever.
#[cfg(windows)]
static SEEN_SAFE: AtomicBool = AtomicBool::new(false);
/// One restart per process, whatever asks for it.
static RESTARTING: AtomicBool = AtomicBool::new(false);

/// What the launch decided, for the window builder and the dashboard's caps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Launch {
    /// Build the main window see-through.
    pub on: bool,
    /// A see-through window could be drawn here at all. False with the user's
    /// switch on means the window came up opaque on purpose, and the dashboard
    /// says why instead of showing a switch that silently does nothing.
    pub ready: bool,
    /// Why not, when `ready` is false: "gpu" (Windows, another graphics card
    /// shows this screen) or "compositor" (Linux, nothing composes the
    /// transparency). The dashboard picks its explanation from it.
    pub why: Option<&'static str>,
}

/// Whether a transparent window on the target screen is drawn by the adapter
/// that shows it. Pure, so it is tested here on every platform; `gpu.rs` reads
/// the machine and calls it.
///
/// `adapters` names the GPU behind each real (non-virtual) screen, `pinned` is
/// the WebView2 adapter flag this process launched with (None when nothing was
/// pinned, the user's switch included), and `target` is the flag that WOULD
/// match the screen the window is on.
///
/// Safe in two cases only: every screen hangs off one adapter, so nothing can
/// cross; or the webview was pinned, and pinned to the adapter of this screen.
/// Anything else (a hybrid with the pin off, two discrete cards, a GPU name we
/// cannot classify) is refused rather than guessed: the cost of a wrong guess
/// is a dashboard that draws nothing at all.
// Read by gpu.rs, which exists on Windows only; tested everywhere.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn drawn_where_shown(adapters: &[&str], pinned: Option<&str>, target: Option<&str>) -> bool {
    let Some(first) = adapters.first() else { return false };
    if adapters.iter().all(|a| a == first) {
        return true;
    }
    matches!((pinned, target), (Some(p), Some(t)) if p == t)
}

/// Whether the window should be see-through now. Read once, in `setup`, after
/// the GPU pin is armed (the rule above reads it) and before the window exists.
pub fn decide(prefs: &prefs::DisplayPrefs, presenting: Option<&str>) -> Launch {
    let why = refusal(presenting);
    let ready = why.is_none();
    let launch = Launch { on: prefs.see_through && ready, ready, why };
    ACTIVE.store(launch.on, Ordering::SeqCst);
    READY.store(launch.ready, Ordering::SeqCst);
    if prefs.see_through && !ready {
        crate::crash_log::note(
            "display",
            match why {
                Some("compositor") => "see-through window not built: no compositor is running, so it would come out black",
                _ => "see-through window not built: this screen is drawn by another graphics card, so it would come out blank",
            },
        );
    }
    launch
}

/// Why a see-through window cannot be drawn on this machine now, or None.
#[cfg(windows)]
fn refusal(presenting: Option<&str>) -> Option<&'static str> {
    (!crate::gpu::see_through_ok(presenting)).then_some("gpu")
}

#[cfg(target_os = "macos")]
fn refusal(_presenting: Option<&str>) -> Option<&'static str> {
    None
}

/// GDK says whether the screen is composited: always on Wayland, and on X11
/// only while a compositing window manager runs (the same question
/// layers/linux.rs asks before drawing widgets on the desktop). Main thread,
/// which `setup` is.
#[cfg(target_os = "linux")]
fn refusal(_presenting: Option<&str>) -> Option<&'static str> {
    let composited = gtk::gdk::Display::default().is_some_and(|d| d.default_screen().is_composited());
    (!composited).then_some("compositor")
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn refusal(_presenting: Option<&str>) -> Option<&'static str> {
    Some("unsupported")
}

/// Whether the switch moving to `want` needs a relaunch to show. Pure, for the
/// tests: nothing to do when the window already is what was asked, and turning
/// it on where it cannot be drawn only records the wish (the next launch checks
/// again, since the screens may have changed by then).
fn needs_restart(want: bool, active: bool, ready: bool) -> bool {
    want != active && (!want || ready)
}

/// The dashboard's switch (`xenon-app:see-through-on|off`). Called on a plain
/// thread: it writes display.json, and the restart from a thread goes through
/// the run loop's Exit, which closes the crash diary's session by itself.
pub fn set_from_dashboard(app: &AppHandle, want: bool) {
    prefs::update(app, |p| p.see_through = want);
    if !needs_restart(want, ACTIVE.load(Ordering::SeqCst), READY.load(Ordering::SeqCst)) {
        return;
    }
    restart(
        app,
        if want { "see-through window switched on: restarting to build it" } else { "see-through window switched off: restarting to build it opaque" },
    );
}

/// One watchdog tick (monitor.rs). Only acts on a see-through window that WAS
/// drawn where it is shown and no longer is: a screen plugged in or out, or the
/// window moved to a screen on the other adapter. The relaunch pins the webview
/// to the adapter of the screen it is on now, which makes it visible again.
#[cfg(windows)]
pub fn watch(app: &AppHandle, presenting: Option<&str>) {
    if !ACTIVE.load(Ordering::SeqCst) {
        return;
    }
    if crate::gpu::see_through_ok(presenting) {
        SEEN_SAFE.store(true, Ordering::SeqCst);
        return;
    }
    if SEEN_SAFE.load(Ordering::SeqCst) {
        restart(app, "see-through window now on a screen another graphics card draws: restarting so it is not blank");
    }
}

fn restart(app: &AppHandle, why: &str) {
    if RESTARTING.swap(true, Ordering::SeqCst) {
        return;
    }
    crate::crash_log::note("display", why);
    crate::stop_owned_backend();
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    const IGPU: &str = "AMD Radeon(TM) Graphics";
    const DGPU: &str = "NVIDIA GeForce RTX 5080";
    const LOW: &str = "--force_low_power_gpu";
    const HIGH: &str = "--force_high_performance_gpu";

    #[test]
    fn one_graphics_card_is_always_safe() {
        assert!(drawn_where_shown(&[DGPU], None, None));
        assert!(drawn_where_shown(&[DGPU, DGPU, DGPU], None, Some(HIGH)));
    }

    #[test]
    fn a_hybrid_is_safe_only_when_pinned_to_the_screen_s_adapter() {
        // The Edge on the motherboard output, webview pinned to the iGPU.
        assert!(drawn_where_shown(&[DGPU, IGPU], Some(LOW), Some(LOW)));
        // The window moved to the monitor on the graphics card afterwards.
        assert!(!drawn_where_shown(&[DGPU, IGPU], Some(LOW), Some(HIGH)));
    }

    #[test]
    fn a_hybrid_with_the_pin_off_is_refused() {
        assert!(!drawn_where_shown(&[DGPU, IGPU], None, Some(LOW)));
    }

    #[test]
    fn two_cards_or_an_unknown_one_are_refused_rather_than_guessed() {
        assert!(!drawn_where_shown(&[DGPU, "AMD Radeon RX 9070 XT"], None, Some(HIGH)));
        assert!(!drawn_where_shown(&[DGPU, "Mystery Adapter"], Some(HIGH), None));
    }

    #[test]
    fn no_readable_screen_is_refused() {
        assert!(!drawn_where_shown(&[], None, None));
    }

    #[test]
    fn the_switch_restarts_only_when_the_window_would_change() {
        // Already what was asked.
        assert!(!needs_restart(true, true, true));
        assert!(!needs_restart(false, false, true));
        // On, and it can be drawn here.
        assert!(needs_restart(true, false, true));
        // On, but it cannot: recorded, no pointless restart into an opaque window.
        assert!(!needs_restart(true, false, false));
        // Off always rebuilds an opaque window.
        assert!(needs_restart(false, true, true));
        assert!(needs_restart(false, true, false));
    }
}
