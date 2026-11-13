// Windows drawing sheet: what the pen, a key or the toolbar does.

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, ReleaseCapture, SetCapture, TME_LEAVE, TrackMouseEvent, TRACKMOUSEEVENT, VK_CONTROL, VK_DELETE};
use windows::Win32::UI::WindowsAndMessaging::{KillTimer, PostMessageW, WM_CAPTURECHANGED, WM_CLOSE, WM_DISPLAYCHANGE, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_TIMER};
use crate::sketch::bar::{self, Item};
use crate::sketch::canvas::Tool;
use super::{HINT_TIMER, MK_CONTROL, MK_SHIFT, point, State, WM_MOUSELEAVE};

impl State {
    pub(super) fn canvas(&mut self, msg: u32, w: WPARAM, l: LPARAM) -> Option<LRESULT> {
        let pt = point(l);
        match msg {
            WM_LBUTTONDOWN => {
                unsafe {
                    SetCapture(self.s.canvas);
                }
                self.dragging = true;
                let (ctrl, shift) = (w.0 & MK_CONTROL != 0, w.0 & MK_SHIFT != 0);
                // Ctrl draws a box, Ctrl+Shift an arrow, Shift a straight line.
                let tool = match (ctrl, shift) {
                    (true, true) => Tool::Arrow,
                    (true, false) => Tool::Box,
                    _ => self.tool,
                };
                let (rgb, scale) = (bar::PALETTE[self.colour], self.s.scale);
                let s = &mut self.s;
                let dirty =
                    s.sketch
                        .begin(s.pixels.bytes_mut(), tool, rgb, scale, shift && !ctrl, pt);
                if dirty.is_some() {
                    s.present(dirty);
                }
                if self.s.has_hint() {
                    self.s.drop_hint();
                    self.paint_bar();
                }
            }
            WM_MOUSEMOVE if self.dragging => {
                let s = &mut self.s;
                if let Some(dirty) = s.sketch.extend(s.pixels.bytes_mut(), pt) {
                    s.present(Some(dirty));
                }
            }
            WM_LBUTTONUP => {
                self.finish_stroke();
                unsafe {
                    let _ = ReleaseCapture();
                }
            }
            WM_CAPTURECHANGED => self.finish_stroke(),
            WM_KEYDOWN => self.key(w.0 as u32),
            WM_TIMER => {
                unsafe {
                    let _ = KillTimer(Some(self.s.canvas), HINT_TIMER);
                }
                if self.s.has_hint() {
                    self.s.drop_hint();
                    self.paint_bar();
                }
            }
            WM_DISPLAYCHANGE => unsafe {
                // The monitor changed under the drawing: it no longer lines up.
                let _ = PostMessageW(Some(self.s.canvas), WM_CLOSE, WPARAM(0), LPARAM(0));
            },
            _ => return None,
        }
        Some(LRESULT(0))
    }

    fn finish_stroke(&mut self) {
        if !self.dragging {
            return;
        }
        self.dragging = false;
        let had = self.s.sketch.has_strokes();
        let s = &mut self.s;
        s.sketch.end(s.pixels.bytes());
        if had != self.s.sketch.has_strokes() {
            self.paint_bar();
        }
    }

    fn key(&mut self, vk: u32) {
        let ctrl = unsafe { GetKeyState(VK_CONTROL.0 as i32) } < 0;
        let colour = b"RYGBWK".iter().position(|&c| c as u32 == vk);
        match (vk, colour) {
            (v, _) if v == b'Z' as u32 && ctrl => self.act(Item::Undo),
            (v, _) if v == b'E' as u32 || v == VK_DELETE.0 as u32 => self.act(Item::Clear),
            (_, Some(i)) if !ctrl => self.act(Item::Colour(i)),
            _ => {}
        }
    }

    fn act(&mut self, item: Item) {
        match item {
            Item::Colour(i) => self.colour = i,
            Item::Tool(t) => self.tool = t,
            Item::Undo | Item::Clear => {
                self.finish_stroke();
                let s = &mut self.s;
                let changed = if item == Item::Undo {
                    s.sketch.undo(s.pixels.bytes_mut())
                } else {
                    s.sketch.clear(s.pixels.bytes_mut())
                };
                if changed {
                    self.s.present(None);
                }
            }
            Item::Close => unsafe {
                let _ = PostMessageW(Some(self.s.canvas), WM_CLOSE, WPARAM(0), LPARAM(0));
                return;
            },
        }
        self.paint_bar();
    }

    pub(super) fn bar(&mut self, msg: u32, l: LPARAM) -> Option<LRESULT> {
        match msg {
            WM_MOUSEMOVE => {
                let (x, y) = point(l);
                let over = bar::hit(&self.s.layout, x, y);
                if self.hover.is_none() {
                    let mut track = TRACKMOUSEEVENT {
                        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                        dwFlags: TME_LEAVE,
                        hwndTrack: self.s.bar,
                        dwHoverTime: 0,
                    };
                    unsafe {
                        let _ = TrackMouseEvent(&mut track);
                    }
                }
                if over != self.hover {
                    self.hover = over;
                    self.paint_bar();
                }
            }
            WM_MOUSELEAVE => {
                self.hover = None;
                self.paint_bar();
            }
            WM_LBUTTONUP => {
                let (x, y) = point(l);
                if let Some(item) = bar::hit(&self.s.layout, x, y) {
                    self.act(item);
                }
            }
            _ => return None,
        }
        Some(LRESULT(0))
    }
}
