//! Instant Replay on Linux (as win/record/replay): the screen is recorded for
//! as long as the replay runs, cut by ffmpeg's segment muxer into short
//! MPEG-TS files in the ring folder, and the oldest are deleted as new ones
//! arrive. A save joins the newest segments into one MP4 without decoding,
//! while the ring goes on.
//!
//! On X11 one ffmpeg (x11grab) writes the ring itself; on the wlroots
//! compositors wf-recorder streams MPEG-TS into an ffmpeg that cuts it. Either
//! way ffmpeg prints each finished segment on its output, and that list is the
//! ring's only source: nothing else in the folder is read.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::replay_plan as plan;
use super::run;
use crate::proto::{Fail, Notify};
use crate::ring::{self, Ring, Segment};

/// A recorder that ends this soon after starting failed to start.
const START_GRACE: Duration = Duration::from_millis(900);
/// After the stop request, before the recorders are killed.
const STOP_GRACE: Duration = Duration::from_secs(6);
/// A save waits for the segment being written to finish (one segment is
/// ~2 s), so the clip ends at the moment it was asked for, not before.
const SAVE_WAIT: Duration = Duration::from_secs(10);
/// Joining copies the data: an hour of video takes a while on a slow disk.
const JOIN_DEADLINE: Duration = Duration::from_secs(600);
const POLL: Duration = Duration::from_millis(100);

/// What records the screen.
pub enum Source {
    /// ffmpeg's x11grab, writing the ring itself.
    Ffmpeg { program: String, args: Vec<String> },
    /// wf-recorder streaming into ffmpeg; it stops on an interrupt.
    Wf {
        program: String,
        args: Vec<String>,
        kill: String,
    },
}

pub struct Plan {
    pub dir: PathBuf,
    pub keep: u32,
    pub ffmpeg: String,
    pub source: Source,
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

/// The recorders of a running replay.
struct Recorders {
    /// The ffmpeg that writes the ring (and prints its list).
    cutter: Child,
    /// wf-recorder, feeding the cutter, and the `kill` that stops it.
    feeder: Option<(Child, String)>,
}

impl Recorders {
    fn spawn(plan: &Plan, dir: &str) -> Result<(Recorders, ChildStdout), Fail> {
        let fail = |e: std::io::Error| Fail::new("replay_failed", e);
        let (mut cutter, feeder) = match &plan.source {
            Source::Ffmpeg { program, args } => {
                let args = plan::ring_from_record(args.clone(), dir).ok_or(Fail::code("replay_failed"))?;
                let child = Command::new(program)
                    .args(&args)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(fail)?;
                (child, None)
            }
            Source::Wf {
                program,
                args,
                kill,
            } => {
                let mut wf = Command::new(program)
                    .args(args)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(fail)?;
                let Some(stream) = wf.stdout.take() else {
                    let _ = wf.kill();
                    let _ = wf.wait();
                    return Err(Fail::code("replay_failed"));
                };
                let cutter = Command::new(&plan.ffmpeg)
                    .args(plan::ring_from_stream(dir))
                    .stdin(Stdio::from(stream))
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn();
                match cutter {
                    Ok(c) => (c, Some((wf, kill.clone()))),
                    Err(e) => {
                        let _ = wf.kill();
                        let _ = wf.wait();
                        return Err(fail(e));
                    }
                }
            }
        };
        let list = cutter.stdout.take();
        let mut rec = Recorders { cutter, feeder };
        std::thread::sleep(START_GRACE);
        match list {
            Some(list) if rec.alive() => Ok((rec, list)),
            _ => {
                rec.end();
                Err(Fail::new("replay_failed", "recorder ended at once"))
            }
        }
    }

    fn alive(&mut self) -> bool {
        let up = |c: &mut Child| matches!(c.try_wait(), Ok(None));
        up(&mut self.cutter) && self.feeder.as_mut().is_none_or(|(f, _)| up(f))
    }

