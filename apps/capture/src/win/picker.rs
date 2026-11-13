//! The area picker: every monitor frozen under a dimmed copy of itself, one
//! borderless topmost window each. Drag to pick an area, click to pick the
//! window under the cursor (or the whole screen over the desktop); Esc or the
//! right button cancels. The windows never take focus, so the app in front
//! stays in front: Esc is read by a keyboard hook that lives only while the
//! picker is open.
//!
//! The same frozen screen serves the colour picker (undimmed, a magnifier
//! follows the cursor, a click picks the pixel) and the ruler (drag an area,
//! its size shows under it; a click alone picks nothing).

use std::cell::RefCell;
use std::time::Duration;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{HBRUSH, HFONT, InvalidateRect};
use windows::Win32::UI::WindowsAndMessaging::PostQuitMessage;
use super::dib::Dib;
use super::grab::Image;
use super::loupe::{Mark, Pens};
use crate::region::{self, Rect};

mod input;
mod paint;
mod window;
mod show;

pub use show::{inspect, pick};
use window::under_cursor;

/// A picker left open is closed by itself after this long.
const GIVE_UP: Duration = Duration::from_secs(120);
const GIVE_UP_TIMER: usize = 1;
const CLASS: PCWSTR = w!("XenonCapturePicker");
/// The hint line: text size, padding and distance from the top, at 100% scale.
const HINT_TEXT: f32 = 15.0;
const HINT_PAD: (f32, f32) = (14.0, 8.0);
const HINT_TOP: f32 = 24.0;
const HINT_BACK: COLORREF = COLORREF(0x001E1E1E);
const HINT_INK: COLORREF = COLORREF(0x00F0F0F0);
const EDGE: COLORREF = COLORREF(0x00FFFFFF);

/// One monitor as it was when the picker was asked for.
pub struct Frozen {
    pub monitor: usize,
    pub rect: Rect,
    pub image: Image,
}

pub struct Picked {
    pub monitor: usize,
    pub image: Image,
    pub copied: bool,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Area,
    Colour,
    Measure,
}

/// What the colour picker or the ruler picked: a colour or a size in pixels.
pub enum Inspected {
    Colour {
        monitor: usize,
        rgb: [u8; 3],
    },
    Size {
        monitor: usize,
        width: i32,
        height: i32,
    },
}

struct Surface {
    hwnd: HWND,
    monitor: usize,
    /// The monitor in desktop pixels; the window covers it exactly.
    rect: Rect,
    normal: Dib,
    dimmed: Dib,
    /// The area shown at full brightness, in window pixels.
    lit: Option<Rect>,
    hint: Option<RECT>,
    scale: f32,
}

enum Outcome {
    Area {
        surface: usize,
        area: Rect,
    },
    /// A pixel, in the surface's window pixels.
    Point {
        surface: usize,
        pt: (i32, i32),
    },
    Cancel,
}

struct State {
    mode: Mode,
    surfaces: Vec<Surface>,
    stack: Vec<Rect>,
    /// Where the left button went down, and on which surface.
    drag: Option<((i32, i32), usize)>,
    outcome: Option<Outcome>,
    hint: Vec<u16>,
    font: Option<HFONT>,
    back: HBRUSH,
    edge: HBRUSH,
    /// The magnifier or the size label, and the surface it is on.
    mark: Option<(usize, Mark)>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn rect_of(r: Rect) -> RECT {
    RECT {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
    }
}

fn invalidate(h: HWND, r: Option<Rect>) {
    if let Some(r) = r {
        unsafe {
            let _ = InvalidateRect(Some(h), Some(&rect_of(r)), false);
        }
    }
}

fn point(l: LPARAM) -> (i32, i32) {
    (
        (l.0 & 0xFFFF) as i16 as i32,
        ((l.0 >> 16) & 0xFFFF) as i16 as i32,
    )
}

impl State {
    fn surface(&self, h: HWND) -> Option<usize> {
        self.surfaces.iter().position(|s| s.hwnd == h)
    }

    fn desktop(&self, i: usize, l: LPARAM) -> (i32, i32) {
        let (x, y) = point(l);
        (
            x + self.surfaces[i].rect.left,
            y + self.surfaces[i].rect.top,
        )
    }

    /// What a click or a drag from `from` ending at `pt` would pick on surface `i`.
    fn pointed(&self, i: usize, from: Option<(i32, i32)>, pt: (i32, i32)) -> Rect {
        let rect = self.surfaces[i].rect;
        match from {
            Some(from) if !region::is_click(from, pt) => region::span(from, pt, rect),
            Some(from) => self.window_at(rect, from),
            None => self.window_at(rect, pt),
        }
    }

    fn window_at(&self, monitor: Rect, pt: (i32, i32)) -> Rect {
        region::hit(&self.stack, pt.0, pt.1)
            .and_then(|w| w.clip(monitor))
            .unwrap_or(monitor)
    }

    /// Shows `area` (desktop pixels) at full brightness on surface `i` only.
    fn light(&mut self, i: usize, area: Rect) {
        for (j, s) in self.surfaces.iter_mut().enumerate() {
            let lit = (j == i).then(|| area.offset(-s.rect.left, -s.rect.top));
            if lit != s.lit {
                invalidate(s.hwnd, s.lit);
                invalidate(s.hwnd, lit);
                s.lit = lit;
            }
        }
    }

    fn hide_hint(&mut self) {
        for s in self.surfaces.iter_mut() {
            if let Some(r) = s.hint.take() {
                invalidate(
                    s.hwnd,
                    Some(Rect {
                        left: r.left,
                        top: r.top,
                        right: r.right,
                        bottom: r.bottom,
                    }),
                );
            }
        }
    }

    fn unlight(&mut self) {
        for s in self.surfaces.iter_mut() {
            invalidate(s.hwnd, s.lit.take());
        }
    }

    fn pens(&self, i: usize) -> Option<Pens> {
        Some(Pens {
            font: self.font?,
            back: self.back,
            edge: self.edge,
            ink: HINT_INK,
            scale: self.surfaces[i].scale,
        })
    }

    fn set_mark(&mut self, mark: Option<(usize, Mark)>) {
        let area = |(j, m): &(usize, Mark)| {
            let r = m.rect;
            (
                *j,
                Rect {
                    left: r.left,
                    top: r.top,
                    right: r.right,
                    bottom: r.bottom,
                },
            )
        };
        for (j, r) in self.mark.iter().map(area).chain(mark.iter().map(area)) {
            invalidate(self.surfaces[j].hwnd, Some(r));
        }
        self.mark = mark;
    }

    fn finish(&mut self, outcome: Outcome) {
        self.outcome.get_or_insert(outcome);
        unsafe { PostQuitMessage(0) };
    }

    /// Enter: the whole screen under the pointer. With windows covering it, no
    /// click reaches it.
    fn take_screen(&mut self) {
        let surface = under_cursor(&self.surfaces);
        let area = self.surfaces[surface].rect;
        self.finish(Outcome::Area { surface, area });
    }
}
