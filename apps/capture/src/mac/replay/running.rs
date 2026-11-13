// macOS replay: the thread that keeps recording into short files.

use std::sync::{Arc, mpsc};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use objc2_core_media::CMSampleBuffer;
use objc2::rc::autoreleasepool;
use serde_json::{json, Value};
use crate::video;
use crate::audio::{self, Mixer, Packet};
use crate::proto::Fail;
use crate::ring::{self, Ring, Segment};
use super::{Control, FIRST_WAIT, Job, Opened, Plan, Prep, SaveJob};
use super::saving::{clear, delete, spawn_save};
use super::super::replay_plan as plan;
use super::super::capture::Shared;
use super::super::ffi::{Sent, time_of_ticks};
use super::super::mic::Mic;
use super::super::replay_pcm::PcmRing;
use super::super::sck::{self};
use super::super::writer::{Shape, Writer};

pub(super) struct Tools {
    shared: Arc<Shared>,
    stream: sck::Stream,
    _mic: Option<Mic>,
    lanes: usize,
    pub(super) pcm: PcmRing,
    pub(super) prep: Prep,
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

pub(super) fn run(plan: Plan, control: Control, jobs: mpsc::Receiver<SaveJob>, started: mpsc::Sender<Result<Opened, Fail>>) -> Value {
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
    pub(super) id: u64,
    pub(super) first: u64,
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
