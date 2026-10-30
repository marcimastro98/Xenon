//! The steps recorder on X11: `xinput test-xi2 --root` reports every press and
//! key press of the session; each left or right press (outside Xenon's own
//! windows) becomes a step, a picture of its monitor with a ring where it
//! landed, saved as a JPEG in the folder the server chose. Keys are never
//! kept, only that typing happened between two steps. There is no pill on
//! screen: the server's card with Stop shows that it runs. Pure parts in
//! `steps_plan` and `crate::steps`.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::json;

use super::run;
use super::steps_plan::{self, Input, Xi2};
use super::tools::{self, Aim, Monitor, Shooter};
use crate::proto::{Fail, Notify};
use crate::steps;

/// A recording with no click for this long ends by itself.
const IDLE: Duration = Duration::from_secs(20 * 60);
/// How often the worker looks at the stop flag while no click comes.
const POLL: Duration = Duration::from_millis(250);
/// xinput that ends this soon could not open the display or its extension.
const START_GRACE: Duration = Duration::from_millis(400);
const TOOL_DEADLINE: Duration = Duration::from_secs(5);
const SHOT_DEADLINE: Duration = Duration::from_secs(10);
/// The shell's process, as /proc names it: clicks on Xenon are not steps.
const XENON_COMM: &str = "xenon-native";
/// The frame's children tried for a process id (title bar parts come first).
const CHILDREN_MAX: usize = 16;

/// The tools a recording runs, found on PATH when the engine started.
pub struct Tools {
    pub xinput: String,
    pub xdotool: String,
    /// Finds the app's window inside the window manager's frame.
    pub xwininfo: Option<String>,
    pub ffmpeg: String,
    pub shooter: Shooter,
    pub shoot: String,
}

