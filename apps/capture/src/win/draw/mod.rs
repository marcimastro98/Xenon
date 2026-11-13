//! Drawing on the screen (pixels and strokes in `crate::sketch`): a layered
//! window over the whole monitor under the pointer shows the strokes and takes
//! the mouse; the bar at its top picks the colour and the tool. Recordings and
//! screenshots show the drawing, never the bar. Esc, the bar's close button or
//! the server end it. It runs its own message loop; dropping the `Drawing`
//! closes it.

mod surfaces;
mod input;
mod window;

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetForegroundWindow, GetMessageW, MSG, PostMessageW, SetForegroundWindow, SetTimer, SetWindowsHookExW, ShowWindow, SW_SHOW, SW_SHOWNOACTIVATE, TranslateMessage, UnhookWindowsHookEx, WH_KEYBOARD_LL, WM_CLOSE};

use crate::sketch::bar::{Item, Look};
use crate::sketch::canvas::Tool;
use surfaces::Surfaces;

use window::{keys, register};

/// Called once when the drawing ends: "closed" by the user, "stopped" by the server.
pub type OnEnd = Box<dyn FnOnce(&'static str) + Send>;

const HINT_TIMER: usize = 1;
const HINT_FOR: Duration = Duration::from_secs(8);
/// In `UI::Controls`, a feature this crate does not otherwise need.
const WM_MOUSELEAVE: u32 = 0x02A3;
const MK_SHIFT: usize = 0x4;
const MK_CONTROL: usize = 0x8;
/// WM_CLOSE's wParam when the server ends the drawing.
const BY_SERVER: usize = 1;

/// The canvas of the drawing open now, for the Esc hook.
static CANVAS: AtomicIsize = AtomicIsize::new(0);

pub struct Drawing {
    hwnd: isize,
    open: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drawing {
    /// Opens the drawing on the monitor under the pointer, with `hint` under
    /// the bar for a few seconds. None when the windows cannot be made.
    pub fn show(hint: String, on_end: OnEnd) -> Option<Drawing> {
        let open = Arc::new(AtomicBool::new(true));
        let (tx, rx) = mpsc::channel();
        let flag = open.clone();
        let thread = std::thread::spawn(move || run(hint, on_end, flag, tx));
        match rx.recv() {
            Ok(Some(hwnd)) => Some(Drawing {
                hwnd,
                open,
                thread: Some(thread),
            }),
            _ => {
                let _ = thread.join();
                None
            }
        }
    }

    pub fn active(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }
}

impl Drop for Drawing {
    fn drop(&mut self) {
        // Only while open: a closed window's handle may belong to another one by now.
        if self.active() {
            unsafe {
                let _ = PostMessageW(
                    Some(hwnd(self.hwnd)),
                    WM_CLOSE,
                    WPARAM(BY_SERVER),
                    LPARAM(0),
                );
            }
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn hwnd(v: isize) -> HWND {
    HWND(v as *mut core::ffi::c_void)
}

struct State {
    s: Surfaces,
    colour: usize,
    tool: Tool,
    hover: Option<Item>,
    dragging: bool,
    /// The window in front before the drawing, given the focus back at the end.
    before: HWND,
    reason: &'static str,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn run(hint: String, on_end: OnEnd, open: Arc<AtomicBool>, tx: mpsc::Sender<Option<isize>>) {
    register();
    let Some(s) = Surfaces::open(&hint) else {
        open.store(false, Ordering::SeqCst);
        let _ = tx.send(None);
        return;
    };
    let (canvas, bar) = (s.canvas, s.bar);
    let before = unsafe { GetForegroundWindow() };
    STATE.with(|st| {
        let mut state = State {
            s,
            colour: 0,
            tool: Tool::Pen,
            hover: None,
            dragging: false,
            before,
            reason: "closed",
        };
        state.s.present(None);
        state.paint_bar();
        *st.borrow_mut() = Some(state);
    });
    CANVAS.store(canvas.0 as isize, Ordering::SeqCst);
    let hook = unsafe {
        let _ = ShowWindow(canvas, SW_SHOW);
        let _ = ShowWindow(bar, SW_SHOWNOACTIVATE);
        // May be refused (another app is in front); the first click gives the focus.
        let _ = SetForegroundWindow(canvas);
        SetTimer(Some(canvas), HINT_TIMER, HINT_FOR.as_millis() as u32, None);
        SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(keys),
            GetModuleHandleW(None).ok().map(Into::into),
            0,
        )
        .ok()
    };
    let _ = tx.send(Some(canvas.0 as isize));
    let mut msg = MSG::default();
    unsafe {
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if let Some(h) = hook {
            let _ = UnhookWindowsHookEx(h);
        }
    }
    CANVAS.store(0, Ordering::SeqCst);
    let reason = STATE
        .with(|st| st.borrow_mut().take())
        .map_or("closed", |state| state.reason);
    open.store(false, Ordering::SeqCst);
    on_end(reason);
}

impl State {
    fn look(&self) -> Look {
        Look {
            colour: self.colour,
            tool: self.tool,
            hover: self.hover,
            can_undo: self.s.sketch.has_strokes(),
        }
    }

    fn paint_bar(&mut self) {
        let look = self.look();
        self.s.paint_bar(&look);
    }
}

/// A mouse message's point, at the pixel's centre.
fn point(l: LPARAM) -> (f32, f32) {
    let x = (l.0 & 0xFFFF) as i16 as f32;
    let y = ((l.0 >> 16) & 0xFFFF) as i16 as f32;
    (x + 0.5, y + 0.5)
}
