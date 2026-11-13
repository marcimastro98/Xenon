// Windows drawing sheet: the window itself, its messages and its keys.

use std::sync::Once;
use std::sync::atomic::Ordering;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
use windows::Win32::UI::WindowsAndMessaging::{CallNextHookEx, DefWindowProcW, DestroyWindow, GetForegroundWindow, HC_ACTION, IDC_ARROW, IDC_CROSS, KBDLLHOOKSTRUCT, LoadCursorW, MA_NOACTIVATE, PostMessageW, PostQuitMessage, RegisterClassExW, SetForegroundWindow, WM_CLOSE, WM_DESTROY, WM_KEYDOWN, WM_MOUSEACTIVATE, WM_SYSKEYDOWN, WNDCLASSEXW};
use super::{BY_SERVER, CANVAS, hwnd, STATE};
use super::surfaces::{BAR_CLASS, CANVAS_CLASS};

unsafe extern "system" fn window_proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match msg {
        WM_MOUSEACTIVATE if h.0 as isize != CANVAS.load(Ordering::SeqCst) => {
            return LRESULT(MA_NOACTIVATE as isize)
        }
        WM_CLOSE => {
            let mut before = None;
            STATE.with(|s| {
                if let Some(st) = s.try_borrow_mut().ok().as_mut().and_then(|g| g.as_mut()) {
                    if w.0 == BY_SERVER {
                        st.reason = "stopped";
                    }
                    before = Some(st.before);
                }
            });
            // The focus goes back where it was, if the drawing had it.
            if let Some(b) = before.filter(|_| GetForegroundWindow() == h) {
                let _ = SetForegroundWindow(b);
            }
            let _ = DestroyWindow(h);
            return LRESULT(0);
        }
        WM_DESTROY => {
            if h.0 as isize == CANVAS.load(Ordering::SeqCst) {
                PostQuitMessage(0);
            }
            return LRESULT(0);
        }
        _ => {}
    }
    // Calls made while handling a message send messages back in; those find
    // the state busy and take the default path.
    let handled = STATE.with(|s| {
        s.try_borrow_mut().ok().and_then(|mut g| {
            g.as_mut().and_then(|st| {
                if h == st.s.canvas {
                    st.canvas(msg, w, l)
                } else if h == st.s.bar {
                    st.bar(msg, l)
                } else {
                    None
                }
            })
        })
    });
    handled.unwrap_or_else(|| DefWindowProcW(h, msg, w, l))
}

/// Esc ends the drawing even before its window has the focus.
pub(super) unsafe extern "system" fn keys(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let k = &*(l.0 as *const KBDLLHOOKSTRUCT);
        if k.vkCode == VK_ESCAPE.0 as u32 {
            if matches!(w.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN) {
                let _ = PostMessageW(
                    Some(hwnd(CANVAS.load(Ordering::SeqCst))),
                    WM_CLOSE,
                    WPARAM(0),
                    LPARAM(0),
                );
            }
            return LRESULT(1); // Esc belongs to the drawing while it is open
        }
    }
    CallNextHookEx(None, code, w, l)
}

pub(super) fn register() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        let instance = GetModuleHandleW(None).map(Into::into).unwrap_or_default();
        for (class, cursor) in [(CANVAS_CLASS, IDC_CROSS), (BAR_CLASS, IDC_ARROW)] {
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(window_proc),
                hInstance: instance,
                hCursor: LoadCursorW(None, cursor).unwrap_or_default(),
                lpszClassName: class,
                ..Default::default()
            };
            RegisterClassExW(&wc);
        }
    });
}
