//! The steps recorder: while it runs, every mouse press (outside Xenon's own
//! windows) becomes a step: a picture of the monitor it happened on with a
//! ring where it landed, saved as a JPEG in the folder the server chose, and
//! an event with what was clicked and in which app. The pill at the top of
//! the screen shows the count all along and ends the recording when clicked;
//! it never appears in the pictures. Keys typed are never recorded, only that
//! typing happened between two steps. Pure parts in `crate::steps`.

mod describe;
mod hooks;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::json;
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, HMONITOR, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetCursorPos, GetWindowThreadProcessId, WindowFromPoint, GA_ROOT,
};

use super::record::badge::{Badge, Label};
use super::{d3d, edit, grab, monitors, window};
use crate::proto::{Fail, Notify};
use crate::steps;
use describe::Describer;
use hooks::{Hooks, Press, TYPED};

/// A recording with no click for this long ends by itself.
const IDLE: Duration = Duration::from_secs(20 * 60);
/// How often the worker looks at the stop flags while no click comes.
const POLL: Duration = Duration::from_millis(250);
/// How long a step waits for the name of what was clicked.
const DESCRIBE_WAIT: Duration = Duration::from_millis(1500);
/// The shell's window: clicks on Xenon itself are not steps of the procedure.
const XENON_EXE: &str = "xenon-native.exe";

pub struct Plan {
    pub dir: PathBuf,
    /// The pill's words, with `{n}` for the count.
    pub template: String,
}

pub struct Steps {
    active: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Steps {
    /// Starts recording. The end always comes as an event `steps_ended
    /// { reason, count, typed }`: "stopped" (the server), "closed" (the pill),
    /// "full", "idle" or "failed".
    pub fn start(plan: Plan, notify: Notify) -> Result<Steps, Fail> {
        std::fs::create_dir_all(&plan.dir).map_err(|e| Fail::new("write_failed", e))?;
        let (tx, presses) = mpsc::channel();
        let hooks = Hooks::install(tx).ok_or(Fail::code("hook_failed"))?;
        let count = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicBool::new(false));
        let label = Label::Count {
            count: count.clone(),
            template: plan.template,
        };
        let badge = Badge::labelled(
            cursor_monitor().0 as isize,
            label,
            closed.clone(),
            closed.clone(),
        );
        let active = Arc::new(AtomicBool::new(true));
        let stop = Arc::new(AtomicBool::new(false));
        let run = Run {
            dir: plan.dir,
            presses,
            hooks,
            badge,
            count,
            closed,
            stop: stop.clone(),
            active: active.clone(),
            notify,
        };
        let thread = std::thread::spawn(move || run.work());
        Ok(Steps {
            active,
            stop,
            thread: Some(thread),
        })
    }

    pub fn active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
}

impl Drop for Steps {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

struct Run {
    dir: PathBuf,
    presses: mpsc::Receiver<Press>,
    hooks: Hooks,
    badge: Option<Badge>,
    count: Arc<AtomicUsize>,
    closed: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    notify: Notify,
}

impl Run {
    fn work(self) {
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
        let device = d3d::create().ok();
        let describer = Describer::start();
        let mut prev: Option<(i32, i32, u64)> = None;
        let mut last = Instant::now();
        let reason = loop {
            if self.stop.load(Ordering::SeqCst) {
                break "stopped";
            }
            if self.closed.load(Ordering::SeqCst) {
                break "closed";
            }
            if self.count.load(Ordering::SeqCst) >= steps::MAX_STEPS {
                break "full";
            }
            if device.is_none() {
                break "failed";
            }
            if last.elapsed() >= IDLE {
                break "idle";
            }
            let press = match self.presses.recv_timeout(POLL) {
                Ok(p) => p,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break "failed",
            };
            if ours(press.pt) {
                continue;
            }
            let (x, y, t) = (press.pt.x, press.pt.y, press.time as u64);
            if steps::is_double(prev, x, y, t) {
                prev = None;
                (self.notify)(
                    json!({ "event": "step_double", "n": self.count.load(Ordering::SeqCst) }),
                );
                continue;
            }
            prev = Some((x, y, t));
            last = Instant::now();
            if let Some(dev) = device.as_ref() {
                self.step(dev, &describer, press);
            }
        };
        let Run {
            hooks,
            badge,
            count,
            active,
            notify,
            ..
        } = self;
        drop(hooks);
        drop(badge);
        let typed = TYPED.swap(false, Ordering::SeqCst);
        active.store(false, Ordering::SeqCst);
        notify(json!({
            "event": "steps_ended", "reason": reason,
            "count": count.load(Ordering::SeqCst), "typed": typed,
        }));
    }

