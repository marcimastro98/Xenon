//! Drawing on the screen (pixels and strokes in `crate::sketch`): a layered
//! window over the whole monitor under the pointer shows the strokes and takes
//! the mouse; the bar at its top picks the colour and the tool. Recordings and
//! screenshots show the drawing, never the bar. Esc, the bar's close button or
//! the server end it. It runs its own message loop; dropping the `Drawing`
//! closes it.

mod surfaces;

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{mpsc, Arc, Once};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, ReleaseCapture, SetCapture, TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT,
    VK_CONTROL, VK_DELETE, VK_ESCAPE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DefWindowProcW, DestroyWindow, DispatchMessageW, GetForegroundWindow,
    GetMessageW, KillTimer, LoadCursorW, PostMessageW, PostQuitMessage, RegisterClassExW,
    SetForegroundWindow, SetTimer, SetWindowsHookExW, ShowWindow, TranslateMessage,
    UnhookWindowsHookEx, HC_ACTION, IDC_ARROW, IDC_CROSS, KBDLLHOOKSTRUCT, MA_NOACTIVATE, MSG,
    SW_SHOW, SW_SHOWNOACTIVATE, WH_KEYBOARD_LL, WM_CAPTURECHANGED, WM_CLOSE, WM_DESTROY,
    WM_DISPLAYCHANGE, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEMOVE,
    WM_SYSKEYDOWN, WM_TIMER, WNDCLASSEXW,
};

use crate::sketch::bar::{self, Item, Look};
use crate::sketch::canvas::Tool;
use surfaces::{Surfaces, BAR_CLASS, CANVAS_CLASS};

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

    fn canvas(&mut self, msg: u32, w: WPARAM, l: LPARAM) -> Option<LRESULT> {
        let pt = point(l);
        match msg {
            WM_LBUTTONDOWN => {
                unsafe {
                    SetCapture(self.s.canvas);
                }
                self.dragging = true;
                let (ctrl, shift) = (w.0 & MK_CONTROL != 0, w.0 & MK_SHIFT != 0);
                // Ctrl draws a box, Ctrl+Shift an arrow, Shift a straight line.
                let tool = match (ctrl, shift) {
                    (true, true) => Tool::Arrow,
                    (true, false) => Tool::Box,
                    _ => self.tool,
                };
                let (rgb, scale) = (bar::PALETTE[self.colour], self.s.scale);
                let s = &mut self.s;
                let dirty =
                    s.sketch
                        .begin(s.pixels.bytes_mut(), tool, rgb, scale, shift && !ctrl, pt);
                if dirty.is_some() {
                    s.present(dirty);
                }
                if self.s.has_hint() {
                    self.s.drop_hint();
                    self.paint_bar();
                }
            }
            WM_MOUSEMOVE if self.dragging => {
                let s = &mut self.s;
                if let Some(dirty) = s.sketch.extend(s.pixels.bytes_mut(), pt) {
                    s.present(Some(dirty));
                }
            }
            WM_LBUTTONUP => {
                self.finish_stroke();
                unsafe {
                    let _ = ReleaseCapture();
                }
            }
            WM_CAPTURECHANGED => self.finish_stroke(),
            WM_KEYDOWN => self.key(w.0 as u32),
            WM_TIMER => {
                unsafe {
                    let _ = KillTimer(Some(self.s.canvas), HINT_TIMER);
                }
                if self.s.has_hint() {
                    self.s.drop_hint();
                    self.paint_bar();
                }
            }
            WM_DISPLAYCHANGE => unsafe {
                // The monitor changed under the drawing: it no longer lines up.
                let _ = PostMessageW(Some(self.s.canvas), WM_CLOSE, WPARAM(0), LPARAM(0));
            },
            _ => return None,
        }
        Some(LRESULT(0))
    }

    fn finish_stroke(&mut self) {
        if !self.dragging {
            return;
        }
        self.dragging = false;
        let had = self.s.sketch.has_strokes();
        let s = &mut self.s;
        s.sketch.end(s.pixels.bytes());
        if had != self.s.sketch.has_strokes() {
            self.paint_bar();
        }
    }

    fn key(&mut self, vk: u32) {
        let ctrl = unsafe { GetKeyState(VK_CONTROL.0 as i32) } < 0;
        let colour = b"RYGBWK".iter().position(|&c| c as u32 == vk);
        match (vk, colour) {
            (v, _) if v == b'Z' as u32 && ctrl => self.act(Item::Undo),
            (v, _) if v == b'E' as u32 || v == VK_DELETE.0 as u32 => self.act(Item::Clear),
            (_, Some(i)) if !ctrl => self.act(Item::Colour(i)),
            _ => {}
        }
    }

    fn act(&mut self, item: Item) {
        match item {
            Item::Colour(i) => self.colour = i,
            Item::Tool(t) => self.tool = t,
            Item::Undo | Item::Clear => {
                self.finish_stroke();
                let s = &mut self.s;
                let changed = if item == Item::Undo {
                    s.sketch.undo(s.pixels.bytes_mut())
                } else {
                    s.sketch.clear(s.pixels.bytes_mut())
                };
                if changed {
                    self.s.present(None);
                }
            }
            Item::Close => unsafe {
                let _ = PostMessageW(Some(self.s.canvas), WM_CLOSE, WPARAM(0), LPARAM(0));
                return;
            },
        }
        self.paint_bar();
    }

    fn bar(&mut self, msg: u32, l: LPARAM) -> Option<LRESULT> {
        match msg {
            WM_MOUSEMOVE => {
                let (x, y) = point(l);
                let over = bar::hit(&self.s.layout, x, y);
                if self.hover.is_none() {
                    let mut track = TRACKMOUSEEVENT {
                        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                        dwFlags: TME_LEAVE,
                        hwndTrack: self.s.bar,
                        dwHoverTime: 0,
                    };
                    unsafe {
                        let _ = TrackMouseEvent(&mut track);
                    }
                }
                if over != self.hover {
                    self.hover = over;
                    self.paint_bar();
                }
            }
            WM_MOUSELEAVE => {
                self.hover = None;
                self.paint_bar();
            }
            WM_LBUTTONUP => {
                let (x, y) = point(l);
                if let Some(item) = bar::hit(&self.s.layout, x, y) {
                    self.act(item);
                }
            }
            _ => return None,
        }
        Some(LRESULT(0))
    }
}

/// A mouse message's point, at the pixel's centre.
fn point(l: LPARAM) -> (f32, f32) {
    let x = (l.0 & 0xFFFF) as i16 as f32;
    let y = ((l.0 >> 16) & 0xFFFF) as i16 as f32;
    (x + 0.5, y + 0.5)
}

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
unsafe extern "system" fn keys(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
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

fn register() {
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
