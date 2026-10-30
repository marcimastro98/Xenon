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

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use objc2::rc::autoreleasepool;
use objc2_core_media::CMSampleBuffer;
use serde_json::{json, Value};

use super::capture::Shared;
use super::ffi::{time_of_ticks, Sent};
use super::mic::Mic;
use super::replay_join::{self as join, Clip};
use super::replay_pcm::PcmRing;
use super::replay_plan as plan;
use super::sck::{self, Target};
use super::writer::{Shape, Writer};
use crate::audio::{self, Mixer, Packet};
use crate::proto::{Fail, Notify};
use crate::ring::{self, Ring, Segment};
use crate::video;

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

struct Tools {
    shared: Arc<Shared>,
    stream: sck::Stream,
    _mic: Option<Mic>,
    lanes: usize,
    pcm: PcmRing,
    prep: Prep,
    writer: Writer,
}

fn open(plan: &Plan) -> Result<(Tools, Opened), Fail> {
    let system = plan.sound && sck::sound_available();
    let shared = Shared::new(system);
    let mic = if plan.mic {
        let lane = usize::from(system);
        let s = shared.clone();
        Mic::start(Box::new(move |b: &CMSampleBuffer| s.push(lane, b)))
    } else {
        None
    };
    let lanes = usize::from(system) + usize::from(mic.is_some());
    let shape = Shape { width: plan.width, height: plan.height, fps: plan.fps, bitrate: plan.bitrate, tracks: 0 };
    let prep = Prep::start(shape);
    prep.send(Job::Open(plan.dir.join(ring::video_name(0))));
    let writer = prep.next()?;
    let spec = sck::Spec {
        target: plan.target,
        width: plan.width,
        height: plan.height,
        interval: time_of_ticks(video::TICKS_PER_SECOND / plan.fps.max(1) as i64),
        cursor: plan.cursor,
        sound: system,
    };
    let sink: sck::SinkRef = shared.clone();
    let stream = match sck::Stream::start(&spec, sink) {
        Ok(s) => s,
        Err(f) => {
            prep.send(Job::Cancel(Sent(writer)));
            prep.end();
            return Err(f);
        }
    };
    let pcm = PcmRing::new(&plan.dir, audio::tracks(lanes).len());
    let opened = Opened { sound: system, mic: mic.is_some() };
    Ok((Tools { shared, stream, _mic: mic, lanes, pcm, prep, writer }, opened))
}

fn run(plan: Plan, control: Control, jobs: mpsc::Receiver<SaveJob>, started: mpsc::Sender<Result<Opened, Fail>>) -> Value {
    clear(&plan.dir);
    let reason = match autoreleasepool(|_| open(&plan)) {
        Err(fail) => {
            let reason = fail.code;
            let _ = started.send(Err(fail));
            reason
        }
        Ok((tools, opened)) => {
            let first_by = Instant::now() + FIRST_WAIT;
            while tools.shared.picture().is_none() && Instant::now() < first_by {
                std::thread::sleep(Duration::from_millis(20));
            }
            if started.send(Ok(opened)).is_err() {
                // The start was given up on.
                control.stop.store(true, Ordering::SeqCst);
            }
            record(tools, &plan, &control, &jobs)
        }
    };
    clear(&plan.dir);
    if reason != "stopped" {
        (control.notify)(json!({ "event": "replay_ended", "reason": reason }));
    }
    json!({ "reason": reason })
}

/// The segment being written.
struct Current {
    id: u64,
    first: u64,
    frames: u64,
}

fn record(mut t: Tools, plan: &Plan, control: &Control, jobs: &mpsc::Receiver<SaveJob>) -> &'static str {
    let mut ring = Ring::new(control.keep.load(Ordering::SeqCst), plan.fps);
    let pinned = Arc::new(AtomicU64::new(u64::MAX));
    let mut saver: Option<JoinHandle<()>> = None;
    let mut cur = Current { id: 0, first: 0, frames: 0 };
    let mut pending: Option<SaveJob> = None;
    let mut mixer = Mixer::new(t.lanes, audio::tracks(t.lanes));
    t.pcm.begin(0, 0);
    t.prep.send(Job::Open(plan.dir.join(ring::video_name(1))));
    t.shared.start_clock();
    let start = Instant::now();
    let mut index = 0u64;
    let reason = loop {
        if control.stop.load(Ordering::SeqCst) {
            break "stopped";
        }
        if let Some(r) = t.prep.failed() {
            break r;
        }
        // The menu bar's stop, a display gone: the server hears it as an end.
        if t.shared.ended_code().is_some() {
            break "capture_failed";
        }
        if pending.is_none() {
            pending = jobs.try_recv().ok();
        }
        let due = start + Duration::from_nanos(video::frame_time(index, plan.fps) as u64 * 100);
        let now = Instant::now();
        if now < due {
            std::thread::sleep(due - now);
        } else {
            index = index.max(video::frame_index((now - start).as_nanos() as i64 / 100, plan.fps));
        }
        if plan::cut_due(index, cur.first, cur.frames, plan.fps, pending.is_some()) {
            ring.set_keep(control.keep.load(Ordering::SeqCst));
            let done = match rotate(&mut t, plan, &mut cur, index) {
                Ok(d) => d,
                Err(r) => break r,
            };
            for gone in ring.push(done, pinned.load(Ordering::SeqCst)) {
                delete(&plan.dir, gone.id, t.pcm.tracks());
            }
            if let Some(job) = pending.take() {
                if let Some(h) = saver.take() {
                    let _ = h.join();
                }
                saver = Some(spawn_save(&t, plan, control, &ring, &pinned, job));
            }
        } else if pending.is_some() && ring.len() == 0 && cur.frames == 0 {
            // Nothing recorded yet: say so instead of saving an empty clip.
            if let Some(job) = pending.take() {
                control.saving.store(false, Ordering::SeqCst);
                (control.notify)(plan::saved_event(&job.token, Err(("too_short", String::new()))));
            }
        }
        let step = autoreleasepool(|_| -> Result<(), &'static str> {
            if let Some(p) = t.shared.picture() {
                let at = video::frame_time(index - cur.first, plan.fps);
                if t.writer.picture(&p, at).map_err(|f| f.code)? {
                    cur.frames += 1;
                }
            }
            pump(&mut t, &mut mixer, start)
        });
        if let Err(r) = step {
            break r;
        }
        index += 1;
    };
    t.stream.stop();
    // A save in progress finishes before the ring is deleted.
    if let Some(h) = saver.take() {
        let _ = h.join();
    }
    let Tools { writer, prep, .. } = t;
    prep.send(Job::Cancel(Sent(writer)));
    prep.end();
    reason
}

