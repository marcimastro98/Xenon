// Windows picker: drawing the dimmed screen, the selection, its size and the hint.

use windows::core::w;
use windows::Win32::Foundation::{POINT, RECT, SIZE};
use windows::Win32::Graphics::Gdi::{BeginPaint, BitBlt, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, CreateFontW, DEFAULT_CHARSET, DrawTextW, DT_CENTER, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, EndPaint, ExcludeClipRect, FillRect, FW_NORMAL, GetDC, GetTextExtentPoint32W, HFONT, OUT_DEFAULT_PRECIS, PAINTSTRUCT, ReleaseDC, SelectObject, SetBkMode, SetTextColor, SRCCOPY, TRANSPARENT};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
use crate::region::Rect;
use super::{HINT_INK, HINT_PAD, HINT_TEXT, HINT_TOP, Mode, rect_of, State, Surface};
use super::super::loupe::{self};

impl State {
    pub(super) fn paint(&self, i: usize) {
        let s = &self.surfaces[i];
        let mut ps = PAINTSTRUCT::default();
        unsafe {
            let hdc = BeginPaint(s.hwnd, &mut ps);
            // Each pixel is drawn once (mark, hint, lit area, then the rest
            // round them), so moving the selection never flickers.
            if let (Some((j, m)), Some(p)) = (&self.mark, self.pens(i)) {
                if *j == i {
                    loupe::paint(hdc, m, &s.normal, &p);
                    let r = m.rect;
                    ExcludeClipRect(hdc, r.left, r.top, r.right, r.bottom);
                }
            }
            if let (Some(r), Some(font)) = (s.hint, self.font) {
                FillRect(hdc, &r, self.back);
                let old = SelectObject(hdc, font.into());
                SetBkMode(hdc, TRANSPARENT);
                SetTextColor(hdc, HINT_INK);
                let mut text = self.hint.clone();
                let mut box_ = r;
                DrawTextW(
                    hdc,
                    &mut text,
                    &mut box_,
                    DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
                );
                SelectObject(hdc, old);
                ExcludeClipRect(hdc, r.left, r.top, r.right, r.bottom);
            }
            if let Some(r) = s.lit {
                let t = s.scale.round().max(1.0) as i32;
                let inner = Rect {
                    left: r.left + t,
                    top: r.top + t,
                    right: r.right - t,
                    bottom: r.bottom - t,
                };
                if inner.right > inner.left && inner.bottom > inner.top {
                    let (w, h) = (inner.right - inner.left, inner.bottom - inner.top);
                    let _ = BitBlt(
                        hdc,
                        inner.left,
                        inner.top,
                        w,
                        h,
                        Some(s.normal.dc),
                        inner.left,
                        inner.top,
                        SRCCOPY,
                    );
                    for strip in [
                        Rect {
                            bottom: inner.top,
                            ..r
                        },
                        Rect {
                            top: inner.bottom,
                            ..r
                        },
                        Rect {
                            top: inner.top,
                            bottom: inner.bottom,
                            right: inner.left,
                            ..r
                        },
                        Rect {
                            top: inner.top,
                            bottom: inner.bottom,
                            left: inner.right,
                            ..r
                        },
                    ] {
                        FillRect(hdc, &rect_of(strip), self.edge);
                    }
                } else {
                    FillRect(hdc, &rect_of(r), self.edge);
                }
                ExcludeClipRect(hdc, r.left, r.top, r.right, r.bottom);
            }
            // The colour picker shows the screen as it is: a dimmed pixel is the wrong colour.
            let back = if self.mode == Mode::Colour {
                &s.normal
            } else {
                &s.dimmed
            };
            let (w, h) = (back.width as i32, back.height as i32);
            let _ = BitBlt(hdc, 0, 0, w, h, Some(back.dc), 0, 0, SRCCOPY);
            let _ = EndPaint(s.hwnd, &ps);
        }
    }
}

/// The font of the hint line and the labels, at surface `s`'s scale.
pub(super) fn make_font(s: &Surface) -> Option<HFONT> {
    let px = |v: f32| (v * s.scale).round() as i32;
    let font = unsafe {
        CreateFontW(
            -px(HINT_TEXT),
            0,
            0,
            0,
            FW_NORMAL.0 as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY,
            0,
            w!("Segoe UI"),
        )
    };
    (!font.is_invalid()).then_some(font)
}

/// Places the hint line at the top of surface `s`, sized to its text.
pub(super) fn place_hint(s: &mut Surface, text: &[u16], font: HFONT) {
    let px = |v: f32| (v * s.scale).round() as i32;
    let mut size = SIZE::default();
    unsafe {
        let dc = GetDC(Some(s.hwnd));
        let old = SelectObject(dc, font.into());
        let _ = GetTextExtentPoint32W(dc, text, &mut size);
        SelectObject(dc, old);
        ReleaseDC(Some(s.hwnd), dc);
    }
    let width = s.rect.right - s.rect.left;
    let w = (size.cx + 2 * px(HINT_PAD.0)).min(width);
    let h = size.cy + 2 * px(HINT_PAD.1);
    let left = (width - w) / 2;
    s.hint = Some(RECT {
        left,
        top: px(HINT_TOP),
        right: left + w,
        bottom: px(HINT_TOP) + h,
    });
}

pub(super) fn cursor() -> (i32, i32) {
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    (p.x, p.y)
}
