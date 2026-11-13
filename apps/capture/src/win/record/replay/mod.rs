//! Instant Replay: the monitor is recorded all the time into a ring of short
//! segments on disk (`crate::ring`), each from an encoder of its own so it
//! starts on a keyframe; sound goes to PCM files beside them (pcm.rs). A save
//! cuts the segment being written, waits for it and its sound to be complete,
//! and joins the newest segments into one MP4 on a thread of its own
//! (remux.rs), while the ring keeps recording. Encoders are opened one
//! segment ahead and closed on a helper thread (Prep), so a joint never makes
//! the frame clock wait.

mod pcm;
mod remux;
mod running;
mod saving;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{json, Value};
use windows::Win32::Graphics::Direct3D11::ID3D11Device;
use windows::Win32::Media::MediaFoundation::{MFShutdown, MFStartup, MFSTARTUP_LITE, MF_VERSION};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use super::encoder::Encoder;
use super::sound::Wanted;
use super::{failure, START_TIMEOUT};
use crate::proto::{Fail, Notify};
use crate::video;

use running::run;

/// How long a save waits for the last sound to arrive (it trails the
/// picture by the mixer's latency); silence fills what is still missing.
const SOUND_WAIT: Duration = Duration::from_millis(1500);
/// How long a save waits for the segment it cut to be closed.
const SEGMENT_WAIT: Duration = Duration::from_secs(10);

pub struct Plan {
    pub monitor: isize,
    pub hdr_white: Option<f32>,
    pub room: (u32, u32),
    /// The ring folder: only files named by `ring::is_ring_file` are touched.
    pub dir: PathBuf,
    pub fps: u32,
    pub height: u32,
    pub quality: video::Quality,
    pub audio: Wanted,
    pub keep: u32,
}

struct SaveJob {
    path: String,
    seconds: u32,
    token: String,
}

pub struct Replay {
    stop: Arc<AtomicBool>,
    saves: mpsc::Sender<SaveJob>,
    saving: Arc<AtomicBool>,
    keep: Arc<AtomicU32>,
    thread: JoinHandle<Value>,
}

impl Replay {
    pub fn active(&self) -> bool {
        !self.thread.is_finished()
    }

    /// Saves the last `seconds` (at most what the ring holds) to `path`; the
    /// result comes as a `replay_saved` event carrying `token`.
    pub fn save(&self, path: String, seconds: u32, token: String) -> Result<(), Fail> {
        if self.saving.swap(true, Ordering::SeqCst) {
            return Err(Fail::code("saving"));
        }
        self.saves
            .send(SaveJob {
                path,
                seconds,
                token,
            })
            .map_err(|_| {
                self.saving.store(false, Ordering::SeqCst);
                Fail::code("not_running")
            })
    }

    /// A new length, from the next segment on.
    pub fn set_keep(&self, seconds: u32) {
        self.keep.store(seconds, Ordering::SeqCst);
    }

    /// Ends the replay: a save in progress is finished, then the ring is deleted.
    pub fn stop(self) -> Value {
        self.stop.store(true, Ordering::SeqCst);
        self.thread
            .join()
            .unwrap_or_else(|_| json!({ "reason": "crashed" }))
    }
}

pub fn start(plan: Plan, notify: Notify) -> Result<(Replay, Value), Fail> {
    let stop = Arc::new(AtomicBool::new(false));
    let saving = Arc::new(AtomicBool::new(false));
    let keep = Arc::new(AtomicU32::new(plan.keep));
    let (saves, jobs) = mpsc::channel();
    let (started, rx) = mpsc::channel();
    let shared = Shared {
        stop: stop.clone(),
        saving: saving.clone(),
        keep: keep.clone(),
        notify,
    };
    let thread = std::thread::spawn(move || run(plan, shared, jobs, started));
    match rx.recv_timeout(START_TIMEOUT) {
        Ok(Ok(info)) => Ok((
            Replay {
                stop,
                saves,
                saving,
                keep,
                thread,
            },
            info,
        )),
        Ok(Err(fail)) => Err(fail),
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            Err(Fail::code("replay_failed"))
        }
    }
}

struct Shared {
    stop: Arc<AtomicBool>,
    saving: Arc<AtomicBool>,
    keep: Arc<AtomicU32>,
    notify: Notify,
}

/// Moves a COM object to the helper thread. The device is created
/// multithread-protected (d3d::create_for_video) and Media Foundation's
/// writer is free-threaded; each object is used by one thread at a time.
struct Moved<T>(T);
unsafe impl<T> Send for Moved<T> {}

/// Which segments are closed: every id below `through`, or why one failed.
#[derive(Default)]
struct Closed {
    through: u64,
    failed: Option<&'static str>,
}
type ClosedState = Arc<(Mutex<Closed>, Condvar)>;

enum Job {
    Open(PathBuf),
    Close(Moved<Encoder>, u64),
}

/// The helper thread: opens the next segment's encoder ahead of time and
/// closes the finished one, in order.
struct Prep {
    jobs: Option<mpsc::Sender<Job>>,
    opened: mpsc::Receiver<windows::core::Result<Moved<Encoder>>>,
    closed: ClosedState,
    thread: Option<JoinHandle<()>>,
}

impl Prep {
    fn start(device: ID3D11Device, size: (u32, u32), fps: u32, bitrate: u32) -> Prep {
        let (jobs, rx) = mpsc::channel::<Job>();
        let (opened_tx, opened) = mpsc::channel();
        let closed: ClosedState = Arc::default();
        let state = closed.clone();
        let device = Moved(device);
        let thread = std::thread::spawn(move || {
            let device = device;
            unsafe {
                let _ = RoInitialize(RO_INIT_MULTITHREADED);
                let _ = MFStartup(MF_VERSION, MFSTARTUP_LITE);
            }
            for job in rx {
                match job {
                    Job::Open(path) => {
                        let path = path.to_string_lossy().into_owned();
                        let made =
                            Encoder::create(&device.0, &path, size, fps, bitrate, 0).map(Moved);
                        if opened_tx.send(made).is_err() {
                            break;
                        }
                    }
                    Job::Close(enc, id) => {
                        let result = enc.0.finish();
                        let (lock, cv) = &*state;
                        let mut c = lock.lock().unwrap_or_else(|p| p.into_inner());
                        if let Err(e) = result {
                            c.failed.get_or_insert(failure(&e));
                        }
                        c.through = c.through.max(id + 1);
                        cv.notify_all();
                    }
                }
            }
            unsafe {
                let _ = MFShutdown();
            }
        });
        Prep {
            jobs: Some(jobs),
            opened,
            closed,
            thread: Some(thread),
        }
    }

    fn send(&self, job: Job) {
        if let Some(j) = &self.jobs {
            let _ = j.send(job);
        }
    }

    fn failed(&self) -> Option<&'static str> {
        self.closed.0.lock().ok().and_then(|c| c.failed)
    }

    /// Waits for the jobs sent so far and ends the thread.
    fn end(mut self) {
        self.jobs = None;
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
