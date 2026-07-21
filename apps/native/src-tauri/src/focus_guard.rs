//! Keep the game focused while the user touches the kiosk.
//!
//! Tapping the Edge normally *activates* the kiosk window, so the foreground
//! game loses focus — borderless games stop receiving input, and exclusive
//! full-screen games minimize outright. While the dashboard reports game mode
//! (it signals `xenon-focus:guard-on/off` from `native-bridge.js`, driven by
//! the same detector that pauses ambient FX), this guard makes the kiosk
//! non-activatable (`WS_EX_NOACTIVATE` on the window and its WebView2
//! children — touch, taps and swipes still work; they never needed
//! activation) and, as a safety net for activations that slip through
//! (WebView2 can focus itself programmatically), gives the foreground
//! straight back to whoever had it.
//!
//! Typing is the deliberate exception: focusing a text field (AI chat, notes,
//! search) signals `type-start`, which lifts the guard and activates the
//! kiosk so the keyboard works — the game backgrounds exactly as it always
//! did while typing — and `type-end` re-arms the guard and hands the focus
//! back to the game. Tray-toggleable ("Keep games focused", on by default,
//! persisted). Pure `user32` FFI like `cursor_guard.rs`, no extra crates.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::prefs;

/// How often the watcher samples the foreground window. 250 ms keeps the
/// thread wakeup rate low for battery/idle-power on weak PCs; the give-back
/// safety net is event-driven (`on_focused`), so this cadence is not latency-
/// critical.
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// While armed, the no-activate style walk (`EnumChildWindows` + a style call
/// per WebView2 child) is re-asserted only when the foreground changes or every
/// this many ticks (~2 s) — late-created children still get it, without paying
/// the full walk on every tick of a gaming session.
const REASSERT_TICKS: u32 = 8;

/// Idle cadence while the kiosk is hidden (tray "Hide"): it cannot be touched,
/// so there is no focus to defend — the watcher just naps.
const HIDDEN_INTERVAL: Duration = Duration::from_millis(1000);

const GWL_EXSTYLE: i32 = -20;
const WS_EX_NOACTIVATE: isize = 0x0800_0000;

/// Master switch, mirrored from `DisplayPrefs::focus_guard` (tray toggle).
static ENABLED: AtomicBool = AtomicBool::new(true);

/// True while the dashboard reports game mode (`xenon-focus:guard-on/off`).
static GAME_MODE: AtomicBool = AtomicBool::new(false);

/// True while the user is typing in a dashboard text field — the guard is
/// lifted so the kiosk can hold keyboard focus.
static TYPING: AtomicBool = AtomicBool::new(false);

/// Raw HWND of the kiosk window; 0 until `start` runs (see `cursor_guard.rs` —
/// the window is created once, so the handle is stable).
static KIOSK_HWND: AtomicIsize = AtomicIsize::new(0);

/// Last foreground window that is not the kiosk — the one to give focus back
/// to (mid-game, that is the game).
static LAST_FOREGROUND: AtomicIsize = AtomicIsize::new(0);

#[link(name = "user32")]
extern "system" {
    fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
    fn EnumChildWindows(
        hwnd: isize,
        callback: extern "system" fn(isize, isize) -> i32,
        lparam: isize,
    ) -> i32;
    fn GetForegroundWindow() -> isize;
    fn SetForegroundWindow(hwnd: isize) -> i32;
    fn IsWindow(hwnd: isize) -> i32;
    fn IsWindowVisible(hwnd: isize) -> i32;
}

/// The guard is live: enabled, a game is in the foreground, and the user is
/// not deliberately typing in the dashboard.
fn armed() -> bool {
    ENABLED.load(Ordering::Relaxed)
        && GAME_MODE.load(Ordering::Relaxed)
        && !TYPING.load(Ordering::Relaxed)
}

fn set_noactivate(hwnd: isize, on: bool) {
    let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    let next = if on { ex | WS_EX_NOACTIVATE } else { ex & !WS_EX_NOACTIVATE };
    if next != ex {
        unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next) };
    }
}

extern "system" fn set_noactivate_child(hwnd: isize, on: isize) -> i32 {
    set_noactivate(hwnd, on != 0);
    1 // keep enumerating
}

