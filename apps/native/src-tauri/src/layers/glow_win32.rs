//! The edge glow windows on Windows: one per monitor, layered (per-pixel
//! alpha from glow.rs), click-through (WS_EX_TRANSPARENT), topmost, never
//! activated, kept out of screenshots and recordings, including Xenon AI's own
//! screen capture. They exist only while the glow is on; one timer breathes
//! their opacity (DWM just recomposes, nothing is repainted) and switches the
//! glow off if the dashboard stops talking to it, so a reloaded or crashed page
//! can never leave the screen lit.
//!
//! Main thread only (window procedures and timers run there): the state is a
//! thread-local, borrowed with `try_borrow_mut` so a re-entrant message skips
//! a beat instead of panicking across the FFI boundary.
#![cfg(target_os = "windows")]

use std::cell::RefCell;

use super::ffi::*;
use super::glow::{self, State};

/// The page re-sends the state at least every 20 s while it lasts.
const STALE_MS: u64 = 60_000;
const BREATH_TICK_MS: u32 = 40;
const STILL_TICK_MS: u32 = 1000;
const TIMER_ID: usize = 1;

pub struct Screen {
    rect: Rect,
    scale: f64,
}

impl Screen {
    /// The whole monitor, in physical pixels.
    pub fn of(m: &tauri::Monitor) -> Self {
        let (p, s) = (m.position(), m.size());
        let rect = Rect { l: p.x, t: p.y, r: p.x + s.width as i32, b: p.y + s.height as i32 };
        Screen { rect, scale: m.scale_factor() }
    }
}

pub struct Plan {
    pub state: State,
    pub rgb: [u8; 3],
    pub still: bool,
    pub screens: Vec<Screen>,
}

struct Win {
    hwnd: isize,
    rect: Rect,
    scale: f64,
}

#[derive(Default)]
struct Glow {
    wins: Vec<Win>,
    /// What the pixels show: the state's look and the accent.
    look: Option<(bool, [u8; 3])>,
    period: u32,
    still: bool,
    started: u64,
    touched: u64,
    timer_on: isize,
}

thread_local! {
    static GLOW: RefCell<Glow> = RefCell::new(Glow::default());
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn class_name() -> Vec<u16> {
    wide("XenonAiEdgeGlow")
}

extern "system" fn wnd_proc(h: isize, m: u32, w: usize, l: isize) -> isize {
    match m {
        WM_NCHITTEST => HTTRANSPARENT,
        WM_TIMER => {
            tick();
            0
        }
        _ => unsafe { DefWindowProcW(h, m, w, l) },
    }
}

fn register_class() {
    let name = class_name();
    let wc = WndClassEx {
        size: std::mem::size_of::<WndClassEx>() as u32,
        style: 0,
        proc_: wnd_proc,
        cls_extra: 0,
        wnd_extra: 0,
        instance: unsafe { GetModuleHandleW(std::ptr::null()) },
        icon: 0,
        cursor: 0,
        background: 0,
        menu: std::ptr::null(),
        class: name.as_ptr(),
        icon_sm: 0,
    };
    unsafe { RegisterClassExW(&wc) };
}

fn create(rect: Rect) -> isize {
    static REGISTER: std::sync::Once = std::sync::Once::new();
    REGISTER.call_once(register_class);
    let class = class_name();
    let ex = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE as u32;
    let h = unsafe {
        CreateWindowExW(
            ex,
            class.as_ptr(),
            class.as_ptr(),
            WS_POPUP,
            rect.l,
            rect.t,
            rect.r - rect.l,
            rect.b - rect.t,
            0,
            0,
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null_mut(),
        )
    };
    if h != 0 {
        // Windows 10 2004+; older systems keep the glow in captures.
        unsafe { SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE) };
    }
    h
}

fn blend(alpha: u8) -> Blend {
    Blend { op: 0, flags: 0, alpha, format: AC_SRC_ALPHA }
}

