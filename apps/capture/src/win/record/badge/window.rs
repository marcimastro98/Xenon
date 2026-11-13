// Windows recording badge: the window itself, its messages and where it sits.

use std::sync::Once;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{DefWindowProcW, DestroyWindow, IDC_HAND, LoadCursorW, MA_NOACTIVATE, PostQuitMessage, RegisterClassExW, WM_CLOSE, WM_DESTROY, WM_MOUSEACTIVATE, WNDCLASSEXW};
use super::{CLASS, STATE};

unsafe extern "system" fn window_proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    // These never need the state: DestroyWindow sends WM_DESTROY while the
    // state is still borrowed, and the loop must end all the same.
    match msg {
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_CLOSE => {
            let _ = DestroyWindow(h);
            return LRESULT(0);
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            return LRESULT(0);
        }
        _ => {}
    }
    // Calls made while handling a message send messages back in; those find
    // the state busy and take the default path.
    let handled = STATE.with(|s| {
        s.try_borrow_mut()
            .ok()
            .and_then(|mut g| g.as_mut().and_then(|st| st.handle(msg)))
    });
    handled.unwrap_or_else(|| DefWindowProcW(h, msg, w, l))
}

pub(super) fn register() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(window_proc),
            hInstance: GetModuleHandleW(None).map(Into::into).unwrap_or_default(),
            hCursor: LoadCursorW(None, IDC_HAND).unwrap_or_default(),
            lpszClassName: CLASS,
            ..Default::default()
        };
        RegisterClassExW(&class);
    });
}

/// The work area (no taskbar) of `monitor` as (left, top, right, bottom).
pub(super) fn work_area(monitor: isize) -> Option<(i32, i32, i32, i32)> {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let ok = unsafe { GetMonitorInfoW(HMONITOR(monitor as *mut core::ffi::c_void), &mut info) };
    ok.as_bool().then(|| {
        let r = info.rcWork;
        (r.left, r.top, r.right, r.bottom)
    })
}
