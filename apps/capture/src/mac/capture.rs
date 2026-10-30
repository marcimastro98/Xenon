//! A recording through ScreenCaptureKit, the way Windows records
//! (win/record/mod.rs): a frame clock takes the latest picture N/fps seconds
//! after the start (every N seconds for a timelapse, played back at
//! `video::LAPSE_FPS`), the Mac's sound and the microphone go through the
//! shared mixer, and AVFoundation writes the MP4 next to its final name until
//! it is finished. With the webcam asked for, its bubble is drawn on a copy
//! of each frame before the writer (webcam.rs). The answers and the summary
//! are the Windows ones.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use objc2::rc::autoreleasepool;
use objc2_core_foundation::CFRetained;
use objc2_core_media::CMSampleBuffer;
use objc2_core_video::CVPixelBuffer;
use serde_json::{json, Value};

use super::ffi::{time_of_ticks as time, Sent};
use super::mic::Mic;
use super::sck::{self, Target};
use super::webcam::Bubble;
use super::writer::{Shape, Writer};
use super::media;
use crate::audio::{self, Mixer, Packet};
use crate::bubble::Corner;
use crate::proto::{Fail, Notify};
use crate::video;

/// The setup (permission prompts included) before the start is answered.
const START_WAIT: Duration = Duration::from_secs(90);
/// How long the first picture may take once the stream runs.
const FIRST_WAIT: Duration = Duration::from_secs(3);
const STOP_WAIT: Duration = Duration::from_secs(40);
const NOT_STARTED: i64 = i64::MIN;

pub struct Plan {
    pub target: Target,
    /// The encoded size (the stream is asked for pictures this size).
    pub width: u32,
    pub height: u32,
    /// The rate the file plays at: `video::LAPSE_FPS` for a timelapse.
    pub fps: u32,
    /// Some(seconds) for a timelapse: one picture that often.
    pub every: Option<u32>,
    pub bitrate: u32,
    pub cursor: bool,
    pub sound: bool,
    pub mic: bool,
    /// Some(corner): the webcam in a bubble there (never in a timelapse).
    pub webcam: Option<Corner>,
    pub path: String,
}

/// What opened: the answer's `sound`, `mic` and `camera`.
pub struct Opened {
    pub sound: bool,
    pub mic: bool,
    pub camera: bool,
}

pub struct Recording {
    stop: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    done: mpsc::Receiver<Value>,
}

impl Recording {
    pub fn active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    /// Ends it and answers the summary.
    pub fn stop(self) -> Value {
        self.stop.store(true, Ordering::SeqCst);
        self.done
            .recv_timeout(STOP_WAIT)
            .unwrap_or_else(|_| json!({ "reason": "capture_failed" }))
    }
}

/// What the stream and the microphone hand in, read by the frame clock
/// (Instant Replay's too: replay.rs).
pub(super) struct Shared {
    latest: Mutex<Option<Sent<CFRetained<CVPixelBuffer>>>>,
    sound: Mutex<Vec<Packet>>,
    /// The host time of the clock's start; NOT_STARTED until then.
    origin: AtomicI64,
    ended: Mutex<Option<isize>>,
    /// The Mac's sound is lane 0 when it is recorded.
    system: bool,
}

impl Shared {
    pub(super) fn new(system: bool) -> Arc<Shared> {
        Arc::new(Shared {
            latest: Mutex::new(None),
            sound: Mutex::new(Vec::new()),
            origin: AtomicI64::new(NOT_STARTED),
            ended: Mutex::new(None),
            system,
        })
    }

    /// The clock starts now: sound before this is dropped.
    pub(super) fn start_clock(&self) {
        self.origin.store(media::host_now(), Ordering::SeqCst);
    }

    /// The SCStreamErrorCode the stream ended with, once it did.
    pub(super) fn ended_code(&self) -> Option<isize> {
        self.ended.lock().ok().and_then(|e| *e)
    }

    /// The sound handed in since the last call.
    pub(super) fn take_sound(&self) -> Vec<Packet> {
        self.sound.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
    }

    pub(super) fn push(&self, lane: usize, buffer: &CMSampleBuffer) {
        let origin = self.origin.load(Ordering::SeqCst);
        if origin == NOT_STARTED {
            return;
        }
        if let Some((at, samples)) = media::sound_of(buffer) {
            let at = audio::frame_at(at - origin);
            if let Ok(mut q) = self.sound.lock() {
                q.push(Packet::Sound { lane, at, samples });
            }
        }
    }

    pub(super) fn picture(&self) -> Option<CFRetained<CVPixelBuffer>> {
        self.latest.lock().ok()?.as_ref().map(|p| p.0.clone())
    }
}

