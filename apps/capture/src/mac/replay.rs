//! Instant Replay on macOS, as on Windows (win/record/replay): a display is
//! recorded through ScreenCaptureKit for as long as the replay runs, into a
//! ring of short segments on disk (`crate::ring`), each written by an
//! AVAssetWriter of its own so it starts on a keyframe; the sound goes to PCM
//! files beside them (replay_pcm.rs). A save cuts the segment being written,
//! waits for it and its sound, and joins the newest segments into one MP4 on
//! a thread of its own (replay_join.rs), while the ring keeps recording.
//! Writers are opened one segment ahead and finished on a helper thread
//! (Prep), so a joint never makes the frame clock wait. Only ring files are
//! ever deleted, and the ring is deleted when the replay ends.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use objc2::rc::autoreleasepool;
use serde_json::{json, Value};

use super::ffi::Sent;
use super::sck::Target;
use super::writer::{Shape, Writer};
use crate::proto::{Fail, Notify};

mod running;
mod saving;

use running::run;

/// The setup (permission prompts included) before the start is answered;
/// under the server's own wait for the answer.
const START_WAIT: Duration = Duration::from_secs(18);
/// How long the first picture may take once the stream runs.
const FIRST_WAIT: Duration = Duration::from_secs(3);
/// How long a save waits for the last sound to arrive (it trails the
/// picture by the mixer's latency); silence fills what is still missing.
const SOUND_WAIT: Duration = Duration::from_millis(1500);
/// How long a save waits for the segment it cut to be finished.
const SEGMENT_WAIT: Duration = Duration::from_secs(10);

pub struct Plan {
    /// Always a display: a replay follows the screen, not one window.
    pub target: Target,
    /// The ring folder: only files named by `ring::is_ring_file` are touched.
    pub dir: PathBuf,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
    pub cursor: bool,
    pub sound: bool,
    pub mic: bool,
    pub keep: u32,
}

/// What opened: the answer's `sound` and `mic`.
pub struct Opened {
    pub sound: bool,
    pub mic: bool,
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
        self.saves.send(SaveJob { path, seconds, token }).map_err(|_| {
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
        self.thread.join().unwrap_or_else(|_| json!({ "reason": "crashed" }))
    }
}

struct Control {
    stop: Arc<AtomicBool>,
    saving: Arc<AtomicBool>,
    keep: Arc<AtomicU32>,
    notify: Notify,
}

pub fn start(plan: Plan, notify: Notify) -> Result<(Replay, Opened), Fail> {
    let stop = Arc::new(AtomicBool::new(false));
    let saving = Arc::new(AtomicBool::new(false));
    let keep = Arc::new(AtomicU32::new(plan.keep));
    let (saves, jobs) = mpsc::channel();
    let (started, rx) = mpsc::channel();
    let control = Control { stop: stop.clone(), saving: saving.clone(), keep: keep.clone(), notify };
    let thread = std::thread::spawn(move || run(plan, control, jobs, started));
    match rx.recv_timeout(START_WAIT) {
        Ok(Ok(opened)) => Ok((Replay { stop, saves, saving, keep, thread }, opened)),
        Ok(Err(fail)) => Err(fail),
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            Err(Fail::new("capture_failed", "start timed out"))
        }
    }
}

/// Which segments are finished: every id below `through`, or why one failed.
#[derive(Default)]
struct Closed {
    through: u64,
    failed: Option<&'static str>,
}
type ClosedState = Arc<(Mutex<Closed>, Condvar)>;

enum Job {
    Open(PathBuf),
    Close(Sent<Writer>, u64, i64),
    Cancel(Sent<Writer>),
}

/// The helper thread: opens the next segment's writer ahead of time and
/// finishes the full one, in order.
struct Prep {
    jobs: Option<mpsc::Sender<Job>>,
    opened: mpsc::Receiver<Result<Sent<Writer>, Fail>>,
    closed: ClosedState,
    thread: Option<JoinHandle<()>>,
}

impl Prep {
    fn start(shape: Shape) -> Prep {
        let (jobs, rx) = mpsc::channel::<Job>();
        let (opened_tx, opened) = mpsc::channel();
        let closed: ClosedState = Arc::default();
        let state = closed.clone();
        let thread = std::thread::spawn(move || {
            for job in rx {
                let sent = autoreleasepool(|_| match job {
                    Job::Open(path) => opened_tx.send(Writer::new(&path, &shape).map(Sent)).is_ok(),
                    Job::Close(writer, id, end) => {
                        let result = writer.0.finish(end);
                        let (lock, cv) = &*state;
                        let mut c = lock.lock().unwrap_or_else(|p| p.into_inner());
                        if let Err(f) = result {
                            c.failed.get_or_insert(f.code);
                        }
                        c.through = c.through.max(id + 1);
                        cv.notify_all();
                        true
                    }
                    Job::Cancel(writer) => {
                        writer.0.cancel();
                        true
                    }
                });
                if !sent {
                    break;
                }
            }
        });
        Prep { jobs: Some(jobs), opened, closed, thread: Some(thread) }
    }

    fn send(&self, job: Job) {
        if let Some(j) = &self.jobs {
            let _ = j.send(job);
        }
    }

    /// The writer opened ahead.
    fn next(&self) -> Result<Writer, Fail> {
        match self.opened.recv() {
            Ok(r) => r.map(|w| w.0),
            Err(_) => Err(Fail::code("encoder_failed")),
        }
    }

    fn failed(&self) -> Option<&'static str> {
        self.closed.0.lock().ok().and_then(|c| c.failed)
    }

    /// Waits for the jobs sent so far, drops a writer opened ahead and ends the thread.
    fn end(mut self) {
        self.jobs = None;
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        for w in self.opened.try_iter().flatten() {
            autoreleasepool(|_| w.0.cancel());
        }
    }
}

/// Waits until segment `id` is finished: false on a timeout or a failure.
fn wait_closed(closed: &ClosedState, id: u64) -> bool {
    let (lock, cv) = &**closed;
    let Ok(guard) = lock.lock() else { return false };
    let (c, _) = cv
        .wait_timeout_while(guard, SEGMENT_WAIT, |c| c.through <= id && c.failed.is_none())
        .unwrap_or_else(|p| p.into_inner());
    c.through > id && c.failed.is_none()
}
