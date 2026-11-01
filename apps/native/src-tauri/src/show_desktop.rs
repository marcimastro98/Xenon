//! Keep the kiosk visible through "show desktop" (Win+D) on Windows.
//!
//! Issue #143: Win+D made Xenon disappear from its own screen until another
//! app was brought back. Show Desktop does not minimise anything: it raises the
//! desktop above every ordinary window, and only always-on-top windows stay in
//! front of it. The kiosk is an ordinary window by design (monitor.rs
//! `clear_stuck_topmost`: it must never sit above the user's apps).
//!
//! So while the DESKTOP is the foreground window, a kiosk that owns its screen
//! (the Edge, or full screen on a screen the user picked) is lifted into the
//! topmost band, without being activated; the moment anything else comes to the
//! front it is put back. That is the widget layers' own answer to the same
//! problem (layers/win32.rs `RAISED`), which keeps Win+D a toggle: nothing is
//! restored or focused, so pressing it again still brings every app back.
//!
//! A windowed Xenon on a shared screen is left alone: there, Win+D hiding it is
//! exactly what the user asked for.
//!
//! macOS and Linux have no equivalent to fix. macOS's Show Desktop moves every
//! window aside as a system gesture, and the Linux desktops each implement it
//! their own way; the kiosk there behaves like any other app.

use std::sync::atomic::{AtomicBool, Ordering};

/// The kiosk is lifted above the desktop right now. monitor.rs reads it, so the
/// watchdog's "never stay topmost" repair does not undo the lift every tick.
#[cfg_attr(not(windows), allow(dead_code))]
static RAISED: AtomicBool = AtomicBool::new(false);

#[cfg_attr(not(windows), allow(dead_code))]
pub fn raised() -> bool {
    RAISED.load(Ordering::SeqCst)
}

/// Window classes that ARE the desktop when they are in front (Show Desktop,
/// or a click on the wallpaper).
#[cfg_attr(not(windows), allow(dead_code))]
fn is_desktop(class: &str) -> bool {
    class == "Progman" || class == "WorkerW"
}

/// Whether the kiosk should sit above the desktop now. Pure, for the tests.
#[cfg_attr(not(windows), allow(dead_code))]
fn want_raised(desktop_in_front: bool, owns_its_screen: bool, visible: bool) -> bool {
    desktop_in_front && owns_its_screen && visible
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::OnceLock;
    use tauri::{AppHandle, Manager};

    #[link(name = "user32")]
    extern "system" {
        fn SetWinEventHook(
            min: u32,
            max: u32,
            module: isize,
            callback: extern "system" fn(isize, u32, isize, i32, i32, u32, u32),
            pid: u32,
            tid: u32,
            flags: u32,
        ) -> isize;
        fn GetClassNameW(hwnd: isize, buf: *mut u16, max: i32) -> i32;
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    }
    const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;
    const WINEVENT_OUTOFCONTEXT: u32 = 0x0000;
    const HWND_TOPMOST: isize = -1;
    const HWND_NOTOPMOST: isize = -2;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOACTIVATE: u32 = 0x0010;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    fn class_of(hwnd: isize) -> String {
        let mut buf = [0u16; 64];
        let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    /// Called once from `setup`, on the main thread: an out-of-context WinEvent
    /// hook is delivered through the installing thread's message loop, and the
    /// main thread is the one that pumps it.
    pub fn start(app: &AppHandle) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        unsafe {
            SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0, on_foreground, 0, 0, WINEVENT_OUTOFCONTEXT);
        }
    }

    extern "system" fn on_foreground(_: isize, _: u32, fg: isize, _: i32, _: i32, _: u32, _: u32) {
        let Some(app) = APP.get() else { return };
        let Some(window) = app.get_webview_window("main") else { return };
        // The round home button owns its own always-on-top (monitor.rs
        // enter_home); dropping it to normal here would sink it behind apps.
        if crate::monitor::in_home_mode() {
            RAISED.store(false, Ordering::SeqCst);
            return;
        }
        let desktop = is_desktop(&class_of(fg));
        let want = want_raised(
            desktop,
            desktop && crate::monitor::owns_its_screen(&window),
            window.is_visible().unwrap_or(false),
        );
        if want == RAISED.load(Ordering::SeqCst) {
            return;
        }
        let Ok(hwnd) = window.hwnd() else { return };
        let after = if want { HWND_TOPMOST } else { HWND_NOTOPMOST };
        unsafe { SetWindowPos(hwnd.0 as isize, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE) };
        RAISED.store(want, Ordering::SeqCst);
    }
}

#[cfg(windows)]
pub use win::start;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_desktop_in_front_lifts_the_kiosk() {
        assert!(want_raised(true, true, true));
        assert!(!want_raised(false, true, true), "an app came back: the kiosk drops to normal");
    }

    #[test]
    fn a_windowed_or_hidden_xenon_is_left_to_win_d() {
        assert!(!want_raised(true, false, true), "windowed on a shared screen: hiding it is what Win+D is for");
        assert!(!want_raised(true, true, false), "hidden (phone mode, tray, remote desktop): stays hidden");
    }

    #[test]
    fn the_desktop_is_recognised_by_its_window_classes() {
        assert!(is_desktop("Progman"));
        assert!(is_desktop("WorkerW"));
        assert!(!is_desktop("Shell_TrayWnd"));
        assert!(!is_desktop("Chrome_WidgetWin_1"));
    }
}
