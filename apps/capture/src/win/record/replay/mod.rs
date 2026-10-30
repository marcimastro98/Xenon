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

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows::Win32::Graphics::Direct3D11::ID3D11Device;
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::Media::MediaFoundation::{MFShutdown, MFStartup, MFSTARTUP_LITE, MF_VERSION};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use super::super::d3d;
use super::super::grab::Target;
use super::encoder::Encoder;
use super::painter::Painter;
use super::sound::{Sound, Wanted};
use super::source::Source;
use super::{draw, failure, Aim, START_TIMEOUT};
use crate::proto::{Fail, Notify};
use crate::ring::{self, Ring, Segment};
use crate::{audio, video};

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

/// Waits until segment `id` is closed: false on a timeout or a failed close.
fn wait_closed(closed: &ClosedState, id: u64) -> bool {
    let (lock, cv) = &**closed;
    let Ok(guard) = lock.lock() else { return false };
    let (c, _) = cv
        .wait_timeout_while(guard, SEGMENT_WAIT, |c| {
            c.through <= id && c.failed.is_none()
        })
        .unwrap_or_else(|p| p.into_inner());
    c.through > id && c.failed.is_none()
}

struct Tools {
    dev: d3d::Device,
    source: Source,
    painter: Painter,
    sound: Sound,
    pcm: pcm::PcmRing,
    prep: Prep,
    encoder: Encoder,
    size: (u32, u32),
    bitrate: u32,
}

fn open(plan: &Plan) -> Result<Tools, Fail> {
    let dev = d3d::create_for_video().map_err(|e| Fail::new("no_encoder", e))?;
    let target = Target::Monitor(HMONITOR(plan.monitor as *mut core::ffi::c_void));
    let source = Source::open(&dev, target, plan.hdr_white.is_some(), plan.room)
        .map_err(|e| Fail::new("capture_failed", e))?;
    let (w, h) = source.size();
    let size = video::encode_size(w, h, plan.height);
    let bitrate = video::bitrate(size.0, size.1, plan.fps, plan.quality);
    let sound = Sound::open(&Aim::Monitor(plan.monitor), plan.audio);
    let pcm = pcm::PcmRing::new(&plan.dir, sound.tracks());
    let prep = Prep::start(dev.d3d.clone(), size, plan.fps, bitrate);
    prep.send(Job::Open(plan.dir.join(ring::video_name(0))));
    let encoder = match prep.opened.recv() {
        Ok(Ok(e)) => e.0,
        Ok(Err(e)) => return Err(Fail::new(failure(&e), e)),
        Err(_) => return Err(Fail::code("encoder_failed")),
    };
    let painter = Painter::new(&dev.d3d).map_err(|e| Fail::new("no_encoder", e))?;
    Ok(Tools {
        dev,
        source,
        painter,
        sound,
        pcm,
        prep,
        encoder,
        size,
        bitrate,
    })
}

fn run(
    plan: Plan,
    shared: Shared,
    jobs: mpsc::Receiver<SaveJob>,
    started: mpsc::Sender<Result<Value, Fail>>,
) -> Value {
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
        if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_LITE) {
            let _ = started.send(Err(Fail::new("no_encoder", e)));
            return json!({ "reason": "no_encoder" });
        }
    }
    clear(&plan.dir);
    let summary = match open(&plan) {
        Err(fail) => {
            let reason = fail.code;
            let _ = started.send(Err(fail));
            json!({ "reason": reason })
        }
        Ok(tools) => {
            let mut info = json!({
                "width": tools.size.0, "height": tools.size.1, "fps": plan.fps,
                "hdr": plan.hdr_white.is_some(), "bitrate": tools.bitrate,
            });
            if let (Some(o), Some(s)) = (info.as_object_mut(), tools.sound.info().as_object()) {
                o.extend(s.clone());
            }
            if started.send(Ok(info)).is_err() {
                shared.stop.store(true, Ordering::SeqCst);
            }
            record(tools, &plan, &shared, &jobs)
        }
    };
    clear(&plan.dir);
    unsafe {
        let _ = MFShutdown();
    }
    let reason = summary["reason"].as_str().unwrap_or("");
    if reason != "stopped" {
        (shared.notify)(json!({ "event": "replay_ended", "reason": reason }));
    }
    summary
}