    /// Saves one step; a picture that cannot be taken or written is skipped.
    fn step(&self, dev: &d3d::Device, describer: &Describer, press: Press) {
        let asked = describer.ask(press.pt);
        let typed = TYPED.swap(false, Ordering::SeqCst);
        let hm = unsafe { MonitorFromPoint(press.pt, MONITOR_DEFAULTTONEAREST) };
        let list = monitors::list();
        let Some(m) = list.iter().find(|m| m.handle == hm) else {
            return;
        };
        let opts = grab::Options {
            hdr_white: m.hdr.then_some(m.white),
            cursor: false,
            crop: None,
            wait: grab::FIRST_FRAME_TIMEOUT,
        };
        let Ok(mut image) = grab::grab(dev, &grab::Target::Monitor(m.handle), &opts) else {
            return;
        };
        let (cx, cy) = (press.pt.x - m.rect.left, press.pt.y - m.rect.top);
        // Sized for the picture as saved: a 4K screen is scaled down to IMAGE_WIDTH.
        let shrink = image.width as f32 / steps::IMAGE_WIDTH as f32;
        let ring_scale = scale(hm).max(shrink);
        steps::ring(
            &mut image.bgr,
            image.width,
            image.height,
            cx,
            cy,
            ring_scale,
        );
        let n = self.count.load(Ordering::SeqCst) + 1;
        let name = steps::file_name(n);
        let Some((width, height)) = self.write(&name, &image) else {
            return;
        };
        let what = describe::answer(asked, DESCRIBE_WAIT);
        self.count.store(n, Ordering::SeqCst);
        if let Some(b) = self.badge.as_ref() {
            b.refresh();
        }
        (self.notify)(json!({
            "event": "step", "n": n, "file": name, "width": width, "height": height,
            "right": press.right, "app": app_at(press.pt), "name": what.name, "role": what.role,
            "typedBefore": typed,
        }));
    }

    /// Writes the JPEG next to its name first, so a half-written file never
    /// carries the real name.
    fn write(&self, name: &str, image: &grab::Image) -> Option<(u32, u32)> {
        let path = self.dir.join(name);
        let part = self.dir.join(format!("{name}.part"));
        let part_s = part.to_string_lossy().to_string();
        let size = edit::jpeg(
            &image.bgr,
            image.width,
            image.height,
            steps::IMAGE_WIDTH,
            &part_s,
        )
        .ok()?;
        match std::fs::rename(&part, &path) {
            Ok(()) => Some(size),
            Err(_) => {
                let _ = std::fs::remove_file(&part);
                None
            }
        }
    }
}

fn cursor_monitor() -> HMONITOR {
    let mut pt = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut pt);
        MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST)
    }
}

/// The monitor's scale (1.0 = 96 dpi), so the ring looks the same everywhere.
fn scale(hm: HMONITOR) -> f32 {
    let (mut dx, mut dy) = (96u32, 96u32);
    unsafe {
        let _ = GetDpiForMonitor(hm, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
    }
    dx.max(96) as f32 / 96.0
}

/// The top-level window under `pt`.
fn root_at(pt: POINT) -> windows::Win32::Foundation::HWND {
    unsafe { GetAncestor(WindowFromPoint(pt), GA_ROOT) }
}

/// A press on our pill or on Xenon's own windows.
fn ours(pt: POINT) -> bool {
    let root = root_at(pt);
    if root.is_invalid() {
        return false;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(root, Some(&mut pid)) };
    pid == std::process::id() || window::exe_name(root).eq_ignore_ascii_case(XENON_EXE)
}

fn app_at(pt: POINT) -> String {
    let root = root_at(pt);
    if root.is_invalid() {
        return String::new();
    }
    window::exe_name(root)
}
