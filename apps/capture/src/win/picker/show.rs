// Windows picker: showing it over every screen and handing back what was picked.

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{CreateSolidBrush, DeleteObject, UpdateWindow};
use windows::Win32::UI::WindowsAndMessaging::{DestroyWindow, DispatchMessageW, GetMessageW, KillTimer, MSG, SetTimer, SetWindowsHookExW, ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE, TranslateMessage, UnhookWindowsHookEx, WH_KEYBOARD_LL};
use crate::{inspect, pixels};
use crate::region::{self, Rect};
use super::{EDGE, Frozen, GIVE_UP, GIVE_UP_TIMER, HINT_BACK, Inspected, Mode, Outcome, Picked, State, STATE, Surface};
use super::paint::{cursor, make_font, place_hint};
use super::super::clipboard;
use super::super::grab::Image;
use super::window::{instance, keys, register, surface, under_cursor};

/// Shows the picker over `frozen` and waits for the user. `stack` is what a
/// click can pick (window rectangles, top first); `hint` the line shown at
/// the top of the screen under the cursor. None when the user cancels.
pub fn pick(frozen: &[Frozen], stack: Vec<Rect>, hint: &str, copy: bool) -> Option<Picked> {
    let state = show(frozen, stack, hint, Mode::Area)?;
    match state.outcome {
        Some(Outcome::Area { surface, area }) => cut(&state.surfaces[surface], area, copy),
        _ => None,
    }
}

/// The colour picker or the ruler over `frozen`. None when the user cancels.
pub fn inspect(frozen: &[Frozen], hint: &str, mode: Mode) -> Option<Inspected> {
    let state = show(frozen, Vec::new(), hint, mode)?;
    match state.outcome {
        Some(Outcome::Point { surface, pt }) => {
            let s = &state.surfaces[surface];
            let rgb = inspect::pixel(s.normal.bytes(), s.normal.width, pt.0, pt.1)?;
            Some(Inspected::Colour {
                monitor: s.monitor,
                rgb,
            })
        }
        Some(Outcome::Area { surface, area }) => Some(Inspected::Size {
            monitor: state.surfaces[surface].monitor,
            width: area.right - area.left,
            height: area.bottom - area.top,
        }),
        _ => None,
    }
}

fn show(frozen: &[Frozen], stack: Vec<Rect>, hint: &str, mode: Mode) -> Option<State> {
    register();
    let mut surfaces: Vec<Surface> = frozen.iter().filter_map(surface).collect();
    if surfaces.is_empty() {
        return None;
    }
    let at = cursor();
    let under = under_cursor(&surfaces);
    let text: Vec<u16> = hint.encode_utf16().collect();
    let font = make_font(&surfaces[under]);
    if let (false, Some(f)) = (text.is_empty(), font) {
        place_hint(&mut surfaces[under], &text, f);
    }
    let first = surfaces[0].hwnd;
    let mut state = State {
        mode,
        surfaces,
        stack,
        drag: None,
        outcome: None,
        hint: text,
        font,
        back: unsafe { CreateSolidBrush(HINT_BACK) },
        edge: unsafe { CreateSolidBrush(EDGE) },
        mark: None,
    };
    let local = |s: &Surface| (at.0 - s.rect.left, at.1 - s.rect.top);
    match mode {
        Mode::Area => {
            let area = state.window_at(state.surfaces[under].rect, at);
            state.light(under, area);
        }
        Mode::Colour => state.move_colour(under, local(&state.surfaces[under])),
        Mode::Measure => {}
    }
    let hwnds: Vec<HWND> = state.surfaces.iter().map(|s| s.hwnd).collect();
    STATE.with(|s| *s.borrow_mut() = Some(state));

    unsafe {
        for &h in &hwnds {
            let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
            let _ = UpdateWindow(h);
        }
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keys), Some(instance()), 0).ok();
        SetTimer(Some(first), GIVE_UP_TIMER, GIVE_UP.as_millis() as u32, None);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = KillTimer(Some(first), GIVE_UP_TIMER);
        if let Some(hook) = hook {
            let _ = UnhookWindowsHookEx(hook);
        }
        for &h in &hwnds {
            let _ = ShowWindow(h, SW_HIDE);
        }
    }
    STATE.with(|s| s.borrow_mut().take())
}

impl Drop for State {
    fn drop(&mut self) {
        unsafe {
            for s in &self.surfaces {
                let _ = DestroyWindow(s.hwnd);
            }
            if let Some(font) = self.font {
                let _ = DeleteObject(font.into());
            }
            let _ = DeleteObject(self.back.into());
            let _ = DeleteObject(self.edge.into());
        }
    }
}

/// The picked area out of the frozen image, also on the clipboard when asked.
fn cut(s: &Surface, area: Rect, copy: bool) -> Option<Picked> {
    let crop = region::within(area, s.rect)?;
    let bgr = pixels::crop_bgra(s.normal.bytes(), s.normal.width, crop);
    let copied = copy && clipboard::copy(s.hwnd, &pixels::dib(crop.width, crop.height, &bgr));
    Some(Picked {
        monitor: s.monitor,
        image: Image {
            width: crop.width,
            height: crop.height,
            bgr,
        },
        copied,
    })
}
