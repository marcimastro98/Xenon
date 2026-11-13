//! The recording badge window (layout and pixels in `crate::badge`): a layered
//! topmost pill at the top of the monitor being recorded, so a recording is
//! visible even with no dashboard on screen. It never takes the focus, it is
//! left out of every capture (so it is never in the video), and a click stops
//! the recording. It runs its own message loop; dropping the `Badge` closes it.
//! The steps recorder shows the same pill with its count instead of the time.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::Instant;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{DeleteObject, HFONT};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT};
use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DispatchMessageW, GetMessageW, MSG, PostMessageW, SetTimer, SetWindowDisplayAffinity, ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE, TranslateMessage, WDA_EXCLUDEFROMCAPTURE, WM_APP, WM_CLOSE, WM_LBUTTONUP, WM_MOUSEMOVE, WM_TIMER, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP};

mod paint;
mod window;

use window::{register, work_area};

const CLASS: PCWSTR = w!("XenonRecordingBadge");
const TICK: usize = 1;
/// In `UI::Controls`, a feature this crate does not otherwise need.
const WM_MOUSELEAVE: u32 = 0x02A3;
/// Draw again now (the count changed).
const WM_REFRESH: u32 = WM_APP + 1;

/// What the pill says next to its dot.
pub enum Label {
    /// The time since it appeared: "0:42".
    Clock,
    /// A number in the user's words: `template` with `{n}` in it ("Steps: {n}").
    Count {
        count: Arc<AtomicUsize>,
        template: String,
    },
}

/// The badge while it is on screen. Handles travel as numbers: not `Send`.
pub struct Badge {
    hwnd: isize,
    thread: Option<JoinHandle<()>>,
}

impl Badge {
    /// Shows the badge on `monitor`. A click sets `pressed` and `stop`.
    /// None when the window cannot be made: the recording goes on without it.
    pub fn show(monitor: isize, stop: Arc<AtomicBool>, pressed: Arc<AtomicBool>) -> Option<Badge> {
        Badge::labelled(monitor, Label::Clock, stop, pressed)
    }

    /// The same pill saying `label`.
    pub fn labelled(
        monitor: isize,
        label: Label,
        stop: Arc<AtomicBool>,
        pressed: Arc<AtomicBool>,
    ) -> Option<Badge> {
        let (tx, rx) = mpsc::channel();
        let thread = std::thread::spawn(move || run(monitor, label, stop, pressed, tx));
        match rx.recv() {
            Ok(Some(hwnd)) => Some(Badge {
                hwnd,
                thread: Some(thread),
            }),
            _ => {
                let _ = thread.join();
                None
            }
        }
    }
}

impl Badge {
    /// Draws the pill again at once, for a count that just changed.
    pub fn refresh(&self) {
        let hwnd = HWND(self.hwnd as *mut core::ffi::c_void);
        unsafe {
            let _ = PostMessageW(Some(hwnd), WM_REFRESH, WPARAM(0), LPARAM(0));
        }
    }
}

impl Drop for Badge {
    fn drop(&mut self) {
        let hwnd = HWND(self.hwnd as *mut core::ffi::c_void);
        unsafe {
            let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

struct State {
    hwnd: HWND,
    monitor: isize,
    label: Label,
    stop: Arc<AtomicBool>,
    pressed: Arc<AtomicBool>,
    start: Instant,
    hover: bool,
    font: Option<(HFONT, f32)>,
    work: (i32, i32, i32, i32),
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn run(
    monitor: isize,
    label: Label,
    stop: Arc<AtomicBool>,
    pressed: Arc<AtomicBool>,
    tx: mpsc::Sender<Option<isize>>,
) {
    register();
    let work = work_area(monitor).unwrap_or((0, 0, 0, 0));
    let ex = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
    let made = unsafe {
        CreateWindowExW(
            ex,
            CLASS,
            w!("Xenon"),
            WS_POPUP,
            work.0,
            work.1,
            1,
            1,
            None,
            None,
            GetModuleHandleW(None).ok().map(Into::into),
            None,
        )
    };
    let Ok(hwnd) = made else {
        let _ = tx.send(None);
        return;
    };
    unsafe {
        // Never in a screenshot or a video, ours or anyone's.
        let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    }
    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            hwnd,
            monitor,
            label,
            stop,
            pressed,
            start: Instant::now(),
            hover: false,
            font: None,
            work,
        });
    });
    STATE.with(|s| {
        if let Some(st) = s.borrow_mut().as_mut() {
            st.draw();
        }
    });
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        SetTimer(Some(hwnd), TICK, 1000, None);
    }
    let _ = tx.send(Some(hwnd.0 as isize));
    let mut msg = MSG::default();
    unsafe {
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    STATE.with(|s| {
        if let Some((font, _)) = s.borrow_mut().take().and_then(|st| st.font) {
            unsafe {
                let _ = DeleteObject(font.into());
            }
        }
    });
}

impl State {
    fn scale(&self) -> f32 {
        unsafe { GetDpiForWindow(self.hwnd) }.max(96) as f32 / 96.0
    }

    fn handle(&mut self, msg: u32) -> Option<LRESULT> {
        match msg {
            WM_MOUSEMOVE if !self.hover => {
                self.hover = true;
                let mut track = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE,
                    hwndTrack: self.hwnd,
                    dwHoverTime: 0,
                };
                unsafe {
                    let _ = TrackMouseEvent(&mut track);
                }
                self.draw();
            }
            WM_MOUSELEAVE => {
                self.hover = false;
                self.draw();
            }
            WM_LBUTTONUP => {
                self.pressed.store(true, Ordering::SeqCst);
                self.stop.store(true, Ordering::SeqCst);
                // Gone at once; the recording thread closes the window when done.
                unsafe {
                    let _ = ShowWindow(self.hwnd, SW_HIDE);
                }
            }
            WM_TIMER | WM_REFRESH => self.draw(),
            _ => return None,
        }
        Some(LRESULT(0))
    }
}
