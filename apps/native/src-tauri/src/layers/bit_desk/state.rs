//! What Bit on the desktop does, the same on every OS (bit_desk.rs has the
//! message rule and the pixels, ground.rs the lane): what the page asked
//! (`take`), the frame on show, where its window stands (`at`), a walk's steps,
//! when the next tick is due, and the mouse's arithmetic: a press that moves is
//! a drag anywhere, onto any screen, one that does not is a tap; a drop says
//! where along the bar, how high (-1: near the bar, so on it) and the corner
//! of the screen it landed on, and the page decides if it stays.
//!
//! The backends (win32.rs, macos.rs, linux.rs) own the window, the timer and
//! the mouse events, and draw what this says. Physical pixels, as the shell
//! reports the screens; tested in unit_tests.rs.

use std::sync::OnceLock;
use std::time::Instant;

use super::{along, lane, paint, place, rise_of, spot, step, Area, Frame, Lane, Plan, Spec};

/// The page re-sends what it shows at least every 20 s.
const STALE_MS: u64 = 60_000;
const WALK_TICK_MS: u64 = 33;
pub(super) const IDLE_TICK_MS: u64 = 2000;
/// A walk step never covers more than this, even after a slow tick.
const MAX_STEP_MS: u64 = 100;
/// A press that moves less (logical pixels) is a tap.
const DRAG_PX: f64 = 6.0;
/// Let go with its feet this close (logical pixels) to the desktop's bottom edge, it goes back on the bar.
const SNAP_PX: f64 = 24.0;

/// Milliseconds on a clock that only goes forward.
pub(super) fn now() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

struct Drag {
    from: (i32, i32),
    at0: (i32, i32),
    moved: bool,
}

#[derive(Default)]
pub(super) struct Desk {
    pub(super) spec: Spec,
    pub(super) mon: Area,
    pub(super) work: Area,
    lane: Lane,
    pub(super) scale: f64,
    pub(super) cell: i32,
    /// The place along the lane the page last asked for, and where Bit stands now.
    heard_home: Option<f64>,
    pos: f64,
    pub(super) left: bool,
    walk: Option<(f64, f64)>,
    walk_seq: Option<u32>,
    once_seq: Option<u32>,
    playing_once: bool,
    frame: usize,
    due: u64,
    last: u64,
    touched: u64,
    /// Hidden by the backend: a window in front fills Bit's screen.
    pub(super) hidden: bool,
    drag: Option<Drag>,
    /// Where the window is while it is dragged, and after a drop until the page answers.
    free: Option<(i32, i32)>,
}

impl Desk {
    pub(super) fn size(&self) -> (i32, i32) {
        (self.spec.w as i32 * self.cell, self.spec.h as i32 * self.cell)
    }

    /// The height Bit needs inside the bar. The Dock is full of icons, so on
    /// macOS Bit stands on top of it, on the desktop's bottom edge.
    fn ground(&self) -> i32 {
        if cfg!(target_os = "macos") { i32::MAX } else { self.spec.body as i32 * self.cell }
    }

    fn frames(&self) -> &[Frame] {
        match (&self.spec.once, self.playing_once) {
            (Some(o), true) => &o.frames,
            _ => &self.spec.looped,
        }
    }

    /// The frame on show.
    pub(super) fn current(&self) -> Option<&Frame> {
        self.frames().get(self.frame)
    }

    /// The frame on show as premultiplied BGRA rows, `size()` pixels.
    pub(super) fn pixels(&self) -> Option<Vec<u8>> {
        let frame = self.current()?;
        Some(paint(frame, self.spec.w, self.spec.h, &self.spec.pal, self.cell as usize, self.left))
    }

    /// The window's top-left corner: held by the mouse, left away from the bar, or on it.
    pub(super) fn at(&self) -> (i32, i32) {
        let (w, h) = self.size();
        match (self.free, self.spec.rise) {
            (Some(p), _) => p,
            (None, Some(rise)) => spot(&self.lane, self.work, self.pos, rise, w, h),
            (None, None) => place(&self.lane, self.pos, w, h),
        }
    }

    pub(super) fn stale(&self, t: u64) -> bool {
        t.saturating_sub(self.touched) > STALE_MS
    }

