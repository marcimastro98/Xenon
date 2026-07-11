//! Keep the desktop mouse where it was when the user touches the kiosk.
//!
//! Windows promotes every touchscreen tap to mouse input and teleports the
//! system cursor to the touched point — so tapping the Edge mid-game yanks the
//! mouse (and the game's aim, for cursor-driven games) onto the Edge panel.
//! There is no per-monitor OS switch for this, so the kiosk works around it:
//! a lightweight watcher remembers the last cursor position *outside* the
//! kiosk window, and when a touch interaction on the dashboard ends (the
//! webview signals it via a `xenon-cursor:restore` navigation, see
//! `native-bridge.js`), the cursor is put back exactly where it was.
//!
//! Mouse clicks on the dashboard are unaffected — the webview only signals for
//! `pointerType === 'touch'`. The behavior can be turned off from the tray
//! ("Keep mouse on its screen") and the choice is remembered in the display
//! prefs. Pure `user32` FFI, no extra crates.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::prefs;

/// How often the watcher samples the cursor. Cheap (two user32 calls), and any
/// position older than one tick is still "where the mouse was before the touch".
/// 250 ms keeps the thread wakeup rate low for battery/idle-power on weak PCs;
/// the restore point being up to a tick stale is imperceptible.
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Master switch, mirrored from `DisplayPrefs::cursor_guard` (tray toggle).
static ENABLED: AtomicBool = AtomicBool::new(true);

/// Raw HWND of the kiosk window (pointer-sized); 0 until `start` runs. The
/// window is created once and only ever hidden/shown, so the handle is stable.
static KIOSK_HWND: AtomicIsize = AtomicIsize::new(0);

/// Last cursor position seen *outside* the kiosk window — the spot to restore
/// to after a touch. `None` until the mouse has been seen off the kiosk.
static SAVED_POS: Mutex<Option<(i32, i32)>> = Mutex::new(None);

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[repr(C)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

/// Idle cadence while the kiosk is hidden (tray "Hide"): nothing can be touched,
/// so the watcher just naps instead of sampling.
const HIDDEN_INTERVAL: Duration = Duration::from_millis(1000);

#[link(name = "user32")]
extern "system" {
    fn GetCursorPos(point: *mut Point) -> i32;
    fn SetCursorPos(x: i32, y: i32) -> i32;
    fn GetWindowRect(hwnd: isize, rect: *mut Rect) -> i32;
    fn IsWindowVisible(hwnd: isize) -> i32;
}

/// Current cursor position in screen coordinates, if Windows will tell us.
fn cursor_pos() -> Option<(i32, i32)> {
    let mut p = Point { x: 0, y: 0 };
    (unsafe { GetCursorPos(&mut p) } != 0).then_some((p.x, p.y))
}

/// Screen rect of the kiosk window (full-screen on the Edge, so effectively the
/// Edge monitor). `None` before `start` or if the window handle went away.
fn kiosk_rect() -> Option<Rect> {
    let hwnd = KIOSK_HWND.load(Ordering::Relaxed);
    if hwnd == 0 {
        return None;
    }
    let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
    (unsafe { GetWindowRect(hwnd, &mut r) } != 0).then_some(r)
}

fn inside(r: &Rect, x: i32, y: i32) -> bool {
    x >= r.left && x < r.right && y >= r.top && y < r.bottom
}

/// Begin watching the cursor. Called once at startup, after the kiosk window is
/// built. The thread looks the window up each tick (like the monitor watchdog)
/// so it stops cleanly once the window is gone.
pub fn start(window: &WebviewWindow) {
    ENABLED.store(prefs::load(window.app_handle()).cursor_guard, Ordering::Relaxed);
    let Ok(hwnd) = window.hwnd() else { return };
    KIOSK_HWND.store(hwnd.0 as isize, Ordering::Relaxed);

    let app = window.app_handle().clone();
    thread::spawn(move || loop {
        thread::sleep(POLL_INTERVAL);
        if app.get_webview_window("main").is_none() {
            break; // window destroyed → stop the watcher
        }
        if !ENABLED.load(Ordering::Relaxed) {
            continue;
        }
        let hwnd = KIOSK_HWND.load(Ordering::Relaxed);
        if hwnd != 0 && unsafe { IsWindowVisible(hwnd) } == 0 {
            thread::sleep(HIDDEN_INTERVAL); // hidden kiosk → no touches to guard
            continue;
        }
        let (Some((x, y)), Some(rect)) = (cursor_pos(), kiosk_rect()) else {
            continue;
        };
        if !inside(&rect, x, y) {
            *SAVED_POS.lock().unwrap() = Some((x, y));
        }
    });
}

/// A touch interaction on the dashboard just ended: if the touch dragged the
/// cursor onto the kiosk, put it back where it was. Skips quietly when the
/// feature is off, no off-kiosk position is known yet, or the cursor is not on
/// the kiosk anymore (e.g. the user already moved the physical mouse).
pub fn restore() {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let Some((sx, sy)) = *SAVED_POS.lock().unwrap() else { return };
    let (Some((cx, cy)), Some(rect)) = (cursor_pos(), kiosk_rect()) else {
        return;
    };
    if inside(&rect, cx, cy) {
        unsafe { SetCursorPos(sx, sy) };
    }
}

/// Tray toggle: flip the behavior now and remember the choice across launches.
pub fn set_enabled(app: &AppHandle, on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
    prefs::update(app, |p| p.cursor_guard = on);
}
