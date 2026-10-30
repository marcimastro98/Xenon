//! A recording on Linux: ffmpeg's x11grab on X11, wf-recorder on the wlroots
//! compositors. Both write next to the final name and the file is renamed when
//! it ends, so a half-written file never carries the real name.
//!
//! ffmpeg stops on a `q` on its input, wf-recorder on an interrupt; either
//! one that does not stop in time is killed, so a stop never hangs (the file
//! is fragmented MP4 and plays up to the last fragment even then).

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::run;
use crate::proto::{Fail, Notify};

/// A recorder that ends this soon after starting failed to start (no
/// encoder, a display it cannot open, an audio source that is not there).
const START_GRACE: Duration = Duration::from_millis(900);
/// After the stop request, before the recorder is killed.
const STOP_GRACE: Duration = Duration::from_secs(8);
/// The longest a stop waits for the summary.
const STOP_WAIT: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(100);

/// How the recorder is asked to finish its file.
pub enum Ending {
    /// `q` on its input (ffmpeg).
    Quit,
    /// SIGINT through the system's `kill` (wf-recorder).
    Interrupt(String),
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

    /// Ends it and answers `{ reason, seconds, bytes }`.
    pub fn stop(self) -> Value {
        self.stop.store(true, Ordering::SeqCst);
        self.done
            .recv_timeout(STOP_WAIT)
            .unwrap_or_else(|_| json!({ "reason": "capture_failed" }))
    }
}

pub fn start(
    program: &str,
    args: &[String],
    ending: Ending,
    path: &str,
    part: &str,
    every: Option<u32>,
    notify: Notify,
) -> Result<Recording, Fail> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    start_command(cmd, Stdio::piped(), ending, path, part, every, None, notify)
}

/// `start` for a command made by the caller, with its standard input
/// (piped for `Ending::Quit`); `keep` (a portal session and its reader)
/// lives as long as the recorder runs.
#[allow(clippy::too_many_arguments)]
pub fn start_command(
    mut cmd: Command,
    stdin: Stdio,
    ending: Ending,
    path: &str,
    part: &str,
    every: Option<u32>,
    keep: Option<Box<dyn Send>>,
    notify: Notify,
) -> Result<Recording, Fail> {
    let _ = std::fs::remove_file(part);
    let mut child = cmd
        .stdin(stdin)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| Fail::new("capture_failed", e))?;
    std::thread::sleep(START_GRACE);
    if let Ok(Some(status)) = child.try_wait() {
        let _ = std::fs::remove_file(part);
        return Err(Fail::new(
            "capture_failed",
            format!("recorder ended: {status}"),
        ));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let active = Arc::new(AtomicBool::new(true));
    let (tx, done) = mpsc::channel();
    let watch = Watch {
        ending,
        part: part.to_owned(),
        path: path.to_owned(),
        stop: stop.clone(),
        active: active.clone(),
        every,
    };
    std::thread::spawn(move || {
        let (summary, asked) = watch.run(child);
        drop(keep);
        if !asked {
            // Ended by itself (the display went away, the disk filled up): say so.
            let mut event = json!({ "event": "record_ended" });
            if let (Some(e), Some(s)) = (event.as_object_mut(), summary.as_object()) {
                e.extend(s.clone());
            }
            notify(event);
        }
        let _ = tx.send(summary);
    });
    Ok(Recording { stop, active, done })
}

struct Watch {
    ending: Ending,
    part: String,
    path: String,
    stop: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    /// A timelapse's seconds between pictures.
    every: Option<u32>,
}

impl Watch {
    /// Waits for the end, asks the recorder to stop when told to, and settles
    /// the file. Answers the summary and whether the stop was asked for.
    fn run(self, mut child: Child) -> (Value, bool) {
        let began = Instant::now();
        let mut asked: Option<Instant> = None;
        let mut seconds = 0.0;
        loop {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            if asked.is_none() && self.stop.load(Ordering::SeqCst) {
                seconds = began.elapsed().as_secs_f64();
                asked = Some(Instant::now());
                self.ask(&mut child);
            }
            if asked.is_some_and(|at| at.elapsed() > STOP_GRACE) {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            std::thread::sleep(POLL);
        }
        if asked.is_none() {
            seconds = began.elapsed().as_secs_f64();
        }
        let bytes = settle(&self.part, &self.path);
        self.active.store(false, Ordering::SeqCst);
        let reason = if bytes > 0 {
            "stopped"
        } else {
            "capture_failed"
        };
        // No frame count: neither tool gives one, and the server then checks
        // that the file exists instead.
        let mut summary = json!({ "reason": reason, "seconds": seconds, "bytes": bytes });
        if let (Some(s), Some(o)) = (self.every, summary.as_object_mut()) {
            o.insert("seconds".into(), json!(lapse_seconds(seconds, s)));
            o.insert("span".into(), json!(seconds.round() as u64));
        }
        (summary, asked.is_some())
    }

    fn ask(&self, child: &mut Child) {
        match &self.ending {
            Ending::Quit => {
                if let Some(mut input) = child.stdin.take() {
                    let _ = input.write_all(b"q");
                }
            }
            Ending::Interrupt(kill) => {
                let pid = child.id().to_string();
                let _ = run::run(kill, &["-INT".into(), pid], None, Duration::from_secs(4));
            }
        }
    }
}

/// The written video under its real name; its size, 0 when there is none.
fn settle(part: &str, path: &str) -> u64 {
    let size = std::fs::metadata(part).map_or(0, |m| m.len());
    if size == 0 || std::fs::rename(part, path).is_err() {
        let _ = std::fs::remove_file(part);
        return 0;
    }
    size
}

/// How long a timelapse plays: one picture at the start, one every `every`
/// seconds after, at video::LAPSE_FPS.
fn lapse_seconds(watched: f64, every: u32) -> f64 {
    let pictures = (watched.max(0.0) / every.max(1) as f64).floor() + 1.0;
    pictures / crate::video::LAPSE_FPS as f64
}

#[cfg(test)]
mod tests {
    use super::lapse_seconds;

    #[test]
    fn a_timelapse_plays_one_frame_per_picture() {
        assert_eq!(lapse_seconds(0.0, 5), 1.0 / 30.0);
        assert_eq!(lapse_seconds(13.4, 1), 14.0 / 30.0);
        assert_eq!(lapse_seconds(3600.0, 60), 61.0 / 30.0);
    }
}
