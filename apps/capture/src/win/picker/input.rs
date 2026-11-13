// Windows picker: what a key or the mouse does to the selection.

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT};
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows::Win32::UI::WindowsAndMessaging::{MA_NOACTIVATE, WM_ERASEBKGND, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEMOVE, WM_PAINT, WM_RBUTTONDOWN, WM_TIMER};
use crate::region::{self};
use super::{Mode, Outcome, point, State};
use super::super::loupe::{self};

impl State {
    pub(super) fn handle(&mut self, h: HWND, msg: u32, l: LPARAM) -> Option<LRESULT> {
        let i = self.surface(h)?;
        match msg {
            WM_PAINT => self.paint(i),
            WM_ERASEBKGND => return Some(LRESULT(1)),
            WM_MOUSEACTIVATE => return Some(LRESULT(MA_NOACTIVATE as isize)),
            WM_MOUSEMOVE => match self.mode {
                Mode::Area => self.move_area(i, l),
                Mode::Colour => self.move_colour(i, point(l)),
                Mode::Measure => self.move_measure(i, l),
            },
            WM_LBUTTONDOWN => {
                self.drag = Some((self.desktop(i, l), i));
                unsafe { SetCapture(h) };
            }
            WM_LBUTTONUP => {
                let Some((from, on)) = self.drag.take() else {
                    return Some(LRESULT(0));
                };
                unsafe {
                    let _ = ReleaseCapture();
                }
                let pt = self.desktop(i, l);
                match self.mode {
                    Mode::Area => {
                        let area = self.pointed(on, Some(from), pt);
                        self.finish(Outcome::Area { surface: on, area });
                    }
                    // The pixel the magnifier shows, wherever the button came up.
                    Mode::Colour => {
                        if let Some((surface, Some((pt, _)))) =
                            self.mark.as_ref().map(|(j, m)| (*j, m.at))
                        {
                            self.finish(Outcome::Point { surface, pt });
                        }
                    }
                    // A click alone measures nothing: the ruler waits for a drag.
                    Mode::Measure if region::is_click(from, pt) => {
                        self.unlight();
                        self.set_mark(None);
                    }
                    Mode::Measure => {
                        let area = region::span(from, pt, self.surfaces[on].rect);
                        self.finish(Outcome::Area { surface: on, area });
                    }
                }
            }
            WM_RBUTTONDOWN | WM_TIMER => self.finish(Outcome::Cancel),
            _ => return None,
        }
        Some(LRESULT(0))
    }

    fn move_area(&mut self, i: usize, l: LPARAM) {
        let on = self.drag.map_or(i, |(_, d)| d);
        let pt = self.desktop(i, l);
        if matches!(self.drag, Some((from, _)) if !region::is_click(from, pt)) {
            self.hide_hint();
        }
        let area = self.pointed(on, self.drag.map(|(f, _)| f), pt);
        self.light(on, area);
    }

    pub(super) fn move_colour(&mut self, i: usize, pt: (i32, i32)) {
        let s = &self.surfaces[i];
        let mark = self
            .pens(i)
            .and_then(|p| loupe::colour(s.hwnd, &p, &s.normal, pt));
        self.set_mark(mark.map(|m| (i, m)));
    }

    fn move_measure(&mut self, i: usize, l: LPARAM) {
        let Some((from, on)) = self.drag else { return };
        let pt = self.desktop(i, l);
        if region::is_click(from, pt) {
            return;
        }
        self.hide_hint();
        let rect = self.surfaces[on].rect;
        let area = region::span(from, pt, rect);
        self.light(on, area);
        let s = &self.surfaces[on];
        let size = (rect.right - rect.left, rect.bottom - rect.top);
        let local = area.offset(-rect.left, -rect.top);
        let mark = self.pens(on).map(|p| loupe::size(s.hwnd, &p, local, size));
        self.set_mark(mark.map(|m| (on, m)));
    }
}