    /// Asks them to finish (wf-recorder first: the cutter then sees the end of
    /// its input), and kills what is still running after the grace.
    fn end(&mut self) {
        match self.feeder.as_mut() {
            Some((wf, kill)) => {
                let pid = wf.id().to_string();
                let _ = run::run(kill, &["-INT".into(), pid], None, Duration::from_secs(4));
            }
            None => {
                if let Some(mut input) = self.cutter.stdin.take() {
                    let _ = input.write_all(b"q");
                }
            }
        }
        let deadline = Instant::now() + STOP_GRACE;
        let mut children: Vec<&mut Child> = vec![&mut self.cutter];
        if let Some((wf, _)) = self.feeder.as_mut() {
            children.push(wf);
        }
        for c in children {
            while matches!(c.try_wait(), Ok(None)) && Instant::now() < deadline {
                std::thread::sleep(POLL);
            }
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

pub fn start(plan: Plan, notify: Notify) -> Result<Replay, Fail> {
    std::fs::create_dir_all(&plan.dir).map_err(|e| Fail::new("write_failed", e))?;
    clear(&plan.dir);
    let dir = plan.dir.to_string_lossy().into_owned();
    let (recorders, list) = Recorders::spawn(&plan, &dir).inspect_err(|_| clear(&plan.dir))?;
    let (segs_tx, segs) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(list).lines().map_while(Result::ok) {
            if let Some(seg) = plan::parse_list_line(&line) {
                if segs_tx.send(seg).is_err() {
                    break;
                }
            }
        }
    });
    let stop = Arc::new(AtomicBool::new(false));
    let saving = Arc::new(AtomicBool::new(false));
    let keep = Arc::new(AtomicU32::new(plan.keep));
    let (saves, jobs) = mpsc::channel();
    let looper = Looper {
        ring: Ring::new(plan.keep, plan::CLOCK),
        dir: plan.dir,
        ffmpeg: plan.ffmpeg,
        stop: stop.clone(),
        saving: saving.clone(),
        keep: keep.clone(),
        pinned: Arc::new(AtomicU64::new(u64::MAX)),
        notify,
    };
    let thread = std::thread::spawn(move || looper.run(recorders, segs, jobs));
    Ok(Replay {
        stop,
        saves,
        saving,
        keep,
        thread,
    })
}

struct Looper {
    ring: Ring,
    dir: PathBuf,
    ffmpeg: String,
    stop: Arc<AtomicBool>,
    saving: Arc<AtomicBool>,
    keep: Arc<AtomicU32>,
    /// The first segment of the save being written: it and the ones after stay.
    pinned: Arc<AtomicU64>,
    notify: Notify,
}

impl Looper {
    fn run(
        mut self,
        mut recorders: Recorders,
        segs: mpsc::Receiver<Segment>,
        jobs: mpsc::Receiver<SaveJob>,
    ) -> Value {
        let mut arrived = 0u64;
        let mut pending: Option<(SaveJob, u64, Instant)> = None;
        let mut writer: Option<JoinHandle<()>> = None;
        let reason = loop {
            match segs.recv_timeout(POLL) {
                Ok(seg) => {
                    arrived += 1;
                    self.ring.set_keep(self.keep.load(Ordering::SeqCst));
                    for gone in self.ring.push(seg, self.pinned.load(Ordering::SeqCst)) {
                        let _ = std::fs::remove_file(self.dir.join(ring::ts_name(gone.id)));
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                // The cutter ended by itself: the display or the disk went away.
                Err(mpsc::RecvTimeoutError::Disconnected) => break "capture_failed",
            }
            if pending.is_none() {
                if let Ok(job) = jobs.try_recv() {
                    pending = Some((job, arrived, Instant::now()));
                }
            }
            let stopping = self.stop.load(Ordering::SeqCst);
            let due = pending
                .as_ref()
                .is_some_and(|(_, at, since)| stopping || arrived > *at || since.elapsed() > SAVE_WAIT);
            if due {
                if let Some((job, _, _)) = pending.take() {
                    writer = self.begin_save(job).or(writer);
                }
            }
            if stopping {
                break "stopped";
            }
        };
        recorders.end();
        if let Some(w) = writer {
            let _ = w.join();
        }
        if let Some((job, _, _)) = pending.take() {
            self.saving.store(false, Ordering::SeqCst);
            (self.notify)(saved_event(&job.token, Err(("capture_failed", String::new()))));
        }
        clear(&self.dir);
        if reason != "stopped" {
            (self.notify)(json!({ "event": "replay_ended", "reason": reason }));
        }
        json!({ "reason": reason })
    }

    /// Starts writing the clip; None (and the event at once) when the ring is empty.
    fn begin_save(&self, job: SaveJob) -> Option<JoinHandle<()>> {
        let segs = self.ring.clip(job.seconds);
        let Some(first) = segs.first().map(|s| s.id) else {
            self.saving.store(false, Ordering::SeqCst);
            (self.notify)(saved_event(&job.token, Err(("too_short", String::new()))));
            return None;
        };
        self.pinned.store(first, Ordering::SeqCst);
        let (dir, ffmpeg) = (self.dir.clone(), self.ffmpeg.clone());
        let (pinned, saving, notify) = (self.pinned.clone(), self.saving.clone(), self.notify.clone());
        Some(std::thread::spawn(move || {
            let result = join(&ffmpeg, &dir, &segs, &job.path);
            pinned.store(u64::MAX, Ordering::SeqCst);
            saving.store(false, Ordering::SeqCst);
            notify(saved_event(&job.token, result));
        }))
    }
}

/// Joins `segs` into `path` (written next to it, then renamed): its seconds and bytes.
fn join(ffmpeg: &str, dir: &Path, segs: &[Segment], path: &str) -> Result<(f64, u64), (&'static str, String)> {
    let list = std::env::temp_dir().join(format!("xenon-replay-{}.txt", std::process::id()));
    let list_name = list.to_string_lossy().into_owned();
    std::fs::write(&list, plan::concat_list(&dir.to_string_lossy(), segs))
        .map_err(|e| ("save_failed", e.to_string()))?;
    let part = format!("{path}.part");
    let ran = run::run_quiet(ffmpeg, &plan::join_args(&list_name, &part), None, JOIN_DEADLINE);
    let _ = std::fs::remove_file(&list);
    let bytes = std::fs::metadata(&part).map_or(0, |m| m.len());
    if !ran || bytes == 0 || std::fs::rename(&part, path).is_err() {
        let _ = std::fs::remove_file(&part);
        return Err(("save_failed", "join failed".into()));
    }
    Ok((plan::seconds(segs), bytes))
}

fn saved_event(token: &str, result: Result<(f64, u64), (&'static str, String)>) -> Value {
    match result {
        Ok((seconds, bytes)) => json!({
            "event": "replay_saved", "token": token, "ok": true, "seconds": seconds, "bytes": bytes,
        }),
        Err((code, detail)) => json!({
            "event": "replay_saved", "token": token, "ok": false, "error": code, "detail": detail,
        }),
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