impl sck::Sink for Shared {
    fn picture(&self, picture: CFRetained<CVPixelBuffer>) {
        if let Ok(mut l) = self.latest.lock() {
            *l = Some(Sent(picture));
        }
    }
    fn sound(&self, buffer: &CMSampleBuffer) {
        if self.system {
            self.push(0, buffer);
        }
    }
    fn ended(&self, code: isize) {
        if let Ok(mut e) = self.ended.lock() {
            e.get_or_insert(code);
        }
    }
}

pub fn start(plan: Plan, notify: Notify) -> Result<(Recording, Opened), Fail> {
    let stop = Arc::new(AtomicBool::new(false));
    let active = Arc::new(AtomicBool::new(true));
    let (ready_tx, ready_rx) = mpsc::channel();
    let (done_tx, done) = mpsc::channel();
    let (s, a) = (stop.clone(), active.clone());
    std::thread::spawn(move || {
        let (summary, pressed) = run(&plan, &s, &ready_tx);
        a.store(false, Ordering::SeqCst);
        let Some(summary) = summary else { return };
        let reason = summary["reason"].as_str().unwrap_or("");
        // As on Windows: a stop the server asked for needs no event; one from
        // the system (the menu bar's stop, a closed window) does.
        if !matches!(reason, "stopped" | "") || pressed {
            let mut event = json!({ "event": "record_ended" });
            if let (Some(e), Some(s)) = (event.as_object_mut(), summary.as_object()) {
                e.extend(s.clone());
            }
            notify(event);
        }
        let _ = done_tx.send(summary);
    });
    let opened = ready_rx
        .recv_timeout(START_WAIT)
        .unwrap_or_else(|_| Err(Fail::new("capture_failed", "start timed out")));
    match opened {
        Ok(o) => Ok((Recording { stop, active, done }, o)),
        Err(f) => {
            stop.store(true, Ordering::SeqCst);
            Err(f)
        }
    }
}

struct Tools {
    shared: Arc<Shared>,
    writer: Writer,
    stream: sck::Stream,
    _mic: Option<Mic>,
    /// None when no webcam was asked for, or none could be opened.
    bubble: Option<Bubble>,
    lanes: usize,
    part: PathBuf,
}

/// Opens everything; the part file is removed when something fails.
fn open(plan: &Plan) -> Result<(Tools, Opened), Fail> {
    let lapse = plan.every.is_some();
    let system = plan.sound && !lapse && sck::sound_available();
    let shared = Shared::new(system);
    let mic = if plan.mic && !lapse {
        let lane = usize::from(system);
        let s = shared.clone();
        Mic::start(Box::new(move |b: &CMSampleBuffer| s.push(lane, b)))
    } else {
        None
    };
    let lanes = usize::from(system) + usize::from(mic.is_some());
    let part = PathBuf::from(format!("{}.part.mp4", plan.path));
    let _ = std::fs::remove_file(&part);
    let shape = Shape {
        width: plan.width,
        height: plan.height,
        fps: plan.fps,
        bitrate: plan.bitrate,
        tracks: audio::tracks(lanes).len(),
    };
    let writer = Writer::new(&part, &shape).inspect_err(|_| {
        let _ = std::fs::remove_file(&part);
    })?;
    // A timelapse needs a picture every N seconds; asking for fewer saves work.
    let interval = match plan.every {
        Some(s) => time(s as i64 * video::TICKS_PER_SECOND / 2),
        None => time(video::TICKS_PER_SECOND / plan.fps.max(1) as i64),
    };
    let spec = sck::Spec {
        target: plan.target,
        width: plan.width,
        height: plan.height,
        interval,
        cursor: plan.cursor,
        sound: system,
    };
    // No camera, or one another app holds: the recording goes on without it.
    let bubble = plan.webcam.filter(|_| !lapse).and_then(Bubble::open);
    let sink: sck::SinkRef = shared.clone();
    let stream = sck::Stream::start(&spec, sink).inspect_err(|_| {
        let _ = std::fs::remove_file(&part);
    })?;
    let opened = Opened {
        sound: system,
        mic: mic.is_some(),
        camera: bubble.is_some(),
    };
    Ok((
        Tools { shared, writer, stream, _mic: mic, bubble, lanes, part },
        opened,
    ))
}

#[derive(Default)]
struct Counts {
    frames: u64,
    dropped: u64,
    end: u64,
}

