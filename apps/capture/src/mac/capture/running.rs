// macOS recording: the thread that captures, encodes and finishes one recording.

use std::path::{Path, PathBuf};
use std::sync::{Arc, mpsc};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use objc2_core_media::CMSampleBuffer;
use objc2::rc::autoreleasepool;
use serde_json::{json, Value};
use crate::video;
use crate::audio::{self, Mixer, Packet};
use crate::proto::Fail;
use super::{FIRST_WAIT, Opened, Plan, Shared};
use super::super::ffi::time_of_ticks as time;
use super::super::mic::Mic;
use super::super::sck::{self, Target};
use super::super::webcam::Bubble;
use super::super::writer::{Shape, Writer};

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
pub(super) fn run(plan: &Plan, stop: &AtomicBool, ready: &mpsc::Sender<Result<Opened, Fail>>) -> (Option<Value>, bool) {
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
