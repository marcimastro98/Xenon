//! The steps recorder on macOS: each left or right press the event tap
//! (steps_tap.rs) hears, outside Xenon's own windows, becomes a step: a
//! picture of its display with a ring where it landed, saved as a JPEG in the
//! folder the server chose. Keys are never kept, only that typing happened
//! between two steps. There is no pill on screen: the server's card with
//! Stop shows that it runs. Pure parts in `steps_plan` and `crate::steps`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::mpsc::RecvTimeoutError;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use objc2::rc::autoreleasepool;
use serde_json::{json, Value};

use super::image::{self, Image};
use super::run;
use super::steps_describe;
use super::steps_plan::{self, Press};
use super::steps_tap::{Feed, Tap};
use super::tools::{self, Aim, Monitor};
use crate::proto::{Fail, Notify};
use crate::steps;

/// A recording with no click for this long ends by itself.
const IDLE: Duration = Duration::from_secs(20 * 60);
/// How often the worker looks at the stop flag while no click comes.
const POLL: Duration = Duration::from_millis(250);
const SHOT_DEADLINE: Duration = Duration::from_secs(10);

pub struct Plan {
    pub dir: PathBuf,
    pub monitors: Vec<Monitor>,
}

pub struct Steps {
    active: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Steps {
    /// Starts recording. The end always comes as an event `steps_ended
    /// { reason, count, typed }`: "stopped" (the server), "full", "idle" or
    /// "failed" (the tap went away).
    pub fn start(plan: Plan, notify: Notify) -> Result<Steps, Fail> {
        std::fs::create_dir_all(&plan.dir).map_err(|e| Fail::new("write_failed", e))?;
        let (tap, feed) = Tap::open()?;
        let active = Arc::new(AtomicBool::new(true));
        let stop = Arc::new(AtomicBool::new(false));
        let run = Run {
            plan,
            feed,
            stop: stop.clone(),
            active: active.clone(),
            notify,
        };
        let thread = std::thread::spawn(move || run.work(tap));
        Ok(Steps {
            active,
            stop,
            thread: Some(thread),
        })
    }

    pub fn active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
}

impl Drop for Steps {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

struct Run {
    plan: Plan,
    feed: Feed,
    stop: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    notify: Notify,
}

impl Run {
    fn work(self, tap: Tap) {
        let own = std::process::id();
        let mut prev: Option<(i32, i32, u64)> = None;
        let mut last = Instant::now();
        let mut count = 0usize;
        let reason = loop {
            if self.stop.load(Ordering::SeqCst) {
                break "stopped";
            }
            if count >= steps::MAX_STEPS {
                break "full";
            }
            if last.elapsed() >= IDLE {
                break "idle";
            }
            let press = match self.feed.presses.recv_timeout(POLL) {
                Ok(p) => p,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break "failed",
            };
            let app = steps_describe::app(press.window);
            if steps_plan::is_ours(app.pid, own, &app.exe) {
                continue;
            }
            let (px, py) = (press.x.floor() as i32, press.y.floor() as i32);
            if steps::is_double(prev, px, py, press.time) {
                prev = None;
                (self.notify)(json!({ "event": "step_double", "n": count }));
                continue;
            }
            prev = Some((px, py, press.time));
            last = Instant::now();
            let n = count + 1;
            if let Some(step) = autoreleasepool(|_| self.step(n, &press, &app.name)) {
                count = n;
                (self.notify)(step);
            }
        };
        drop(tap);
        self.active.store(false, Ordering::SeqCst);
        (self.notify)(json!({
            "event": "steps_ended", "reason": reason, "count": count,
            "typed": self.feed.typed.load(Ordering::SeqCst),
        }));
    }

    /// Step `n`'s event once its picture is saved; None when it could not be
    /// (the step is skipped).
    fn step(&self, n: usize, press: &Press, app: &str) -> Option<Value> {
        // Asked first: the click may close what it landed on.
        let control = steps_describe::control(press.x, press.y);
        let file = steps::file_name(n);
        let (width, height) = self.picture(&file, press.x, press.y)?;
        let typed = self.feed.typed.swap(false, Ordering::SeqCst);
        Some(json!({
            "event": "step", "n": n, "file": file, "width": width, "height": height,
            "right": press.right, "app": app, "name": control.name, "role": control.role,
            "typedBefore": typed,
        }))
    }

    /// The step's picture: the display under (`x`, `y`), scaled, ringed and
    /// written as `name`.
    fn picture(&self, name: &str, x: f64, y: f64) -> Option<(u32, u32)> {
        let m = tools::monitor_at(&self.plan.monitors, Some((x.floor() as i64, y.floor() as i64)))?;
        let shot = std::env::temp_dir().join(format!("xenon-step-{}.png", std::process::id()));
        let taken = grab(m, &shot);
        let _ = std::fs::remove_file(&shot);
        let taken = taken?;
        let (taken_width, taken_height) = image::size(&taken);
        let saved = steps::picture_size(taken_width, taken_height);
        let bgrx = image::scaled_bgrx(&taken, saved)?;
        let mut bgr = steps_plan::bgrx_to_bgr(&bgrx, saved, saved.0 as usize * 4);
        let (cx, cy) = steps_plan::ring_at(x, y, (m.x, m.y, m.width, m.height), saved);
        let scale = steps_plan::ring_scale(m.scale, saved.0, taken_width);
        steps::ring(&mut bgr, saved.0, saved.1, cx, cy, scale);
        let ringed = image::from_bgrx(&steps_plan::bgr_to_bgrx(&bgr), saved)?;
        write(&self.plan.dir, name, &ringed).then_some(saved)
    }
}

/// A picture of display `m`, taken to `shot`.
fn grab(m: &Monitor, shot: &Path) -> Option<Image> {
    let shot = shot.to_string_lossy();
    let args = tools::screenshot_args(&Aim::Display(m.index), false, &shot);
    run::run(run::SCREENCAPTURE, &args, None, SHOT_DEADLINE).filter(|o| o.ok)?;
    image::open(&shot)
}

/// Writes the JPEG next to its name first, so a half-written file never
/// carries the real name.
fn write(dir: &Path, name: &str, picture: &Image) -> bool {
    let path = dir.join(name);
    let part = dir.join(format!("{name}.part"));
    let ok = image::write_jpeg(picture, &part) && std::fs::rename(&part, &path).is_ok();
    if !ok {
        let _ = std::fs::remove_file(&part);
    }
    ok
}
