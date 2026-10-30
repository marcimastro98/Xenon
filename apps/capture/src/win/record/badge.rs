//! The recording badge window (layout and pixels in `crate::badge`): a layered
//! topmost pill at the top of the monitor being recorded, so a recording is
//! visible even with no dashboard on screen. It never takes the focus, it is
//! left out of every capture (so it is never in the video), and a click stops
//! the recording. It runs its own message loop; dropping the `Badge` closes it.
//! The steps recorder shows the same pill with its count instead of the time.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Once};
use std::thread::JoinHandle;
use std::time::Instant;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateFontW, DeleteObject, GdiFlush, GetMonitorInfoW, GetTextExtentPoint32W, SelectObject,
    SetBkMode, SetTextColor, TextOutW, AC_SRC_ALPHA, AC_SRC_OVER, ANTIALIASED_QUALITY,
    BLENDFUNCTION, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, FW_SEMIBOLD, HFONT, HMONITOR, MONITORINFO,
    OUT_DEFAULT_PRECIS, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, LoadCursorW,
    PostMessageW, PostQuitMessage, RegisterClassExW, SetTimer, SetWindowDisplayAffinity,
    SetWindowPos, ShowWindow, TranslateMessage, UpdateLayeredWindow, HWND_TOPMOST, IDC_HAND,
    MA_NOACTIVATE, MSG, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOWNOACTIVATE,
    ULW_ALPHA, WDA_EXCLUDEFROMCAPTURE, WM_APP, WM_CLOSE, WM_DESTROY, WM_LBUTTONUP,
    WM_MOUSEACTIVATE, WM_MOUSEMOVE, WM_TIMER, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

use super::super::dib::Dib;
use crate::badge;

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

    /// The font for this scale, made again only when the scale changes.
    fn font(&mut self, scale: f32) -> Option<HFONT> {
        if let Some((f, s)) = self.font {
            if s == scale {
                return Some(f);
            }
            unsafe {
                let _ = DeleteObject(f.into());
            }
            self.font = None;
        }
        let f = unsafe {
            CreateFontW(
                -((badge::TEXT * scale).round() as i32),
                0,
                0,
                0,
                FW_SEMIBOLD.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                ANTIALIASED_QUALITY,
                0,
                w!("Segoe UI"),
            )
        };
        (!f.is_invalid()).then(|| {
            self.font = Some((f, scale));
            f
        })
    }

    fn text(&self) -> String {
        match &self.label {
            Label::Clock => badge::clock(self.start.elapsed().as_secs()),
            Label::Count { count, template } => {
                badge::count(template, count.load(Ordering::SeqCst))
            }
        }
    }

    fn draw(&mut self) {
        // The monitor may have moved or changed scale since the last tick.
        if let Some(work) = work_area(self.monitor) {
            self.work = work;
        }
        let scale = self.scale();
        let Some(font) = self.font(scale) else {
            return;
        };
        let text: Vec<u16> = self.text().encode_utf16().collect();
        let mut size = SIZE::default();
        let Some(mut canvas) = Dib::blank(1, 1) else {
            return;
        };
        unsafe {
            let old = SelectObject(canvas.dc, font.into());
            let _ = GetTextExtentPoint32W(canvas.dc, &text, &mut size);
            SelectObject(canvas.dc, old);
        }
        let l = badge::layout(size.cx, scale);
        match Dib::blank(l.width, l.height) {
            Some(d) => canvas = d,
            None => return,
        }
        let back = if self.hover {
            badge::BACK_HOVER
        } else {
            badge::BACK
        };
        for p in canvas.bytes_mut().chunks_exact_mut(4) {
            p.copy_from_slice(&[back[2], back[1], back[0], 0]);
        }
        let ink = badge::INK;
        unsafe {
            let old = SelectObject(canvas.dc, font.into());
            SetBkMode(canvas.dc, TRANSPARENT);
            SetTextColor(
                canvas.dc,
                COLORREF(ink[0] as u32 | (ink[1] as u32) << 8 | (ink[2] as u32) << 16),
            );
            let y = (l.height as i32 - size.cy) / 2;
            let _ = TextOutW(canvas.dc, l.text.0, y, &text);
            SelectObject(canvas.dc, old);
            let _ = GdiFlush();
        }
        badge::shade(canvas.bytes_mut(), &l, self.hover);
        let (x, y) = badge::place(self.work, &l, scale);
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        unsafe {
            let _ = UpdateLayeredWindow(
                self.hwnd,
                None,
                Some(&POINT { x, y }),
                Some(&SIZE {
                    cx: l.width as i32,
                    cy: l.height as i32,
                }),
                Some(canvas.dc),
                Some(&POINT::default()),
                COLORREF(0),
                Some(&blend),
                ULW_ALPHA,
            );
            // Another topmost window may have come over it since.
            let _ = SetWindowPos(
                self.hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
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

fn register() {
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
fn work_area(monitor: isize) -> Option<(i32, i32, i32, i32)> {
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
