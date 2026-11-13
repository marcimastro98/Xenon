// Windows: getting the picture a screenshot is made of, and a window on its own without what covers it.

use std::sync::mpsc;
use std::time::Duration;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
use crate::proto::Fail;
use crate::region::{self, Rect};
use super::{Backend, d3d, grab, monitors, picker, window};

/// How long a window may take to be captured on its own before its monitor is
/// used instead. A window that answers gives its frame in well under 200 ms.
const WINDOW_ALONE_DEADLINE: Duration = Duration::from_secs(1);
/// The window alone gives up on its first frame before that deadline, so a
/// window that never sends one leaves the worker free for the next capture.
const WINDOW_ALONE_WAIT: Duration = Duration::from_millis(700);

pub(super) type WindowJob = (isize, grab::Options, mpsc::Sender<Option<grab::Image>>);

/// Captures windows on a thread of its own, with a device of its own: an app
/// that freezes while its window is being captured can block a capture call
/// for many seconds (measured past 15 s). The engine stops waiting at the
/// deadline and starts a fresh worker; the stuck one ends by itself once its
/// call returns and finds nobody listening.
pub(super) struct WindowWorker {
    jobs: mpsc::Sender<WindowJob>,
}

impl WindowWorker {
    pub(super) fn start() -> WindowWorker {
        let (jobs, rx) = mpsc::channel::<WindowJob>();
        std::thread::spawn(move || {
            unsafe {
                let _ = RoInitialize(RO_INIT_MULTITHREADED);
            }
            let mut dev = None;
            for (raw, opts, reply) in rx {
                if dev.is_none() {
                    dev = d3d::create().ok();
                }
                let target = grab::Target::Window(HWND(raw as *mut core::ffi::c_void));
                let shot = dev
                    .as_ref()
                    .and_then(|d| grab::grab(d, &target, &opts).ok());
                if reply.send(shot).is_err() {
                    return;
                }
            }
        });
        WindowWorker { jobs }
    }
}

impl Backend {
    /// Every monitor as it is now, for the pickers.
    pub(super) fn freeze(&mut self, list: &[monitors::Monitor]) -> Result<Vec<picker::Frozen>, Fail> {
        let mut frozen = Vec::new();
        for m in list {
            let opts = grab::Options {
                hdr_white: m.hdr.then_some(m.white),
                cursor: false,
                crop: None,
                wait: grab::FIRST_FRAME_TIMEOUT,
            };
            // A monitor that cannot be captured is left out, not the whole pick.
            if let Ok(image) = self.grab(&grab::Target::Monitor(m.handle), &opts) {
                let r = m.rect;
                frozen.push(picker::Frozen {
                    monitor: m.index,
                    rect: Rect {
                        left: r.left,
                        top: r.top,
                        right: r.right,
                        bottom: r.bottom,
                    },
                    image,
                });
            }
        }
        if frozen.is_empty() {
            return Err(Fail::code("capture_failed"));
        }
        Ok(frozen)
    }

    /// One frame with the engine's own device.
    pub(super) fn grab(&mut self, target: &grab::Target, opts: &grab::Options) -> Result<grab::Image, Fail> {
        let shot = grab::grab(self.device()?, target, opts);
        shot.map_err(|e| {
            // A lost GPU (driver reset, adapter unplugged) is recreated next time.
            self.device = None;
            Fail::new("capture_failed", e)
        })
    }

    /// A window on its own; cut out of its monitor when its app is frozen, or the
    /// window alone gives no frame in time. The monitor still shows what the
    /// window last drew, which is what the user sees.
    pub(super) fn grab_window(
        &mut self,
        h: HWND,
        mon: Option<&monitors::Monitor>,
        opts: grab::Options,
    ) -> Result<grab::Image, Fail> {
        if window::responsive(h) {
            if let Some(image) = self.window_alone(h, opts) {
                return Ok(image);
            }
        }
        let m = mon.ok_or(Fail::code("capture_failed"))?;
        let r = m.rect;
        let crop = window::bounds(h)
            .and_then(|b| {
                region::within(
                    b,
                    Rect {
                        left: r.left,
                        top: r.top,
                        right: r.right,
                        bottom: r.bottom,
                    },
                )
            })
            .ok_or(Fail::code("capture_failed"))?;
        self.grab(
            &grab::Target::Monitor(m.handle),
            &grab::Options {
                crop: Some(crop),
                ..opts
            },
        )
    }

    fn window_alone(&mut self, h: HWND, opts: grab::Options) -> Option<grab::Image> {
        let worker = self.window_worker.get_or_insert_with(WindowWorker::start);
        let (reply, rx) = mpsc::channel();
        let job = (
            h.0 as isize,
            grab::Options {
                wait: WINDOW_ALONE_WAIT,
                ..opts
            },
            reply,
        );
        if worker.jobs.send(job).is_err() {
            self.window_worker = None;
            return None;
        }
        rx.recv_timeout(WINDOW_ALONE_DEADLINE).unwrap_or_else(|_| {
            self.window_worker = None; // stuck in a call: a fresh worker next time
            None
        })
    }
}