    /// What the page asked: new frames, a new home, a walk or a clip once.
    pub(super) fn take(&mut self, plan: Plan, t: u64) {
        let cell = (f64::from(plan.spec.cell) * plan.scale).round().max(1.0) as i32;
        let moved = plan.mon != self.mon || cell != self.cell || plan.spec.w != self.spec.w || plan.spec.h != self.spec.h;
        let relooped = plan.spec.looped != self.spec.looped;
        let home = plan.spec.home;
        let rehomed = self.heard_home.is_none_or(|was| (was - home).abs() > 1e-6);
        let (walk, once) = (plan.spec.walk, plan.spec.once.as_ref().map(|o| o.seq));
        self.mon = plan.mon;
        self.work = plan.work;
        self.cell = cell;
        self.scale = plan.scale;
        self.spec = plan.spec;
        self.lane = lane(plan.mon, plan.work, self.ground());
        self.heard_home = Some(home);
        self.touched = t;
        // The page's word puts it back where it belongs: where it was dropped, or where it was when the drop was refused.
        if self.drag.is_none() {
            self.free = None;
        }
        if (moved || rehomed) && self.drag.is_none() {
            self.pos = home;
            self.walk = None;
        }
        if let Some(w) = walk.filter(|w| self.walk_seq != Some(w.seq)) {
            self.walk_seq = Some(w.seq);
            self.left = w.to < self.pos;
            self.walk = Some((w.to, w.pxs * plan.scale));
            self.last = t;
        }
        if let Some(seq) = once.filter(|s| self.once_seq != Some(*s)) {
            self.once_seq = Some(seq);
            self.playing_once = true;
            self.frame = 0;
        } else if relooped && !self.playing_once {
            self.frame = 0;
        }
        // A clip dropped from the message, or one with fewer frames now, never leaves it past its end.
        self.playing_once &= self.spec.once.is_some();
        if self.frame >= self.frames().len() {
            self.frame = 0;
        }
        self.due = t + u64::from(self.frames().get(self.frame).map_or(IDLE_TICK_MS as u32, |f| f.ms));
    }

    /// The next frame when its time came: a clip played once goes back to the loop.
    fn advance(&mut self, t: u64) -> bool {
        if t < self.due || !(self.playing_once || self.spec.looped.len() > 1) {
            return false;
        }
        self.frame += 1;
        if self.frame >= self.frames().len() {
            self.playing_once = false;
            self.frame = 0;
        }
        self.due = t + u64::from(self.frames().get(self.frame).map_or(IDLE_TICK_MS as u32, |f| f.ms));
        true
    }

    /// One timer tick: a walk's step and the next frame while shown. Whether
    /// to redraw, and whether a walk just arrived.
    pub(super) fn tick(&mut self, t: u64) -> (bool, bool) {
        let (mut dirty, mut arrived) = (false, false);
        if !self.hidden {
            if let Some((to, pxs)) = self.walk.filter(|_| self.drag.is_none()) {
                let (w, _) = self.size();
                self.pos = step(&self.lane, w, self.pos, to, pxs, t.saturating_sub(self.last).min(MAX_STEP_MS));
                arrived = self.pos == to;
                if arrived {
                    self.walk = None;
                }
                dirty = true;
            }
            dirty |= self.advance(t);
        }
        self.last = t;
        (dirty, arrived)
    }

    /// Milliseconds to the next tick: the walk's pace, the next frame of a
    /// clip, else the idle beat for the watchdog and the full screen check.
    pub(super) fn wait_ms(&self, t: u64) -> u64 {
        if self.hidden || self.drag.is_some() {
            IDLE_TICK_MS
        } else if self.walk.is_some() {
            WALK_TICK_MS
        } else if self.playing_once || self.spec.looped.len() > 1 {
            self.due.saturating_sub(t).clamp(16, IDLE_TICK_MS)
        } else {
            IDLE_TICK_MS
        }
    }

    /// The button went down on Bit, the cursor at `cursor`.
    pub(super) fn press(&mut self, cursor: (i32, i32)) {
        self.drag = Some(Drag { from: cursor, at0: self.at(), moved: false });
    }

    /// The cursor moved while pressed: true when the window moves with it.
    pub(super) fn drag_to(&mut self, cursor: (i32, i32)) -> bool {
        let Some(drag) = self.drag.as_ref() else { return false };
        let (dx, dy) = (cursor.0 - drag.from.0, cursor.1 - drag.from.1);
        if !drag.moved && f64::from(dx).hypot(f64::from(dy)) < DRAG_PX * self.scale {
            return false;
        }
        let to = (drag.at0.0 + dx, drag.at0.1 + dy);
        if let Some(drag) = self.drag.as_mut() {
            drag.moved = true;
        }
        let was = self.at().0;
        if to.0 != was {
            self.left = to.0 < was;
        }
        self.walk = None;
        self.free = Some(to);
        true
    }

    /// The press ended (`up`: the button came up, else the mouse was taken
    /// away): what the page is told, a tap or a drop on the screen `screen`
    /// names (its whole area and its desktop), or nothing.
    pub(super) fn release(&mut self, up: bool, screen: impl FnOnce(&Desk) -> Option<(Area, Area)>) -> Option<String> {
        let drag = self.drag.take()?;
        if !drag.moved {
            return up.then(|| "tapped()".to_string());
        }
        let (mon, work) = screen(self).unwrap_or((self.mon, self.work));
        let (w, h) = self.size();
        let (left, top) = self.at();
        let on = lane(mon, work, self.ground());
        let rise = rise_of(&on, work, top, h, (SNAP_PX * self.scale).round() as i32).unwrap_or(-1.0);
        Some(format!("dropped({:.4},{rise:.4},{},{})", along(&on, left, w), mon.l, mon.t))
    }
}