/// The whole recording on its own thread: the summary (None when it never
/// started) and whether the system's stop ended it.
fn run(plan: &Plan, stop: &AtomicBool, ready: &mpsc::Sender<Result<Opened, Fail>>) -> (Option<Value>, bool) {
    let opened = autoreleasepool(|_| open(plan));
    let (mut t, opened) = match opened {
        Ok(o) => o,
        Err(f) => {
            let _ = ready.send(Err(f));
            return (None, false);
        }
    };
    let first_by = Instant::now() + FIRST_WAIT;
    while t.shared.picture().is_none() && Instant::now() < first_by && !stop.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(20));
    }
    let start = Instant::now();
    t.shared.start_clock();
    if ready.send(Ok(opened)).is_err() {
        // The start was given up on: nothing is kept.
        t.stream.stop();
        let _ = std::fs::remove_file(&t.part);
        return (None, false);
    }
    let mut mixer = Mixer::new(t.lanes, audio::tracks(t.lanes));
    let mut counts = Counts::default();
    let (reason, pressed) = clock(&mut t, plan, stop, start, &mut mixer, &mut counts);
    t.stream.stop();
    // The camera's light goes off with the recording, before the file is finished.
    t.bubble = None;
    let end_ticks = video::frame_time(counts.end, plan.fps);
    let summary = finish(t, &mut mixer, plan, reason, &counts, end_ticks);
    let mut summary = summary;
    if let (Some(_), Some(o)) = (plan.every, summary.as_object_mut()) {
        o.insert("span".into(), json!(start.elapsed().as_secs()));
    }
    (Some(summary), pressed)
}

/// The frame clock: frame N is due N/fps seconds after the start (N * every
/// for a timelapse); a tick that comes late skips to the frame of the moment.
fn clock(
    t: &mut Tools,
    plan: &Plan,
    stop: &AtomicBool,
    start: Instant,
    mixer: &mut Mixer,
    counts: &mut Counts,
) -> (&'static str, bool) {
    let mut index = 0u64;
    loop {
        if stop.load(Ordering::SeqCst) {
            return ("stopped", false);
        }
        if let Some(code) = t.shared.ended_code() {
            return match (code, plan.target) {
                (sck::ERROR_USER_STOPPED, _) => ("stopped", true),
                (_, Target::Window(_)) => ("window_closed", false),
                _ => ("capture_failed", false),
            };
        }
        let due = start + Duration::from_nanos(video::shot_time(index, plan.fps, plan.every) as u64 * 100);
        let now = Instant::now();
        if now < due {
            std::thread::sleep(due - now);
        } else {
            let ticks = (now - start).as_nanos() as i64 / 100;
            let current = video::shot_index(ticks, plan.fps, plan.every);
            if current > index {
                counts.dropped += current - index;
                index = current;
            }
        }
        let step = autoreleasepool(|_| -> Result<(), Fail> {
            let picture = match (t.shared.picture(), t.bubble.as_mut()) {
                (Some(p), Some(b)) => Some(b.over(p)),
                (p, _) => p,
            };
            match picture {
                Some(p) if t.writer.picture(&p, video::frame_time(index, plan.fps))? => {
                    counts.frames += 1;
                    counts.end = index + 1;
                }
                _ => counts.dropped += 1,
            }
            pump(t, mixer, start)
        });
        if let Err(f) = step {
            return (f.code, false);
        }
        index += 1;
    }
}

/// What the sources handed in, placed and written; silence up to the latency
/// for a source that said nothing.
fn pump(t: &Tools, mixer: &mut Mixer, start: Instant) -> Result<(), Fail> {
    if t.lanes == 0 {
        return Ok(());
    }
    for p in t.shared.take_sound() {
        mixer.push(p);
    }
    let now = start.elapsed().as_nanos() as i64 / 100;
    let until = audio::frame_at(now - audio::LATENCY_TICKS);
    for lane in 0..t.lanes {
        mixer.push(Packet::Quiet { lane, until });
    }
    write(&t.writer, mixer.take())
}

fn write(writer: &Writer, pieces: Vec<audio::Piece>) -> Result<(), Fail> {
    for p in pieces {
        writer.sound(p.track, p.at, &p.samples)?;
    }
    Ok(())
}

fn finish(t: Tools, mixer: &mut Mixer, plan: &Plan, reason: &'static str, counts: &Counts, end_ticks: i64) -> Value {
    let Tools { shared, writer, part, lanes, .. } = t;
    let tail = if lanes > 0 {
        for p in shared.take_sound() {
            mixer.push(p);
        }
        write(&writer, mixer.finish(audio::frame_at(end_ticks).max(0) as u64))
    } else {
        Ok(())
    };
    let finished = autoreleasepool(|_| tail.and_then(|()| writer.finish(end_ticks)));
    // With no frame the writer has nothing to finish: that is "too short",
    // which the server tells from `frames`, not a failure.
    let mut reason = match finished {
        Err(f) if reason == "stopped" && counts.frames > 0 => f.code,
        _ => reason,
    };
    let bytes = if counts.frames == 0 {
        // Nothing to watch: no empty file left behind.
        let _ = std::fs::remove_file(&part);
        0
    } else {
        match crate::faststart::settle(&part, Path::new(&plan.path)) {
            Ok(()) => std::fs::metadata(&plan.path).map_or(0, |m| m.len()),
            Err((code, _)) => {
                reason = code;
                0
            }
        }
    };
    json!({
        "reason": reason,
        "seconds": end_ticks as f64 / video::TICKS_PER_SECOND as f64,
        "frames": counts.frames, "dropped": counts.dropped, "bytes": bytes,
    })
}