/// The segment being written.
struct Current {
    id: u64,
    first: u64,
    frames: u64,
}

fn record(mut t: Tools, plan: &Plan, shared: &Shared, jobs: &mpsc::Receiver<SaveJob>) -> Value {
    let seg_frames = (ring::SEGMENT_SECONDS * plan.fps) as u64;
    let mut ring = Ring::new(shared.keep.load(Ordering::SeqCst), plan.fps);
    let pinned = Arc::new(AtomicU64::new(u64::MAX));
    let mut saver: Option<JoinHandle<()>> = None;
    let mut cur = Current {
        id: 0,
        first: 0,
        frames: 0,
    };
    let mut pending: Option<SaveJob> = None;
    t.pcm.begin(0, 0);
    t.prep.send(Job::Open(plan.dir.join(ring::video_name(1))));
    let start = Instant::now();
    t.sound.begin();
    let mut index = 0u64;
    let reason = loop {
        if shared.stop.load(Ordering::SeqCst) {
            break "stopped";
        }
        if let Some(r) = t.prep.failed() {
            break r;
        }
        if pending.is_none() {
            pending = jobs.try_recv().ok();
        }
        let due = start + Duration::from_nanos(video::frame_time(index, plan.fps) as u64 * 100);
        let now = Instant::now();
        if now < due {
            std::thread::sleep(due - now);
        } else {
            let ticks = (now - start).as_nanos() as i64 / 100;
            index = index.max(video::frame_index(ticks, plan.fps));
        }
        let full = index >= cur.first + seg_frames;
        if (full || pending.is_some()) && cur.frames > 0 {
            ring.set_keep(shared.keep.load(Ordering::SeqCst));
            let done = match rotate(&mut t, plan, &mut cur, index) {
                Ok(d) => d,
                Err(r) => break r,
            };
            for gone in ring.push(done, pinned.load(Ordering::SeqCst)) {
                delete(&plan.dir, gone.id, t.pcm_tracks());
            }
            if let Some(job) = pending.take() {
                if let Some(h) = saver.take() {
                    let _ = h.join();
                }
                saver = Some(spawn_save(&t, plan, shared, &ring, &pinned, job));
            }
        } else if pending.is_some() && ring.len() == 0 {
            // Nothing recorded yet: say so instead of saving an empty clip.
            let job = pending.take().unwrap();
            shared.saving.store(false, Ordering::SeqCst);
            (shared.notify)(
                json!({ "event": "replay_saved", "token": job.token, "ok": false, "error": "too_short" }),
            );
        }
        if t.source.refresh(&t.dev).is_err() {
            break "capture_failed";
        }
        match t.encoder.frame() {
            Ok(Some(frame)) => {
                draw(
                    &t.dev,
                    &t.painter,
                    &t.source,
                    t.size,
                    plan.hdr_white,
                    &frame,
                );
                if let Err(e) = t.encoder.write(frame, index - cur.first) {
                    break failure(&e);
                }
                cur.frames += 1;
            }
            Ok(None) => {}
            Err(e) => break failure(&e),
        }
        if let Err(e) = t.sound.pump(&t.pcm) {
            break failure(&e);
        }
        index += 1;
    };
    // A save in progress finishes before the ring is deleted.
    if let Some(h) = saver.take() {
        let _ = h.join();
    }
    let end = audio::frame_at(video::frame_time(index, plan.fps)).max(0) as u64;
    let _ = t.sound.end(&t.pcm, audio::ticks_at(end));
    let _ = t.encoder.finish();
    t.prep.end();
    json!({ "reason": reason })
}

impl Tools {
    fn pcm_tracks(&self) -> usize {
        self.sound.tracks()
    }
}

