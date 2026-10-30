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
use std::sync::Once;
use std::time::Duration;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{
    COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateFontW, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint,
    ExcludeClipRect, FillRect, GetDC, GetTextExtentPoint32W, InvalidateRect, ReleaseDC,
    SelectObject, SetBkMode, SetTextColor, UpdateWindow, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS,
    DEFAULT_CHARSET, DT_CENTER, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, FW_NORMAL, HBRUSH, HFONT,
    OUT_DEFAULT_PRECIS, PAINTSTRUCT, SRCCOPY, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture, VK_ESCAPE};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos,
    GetMessageW, KillTimer, LoadCursorW, PostQuitMessage, RegisterClassExW, SetTimer,
    SetWindowsHookExW, ShowWindow, TranslateMessage, UnhookWindowsHookEx, HC_ACTION, IDC_CROSS,
    KBDLLHOOKSTRUCT, MA_NOACTIVATE, MSG, SW_HIDE, SW_SHOWNOACTIVATE, WH_KEYBOARD_LL, WM_ERASEBKGND,
    WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEMOVE, WM_PAINT,
    WM_RBUTTONDOWN, WM_SYSKEYDOWN, WM_TIMER, WNDCLASSEXW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_POPUP,
};

use super::clipboard;
use super::dib::Dib;
use super::grab::Image;
use super::loupe::{self, Mark, Pens};
use crate::inspect;
use crate::pixels;
use crate::region::{self, Rect};

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

    fn handle(&mut self, h: HWND, msg: u32, l: LPARAM) -> Option<LRESULT> {
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

    fn move_colour(&mut self, i: usize, pt: (i32, i32)) {
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

    fn paint(&self, i: usize) {
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

unsafe extern "system" fn window_proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    // Calls made while handling a message (ReleaseCapture, ShowWindow) send
    // messages back in; those find the state busy and take the default path.
    let handled = STATE.with(|s| {
        s.try_borrow_mut()
            .ok()
            .and_then(|mut g| g.as_mut().and_then(|st| st.handle(h, msg, l)))
    });
    handled.unwrap_or_else(|| DefWindowProcW(h, msg, w, l))
}

unsafe extern "system" fn keys(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let k = &*(l.0 as *const KBDLLHOOKSTRUCT);
        if k.vkCode == VK_ESCAPE.0 as u32 {
            if matches!(w.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN) {
                STATE.with(|s| {
                    if let Some(st) = s.try_borrow_mut().ok().as_mut().and_then(|g| g.as_mut()) {
                        st.outcome.get_or_insert(Outcome::Cancel);
                    }
                });
                PostQuitMessage(0);
            }
            return LRESULT(1); // Esc belongs to the picker while it is open
        }
    }
    CallNextHookEx(None, code, w, l)
}

fn instance() -> HINSTANCE {
    unsafe { GetModuleHandleW(None) }
        .map(Into::into)
        .unwrap_or_default()
}

fn register() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(window_proc),
            hInstance: instance(),
            hCursor: LoadCursorW(None, IDC_CROSS).unwrap_or_default(),
            lpszClassName: CLASS,
            ..Default::default()
        };
        RegisterClassExW(&class);
    });
}

fn surface(f: &Frozen) -> Option<Surface> {
    let normal = Dib::new(&f.image, pixels::FULL)?;
    let dimmed = Dib::new(&f.image, pixels::DIMMED)?;
    let r = f.rect;
    let ex = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
    let hwnd = unsafe {
        CreateWindowExW(
            ex,
            CLASS,
            w!("Xenon"),
            WS_POPUP,
            r.left,
            r.top,
            r.right - r.left,
            r.bottom - r.top,
            None,
            None,
            Some(instance()),
            None,
        )
    }
    .ok()?;
    let scale = unsafe { GetDpiForWindow(hwnd) }.max(96) as f32 / 96.0;
    Some(Surface {
        hwnd,
        monitor: f.monitor,
        rect: r,
        normal,
        dimmed,
        lit: None,
        hint: None,
        scale,
    })
}

/// The font of the hint line and the labels, at surface `s`'s scale.
fn make_font(s: &Surface) -> Option<HFONT> {
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
fn place_hint(s: &mut Surface, text: &[u16], font: HFONT) {
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

fn cursor() -> (i32, i32) {
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    (p.x, p.y)
}

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
    let under = surfaces
        .iter()
        .position(|s| s.rect.contains(at.0, at.1))
        .unwrap_or(0);
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
