//! Bit on the desktop on Windows (bit_desk.rs has the rule and the pixels,
//! state.rs what Bit does): one layered window, topmost, never activated, a
//! tool window (no taskbar button, no Alt+Tab). Not click-through: its empty
//! pixels let every click pass (alpha 0), its cells take them, so Bit can be
//! tapped and dragged anywhere while the rest of the bar works as always. It
//! stays in screenshots and recordings: a desktop with Bit on it is meant to
//! be seen.
//!
//! One timer: at the walk's pace while it walks, at the next frame while a clip
//! has more than one, else every IDLE_TICK_MS for the watchdog and the full
//! screen check, so a still Bit costs nothing. Hidden while a window fills its
//! screen (a game, a video) and shown again after. A foreground hook puts it
//! back over the taskbar, which comes to the top of the topmost band each time
//! it is clicked.
//!
//! Main thread only; the state is a thread-local borrowed with
//! `try_borrow_mut` like glow_win32.rs; the window itself and the mouse on it
//! are in window_win32.rs.

use std::cell::RefCell;

use super::super::ffi::*;
use super::state::{now, Desk};
use super::window_win32::create;
use super::{tell, Area, Plan};

const TIMER_ID: usize = 1;

#[derive(Default)]
pub(super) struct Win {
    pub(super) hwnd: isize,
    hook: isize,
    pub(super) desk: Desk,
}

thread_local! {
    pub(super) static WIN: RefCell<Win> = RefCell::new(Win::default());
}

fn close(w: &mut Win) {
    if w.hook != 0 {
        unsafe { UnhookWinEvent(w.hook) };
    }
    if w.hwnd != 0 {
        unsafe { DestroyWindow(w.hwnd) };
    }
    *w = Win::default();
}

pub(super) fn render(w: &Win) -> bool {
    let d = &w.desk;
    let Some(px) = d.pixels() else { return false };
    let ((x, y), (sw, sh)) = (d.at(), d.size());
    blit(w.hwnd, Rect { l: x, t: y, r: x + sw, b: y + sh }, &px, 255)
}

/// A window in front fills Bit's screen (a game, a video): never the desktop or the taskbar.
fn covered(w: &Win) -> bool {
    let h = unsafe { GetForegroundWindow() };
    if h == 0 || h == w.hwnd {
        return false;
    }
    let class = class_of(h);
    if matches!(class.as_str(), "Progman" | "WorkerW") || class.starts_with("Shell_") {
        return false;
    }
    let Some(m) = monitor_rect_of(h) else { return false };
    Area { l: m.l, t: m.t, r: m.r, b: m.b } == w.desk.mon && super::super::scene::covers(&frame_of(h), &m)
}

/// Shown or hidden as the window in front asks, and over the taskbar again. True when it just came back.
fn recheck(w: &mut Win) -> bool {
    let cover = covered(w);
    let back = w.desk.hidden && !cover;
    if cover != w.desk.hidden {
        w.desk.hidden = cover;
        unsafe { ShowWindow(w.hwnd, if cover { SW_HIDE } else { SW_SHOWNOACTIVATE }) };
    }
    if !cover {
        unsafe { SetWindowPos(w.hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE) };
    }
    back
}

extern "system" fn on_foreground(_: isize, _: u32, _: isize, _: i32, _: i32, _: u32, _: u32) {
    WIN.with(|cell| {
        let Ok(mut w) = cell.try_borrow_mut() else { return };
        if w.hwnd != 0 && recheck(&mut w) {
            render(&w);
        }
    });
}

fn arm(w: &Win, t: u64) {
    // Re-arming the same id just changes its interval.
    unsafe { SetTimer(w.hwnd, TIMER_ID, w.desk.wait_ms(t) as u32, 0) };
}

pub fn apply(plan: Plan) {
    WIN.with(|cell| {
        let Ok(mut w) = cell.try_borrow_mut() else { return };
        if !plan.spec.on {
            return close(&mut w);
        }
        if w.hwnd == 0 {
            w.hwnd = create();
            if w.hwnd == 0 {
                return;
            }
            w.desk.hidden = true; // created hidden: shown by `recheck` unless a full screen window is in front
            w.hook = unsafe { SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0, on_foreground, 0, 0, 0) };
        }
        let t = now();
        w.desk.take(plan, t);
        recheck(&mut w);
        if !w.desk.hidden && !render(&w) {
            return close(&mut w);
        }
        arm(&w, t);
    });
}

pub(super) fn tick() {
    let mut arrived = false;
    WIN.with(|cell| {
        let Ok(mut w) = cell.try_borrow_mut() else { return };
        let t = now();
        if w.desk.stale(t) {
            return close(&mut w);
        }
        let back = recheck(&mut w);
        let (dirty, came) = w.desk.tick(t);
        arrived = came;
        if !w.desk.hidden && (back || dirty) {
            render(&w);
        }
        arm(&w, t);
    });
    if arrived {
        tell("arrived()".into());
    }
}
