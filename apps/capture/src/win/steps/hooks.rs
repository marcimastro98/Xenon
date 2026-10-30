//! The global mouse and keyboard hooks of the steps recorder, on a thread of
//! their own with a message loop, installed only while a recording runs.
//! The mouse hook hands each press to the recorder and returns at once (a
//! slow low-level hook is dropped by Windows). The keyboard hook only notes
//! THAT something was typed: which keys never leaves it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread::JoinHandle;

use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    VK_CAPITAL, VK_CONTROL, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU, VK_RCONTROL,
    VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_LBUTTONDOWN, WM_QUIT, WM_RBUTTONDOWN,
    WM_SYSKEYDOWN,
};

/// One press of a mouse button, as the hook saw it.
#[derive(Clone, Copy)]
pub struct Press {
    pub pt: POINT,
    pub right: bool,
    /// The system's time of the press, in milliseconds.
    pub time: u32,
}

/// Where the mouse hook sends presses while a recording runs.
static PRESSES: Mutex<Option<mpsc::Sender<Press>>> = Mutex::new(None);
/// Something was typed since the last press.
pub static TYPED: AtomicBool = AtomicBool::new(false);

pub struct Hooks {
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl Hooks {
    /// Installs the hooks; presses arrive on `to`. None when Windows refuses.
    pub fn install(to: mpsc::Sender<Press>) -> Option<Hooks> {
        if let Ok(mut slot) = PRESSES.lock() {
            *slot = Some(to);
        }
        TYPED.store(false, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        let thread = std::thread::spawn(move || run(tx));
        match rx.recv() {
            Ok(Some(thread_id)) => Some(Hooks {
                thread_id,
                thread: Some(thread),
            }),
            _ => {
                let _ = thread.join();
                clear();
                None
            }
        }
    }
}

impl Drop for Hooks {
    fn drop(&mut self) {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        clear();
    }
}

fn clear() {
    if let Ok(mut slot) = PRESSES.lock() {
        *slot = None;
    }
}

fn run(tx: mpsc::Sender<Option<u32>>) {
    let module = unsafe { GetModuleHandleW(None) }.ok().map(Into::into);
    let mouse = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), module, 0) }.ok();
    let keys = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), module, 0) }.ok();
    let (Some(mouse), Some(keys)) = (mouse, keys) else {
        for h in [mouse, keys].into_iter().flatten() {
            unsafe {
                let _ = UnhookWindowsHookEx(h);
            }
        }
        let _ = tx.send(None);
        return;
    };
    let _ = tx.send(Some(unsafe { GetCurrentThreadId() }));
    let mut msg = MSG::default();
    unsafe {
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = UnhookWindowsHookEx(mouse);
        let _ = UnhookWindowsHookEx(keys);
    }
}

unsafe extern "system" fn on_mouse(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    let msg = w.0 as u32;
    if code == HC_ACTION as i32 && (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN) {
        // Injected clicks count too: a support tech working through a remote
        // tool is recording real steps.
        let info = &*(l.0 as *const MSLLHOOKSTRUCT);
        let press = Press {
            pt: info.pt,
            right: msg == WM_RBUTTONDOWN,
            time: info.time,
        };
        // Never wait in a low-level hook: a busy slot loses one press, not the hook.
        if let Ok(slot) = PRESSES.try_lock() {
            if let Some(to) = slot.as_ref() {
                let _ = to.send(press);
            }
        }
    }
    CallNextHookEx(None, code, w, l)
}

unsafe extern "system" fn on_key(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    let msg = w.0 as u32;
    if code == HC_ACTION as i32 && (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
        let vk = (*(l.0 as *const KBDLLHOOKSTRUCT)).vkCode as u16;
        let modifier = [
            VK_SHIFT,
            VK_LSHIFT,
            VK_RSHIFT,
            VK_CONTROL,
            VK_LCONTROL,
            VK_RCONTROL,
            VK_MENU,
            VK_LMENU,
            VK_RMENU,
            VK_LWIN,
            VK_RWIN,
            VK_CAPITAL,
        ]
        .iter()
        .any(|k| k.0 == vk);
        if !modifier {
            TYPED.store(true, Ordering::SeqCst);
        }
    }
    CallNextHookEx(None, code, w, l)
}
