//! Bit's window on Windows (win32.rs draws in it): its class, its messages,
//! the mouse on it and what it tells the page. A press that moves is a drag
//! along the lane, one that does not is a tap; the window is held while the
//! press lasts and never activated, so the app in front keeps the focus.

use tauri::Manager;

use super::super::ffi::*;
use super::win32::{render, size, tick, DESK};
use super::{along, place};

/// A press that moves less (logical pixels) is a tap.
const DRAG_PX: f64 = 6.0;

pub(super) struct Drag {
    x0: i32,
    left0: i32,
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

fn cursor_x() -> i32 {
    let mut p = Point { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p) };
    p.x
}

fn press(h: isize) {
    DESK.with(|cell| {
        let Ok(mut d) = cell.try_borrow_mut() else { return };
        let (w, h_px) = size(&d);
        let left0 = place(&d.lane, d.pos, w, h_px).0;
        d.drag = Some(Drag { x0: cursor_x(), left0, moved: false });
    });
    unsafe { SetCapture(h) };
}

fn drag_to() {
    DESK.with(|cell| {
        let Ok(mut d) = cell.try_borrow_mut() else { return };
        let Some(drag) = d.drag.as_ref() else { return };
        let dx = cursor_x() - drag.x0;
        if !drag.moved && f64::from(dx.abs()) < DRAG_PX * d.scale {
            return;
        }
        let left = drag.left0 + dx;
        if let Some(drag) = d.drag.as_mut() {
            drag.moved = true;
        }
        let (w, _) = size(&d);
        d.walk = None;
        d.left = left < place(&d.lane, d.pos, w, 0).0;
        d.pos = along(&d.lane, left, w);
        render(&d);
    });
}

/// The press ended: a tap, or a drop where Bit now lives. A capture lost mid-drag drops it too.
fn release(up: bool) {
    let mut said = None;
    DESK.with(|cell| {
        let Ok(mut d) = cell.try_borrow_mut() else { return };
        let Some(drag) = d.drag.take() else { return };
        said = Some(if drag.moved { format!("dropped({:.4})", d.pos) } else if up { "tapped()".into() } else { return });
    });
    if up {
        unsafe { ReleaseCapture() };
    }
    if let Some(call) = said {
        tell(call);
    }
}