/// Ends the segment being written at frame `index` and starts the next with
/// the encoder opened ahead; the next one after it starts opening.
fn rotate(
    t: &mut Tools,
    plan: &Plan,
    cur: &mut Current,
    index: u64,
) -> Result<Segment, &'static str> {
    let next = match t.prep.opened.recv() {
        Ok(Ok(e)) => e.0,
        Ok(Err(e)) => return Err(failure(&e)),
        Err(_) => return Err("encoder_failed"),
    };
    let old = std::mem::replace(&mut t.encoder, next);
    let done = Segment {
        id: cur.id,
        first: cur.first,
        end: index,
    };
    t.prep.send(Job::Close(Moved(old), done.id));
    *cur = Current {
        id: cur.id + 1,
        first: index,
        frames: 0,
    };
    t.pcm.begin(cur.id, done.sound_span(plan.fps).1);
    t.prep
        .send(Job::Open(plan.dir.join(ring::video_name(cur.id + 1))));
    Ok(done)
}

/// Saves the newest segments on a thread of their own; they stay on disk
/// (pinned) until it is done.
fn spawn_save(
    t: &Tools,
    plan: &Plan,
    shared: &Shared,
    ring: &Ring,
    pinned: &Arc<AtomicU64>,
    job: SaveJob,
) -> JoinHandle<()> {
    let segs = ring.clip(job.seconds);
    pinned.store(segs.first().map_or(u64::MAX, |s| s.id), Ordering::SeqCst);
    let dir = plan.dir.clone();
    let fps = plan.fps;
    let tracks = t.pcm_tracks();
    let written = t.pcm.written();
    let closed = t.prep.closed.clone();
    let pinned = pinned.clone();
    let saving = shared.saving.clone();
    let notify = shared.notify.clone();
    std::thread::spawn(move || {
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
            let _ = MFStartup(MF_VERSION, MFSTARTUP_LITE);
        }
        let result = save(&dir, &segs, fps, tracks, &written, &closed, &job.path);
        unsafe {
            let _ = MFShutdown();
        }
        pinned.store(u64::MAX, Ordering::SeqCst);
        saving.store(false, Ordering::SeqCst);
        let mut event = json!({ "event": "replay_saved", "token": job.token });
        if let Some(o) = event.as_object_mut() {
            match result {
                Ok((ticks, bytes)) => {
                    o.insert("ok".into(), json!(true));
                    o.insert(
                        "seconds".into(),
                        json!(ticks as f64 / video::TICKS_PER_SECOND as f64),
                    );
                    o.insert("bytes".into(), json!(bytes));
                }
                Err((code, detail)) => {
                    o.insert("ok".into(), json!(false));
                    o.insert("error".into(), json!(code));
                    // For the server log, like a reply's `detail`.
                    o.insert("detail".into(), json!(detail));
                }
            }
        }
        notify(event);
    })
}

fn save(
    dir: &Path,
    segs: &[Segment],
    fps: u32,
    tracks: usize,
    written: &[AtomicU64],
    closed: &ClosedState,
    path: &str,
) -> Result<(i64, u64), (&'static str, String)> {
    let last = segs.last().ok_or(("too_short", String::new()))?;
    if !wait_closed(closed, last.id) {
        return Err(("save_failed", "segment not closed".into()));
    }
    let end = last.sound_span(fps).1;
    let deadline = Instant::now() + SOUND_WAIT;
    while written.iter().any(|w| w.load(Ordering::SeqCst) < end) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let part = format!("{path}.part");
    let clip = remux::Clip {
        dir,
        segs,
        fps,
        tracks,
    };
    let ticks = remux::save(&clip, &part).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        (failure(&e), format!("{:#010x} {}", e.code().0, e.message()))
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
        if name.to_str().is_some_and(ring::is_ring_file) && e.file_type().is_ok_and(|t| t.is_file())
        {
            let _ = std::fs::remove_file(e.path());
        }
    }
}
