//! A recording on macOS: Apple's `screencapture -v`, which records with the
//! system's own encoder and shows the system's own recording indicator in
//! the menu bar. It writes next to the final name and is renamed when it ends,
//! so a half-written file never carries the real name.
//!
//! screencapture stops when its input gets a key; when it does not, it gets an
//! interrupt (Ctrl+C) and, past a deadline, is killed: a stop never hangs.

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::run;
use super::tools::{self, Aim};
use crate::proto::{Fail, Notify};

/// A screencapture that ends this soon after starting failed to start (no
/// Screen Recording grant, a window that went away, a bad display).
const START_GRACE: Duration = Duration::from_millis(900);
/// After the key on its input, then after the interrupt, before the next step.
const KEY_WAIT: Duration = Duration::from_secs(4);
const INT_WAIT: Duration = Duration::from_secs(8);
/// The longest a stop waits for the summary.
const STOP_WAIT: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(100);

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

pub fn start(aim: &Aim, mic: bool, path: &str, notify: Notify) -> Result<Recording, Fail> {
    let part = format!("{path}.part.mov");
    let mut child = Command::new(run::SCREENCAPTURE)
        .args(tools::record_args(aim, mic, &part))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| Fail::new("capture_failed", e))?;
    std::thread::sleep(START_GRACE);
    if let Ok(Some(status)) = child.try_wait() {
        let _ = std::fs::remove_file(&part);
        return Err(Fail::new(
            "capture_failed",
            format!("screencapture ended: {status}"),
        ));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let active = Arc::new(AtomicBool::new(true));
    let (tx, done) = mpsc::channel();
    let plan = Watch {
        part,
        path: path.to_owned(),
        stop: stop.clone(),
        active: active.clone(),
    };
    std::thread::spawn(move || {
        let (summary, asked) = plan.run(child);
        if !asked {
            // Ended by itself (the menu bar's stop, a window closed): say so.
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
    part: String,
    path: String,
    stop: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
}

impl Watch {
    /// Waits for the end, asks screencapture to stop when told to, and settles
    /// the file. Answers the summary and whether the stop was asked for.
    fn run(self, mut child: Child) -> (Value, bool) {
        let began = Instant::now();
        let mut asked: Option<Instant> = None;
        let mut interrupted = false;
        let mut seconds = 0.0;
        loop {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            if asked.is_none() && self.stop.load(Ordering::SeqCst) {
                seconds = began.elapsed().as_secs_f64();
                asked = Some(Instant::now());
                if let Some(mut input) = child.stdin.take() {
                    let _ = input.write_all(b"\n");
                }
            }
            if let Some(at) = asked {
                if !interrupted && at.elapsed() > KEY_WAIT {
                    interrupted = true;
                    let pid = child.id().to_string();
                    let _ = run::run(run::KILL, &["-INT".into(), pid], None, KEY_WAIT);
                }
                if at.elapsed() > KEY_WAIT + INT_WAIT {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
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
        // No frame count: screencapture does not give one, and the server then
        // checks that the file exists instead.
        let summary = json!({ "reason": reason, "seconds": seconds, "bytes": bytes });
        (summary, asked.is_some())
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
