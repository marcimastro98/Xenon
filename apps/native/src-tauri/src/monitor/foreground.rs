// Keeps the kiosk above other windows without taking the keyboard: who has the foreground, and raising quietly.

use tauri::WebviewWindow;
#[cfg(not(windows))]
use tauri::Manager;

/// True when the kiosk window currently holds the OS foreground. The watchdog
/// asks before re-focusing on a re-pin: re-asserting full-screen over a taskbar
/// Windows moved onto the Edge is worth a raise, but only when the kiosk was
/// already the window in use. If anything else has the foreground — most often a
/// window the user deliberately dragged onto the Edge — the re-pin stays silent.
#[cfg(windows)]
pub(super) fn kiosk_has_foreground(window: &WebviewWindow) -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
    }
    let Ok(hwnd) = window.hwnd() else { return false };
    unsafe { GetForegroundWindow() == hwnd.0 as isize }
}

#[cfg(not(windows))]
pub(super) fn kiosk_has_foreground(_window: &WebviewWindow) -> bool {
    true
}

/// True when the foreground belongs to any window of this process, the menu too.
#[cfg(windows)]
pub(super) fn xenon_has_foreground(_window: &WebviewWindow) -> bool {
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
pub(super) fn xenon_has_foreground(window: &WebviewWindow) -> bool {
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
pub(super) fn clear_stuck_topmost(window: &WebviewWindow) {
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
pub(super) fn raise_quietly(window: &WebviewWindow) {
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
pub(super) fn raise_quietly(_window: &WebviewWindow) {}
