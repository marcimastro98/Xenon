//! macOS backend. Pictures, edits and text reading use Apple's own tools, each
//! spawned with an argv array (run.rs): screencapture takes pictures with the
//! system's area picker; avconvert, afconvert, sips and qlmanage edit; Vision
//! and AppKit are reached through osascript (scripts.rs).
//!
//! Recordings go through ScreenCaptureKit (macOS 12.3 and later, opened at run
//! time: sck.rs) into an MP4 AVFoundation writes (writer.rs), with the Mac's
//! sound (macOS 13), the microphone (mic.rs), the frame rate, size and
//! quality asked for, and timelapses, answered as on Windows (capture.rs).
//! Where ScreenCaptureKit is missing, screencapture records instead: no
//! timelapse (`unsupported`), no sound (the answer has no `sound`), no tuning.
//! The Screen Recording and Microphone grants are the system's own prompts.
//!
//! The gallery's exports (export.rs) decode and encode through AVFoundation,
//! write GIFs and covered pictures through ImageIO (image.rs), and find the
//! spots to cover with Vision (cover.rs). The colour picker is the system's
//! own sampler (NSColorSampler, macOS 10.15); the ruler measures an area
//! picked with screencapture's own picker, as on Linux.
//!
//! Instant Replay (replay.rs) keeps the last minutes as two-second MP4
//! segments plus raw sound in the ring folder the server names, and a save
//! joins them without re-encoding the picture (replay_join.rs). The webcam
//! bubble (camera.rs, webcam.rs) is drawn on a copy of each recorded frame on
//! the CPU, after the system's Camera prompt. The steps recorder (steps.rs)
//! hears clicks through a listen-only event tap, after the system's Input
//! Monitoring prompt; the names of buttons need the Accessibility grant.
//!
//! `FEATURES` is one static list (main.rs), so it names what a current macOS
//! does; an older one answers with the codes above instead. Left out:
//! drawing, so the server hides it.

mod bubble_nv12;
mod camera;
mod capture;
mod cover;
mod edit;
mod encode;
mod export;
mod ffi;
mod frame;
mod image;
mod kit_shot;
mod media;
mod mic;
mod no_share;
mod no_share_plan;
mod reader;
mod record;
mod replay;
mod replay_join;
mod replay_pcm;
mod replay_plan;
mod run;
mod sck;
mod scripts;
mod steps;
mod steps_describe;
mod steps_plan;
mod steps_tap;
pub mod tools;
mod webcam;
mod writer;
mod recording;
mod jobs;
mod shots;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::proto::Fail;

use shots::{copy_image, front, monitors, take};

/// What this engine can do, as the server's capability probes read it.
pub const FEATURES: &[&str] = &[
    "screenshot",
    "region",
    "window",
    "record",
    "mic",
    "sound",
    "lapse",
    "ocr",
    "thumb",
    "trim",
    "copy_files",
    "pick_folder",
    "speech",
    "tuning",
    "export",
    "cover",
    "inspect",
    "measure",
    "replay",
    "webcam",
    "steps",
];

const SHOT_DEADLINE: Duration = Duration::from_secs(15);
/// The area picker waits on the user (the server waits 150 s).
const PICK_DEADLINE: Duration = Duration::from_secs(140);
const SCRIPT_DEADLINE: Duration = Duration::from_secs(10);
const OCR_DEADLINE: Duration = Duration::from_secs(30);
const FOLDER_DEADLINE: Duration = Duration::from_secs(300);
const HINT_MAX: usize = 160;
/// The colour sampler closes itself after this, as the Windows picker does
/// (the server waits 150 s).
const SAMPLER_OPEN: Duration = Duration::from_secs(120);

/// A recording in progress: through ScreenCaptureKit, or screencapture
/// where ScreenCaptureKit is missing (before macOS 12.3).
enum Recording {
    Kit(capture::Recording),
    Tool(record::Recording),
}

impl Recording {
    fn active(&self) -> bool {
        match self {
            Recording::Kit(r) => r.active(),
            Recording::Tool(r) => r.active(),
        }
    }
    fn stop(self) -> Value {
        match self {
            Recording::Kit(r) => r.stop(),
            Recording::Tool(r) => r.stop(),
        }
    }
}

pub struct Backend {
    recording: Option<Recording>,
    replay: Option<replay::Replay>,
    steps: Option<steps::Steps>,
    picking: Arc<AtomicBool>,
    edits: edit::Jobs,
}

/// A picture taken to a file.
struct Shot {
    width: u32,
    height: u32,
    monitor: Option<usize>,
}

impl Backend {
    pub fn new() -> Backend {
        Backend {
            recording: None,
            replay: None,
            steps: None,
            picking: Arc::new(AtomicBool::new(false)),
            edits: edit::Jobs::default(),
        }
    }

    pub fn monitors(&self) -> Value {
        let list: Vec<Value> = monitors()
            .iter()
            .map(|m| {
                json!({
                    "index": m.index, "name": m.name, "primary": m.primary, "hdr": false,
                    "x": m.x, "y": m.y, "width": m.width, "height": m.height,
                })
            })
            .collect();
        let supported = std::path::Path::new(run::SCREENCAPTURE).exists();
        json!({ "monitors": list, "supported": supported, "borderless": true, "ocr": supported })
    }

    /// `{ target: "screen" | "window" | "region", monitor?, path, cursor?, copy? }`;
    /// "region" is the system's own picker (the space bar picks a window).
    pub fn screenshot(&mut self, req: &Value) -> Result<Value, Fail> {
        let path = edit::text(req, "path")?;
        let cursor = req.get("cursor").and_then(Value::as_bool).unwrap_or(false);
        let copy = req.get("copy").and_then(Value::as_bool).unwrap_or(false);
        let front = front();
        let Some(shot) = take(req, &front, cursor, &path)? else {
            return Ok(json!({ "cancelled": true }));
        };
        let copied = copy && copy_image(&path);
        Ok(json!({
            "width": shot.width, "height": shot.height, "hdr": false,
            "monitor": shot.monitor, "exe": front.exe, "copied": copied,
        }))
    }

    pub fn recording(&self) -> bool {
        self.recording
            .as_ref()
            .is_some_and(Recording::active)
    }

    pub fn busy(&self) -> bool {
        self.recording()
            || self.replaying()
            || self.steps.as_ref().is_some_and(steps::Steps::active)
            || self.picking.load(Ordering::SeqCst)
            || self.edits.load(Ordering::SeqCst) > 0
    }

    /// The server went away: a recording in progress is finished properly.
    pub fn shutdown(&mut self) {
        if let Some(r) = self.recording.take() {
            r.stop();
        }
        if let Some(r) = self.replay.take() {
            r.stop();
        }
        self.steps = None;
    }
}
