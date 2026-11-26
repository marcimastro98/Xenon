//! Bit's window on Windows (win32.rs draws in it): its class, its messages,
//! the mouse on it and what it tells the page. A press that moves is a drag
//! anywhere, onto any screen, one that does not is a tap; the window is held
//! while the press lasts and never activated, so the app in front keeps the
//! focus. A drop says where along the bar, how high (-1: near the bar, so on
//! it) and the corner of the screen it landed on; the page decides if it stays.

use tauri::Manager;

use super::super::ffi::*;
use super::win32::{at, render, size, tick, DESK};
use super::{along, lane, rise_of, Area};

/// A press that moves less (logical pixels) is a tap.
const DRAG_PX: f64 = 6.0;
/// Let go with its feet this close (logical pixels) to the desktop's bottom edge, it goes back on the bar.
const SNAP_PX: f64 = 24.0;

pub(super) struct Drag {
    from: Point,
    at0: (i32, i32),
    moved: bool,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// The page's `window.BitDesk`, told with numbers only.
pub(super) fn tell(call: String) {
    let Some(app) = super::super::APP.get() else { return };
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.eval(format!("try{{window.BitDesk&&window.BitDesk.{call}}}catch(e){{}}"));
    }
}

extern "system" fn wnd_proc(h: isize, m: u32, w: usize, l: isize) -> isize {
    match m {
        WM_MOUSEACTIVATE => MA_NOACTIVATE,
        WM_SETCURSOR => unsafe {
            SetCursor(LoadCursorW(0, IDC_HAND as *const u16));
            1
        },
        WM_LBUTTONDOWN => {
            press(h);
            0
        }
        WM_MOUSEMOVE => {
            drag_to();
            0
        }
        WM_LBUTTONUP | WM_CAPTURECHANGED => {
            release(m == WM_LBUTTONUP);
            0
        }
        WM_TIMER => {
            tick();
            0
        }
        _ => unsafe { DefWindowProcW(h, m, w, l) },
    }
}

pub(super) fn create() -> isize {
    static REGISTER: std::sync::Once = std::sync::Once::new();
    let class = wide("XenonBitDesk");
    REGISTER.call_once(|| {
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
            class: class.as_ptr(),
            icon_sm: 0,
        };
        unsafe { RegisterClassExW(&wc) };
    });
    let ex = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE as u32;
    let title = wide("Bit");
    unsafe {
        CreateWindowExW(
            ex, class.as_ptr(), title.as_ptr(), WS_POPUP, 0, 0, 1, 1, 0, 0,
            GetModuleHandleW(std::ptr::null()), std::ptr::null_mut(),
        )
    }
}

fn cursor() -> Point {
    let mut p = Point { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p) };
    p
}

fn press(h: isize) {
    DESK.with(|cell| {
        let Ok(mut d) = cell.try_borrow_mut() else { return };
        let at0 = at(&d);
        d.drag = Some(Drag { from: cursor(), at0, moved: false });
    });
    unsafe { SetCapture(h) };
}

fn drag_to() {
    DESK.with(|cell| {
        let Ok(mut d) = cell.try_borrow_mut() else { return };
        let Some(drag) = d.drag.as_ref() else { return };
        let p = cursor();
        let (dx, dy) = (p.x - drag.from.x, p.y - drag.from.y);
        if !drag.moved && f64::from(dx).hypot(f64::from(dy)) < DRAG_PX * d.scale {
            return;
        }
        let to = (drag.at0.0 + dx, drag.at0.1 + dy);
        if let Some(drag) = d.drag.as_mut() {
            drag.moved = true;
        }
        let was = at(&d).0;
        if to.0 != was {
            d.left = to.0 < was;
        }
        d.walk = None;
        d.free = Some(to);
        render(&d);
    });
}

/// Where a drop landed, as the page is told: along that screen's bar, how high (-1 on the bar), the screen's corner.
fn landed(d: &super::win32::Desk) -> String {
    let (w, h) = size(d);
    let (left, top) = at(d);
    let (mon, work) = monitor_areas_of(d.hwnd)
        .map(|(m, k)| (Area { l: m.l, t: m.t, r: m.r, b: m.b }, Area { l: k.l, t: k.t, r: k.r, b: k.b }))
        .unwrap_or((d.mon, d.work));
    let on = lane(mon, work, d.spec.body as i32 * d.cell);
    let rise = rise_of(&on, work, top, h, (SNAP_PX * d.scale).round() as i32).unwrap_or(-1.0);
    format!("dropped({:.4},{rise:.4},{},{})", along(&on, left, w), mon.l, mon.t)
}

/// The press ended: a tap, or a drop the page decides on. A capture lost mid-drag drops it too.
fn release(up: bool) {
    let mut said = None;
    DESK.with(|cell| {
        let Ok(mut d) = cell.try_borrow_mut() else { return };
        let Some(drag) = d.drag.take() else { return };
        said = Some(if drag.moved { landed(&d) } else if up { "tapped()".into() } else { return });
    });
    if up {
        unsafe { ReleaseCapture() };
    }
    if let Some(call) = said {
        tell(call);
    }
}
