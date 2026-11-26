//! Bit on the desktop on Windows (bit_desk.rs has the rule and the pixels):
//! one layered window, topmost, never activated, a tool window (no taskbar
//! button, no Alt+Tab). Not click-through: its empty pixels let every click
//! pass (alpha 0), its cells take them, so Bit can be tapped and dragged along
//! the taskbar while the rest of the bar works as always. It stays in
//! screenshots and recordings: a desktop with Bit on it is meant to be seen.
//!
//! One timer: at the walk's pace while it walks, at the next frame while a clip
//! has more than one, else every IDLE_TICK_MS for the watchdog and the full
//! screen check, so a still Bit costs nothing. Hidden while a window fills its
//! screen (a game, a video) and shown again after. A foreground hook puts it
//! back over the taskbar, which comes to the top of the topmost band each time
//! it is clicked.
//!
//! Main thread only; the state is a thread-local borrowed with
//! `try_borrow_mut` like glow_win32.rs; the window itself, the mouse and
//! what the page is told are in window_win32.rs.

use std::cell::RefCell;

use super::super::ffi::*;
use super::window_win32::{create, tell, Drag};
use super::{lane, paint, place, step, Area, Frame, Lane, Plan, Spec};

/// The page re-sends what it shows at least every 20 s.
const STALE_MS: u64 = 60_000;
const WALK_TICK_MS: u32 = 33;
const IDLE_TICK_MS: u32 = 2000;
/// A walk step never covers more than this, even after a slow tick.
const MAX_STEP_MS: u64 = 100;
const TIMER_ID: usize = 1;

#[derive(Default)]
pub(super) struct Desk {
    pub(super) hwnd: isize,
    hook: isize,
    pub(super) spec: Spec,
    mon: Area,
    pub(super) lane: Lane,
    pub(super) scale: f64,
    pub(super) cell: i32,
    /// The place along the lane the page last asked for, and where Bit stands now.
    heard_home: Option<f64>,
    pub(super) pos: f64,
    pub(super) left: bool,
    pub(super) walk: Option<(f64, f64)>,
    walk_seq: Option<u32>,
    once_seq: Option<u32>,
    playing_once: bool,
    frame: usize,
    due: u64,
    last: u64,
    touched: u64,
    hidden: bool,
    pub(super) drag: Option<Drag>,
}

thread_local! {
    pub(super) static DESK: RefCell<Desk> = RefCell::new(Desk::default());
}

fn now() -> u64 {
    unsafe { GetTickCount64() }
}

fn close(d: &mut Desk) {
    if d.hook != 0 {
        unsafe { UnhookWinEvent(d.hook) };
    }
    if d.hwnd != 0 {
        unsafe { DestroyWindow(d.hwnd) };
    }
    *d = Desk::default();
}

pub(super) fn size(d: &Desk) -> (i32, i32) {
    (d.spec.w as i32 * d.cell, d.spec.h as i32 * d.cell)
}

fn frames(d: &Desk) -> &[Frame] {
    match (&d.spec.once, d.playing_once) {
        (Some(o), true) => &o.frames,
        _ => &d.spec.looped,
    }
}

pub(super) fn render(d: &Desk) -> bool {
    let Some(frame) = frames(d).get(d.frame) else { return false };
    let (w, h) = size(d);
    let (x, y) = place(&d.lane, d.pos, w, h);
    let px = paint(frame, d.spec.w, d.spec.h, &d.spec.pal, d.cell as usize, d.left);
    blit(d.hwnd, Rect { l: x, t: y, r: x + w, b: y + h }, &px, 255)
}

/// A window in front fills Bit's screen (a game, a video): never the desktop or the taskbar.
fn covered(d: &Desk) -> bool {
    let h = unsafe { GetForegroundWindow() };
    if h == 0 || h == d.hwnd {
        return false;
    }
    let class = class_of(h);
    if matches!(class.as_str(), "Progman" | "WorkerW") || class.starts_with("Shell_") {
        return false;
    }
    let Some(m) = monitor_rect_of(h) else { return false };
    Area { l: m.l, t: m.t, r: m.r, b: m.b } == d.mon && super::super::scene::covers(&frame_of(h), &m)
}

/// Shown or hidden as the window in front asks, and over the taskbar again. True when it just came back.
fn recheck(d: &mut Desk) -> bool {
    let cover = covered(d);
    let back = d.hidden && !cover;
    if cover != d.hidden {
        d.hidden = cover;
        unsafe { ShowWindow(d.hwnd, if cover { SW_HIDE } else { SW_SHOWNOACTIVATE }) };
    }
    if !cover {
        unsafe { SetWindowPos(d.hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE) };
    }
    back
}

