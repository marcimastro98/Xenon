//! The two windows of a drawing and their pixels: the canvas over the whole
//! monitor (in every capture, so a recording shows the drawing) and the bar at
//! its top (in none). Both are layered windows drawn from a bitmap.

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, POINT, RECT, SIZE};
use windows::Win32::Graphics::Gdi::{
    CreateFontW, DeleteObject, GdiFlush, GetMonitorInfoW, GetTextExtentPoint32W, MonitorFromPoint,
    SelectObject, SetBkMode, SetTextColor, TextOutW, AC_SRC_ALPHA, AC_SRC_OVER,
    ANTIALIASED_QUALITY, BLENDFUNCTION, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, FW_NORMAL, HDC,
    HFONT, MONITORINFO, MONITOR_DEFAULTTONEAREST, OUT_DEFAULT_PRECIS, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GetCursorPos, SetWindowDisplayAffinity, SetWindowPos,
    UpdateLayeredWindowIndirect, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, ULW_ALPHA,
    UPDATELAYEREDWINDOWINFO, WDA_EXCLUDEFROMCAPTURE, WINDOW_EX_STYLE, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

use super::super::dib::Dib;
use crate::sketch::bar::{self, Layout, Look};
use crate::sketch::canvas::Canvas;
use crate::sketch::raster::Area;

pub const CANVAS_CLASS: PCWSTR = w!("XenonDrawCanvas");
pub const BAR_CLASS: PCWSTR = w!("XenonDrawBar");

pub struct Surfaces {
    pub canvas: HWND,
    pub bar: HWND,
    /// The monitor's top-left corner, and its work area (left, top, right, bottom).
    origin: (i32, i32),
    work: (i32, i32, i32, i32),
    pub scale: f32,
    pub sketch: Canvas,
    pub pixels: Dib,
    hint: Vec<u16>,
    font: Option<HFONT>,
    pub layout: Layout,
}

/// The monitor under the pointer: its rectangle and its work area.
fn monitor() -> Option<(RECT, RECT)> {
    let mut pt = POINT::default();
    unsafe { GetCursorPos(&mut pt).ok()? };
    let m = unsafe { MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetMonitorInfoW(m, &mut info) }
        .as_bool()
        .then_some((info.rcMonitor, info.rcWork))
}

/// A layered topmost popup; an owned one always stays above its owner.
fn window(ex: WINDOW_EX_STYLE, class: PCWSTR, r: RECT, owner: Option<HWND>) -> Option<HWND> {
    unsafe {
        CreateWindowExW(
            ex | WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            class,
            w!("Xenon"),
            WS_POPUP,
            r.left,
            r.top,
            r.right - r.left,
            r.bottom - r.top,
            owner,
            None,
            GetModuleHandleW(None).ok().map(Into::into),
            None,
        )
    }
    .ok()
}

impl Surfaces {
    /// Both windows, not shown yet; None when one cannot be made.
    pub fn open(hint: &str) -> Option<Surfaces> {
        let (mon, work) = monitor()?;
        let (w, h) = ((mon.right - mon.left) as u32, (mon.bottom - mon.top) as u32);
        let canvas = window(WINDOW_EX_STYLE(0), CANVAS_CLASS, mon, None)?;
        let made = (|| {
            // Owned by the canvas, so a click that brings the canvas forward never covers it.
            let spot = RECT {
                left: work.left,
                top: work.top,
                right: work.left + 1,
                bottom: work.top + 1,
            };
            let bar = window(WS_EX_NOACTIVATE, BAR_CLASS, spot, Some(canvas))?;
            // The bar is a tool, never part of what is shown or recorded.
            unsafe {
                let _ = SetWindowDisplayAffinity(bar, WDA_EXCLUDEFROMCAPTURE);
            }
            let pixels = Dib::blank(w, h)?;
            Some((bar, pixels))
        })();
        let Some((bar, mut pixels)) = made else {
            unsafe {
                let _ = DestroyWindow(canvas);
            }
            return None;
        };
        let sketch = Canvas::new(w, h);
        sketch.show(pixels.bytes_mut());
        let scale = unsafe { GetDpiForWindow(canvas) }.max(96) as f32 / 96.0;
        let hint: Vec<u16> = hint.encode_utf16().collect();
        Some(Surfaces {
            canvas,
            bar,
            origin: (mon.left, mon.top),
            work: (work.left, work.top, work.right, work.bottom),
            scale,
            sketch,
            pixels,
            layout: bar::layout(scale, None),
            hint,
            font: None,
        })
    }

    /// Shows the canvas again where `dirty` changed (all of it when None).
    pub fn present(&self, dirty: Option<Area>) {
        let size = SIZE {
            cx: self.pixels.width as i32,
            cy: self.pixels.height as i32,
        };
        let (dst, src) = (
            POINT {
                x: self.origin.0,
                y: self.origin.1,
            },
            POINT::default(),
        );
        let blend = blend();
        let rect = dirty.map(|a| RECT {
            left: a.x0,
            top: a.y0,
            right: a.x1,
            bottom: a.y1,
        });
        let info = UPDATELAYEREDWINDOWINFO {
            cbSize: std::mem::size_of::<UPDATELAYEREDWINDOWINFO>() as u32,
            hdcDst: HDC::default(),
            pptDst: &dst,
            psize: &size,
            hdcSrc: self.pixels.dc,
            pptSrc: &src,
            crKey: COLORREF(0),
            pblend: &blend,
            dwFlags: ULW_ALPHA,
            prcDirty: rect.as_ref().map_or(std::ptr::null(), |r| r as *const RECT),
        };
        unsafe {
            let _ = UpdateLayeredWindowIndirect(self.canvas, &info);
        }
    }

    pub fn has_hint(&self) -> bool {
        !self.hint.is_empty()
    }

    pub fn drop_hint(&mut self) {
        self.hint.clear();
    }

    fn font(&mut self) -> Option<HFONT> {
        if self.font.is_none() {
            let f = unsafe {
                CreateFontW(
                    -((bar::HINT_TEXT * self.scale).round() as i32),
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
                    ANTIALIASED_QUALITY,
                    0,
                    w!("Segoe UI"),
                )
            };
            self.font = (!f.is_invalid()).then_some(f);
        }
        self.font
    }

    /// Draws the bar (and the hint while it lasts) as `look` says.
    pub fn paint_bar(&mut self, look: &Look) {
        let font = if self.has_hint() { self.font() } else { None };
        let mut text_size = None;
        if let Some(f) = font {
            let mut size = SIZE::default();
            if let Some(probe) = Dib::blank(1, 1) {
                unsafe {
                    let old = SelectObject(probe.dc, f.into());
                    let _ = GetTextExtentPoint32W(probe.dc, &self.hint, &mut size);
                    SelectObject(probe.dc, old);
                }
                text_size = Some((size.cx, size.cy));
            }
        }
        self.layout = bar::layout(self.scale, text_size);
        let l = &self.layout;
        let Some(mut canvas) = Dib::blank(l.width, l.height) else {
            return;
        };
        bar::paint(canvas.bytes_mut(), l, look);
        if let (Some(f), Some((_, (tx, ty)))) = (font, l.hint) {
            let ink = bar::INK;
            unsafe {
                let old = SelectObject(canvas.dc, f.into());
                SetBkMode(canvas.dc, TRANSPARENT);
                SetTextColor(
                    canvas.dc,
                    COLORREF(ink[0] as u32 | (ink[1] as u32) << 8 | (ink[2] as u32) << 16),
                );
                let _ = TextOutW(canvas.dc, tx, ty, &self.hint);
                SelectObject(canvas.dc, old);
                let _ = GdiFlush();
            }
            bar::finish_hint(canvas.bytes_mut(), l);
        }
        let (x, y) = bar::place(self.work, l);
        let size = SIZE {
            cx: l.width as i32,
            cy: l.height as i32,
        };
        let (dst, src, blend) = (POINT { x, y }, POINT::default(), blend());
        let info = UPDATELAYEREDWINDOWINFO {
            cbSize: std::mem::size_of::<UPDATELAYEREDWINDOWINFO>() as u32,
            hdcDst: HDC::default(),
            pptDst: &dst,
            psize: &size,
            hdcSrc: canvas.dc,
            pptSrc: &src,
            crKey: COLORREF(0),
            pblend: &blend,
            dwFlags: ULW_ALPHA,
            prcDirty: std::ptr::null(),
        };
        unsafe {
            let _ = UpdateLayeredWindowIndirect(self.bar, &info);
            // Over the canvas, and over a topmost window that came up since.
            let _ = SetWindowPos(
                self.bar,
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

fn blend() -> BLENDFUNCTION {
    BLENDFUNCTION {
        BlendOp: AC_SRC_OVER as u8,
        BlendFlags: 0,
        SourceConstantAlpha: 255,
        AlphaFormat: AC_SRC_ALPHA as u8,
    }
}

impl Drop for Surfaces {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.bar);
            if let Some(f) = self.font.take() {
                let _ = DeleteObject(f.into());
            }
        }
    }
}
