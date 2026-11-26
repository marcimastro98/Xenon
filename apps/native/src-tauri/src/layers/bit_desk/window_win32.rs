//! Bit's window on Windows (win32.rs draws in it): its class, its messages
//! and the mouse on it (state.rs says what a press, a drag and a drop mean).
//! The window is held while the press lasts and never activated, so the app
//! in front keeps the focus.

use super::super::ffi::*;
use super::win32::{render, tick, WIN};
use super::{tell, Area};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
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

fn cursor() -> (i32, i32) {
    let mut p = Point { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p) };
    (p.x, p.y)
}

fn press(h: isize) {
    WIN.with(|cell| {
        if let Ok(mut w) = cell.try_borrow_mut() {
            w.desk.press(cursor());
        }
    });
    unsafe { SetCapture(h) };
}

fn drag_to() {
    WIN.with(|cell| {
        let Ok(mut w) = cell.try_borrow_mut() else { return };
        if w.desk.drag_to(cursor()) {
            render(&w);
        }
    });
}

/// The press ended: a tap, or a drop on the screen the window is on now. A capture lost mid-drag drops it too.
fn release(up: bool) {
    let mut said = None;
    WIN.with(|cell| {
        let Ok(mut w) = cell.try_borrow_mut() else { return };
        let hwnd = w.hwnd;
        said = w.desk.release(up, |_| {
            monitor_areas_of(hwnd).map(|(m, k)| (Area { l: m.l, t: m.t, r: m.r, b: m.b }, Area { l: k.l, t: k.t, r: k.r, b: k.b }))
        });
    });
    if up {
        unsafe { ReleaseCapture() };
    }
    if let Some(call) = said {
        tell(call);
    }
}
