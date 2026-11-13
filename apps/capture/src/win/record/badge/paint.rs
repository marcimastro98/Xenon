// Windows recording badge: its font and its drawing.

use std::sync::atomic::Ordering;
use windows::core::w;
use windows::Win32::Foundation::{COLORREF, POINT, SIZE};
use windows::Win32::Graphics::Gdi::{AC_SRC_ALPHA, AC_SRC_OVER, ANTIALIASED_QUALITY, BLENDFUNCTION, CLIP_DEFAULT_PRECIS, CreateFontW, DEFAULT_CHARSET, DeleteObject, FW_SEMIBOLD, GdiFlush, GetTextExtentPoint32W, HFONT, OUT_DEFAULT_PRECIS, SelectObject, SetBkMode, SetTextColor, TextOutW, TRANSPARENT};
use windows::Win32::UI::WindowsAndMessaging::{HWND_TOPMOST, SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, ULW_ALPHA, UpdateLayeredWindow};
use crate::badge;
use super::{Label, State};
use super::super::super::dib::Dib;
use super::window::work_area;

impl State {
    /// The font for this scale, made again only when the scale changes.
    pub(super) fn font(&mut self, scale: f32) -> Option<HFONT> {
        if let Some((f, s)) = self.font {
            if s == scale {
                return Some(f);
            }
            unsafe {
                let _ = DeleteObject(f.into());
            }
            self.font = None;
        }
        let f = unsafe {
            CreateFontW(
                -((badge::TEXT * scale).round() as i32),
                0,
                0,
                0,
                FW_SEMIBOLD.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                ANTIALIASED_QUALITY,
                0,
                w!("Segoe UI"),
            )
        };
        (!f.is_invalid()).then(|| {
            self.font = Some((f, scale));
            f
        })
    }

    fn text(&self) -> String {
        match &self.label {
            Label::Clock => badge::clock(self.start.elapsed().as_secs()),
            Label::Count { count, template } => {
                badge::count(template, count.load(Ordering::SeqCst))
            }
        }
    }

    pub(super) fn draw(&mut self) {
        // The monitor may have moved or changed scale since the last tick.
        if let Some(work) = work_area(self.monitor) {
            self.work = work;
        }
        let scale = self.scale();
        let Some(font) = self.font(scale) else {
            return;
        };
        let text: Vec<u16> = self.text().encode_utf16().collect();
        let mut size = SIZE::default();
        let Some(mut canvas) = Dib::blank(1, 1) else {
            return;
        };
        unsafe {
            let old = SelectObject(canvas.dc, font.into());
            let _ = GetTextExtentPoint32W(canvas.dc, &text, &mut size);
            SelectObject(canvas.dc, old);
        }
        let l = badge::layout(size.cx, scale);
        match Dib::blank(l.width, l.height) {
            Some(d) => canvas = d,
            None => return,
        }
        let back = if self.hover {
            badge::BACK_HOVER
        } else {
            badge::BACK
        };
        for p in canvas.bytes_mut().chunks_exact_mut(4) {
            p.copy_from_slice(&[back[2], back[1], back[0], 0]);
        }
        let ink = badge::INK;
        unsafe {
            let old = SelectObject(canvas.dc, font.into());
            SetBkMode(canvas.dc, TRANSPARENT);
            SetTextColor(
                canvas.dc,
                COLORREF(ink[0] as u32 | (ink[1] as u32) << 8 | (ink[2] as u32) << 16),
            );
            let y = (l.height as i32 - size.cy) / 2;
            let _ = TextOutW(canvas.dc, l.text.0, y, &text);
            SelectObject(canvas.dc, old);
            let _ = GdiFlush();
        }
        badge::shade(canvas.bytes_mut(), &l, self.hover);
        let (x, y) = badge::place(self.work, &l, scale);
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        unsafe {
            let _ = UpdateLayeredWindow(
                self.hwnd,
                None,
                Some(&POINT { x, y }),
                Some(&SIZE {
                    cx: l.width as i32,
                    cy: l.height as i32,
                }),
                Some(canvas.dc),
                Some(&POINT::default()),
                COLORREF(0),
                Some(&blend),
                ULW_ALPHA,
            );
            // Another topmost window may have come over it since.
            let _ = SetWindowPos(
                self.hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
}