pub struct Plan {
    pub dir: PathBuf,
    pub tools: Tools,
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
    /// "failed" (xinput went away).
    pub fn start(plan: Plan, notify: Notify) -> Result<Steps, Fail> {
        std::fs::create_dir_all(&plan.dir).map_err(|e| Fail::new("write_failed", e))?;
        let mut child = Command::new(&plan.tools.xinput)
            .args(["test-xi2", "--root"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| Fail::new("hook_failed", e))?;
        std::thread::sleep(START_GRACE);
        let stdout = match (child.try_wait(), child.stdout.take()) {
            (Ok(None), Some(out)) => out,
            _ => {
                end(&mut child);
                return Err(Fail::code("hook_failed"));
            }
        };
        let (tx, inputs) = mpsc::channel();
        std::thread::spawn(move || {
            let mut xi = Xi2::default();
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(input) = xi.feed(&line) {
                    if tx.send(input).is_err() {
                        break;
                    }
                }
            }
        });
        let active = Arc::new(AtomicBool::new(true));
        let stop = Arc::new(AtomicBool::new(false));
        let run = Run {
            plan,
            inputs,
            stop: stop.clone(),
            active: active.clone(),
            notify,
        };
        let thread = std::thread::spawn(move || run.work(child));
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

fn end(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

struct Run {
    plan: Plan,
    inputs: mpsc::Receiver<Input>,
    stop: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    notify: Notify,
}

impl Run {
    fn work(self, mut child: Child) {
        let mut prev: Option<(i32, i32, u64)> = None;
        let mut last = Instant::now();
        let mut count = 0usize;
        let mut typed = false;
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
            let (right, time) = match self.inputs.recv_timeout(POLL) {
                Ok(Input::Press { right, time }) => (right, time),
                Ok(Input::Typed) => {
                    typed = true;
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break "failed",
            };
            let Some((x, y, window)) = self.pointer() else {
                continue;
            };
            let app = self.app(window);
            if app == XENON_COMM {
                continue;
            }
            let (px, py) = (x as i32, y as i32);
            if steps::is_double(prev, px, py, time) {
                prev = None;
                (self.notify)(json!({ "event": "step_double", "n": count }));
                continue;
            }
            prev = Some((px, py, time));
            last = Instant::now();
            let n = count + 1;
            let name = steps::file_name(n);
            let Some((width, height)) = self.picture(&name, x, y) else {
                continue;
            };
            count = n;
            (self.notify)(json!({
                "event": "step", "n": n, "file": name, "width": width, "height": height,
                "right": right, "app": app, "name": "", "role": "", "typedBefore": typed,
            }));
            typed = false;
        };
        end(&mut child);
        self.active.store(false, Ordering::SeqCst);
        (self.notify)(json!({
            "event": "steps_ended", "reason": reason, "count": count, "typed": typed,
        }));
    }

    fn xdotool(&self, args: &[&str]) -> Option<String> {
        let args: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
        run::run(&self.plan.tools.xdotool, &args, None, TOOL_DEADLINE)
            .filter(|o| o.ok)
            .map(|o| o.stdout)
    }

    /// Where the pointer is now, and the window under it.
    fn pointer(&self) -> Option<(i64, i64, u64)> {
        steps_plan::parse_mouse(&self.xdotool(&["getmouselocation", "--shell"])?)
    }

    /// The process name of the window's app; its title is never read. The
    /// window under the pointer is usually the window manager's frame, which
    /// has no process: the app's own window is one of its children.
    fn app(&self, window: u64) -> String {
        if window == 0 {
            return String::new();
        }
        let pid = |id: u64| {
            self.xdotool(&["getwindowpid", &id.to_string()])
                .and_then(|pid| pid.trim().parse::<u32>().ok())
        };
        let children = || {
            let xwininfo = self.plan.tools.xwininfo.as_deref()?;
            let args = vec!["-children".into(), "-id".into(), window.to_string()];
            run::run(xwininfo, &args, None, TOOL_DEADLINE)
                .filter(|o| o.ok)
                .map(|o| steps_plan::parse_children(&o.stdout))
        };
        pid(window)
            .or_else(|| {
                children()?
                    .into_iter()
                    .take(CHILDREN_MAX)
                    .find_map(pid)
            })
            .and_then(|pid| std::fs::read_to_string(format!("/proc/{pid}/comm")).ok())
            .map(|c| c.trim().chars().take(64).collect())
            .unwrap_or_default()
    }

    /// The step's picture: the monitor under (`x`, `y`), scaled, ringed and
    /// written as `name`. None when any tool failed (the step is skipped).
    fn picture(&self, name: &str, x: i64, y: i64) -> Option<(u32, u32)> {
        let m = tools::monitor_at(&self.plan.monitors, Some((x, y)))?;
        let shot = std::env::temp_dir().join(format!("xenon-step-{}.png", std::process::id()));
        let shot = shot.to_string_lossy().into_owned();
        let pixels = self.grab(m, &shot);
        let _ = std::fs::remove_file(&shot);
        let (mut bgr, (w, h), (sw, sh)) = pixels?;
        let cx = ((x - m.x) as f64 * f64::from(w) / sw as f64) as i32;
        let cy = ((y - m.y) as f64 * f64::from(h) / sh as f64) as i32;
        steps::ring(&mut bgr, w, h, cx, cy, 1.0);
        self.write(name, &bgr, w, h).then_some((w, h))
    }

    /// The monitor's picture as BGR rows at the saved size, that size, and
    /// the size it was taken at.
    #[allow(clippy::type_complexity)]
    fn grab(&self, m: &Monitor, shot: &str) -> Option<(Vec<u8>, (u32, u32), (u32, u32))> {
        let t = &self.plan.tools;
        let rect = (m.x, m.y, m.width, m.height);
        let args = tools::shot_args(t.shooter, &Aim::Screen(Some(rect)), false, shot, None);
        run::run(&t.shoot, &args, None, SHOT_DEADLINE).filter(|o| o.ok)?;
        let head = std::fs::read(shot).ok()?;
        let taken = tools::png_size(&head[..head.len().min(32)])?;
        let (w, h) = steps_plan::picture_size(taken.0, taken.1);
        let bgr = run::run_bytes(&t.ffmpeg, &steps_plan::decode_args(shot, w, h), SHOT_DEADLINE)?;
        (bgr.len() == (w * h * 3) as usize).then_some((bgr, (w, h), taken))
    }

    /// Writes the JPEG next to its name first, so a half-written file never
    /// carries the real name.
    fn write(&self, name: &str, bgr: &[u8], w: u32, h: u32) -> bool {
        let path = self.plan.dir.join(name);
        let part = self.plan.dir.join(format!("{name}.part"));
        let part_s = part.to_string_lossy().into_owned();
        let args = steps_plan::encode_args(w, h, &part_s);
        let ok = run::run_quiet(&self.plan.tools.ffmpeg, &args, Some(bgr), SHOT_DEADLINE)
            && std::fs::rename(&part, &path).is_ok();
        if !ok {
            let _ = std::fs::remove_file(&part);
        }
        ok
    }
}
