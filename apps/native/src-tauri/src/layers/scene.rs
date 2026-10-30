//! The Win32 side of the Ambient scene outside the dashboard
//! (server/js/screen-scene-model.js): the animated wallpaper behind the
//! desktop icons and the screensaver. win32.rs decides when they show; this
//! file holds what only they need.
//!
//! Wallpaper: a child of the desktop window, under the icons, the way Lively
//! does it (WinDesktopCore.cs). Message 0x052C asks Explorer for its WorkerW.
//! On Windows 11 24H2 and later, where Progman has WS_EX_NOREDIRECTIONBITMAP,
//! the WorkerW is a child of Progman and the wallpaper goes in Progman too,
//! right under SHELLDLL_DefView (the icons) and above that WorkerW; before,
//! it goes inside the WorkerW that follows the window holding the icons. A
//! child of the desktop never takes clicks, which is fine for a wallpaper (the
//! spike ruled it out for widgets for that reason).
//!
//! Explorer restarting destroys its windows and the wallpaper with them: the
//! sync drops a window that is gone and opens a new one on the next pass.
#![cfg(target_os = "windows")]

use super::ffi::*;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn find(parent: isize, after: isize, class: &str) -> isize {
    let c = wide(class);
    unsafe { FindWindowExW(parent, after, c.as_ptr(), std::ptr::null()) }
}

struct Desk {
    /// The window the wallpaper becomes a child of.
    parent: isize,
    /// 24H2+: SHELLDLL_DefView, which the wallpaper sits under, and the
    /// WorkerW that must stay last. 0 on older builds.
    icons: isize,
    worker: isize,
}

extern "system" fn worker_after_icons(h: isize, out: isize) -> i32 {
    if find(h, 0, "SHELLDLL_DefView") != 0 {
        unsafe { *(out as *mut isize) = find(0, h, "WorkerW") };
        return 0;
    }
    1
}

fn desk() -> Option<Desk> {
    let progman = find(0, 0, "Progman");
    if progman == 0 {
        return None;
    }
    let mut ignored = 0usize;
    unsafe { SendMessageTimeoutW(progman, 0x052C, 0xD, 0x1, SMTO_NORMAL, 1000, &mut ignored) };
    let ex = unsafe { GetWindowLongPtrW(progman, GWL_EXSTYLE) };
    if ex & WS_EX_NOREDIRECTIONBITMAP != 0 {
        let icons = find(progman, 0, "SHELLDLL_DefView");
        let worker = find(progman, 0, "WorkerW");
        return (icons != 0).then_some(Desk { parent: progman, icons, worker });
    }
    let mut worker = 0isize;
    unsafe { EnumWindows(worker_after_icons, &mut worker as *mut isize as isize) };
    (worker != 0).then_some(Desk { parent: worker, icons: 0, worker: 0 })
}

/// Make `h` a child of the desktop, under the icons. False when Explorer has
/// no desktop to attach to (another shell, Explorer not running yet).
pub fn attach(h: isize) -> bool {
    let Some(d) = desk() else { return false };
    unsafe {
        let style = GetWindowLongPtrW(h, GWL_STYLE);
        SetWindowLongPtrW(h, GWL_STYLE, (style & !WS_TOPLEVEL_BITS) | WS_CHILD);
        if d.icons != 0 {
            // A child of a window without a redirection bitmap is composed
            // only when it is layered.
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex | WS_EX_LAYERED as isize);
            SetLayeredWindowAttributes(h, 0, 255, LWA_ALPHA);
        }
        if SetParent(h, d.parent) == 0 {
            return false;
        }
    }
    true
}

/// Still a child of the desktop: false after Explorer rebuilt it.
pub fn attached(h: isize) -> bool {
    let parent = unsafe { GetParent(h) };
    parent != 0 && matches!(class_of(parent).as_str(), "Progman" | "WorkerW")
}

/// Cover `area` (screen pixels) in the parent's coordinates, under the icons.
pub fn place(h: isize, area: Rect) {
    let Some(d) = desk() else { return };
    let mut pts = [Point { x: area.l, y: area.t }, Point { x: area.r, y: area.b }];
    unsafe { MapWindowPoints(0, GetParent(h), pts.as_mut_ptr(), 2) };
    let (w, ht) = (pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    unsafe {
        if d.icons != 0 {
            SetWindowPos(h, d.icons, pts[0].x, pts[0].y, w, ht, SWP_NOACTIVATE);
            if d.worker != 0 {
                SetWindowPos(d.worker, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        } else {
            SetWindowPos(h, HWND_TOP, pts[0].x, pts[0].y, w, ht, SWP_NOACTIVATE);
        }
    }
}

/// A Remote Desktop session: a moving wallpaper would be streamed frame by
/// frame for nothing.
pub fn remote_session() -> bool {
    unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 }
}

/// An app asked to keep the screen on (a video, a presentation): no
/// screensaver over it, like Windows' own.
pub fn display_required() -> bool {
    let mut state = 0u32;
    let status = unsafe {
        CallNtPowerInformation(SYSTEM_EXECUTION_STATE, std::ptr::null(), 0, (&mut state as *mut u32).cast(), 4)
    };
    status == 0 && state & ES_DISPLAY_REQUIRED != 0
}

/// The window in front fills its whole monitor, taskbar included (a game or
/// a video in full screen). Never Xenon's own: the dashboard is a full-screen
/// kiosk on its screen and is in front after every tap on it.
pub fn front_fullscreen() -> bool {
    let h = unsafe { GetForegroundWindow() };
    if h == 0 || matches!(class_of(h).as_str(), "Progman" | "WorkerW") || class_of(h).starts_with("Shell_") {
        return false;
    }
    if pid_of(h) == unsafe { GetCurrentProcessId() } {
        return false;
    }
    let Some(mon) = monitor_rect_of(h) else { return false };
    covers(&frame_of(h), &mon)
}

pub fn covers(r: &Rect, mon: &Rect) -> bool {
    r.l <= mon.l && r.t <= mon.t && r.r >= mon.r && r.b >= mon.b
}

/// Bring the screensaver forward so the first key reaches it and not the app
/// underneath. Windows allows it once the foreground lock time-out (200 s by
/// default) has passed since the last input, which the idle wait guarantees.
pub fn take_focus(h: isize) -> bool {
    unsafe { SetForegroundWindow(h) != 0 }
}

/// Give the focus back to the window that had it before the screensaver.
pub fn give_back(prev: isize) {
    if prev != 0 && unsafe { IsWindow(prev) } != 0 {
        unsafe { SetForegroundWindow(prev) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_window_over_the_whole_monitor_is_full_screen() {
        let mon = Rect { l: 0, t: 0, r: 1920, b: 1080 };
        assert!(covers(&Rect { l: 0, t: 0, r: 1920, b: 1080 }, &mon));
        assert!(covers(&Rect { l: -8, t: -8, r: 1928, b: 1088 }, &mon));
        assert!(!covers(&Rect { l: 0, t: 0, r: 1920, b: 1040 }, &mon), "maximized above the taskbar");
    }
}