extern "system" fn on_foreground(_: isize, _: u32, _: isize, _: i32, _: i32, _: u32, _: u32) {
    DESK.with(|cell| {
        let Ok(mut d) = cell.try_borrow_mut() else { return };
        if d.hwnd != 0 && recheck(&mut d) {
            render(&d);
        }
    });
}

fn arm(d: &Desk, t: u64) {
    let ms = if d.hidden || d.drag.is_some() {
        IDLE_TICK_MS
    } else if d.walk.is_some() {
        WALK_TICK_MS
    } else if d.playing_once || d.spec.looped.len() > 1 {
        d.due.saturating_sub(t).clamp(16, u64::from(IDLE_TICK_MS)) as u32
    } else {
        IDLE_TICK_MS
    };
    // Re-arming the same id just changes its interval.
    unsafe { SetTimer(d.hwnd, TIMER_ID, ms, 0) };
}

/// What the page asked: new frames, a new home, a walk or a clip once.
fn take(d: &mut Desk, plan: Plan, t: u64) {
    let cell = (f64::from(plan.spec.cell) * plan.scale).round().max(1.0) as i32;
    let moved = plan.mon != d.mon || cell != d.cell || plan.spec.w != d.spec.w || plan.spec.h != d.spec.h;
    let relooped = plan.spec.looped != d.spec.looped;
    let home = plan.spec.home;
    let rehomed = d.heard_home.is_none_or(|was| (was - home).abs() > 1e-6);
    let (walk, once) = (plan.spec.walk, plan.spec.once.as_ref().map(|o| o.seq));
    d.mon = plan.mon;
    d.cell = cell;
    d.scale = plan.scale;
    d.lane = lane(plan.mon, plan.work, plan.spec.body as i32 * cell);
    d.spec = plan.spec;
    d.heard_home = Some(home);
    d.touched = t;
    if (moved || rehomed) && d.drag.is_none() {
        d.pos = home;
        d.walk = None;
    }
    if let Some(w) = walk.filter(|w| d.walk_seq != Some(w.seq)) {
        d.walk_seq = Some(w.seq);
        d.left = w.to < d.pos;
        d.walk = Some((w.to, w.pxs * plan.scale));
        d.last = t;
    }
    if let Some(seq) = once.filter(|s| d.once_seq != Some(*s)) {
        d.once_seq = Some(seq);
        d.playing_once = true;
        d.frame = 0;
    } else if relooped && !d.playing_once {
        d.frame = 0;
    }
    // A clip dropped from the message, or one with fewer frames now, never leaves it past its end.
    d.playing_once &= d.spec.once.is_some();
    if d.frame >= frames(d).len() {
        d.frame = 0;
    }
    d.due = t + u64::from(frames(d).get(d.frame).map_or(IDLE_TICK_MS, |f| f.ms));
}

pub fn apply(plan: Plan) {
    DESK.with(|cell| {
        let Ok(mut d) = cell.try_borrow_mut() else { return };
        if !plan.spec.on {
            return close(&mut d);
        }
        if d.hwnd == 0 {
            d.hwnd = create();
            if d.hwnd == 0 {
                return;
            }
            d.hidden = true; // created hidden: shown by `recheck` unless a full screen window is in front
            d.hook = unsafe { SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0, on_foreground, 0, 0, 0) };
        }
        let t = now();
        take(&mut d, plan, t);
        recheck(&mut d);
        if !d.hidden && !render(&d) {
            return close(&mut d);
        }
        arm(&d, t);
    });
}

/// The next frame when its time came: a clip played once goes back to the loop.
fn advance(d: &mut Desk, t: u64) -> bool {
    if t < d.due || !(d.playing_once || d.spec.looped.len() > 1) {
        return false;
    }
    d.frame += 1;
    if d.frame >= frames(d).len() {
        d.playing_once = false;
        d.frame = 0;
    }
    d.due = t + u64::from(frames(d).get(d.frame).map_or(IDLE_TICK_MS, |f| f.ms));
    true
}

pub(super) fn tick() {
    let mut arrived = false;
    DESK.with(|cell| {
        let Ok(mut d) = cell.try_borrow_mut() else { return };
        let t = now();
        if t.saturating_sub(d.touched) > STALE_MS {
            return close(&mut d);
        }
        let mut dirty = recheck(&mut d);
        if !d.hidden {
            if let Some((to, pxs)) = d.walk.filter(|_| d.drag.is_none()) {
                let (w, _) = size(&d);
                d.pos = step(&d.lane, w, d.pos, to, pxs, t.saturating_sub(d.last).min(MAX_STEP_MS));
                arrived = d.pos == to;
                if arrived {
                    d.walk = None;
                }
                dirty = true;
            }
            dirty |= advance(&mut d, t);
            if dirty {
                render(&d);
            }
        }
        d.last = t;
        arm(&d, t);
    });
    if arrived {
        tell("arrived()".into());
    }
}