/// Draw the glow into the window: a top-down 32-bit DIB handed to
/// UpdateLayeredWindow, then freed (the system keeps its own copy).
fn repaint(w: &Win, state: State, rgb: [u8; 3], alpha: u8) -> bool {
    let (cx, cy) = (w.rect.r - w.rect.l, w.rect.b - w.rect.t);
    if cx <= 0 || cy <= 0 {
        return false;
    }
    let pixels = glow::paint(cx as usize, cy as usize, w.scale, state, rgb);
    let info = BitmapInfo {
        size: 40,
        width: cx,
        height: -cy,
        planes: 1,
        bit_count: 32,
        compression: 0,
        size_image: 0,
        x_ppm: 0,
        y_ppm: 0,
        clr_used: 0,
        clr_important: 0,
        colors: [0],
    };
    unsafe {
        let screen = GetDC(0);
        let mem = CreateCompatibleDC(screen);
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let bmp = CreateDIBSection(mem, &info, 0, &mut bits, 0, 0);
        let mut ok = false;
        if bmp != 0 && !bits.is_null() {
            std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits.cast::<u8>(), pixels.len());
            let old = SelectObject(mem, bmp);
            let pos = Point { x: w.rect.l, y: w.rect.t };
            let size = Size { cx, cy };
            let src = Point { x: 0, y: 0 };
            let b = blend(alpha);
            ok = UpdateLayeredWindow(w.hwnd, screen, &pos, &size, mem, &src, 0, &b, ULW_ALPHA) != 0;
            SelectObject(mem, old);
            DeleteObject(bmp);
        }
        DeleteDC(mem);
        ReleaseDC(0, screen);
        ok
    }
}

fn destroy_all(g: &mut Glow) {
    for w in g.wins.drain(..) {
        unsafe { DestroyWindow(w.hwnd) };
    }
    g.look = None;
    g.timer_on = 0;
}

fn now() -> u64 {
    unsafe { GetTickCount64() }
}

fn current_alpha(g: &Glow) -> u8 {
    glow::breath_alpha(now().saturating_sub(g.started), g.period, g.still)
}

/// Show the plan: windows for its screens only, repainted when the look
/// changed, topmost again, one timer for all.
pub fn apply(plan: Plan) {
    GLOW.with(|cell| {
        let Ok(mut g) = cell.try_borrow_mut() else { return };
        if plan.state == State::Off || plan.screens.is_empty() {
            return destroy_all(&mut g);
        }
        let t = now();
        if g.wins.is_empty() {
            g.started = t;
        }
        g.touched = t;
        g.period = glow::period_ms(plan.state);
        g.still = plan.still;
        let look = Some((plan.state == State::Speaking, glow::colour(plan.state, plan.rgb)));
        let relook = g.look != look;
        g.look = look;
        let alpha = current_alpha(&g);
        let mut old = std::mem::take(&mut g.wins);
        for s in plan.screens {
            if g.wins.iter().any(|w| w.rect == s.rect) {
                continue;
            }
            let (win, fresh) = match old.iter().position(|w| w.rect == s.rect && w.scale == s.scale) {
                Some(i) => (old.swap_remove(i), false),
                None => (Win { hwnd: create(s.rect), rect: s.rect, scale: s.scale }, true),
            };
            if win.hwnd == 0 {
                continue;
            }
            if (fresh || relook) && !repaint(&win, plan.state, plan.rgb, alpha) {
                unsafe { DestroyWindow(win.hwnd) };
                continue;
            }
            unsafe {
                SetWindowPos(win.hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                ShowWindow(win.hwnd, SW_SHOWNOACTIVATE);
            }
            g.wins.push(win);
        }
        for w in old {
            unsafe { DestroyWindow(w.hwnd) };
        }
        restart_timer(&mut g);
    });
}

fn restart_timer(g: &mut Glow) {
    let Some(first) = g.wins.first().map(|w| w.hwnd) else { return };
    if g.timer_on != 0 && g.timer_on != first {
        unsafe { KillTimer(g.timer_on, TIMER_ID) };
    }
    let ms = if g.still { STILL_TICK_MS } else { BREATH_TICK_MS };
    // Re-arming an existing timer id just changes its interval.
    unsafe { SetTimer(first, TIMER_ID, ms, 0) };
    g.timer_on = first;
}

fn tick() {
    GLOW.with(|cell| {
        let Ok(mut g) = cell.try_borrow_mut() else { return };
        if now().saturating_sub(g.touched) > STALE_MS {
            return destroy_all(&mut g);
        }
        let b = blend(current_alpha(&g));
        for w in &g.wins {
            unsafe {
                UpdateLayeredWindow(w.hwnd, 0, std::ptr::null(), std::ptr::null(), 0, std::ptr::null(), 0, &b, ULW_ALPHA)
            };
        }
    });
}