/// What the sources handed in, placed and written to the PCM files.
fn pump(t: &mut Tools, mixer: &mut Mixer, start: Instant) -> Result<(), &'static str> {
    if t.lanes == 0 {
        return Ok(());
    }
    for p in t.shared.take_sound() {
        mixer.push(p);
    }
    let until = audio::frame_at(start.elapsed().as_nanos() as i64 / 100 - audio::LATENCY_TICKS);
    for lane in 0..t.lanes {
        mixer.push(Packet::Quiet { lane, until });
    }
    for piece in mixer.take() {
        t.pcm.put(piece.track, piece.at, &piece.samples)?;
    }
    Ok(())
}

/// Ends the segment being written at frame `index` and starts the next with
/// the writer opened ahead; the one after it starts opening.
fn rotate(t: &mut Tools, plan: &Plan, cur: &mut Current, index: u64) -> Result<Segment, &'static str> {
    let next = t.prep.next().map_err(|f| f.code)?;
    let old = std::mem::replace(&mut t.writer, next);
    let done = Segment { id: cur.id, first: cur.first, end: index };
    t.prep.send(Job::Close(Sent(old), done.id, plan::own_length(&done, plan.fps)));
    *cur = Current { id: cur.id + 1, first: index, frames: 0 };
    t.pcm.begin(cur.id, done.sound_span(plan.fps).1);
    t.prep.send(Job::Open(plan.dir.join(ring::video_name(cur.id + 1))));
    Ok(done)
}

/// Saves the newest segments on a thread of their own; they stay on disk
/// (pinned) until it is done.
fn spawn_save(t: &Tools, plan: &Plan, control: &Control, ring: &Ring, pinned: &Arc<AtomicU64>, job: SaveJob) -> JoinHandle<()> {
    let segs = ring.clip(job.seconds);
    pinned.store(segs.first().map_or(u64::MAX, |s| s.id), Ordering::SeqCst);
    let (dir, fps, tracks) = (plan.dir.clone(), plan.fps, t.pcm.tracks());
    let (written, closed) = (t.pcm.written(), t.prep.closed.clone());
    let (pinned, saving, notify) = (pinned.clone(), control.saving.clone(), control.notify.clone());
    std::thread::spawn(move || {
        let clip = Clip { dir: &dir, segs: &segs, fps, tracks };
        let result = autoreleasepool(|_| save(&clip, &written, &closed, &job.path));
        pinned.store(u64::MAX, Ordering::SeqCst);
        saving.store(false, Ordering::SeqCst);
        notify(plan::saved_event(&job.token, result));
    })
}

fn save(clip: &Clip, written: &[AtomicU64], closed: &ClosedState, path: &str) -> Result<(i64, u64), (&'static str, String)> {
    let last = clip.segs.last().ok_or(("too_short", String::new()))?;
    if !wait_closed(closed, last.id) {
        return Err(("save_failed", "segment not finished".into()));
    }
    let end = last.sound_span(clip.fps).1;
    let deadline = Instant::now() + SOUND_WAIT;
    while written.iter().any(|w| w.load(Ordering::SeqCst) < end) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let part = plan::part_path(path);
    let _ = std::fs::remove_file(&part);
    let ticks = join::save(clip, Path::new(&part)).map_err(|f| {
        let _ = std::fs::remove_file(&part);
        (f.code, f.detail)
    })?;
    crate::faststart::settle(Path::new(&part), Path::new(path))?;
    let bytes = std::fs::metadata(path).map_or(0, |m| m.len());
    Ok((ticks, bytes))
}

/// Deletes segment `id`: its video and its sound tracks.
fn delete(dir: &Path, id: u64, tracks: usize) {
    let _ = std::fs::remove_file(dir.join(ring::video_name(id)));
    for k in 0..tracks {
        let _ = std::fs::remove_file(dir.join(ring::sound_name(id, k)));
    }
}

/// Deletes every ring file in the folder (a replay that crashed leaves some);
/// nothing else in it is touched.
fn clear(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name();
        if name.to_str().is_some_and(ring::is_ring_file) && e.file_type().is_ok_and(|t| t.is_file()) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}
