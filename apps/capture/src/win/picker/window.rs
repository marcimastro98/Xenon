// Windows picker: the window itself, its messages and its keys.

use std::sync::Once;
use windows::core::w;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{VK_ESCAPE, VK_RETURN};
use windows::Win32::UI::WindowsAndMessaging::{CallNextHookEx, CreateWindowExW, DefWindowProcW, HC_ACTION, IDC_CROSS, KBDLLHOOKSTRUCT, LoadCursorW, PostQuitMessage, RegisterClassExW, WM_KEYDOWN, WM_SYSKEYDOWN, WNDCLASSEXW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP};
use crate::pixels;
use super::{CLASS, Frozen, Mode, Outcome, STATE, Surface};
use super::paint::cursor;
use super::super::dib::Dib;

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

pub(super) unsafe extern "system" fn keys(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
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
        if k.vkCode == VK_RETURN.0 as u32 {
            let down = matches!(w.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            let taken = STATE.with(|s| {
                let mut guard = s.try_borrow_mut().ok()?;
                let st = guard.as_mut().filter(|st| st.mode == Mode::Area)?;
                if down {
                    st.take_screen();
                }
                Some(())
            });
            if taken.is_some() {
                return LRESULT(1);
            }
        }
    }
    CallNextHookEx(None, code, w, l)
}

pub(super) fn instance() -> HINSTANCE {
    unsafe { GetModuleHandleW(None) }
        .map(Into::into)
        .unwrap_or_default()
}

pub(super) fn register() {
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

pub(super) fn surface(f: &Frozen) -> Option<Surface> {
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

/// The surface the pointer is on, the first one if it is on none.
pub(super) fn under_cursor(surfaces: &[Surface]) -> usize {
    let at = cursor();
    surfaces
        .iter()
        .position(|s| s.rect.contains(at.0, at.1))
        .unwrap_or(0)
}
