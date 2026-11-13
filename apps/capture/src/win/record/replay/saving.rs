// Windows replay: keeping only the newest short files, and joining them into the saved clip.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use serde_json::json;
use windows::Win32::Media::MediaFoundation::{MF_VERSION, MFShutdown, MFStartup, MFSTARTUP_LITE};
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
use crate::video;
use crate::ring::{self, Ring, Segment};
use super::{ClosedState, Job, Moved, Plan, remux, SaveJob, Shared, SOUND_WAIT};
use super::running::{Current, Tools, wait_closed};
use super::super::failure;

/// Ends the segment being written at frame `index` and starts the next with
/// the encoder opened ahead; the next one after it starts opening.
pub(super) fn rotate(
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
pub(super) fn spawn_save(
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
pub(super) fn delete(dir: &Path, id: u64, tracks: usize) {
    let _ = std::fs::remove_file(dir.join(ring::video_name(id)));
    for k in 0..tracks {
        let _ = std::fs::remove_file(dir.join(ring::sound_name(id, k)));
    }
}

/// Deletes every ring file in the folder (a replay that crashed leaves some);
/// nothing else in it is touched.
pub(super) fn clear(dir: &Path) {
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
