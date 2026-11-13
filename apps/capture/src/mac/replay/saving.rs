// macOS replay: joining the newest short files into the saved clip, and clearing them.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use objc2::rc::autoreleasepool;
use crate::ring::{self, Ring};
use super::{ClosedState, Control, Plan, SaveJob, SOUND_WAIT, wait_closed};
use super::running::Tools;
use super::super::replay_plan as plan;
use super::super::replay_join::{Clip, self as join};

/// Saves the newest segments on a thread of their own; they stay on disk
/// (pinned) until it is done.
pub(super) fn spawn_save(t: &Tools, plan: &Plan, control: &Control, ring: &Ring, pinned: &Arc<AtomicU64>, job: SaveJob) -> JoinHandle<()> {
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
        if name.to_str().is_some_and(ring::is_ring_file) && e.file_type().is_ok_and(|t| t.is_file()) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}