/// Apply/remove `WS_EX_NOACTIVATE` on the kiosk window and every child (the
/// WebView2 host windows), so a click anywhere in the kiosk never activates it.
fn apply_guard(on: bool) {
    let hwnd = KIOSK_HWND.load(Ordering::Relaxed);
    if hwnd == 0 {
        return;
    }
    set_noactivate(hwnd, on);
    unsafe { EnumChildWindows(hwnd, set_noactivate_child, on as isize) };
}

/// Hand the foreground back to the window that had it (the game). Safe to call
/// while the kiosk is foreground — a foreground process may give focus away.
fn give_back() {
    let fg = LAST_FOREGROUND.load(Ordering::Relaxed);
    if fg != 0 && unsafe { IsWindow(fg) } != 0 {
        unsafe { SetForegroundWindow(fg) };
    }
}

/// Begin watching the foreground window. Called once at startup, after the
/// kiosk window is built; the thread stops once the window is gone.
pub fn start(window: &WebviewWindow) {
    ENABLED.store(prefs::load(window.app_handle()).focus_guard, Ordering::Relaxed);
    let Ok(hwnd) = window.hwnd() else { return };
    KIOSK_HWND.store(hwnd.0 as isize, Ordering::Relaxed);

    let app = window.app_handle().clone();
    thread::spawn(move || {
        let mut last_fg: isize = 0;
        let mut tick: u32 = 0;
        loop {
            thread::sleep(POLL_INTERVAL);
            if app.get_webview_window("main").is_none() {
                break; // window destroyed → stop the watcher
            }
            let kiosk = KIOSK_HWND.load(Ordering::Relaxed);
            if kiosk != 0 && unsafe { IsWindowVisible(kiosk) } == 0 {
                thread::sleep(HIDDEN_INTERVAL); // hidden kiosk → no focus to defend
                continue;
            }
            tick = tick.wrapping_add(1);
            let fg = unsafe { GetForegroundWindow() };
            if fg != 0 && fg != KIOSK_HWND.load(Ordering::Relaxed) {
                LAST_FOREGROUND.store(fg, Ordering::Relaxed);
            }
            if armed() && (fg != last_fg || tick % REASSERT_TICKS == 0) {
                apply_guard(true);
            }
            last_fg = fg;
        }
    });
}

/// The dashboard entered/left game mode (`xenon-focus:guard-on/off`).
pub fn set_game_mode(on: bool) {
    GAME_MODE.store(on, Ordering::Relaxed);
    if !on {
        TYPING.store(false, Ordering::Relaxed);
    }
    apply_guard(armed());
}

/// True while the dashboard reports game mode. Read by the display watchdog
/// (`monitor.rs`) so it does not re-pin — and steal the foreground from — a
/// running game that is switching the desktop resolution for exclusive
/// full-screen (that re-pin calls `set_focus()`, which yanks focus off the game).
pub fn game_mode() -> bool {
    GAME_MODE.load(Ordering::Relaxed)
}

/// The kiosk window just got the OS focus. While armed this should not happen
/// (no-activate), but WebView2 can still focus itself programmatically — give
/// the foreground straight back to the game.
pub fn on_focused() {
    if armed() {
        give_back();
    }
}

/// The user focused a text field (`xenon-focus:type-start`): lift the guard and
/// activate the kiosk so the keyboard (physical or touch) reaches the field.
pub fn type_start(window: &WebviewWindow) {
    if !ENABLED.load(Ordering::Relaxed) || !GAME_MODE.load(Ordering::Relaxed) {
        return; // nothing is guarded — normal focus behavior already applies
    }
    TYPING.store(true, Ordering::Relaxed);
    apply_guard(false);
    let _ = window.set_focus();
}

/// The user left the text field (`xenon-focus:type-end`): re-arm the guard and
/// hand the focus back to the game.
pub fn type_end() {
    if !TYPING.swap(false, Ordering::Relaxed) {
        return;
    }
    if armed() {
        apply_guard(true);
        give_back();
    }
}

/// Tray toggle: flip the behavior now and remember the choice across launches.
pub fn set_enabled(app: &AppHandle, on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
    prefs::update(app, |p| p.focus_guard = on);
    apply_guard(armed());
}
