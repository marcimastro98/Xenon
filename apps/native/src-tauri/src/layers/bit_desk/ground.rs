//! Where Bit stands on its screen: the lane along the taskbar or the
//! desktop's bottom edge, its place on it and a walk's steps, in physical
//! pixels. Plain numbers, tested in unit_tests.rs.

use super::fraction;

/// A rectangle in physical pixels: a monitor or its work area.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Area {
    pub l: i32,
    pub t: i32,
    pub r: i32,
    pub b: i32,
}

/// Where Bit walks: from `l` to `r`, its feet on `floor`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Lane {
    pub l: i32,
    pub r: i32,
    pub floor: i32,
}

/// Inside the taskbar when it sits at the bottom and Bit fits in it (in the
/// middle of its height); else on the bottom edge of the desktop: a taskbar
/// that hides itself, or one on a side or at the top.
pub fn lane(mon: Area, work: Area, h: i32) -> Lane {
    let band = mon.b - work.b;
    let floor = if band >= h { mon.b - (band - h) / 2 } else { work.b };
    Lane { l: work.l, r: work.r.max(work.l), floor }
}

/// The window's top-left corner for a sprite of `w` x `h` at `x` along the lane.
pub fn place(lane: &Lane, x: f64, w: i32, h: i32) -> (i32, i32) {
    let room = (lane.r - lane.l - w).max(0);
    (lane.l + (fraction(x) * f64::from(room)).round() as i32, lane.floor - h)
}

/// The other way: where along the lane a window whose left edge is `left` stands.
pub fn along(lane: &Lane, left: i32, w: i32) -> f64 {
    let room = lane.r - lane.l - w;
    if room <= 0 { 0.0 } else { fraction(f64::from(left - lane.l) / f64::from(room)) }
}

/// One step of a walk: `dt_ms` at `pxs` physical pixels a second, never past `to`.
pub fn step(lane: &Lane, w: i32, from: f64, to: f64, pxs: f64, dt_ms: u64) -> f64 {
    let room = f64::from((lane.r - lane.l - w).max(1));
    let d = pxs * dt_ms as f64 / 1000.0 / room;
    if (to - from).abs() <= d { to } else if to > from { from + d } else { from - d }
}
