//! What the colour picker and the ruler draw over the frozen screen: the
//! magnifier with the colour under the cursor, and the size of the area.

use windows::Win32::Foundation::{COLORREF, HWND, RECT, SIZE};
use windows::Win32::Graphics::Gdi::{
    CreateSolidBrush, DeleteObject, DrawTextW, FillRect, FrameRect, GetDC, GetTextExtentPoint32W,
    ReleaseDC, SelectObject, SetBkMode, SetStretchBltMode, SetTextColor, StretchBlt, COLORONCOLOR,
    DT_CENTER, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, HBRUSH, HDC, HFONT, SRCCOPY, TRANSPARENT,
};

use super::dib::Dib;
use crate::inspect;
use crate::region::Rect;

/// One magnified pixel, the gap to the cursor and the label padding, at 100% scale.
const CELL: f32 = 12.0;
const GAP: f32 = 24.0;
const PAD: (f32, f32) = (10.0, 6.0);
const LABEL_GAP: f32 = 8.0;

pub struct Mark {
    /// The whole box, in window pixels.
    pub rect: RECT,
    /// The colour picker: the pixel under the cursor and its colour.
    pub at: Option<((i32, i32), [u8; 3])>,
    pub text: Vec<u16>,
}

pub struct Pens {
    pub font: HFONT,
    pub back: HBRUSH,
    pub edge: HBRUSH,
    pub ink: COLORREF,
    pub scale: f32,
}

impl Pens {
    fn px(&self, v: f32) -> i32 {
        (v * self.scale).round() as i32
    }
}

fn text_size(hwnd: HWND, font: HFONT, text: &[u16]) -> SIZE {
    let mut size = SIZE::default();
    unsafe {
        let dc = GetDC(Some(hwnd));
        let old = SelectObject(dc, font.into());
        let _ = GetTextExtentPoint32W(dc, text, &mut size);
        SelectObject(dc, old);
        ReleaseDC(Some(hwnd), dc);
    }
    size
}

/// The magnifier for the cursor at `pt` (window pixels) over `normal`.
pub fn colour(hwnd: HWND, p: &Pens, normal: &Dib, pt: (i32, i32)) -> Option<Mark> {
    let rgb = inspect::pixel(normal.bytes(), normal.width, pt.0, pt.1)?;
    let text: Vec<u16> = inspect::hex(rgb).encode_utf16().collect();
    let side = inspect::CELLS * p.px(CELL);
    let label = text_size(hwnd, p.font, &text).cy + 2 * p.px(PAD.1);
    let size = (normal.width as i32, normal.height as i32);
    let (left, top) = inspect::place(pt, size, (side, side + label), p.px(GAP));
    Some(Mark {
        rect: RECT {
            left,
            top,
            right: left + side,
            bottom: top + side + label,
        },
        at: Some((pt, rgb)),
        text,
    })
}

/// The size label of `area` (window pixels) on a surface of `size`.
pub fn size(hwnd: HWND, p: &Pens, area: Rect, size: (i32, i32)) -> Mark {
    let text: Vec<u16> = inspect::size_text(area.right - area.left, area.bottom - area.top)
        .encode_utf16()
        .collect();
    let t = text_size(hwnd, p.font, &text);
    let (w, h) = (t.cx + 2 * p.px(PAD.0), t.cy + 2 * p.px(PAD.1));
    let edges = (area.left, area.top, area.right, area.bottom);
    let (left, top) = inspect::label_at(edges, (w, h), size, p.px(LABEL_GAP));
    Mark {
        rect: RECT {
            left,
            top,
            right: left + w,
            bottom: top + h,
        },
        at: None,
        text,
    }
}

/// Draws `m`; the caller keeps the rest of the window off its rectangle.
pub fn paint(hdc: HDC, m: &Mark, normal: &Dib, p: &Pens) {
    let mut label = m.rect;
    unsafe {
        FillRect(hdc, &m.rect, p.back);
        if let Some((pt, rgb)) = m.at {
            let cell = p.px(CELL);
            let side = inspect::CELLS * cell;
            let size = (normal.width as i32, normal.height as i32);
            if let Some(((sx, sy, sw, sh), (ox, oy))) = inspect::source(pt, size) {
                SetStretchBltMode(hdc, COLORONCOLOR);
                let _ = StretchBlt(
                    hdc,
                    m.rect.left + ox * cell,
                    m.rect.top + oy * cell,
                    sw * cell,
                    sh * cell,
                    Some(normal.dc),
                    sx,
                    sy,
                    sw,
                    sh,
                    SRCCOPY,
                );
            }
            // The picked pixel: a dark frame round a light one, seen on any colour.
            let c = inspect::CELLS / 2 * cell;
            let centre = RECT {
                left: m.rect.left + c,
                top: m.rect.top + c,
                right: m.rect.left + c + cell,
                bottom: m.rect.top + c + cell,
            };
            FrameRect(hdc, &centre, p.edge);
            let outer = RECT {
                left: centre.left - 1,
                top: centre.top - 1,
                right: centre.right + 1,
                bottom: centre.bottom + 1,
            };
            FrameRect(hdc, &outer, p.back);
            label.top = m.rect.top + side;
            let pad = p.px(PAD.1);
            let swatch = RECT {
                left: label.left + p.px(PAD.0),
                top: label.top + pad,
                right: label.left + p.px(PAD.0) + (label.bottom - label.top - 2 * pad),
                bottom: label.bottom - pad,
            };
            let [r, g, b] = rgb;
            let brush = CreateSolidBrush(COLORREF(r as u32 | (g as u32) << 8 | (b as u32) << 16));
            FillRect(hdc, &swatch, brush);
            FrameRect(hdc, &swatch, p.edge);
            let _ = DeleteObject(brush.into());
            label.left = swatch.right;
        }
        FrameRect(hdc, &m.rect, p.edge);
        let old = SelectObject(hdc, p.font.into());
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, p.ink);
        let mut text = m.text.clone();
        DrawTextW(
            hdc,
            &mut text,
            &mut label,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
        );
        SelectObject(hdc, old);
    }
}
