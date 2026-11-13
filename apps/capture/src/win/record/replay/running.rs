// Windows replay: the thread that keeps recording into short files.

use std::sync::{Arc, mpsc};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::Media::MediaFoundation::{MF_VERSION, MFShutdown, MFStartup, MFSTARTUP_LITE};
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
use crate::{audio, video};
use crate::proto::Fail;
use crate::ring::{self, Ring};
use super::{ClosedState, Job, pcm, Plan, Prep, SaveJob, SEGMENT_WAIT, Shared};
use super::saving::{clear, delete, rotate, spawn_save};
use super::super::{Aim, draw, failure};
use super::super::encoder::Encoder;
use super::super::painter::Painter;
use super::super::sound::Sound;
use super::super::source::Source;
use super::super::super::d3d;
use super::super::super::grab::Target;

/// Waits until segment `id` is closed: false on a timeout or a failed close.
pub(super) fn wait_closed(closed: &ClosedState, id: u64) -> bool {
    let (lock, cv) = &**closed;
    let Ok(guard) = lock.lock() else { return false };
    let (c, _) = cv
        .wait_timeout_while(guard, SEGMENT_WAIT, |c| {
            c.through <= id && c.failed.is_none()
        })
        .unwrap_or_else(|p| p.into_inner());
    c.through > id && c.failed.is_none()
}

pub(super) struct Tools {
    dev: d3d::Device,
    source: Source,
    painter: Painter,
    sound: Sound,
    pub(super) pcm: pcm::PcmRing,
    pub(super) prep: Prep,
    pub(super) encoder: Encoder,
    pub(super) size: (u32, u32),
    pub(super) bitrate: u32,
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

pub(super) fn run(
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
pub(super) struct Current {
    pub(super) id: u64,
    pub(super) first: u64,
    pub(super) frames: u64,
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
    pub(super) fn pcm_tracks(&self) -> usize {
        self.sound.tracks()
    }
}
