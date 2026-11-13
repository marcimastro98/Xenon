//! Linux backend: the system's own tools, each spawned with an argv array
//! (run.rs) and found on PATH when the engine starts. What a desktop can do
//! depends on its session and on what is installed, so `features()` is read
//! at runtime and the server offers only that:
//!
//! - X11: maim (or ImageMagick's import) with xdotool for pictures, ffmpeg's
//!   x11grab for recordings, PulseAudio/PipeWire for the sound and the mic.
//! - Sway, Hyprland and the other wlroots compositors: grim and slurp,
//!   wf-recorder.
//! - KDE and GNOME on Wayland: Spectacle and GNOME Screenshot take pictures.
//!   Their compositors share the screen only through the ScreenCast portal
//!   (the user picks it once), read by gst-launch and encoded by ffmpeg
//!   (portal.rs, portal_plan.rs).
//!
//! Everywhere: tesseract reads text, ffmpeg makes previews, trims and the sound
//! for transcripts, xclip or wl-copy fill the clipboard, zenity or kdialog
//! open the folder dialog. Nothing is linked into the engine.

mod cover;
mod cover_plan;
mod edit;
mod export;
mod export_plan;
mod inspect;
mod inspect_plan;
mod portal;
mod portal_plan;
mod record;
mod replay;
mod replay_plan;
mod run;
mod steps;
mod steps_plan;
pub mod tools;
mod reader;
mod kit_detect;
mod recording;
mod jobs;
mod shots;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::proto::Fail;
use tools::{Aim, Desk, Kit};

use kit_detect::detect;

const SHOT_DEADLINE: Duration = Duration::from_secs(15);
/// The area picker waits on the user (the server waits 150 s).
const PICK_DEADLINE: Duration = Duration::from_secs(140);
const TOOL_DEADLINE: Duration = Duration::from_secs(5);
const OCR_DEADLINE: Duration = Duration::from_secs(30);
const FOLDER_DEADLINE: Duration = Duration::from_secs(300);
const HINT_MAX: usize = 160;

pub struct Backend {
    desk: Desk,
    kit: Kit,
    display: String,
    recording: Option<record::Recording>,
    replay: Option<replay::Replay>,
    picking: Arc<AtomicBool>,
    edits: edit::Jobs,
    steps: Option<steps::Steps>,
}

/// A picture taken to a file.
/// A rectangle on the desktop: x, y, width, height.
type Rect = (i64, i64, i64, i64);

/// One planned picture: what to aim at, its monitor, slurp's area and the deadline.
struct Plan {
    aim: Aim,
    monitor: Option<usize>,
    area: Option<String>,
    deadline: Duration,
}

struct Shot {
    width: u32,
    height: u32,
    monitor: Option<usize>,
}

fn env(key: &str) -> String {
    std::env::var(key).unwrap_or_default()
}

/// The tools on PATH, and what this ffmpeg was built with.
/// The tesseract languages to read with: the locale's plus English.
fn ocr_langs(tesseract: &str) -> Result<String, Fail> {
    let listing = run::run(tesseract, &["--list-langs".into()], None, TOOL_DEADLINE)
        .map(|o| o.stdout)
        .unwrap_or_default();
    let locale = [env("LC_ALL"), env("LC_MESSAGES"), env("LANG")]
        .into_iter()
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    tools::ocr_langs(&listing, &locale).ok_or(Fail::code("no_ocr_language"))
}

/// wf-recorder's arguments streaming to the replay's cutter.
fn plan_stream(args: Vec<String>, fps: u32) -> Result<Vec<String>, Fail> {
    replay_plan::wf_to_stream(args, fps).ok_or(Fail::code("replay_failed"))
}

impl Backend {
    pub fn new() -> Backend {
        let desk = tools::desk(
            &env("XDG_SESSION_TYPE"),
            &env("WAYLAND_DISPLAY"),
            &env("DISPLAY"),
            &env("XDG_CURRENT_DESKTOP"),
        );
        Backend {
            desk,
            kit: detect(desk),
            display: env("DISPLAY"),
            recording: None,
            replay: None,
            picking: Arc::new(AtomicBool::new(false)),
            edits: edit::Jobs::default(),
            steps: None,
        }
    }

    pub fn features(&self) -> Vec<&'static str> {
        self.kit.features(self.desk)
    }

    pub fn monitors(&self) -> Value {
        let list: Vec<Value> = self
            .monitor_list()
            .iter()
            .map(|m| {
                json!({
                    "index": m.index, "name": m.name, "primary": m.primary, "hdr": false,
                    "x": m.x, "y": m.y, "width": m.width, "height": m.height,
                })
            })
            .collect();
        let supported = self.kit.shooter(self.desk).is_some();
        let ocr = supported && self.kit.tesseract.is_some();
        json!({ "monitors": list, "supported": supported, "borderless": true, "ocr": ocr })
    }

    /// `{ target: "screen" | "window" | "region", monitor?, path, cursor?, copy? }`.
    pub fn screenshot(&mut self, req: &Value) -> Result<Value, Fail> {
        let path = edit::text(req, "path")?;
        let cursor = req.get("cursor").and_then(Value::as_bool).unwrap_or(false);
        let copy = req.get("copy").and_then(Value::as_bool).unwrap_or(false);
        let front = self.front();
        let Some(shot) = self.take(req, &front, cursor, &path)? else {
            return Ok(json!({ "cancelled": true }));
        };
        let copied = copy && self.copy_image(&path);
        Ok(json!({
            "width": shot.width, "height": shot.height, "hdr": false,
            "monitor": shot.monitor, "exe": front.exe, "copied": copied,
        }))
    }

    pub fn recording(&self) -> bool {
        self.recording
            .as_ref()
            .is_some_and(record::Recording::active)
    }

    pub fn busy(&self) -> bool {
        self.recording()
            || self.replaying()
            || self.picking.load(Ordering::SeqCst)
            || self.edits.load(Ordering::SeqCst) > 0
            || self.steps.as_ref().is_some_and(steps::Steps::active)
    }

    /// The server went away: a recording in progress is finished properly.
    pub fn shutdown(&mut self) {
        self.steps = None;
        if let Some(r) = self.recording.take() {
            r.stop();
        }
        if let Some(r) = self.replay.take() {
            r.stop();
        }
    }
}
