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
mod media;
mod mic;
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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::proto::{Fail, Notify};
use tools::{Aim, Monitor};

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

    /// `{ target: "screen" | "window", monitor?, path, fps?, height?, quality?,
    /// sound?, mic?, every?, cursor?, webcam? }`, answered as on Windows. Through
    /// ScreenCaptureKit when this macOS has it, else screencapture (no
    /// timelapse, no tuning, no `sound` in the answer: the Mac's sound is not
    /// recorded). The webcam bubble needs ScreenCaptureKit: through
    /// screencapture `camera` is false when asked.
    pub fn record_start(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        if self.recording() {
            return Err(Fail::code("already_recording"));
        }
        if sck::available() {
            return self.record_kit(req, notify);
        }
        if req.get("every").and_then(Value::as_u64).is_some() {
            return Err(Fail::code("unsupported"));
        }
        let path = edit::text(req, "path")?;
        let list = monitors();
        let front = front();
        let (aim, mon) = match req
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or("screen")
        {
            "window" if front.id != 0 => (
                Aim::Window(front.id),
                tools::monitor_at(&list, front.centre),
            ),
            "window" => return Err(Fail::code("no_window")),
            "screen" => {
                let m = pick_monitor(&list, req, &front)?;
                (Aim::Display(m.index), Some(m))
            }
            _ => return Err(Fail::code("bad_request")),
        };
        let mic = req.get("mic").and_then(Value::as_bool).unwrap_or(false);
        self.recording = Some(Recording::Tool(record::start(&aim, mic, &path, notify)?));
        let mut info = json!({
            "width": mon.map_or(0, |m| m.width), "height": mon.map_or(0, |m| m.height),
            "fps": Value::Null, "hdr": false, "mic": mic,
            "monitor": mon.map(|m| m.index), "exe": front.exe,
        });
        if let (Some(o), true) = (info.as_object_mut(), req.get("webcam").is_some()) {
            o.insert("camera".into(), json!(false));
        }
        Ok(info)
    }

    pub fn record_stop(&mut self) -> Result<Value, Fail> {
        match self.recording.take() {
            Some(r) if r.active() => Ok(r.stop()),
            _ => Err(Fail::code("not_recording")),
        }
    }

    fn record_kit(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        let path = edit::text(req, "path")?;
        let list = monitors();
        let front = front();
        let Aimed { target, monitor: mon, points } = kit_target(req, &list, &front)?;
        let every = crate::video::lapse_every(req.get("every").and_then(Value::as_u64));
        let fps = match every {
            Some(_) => crate::video::LAPSE_FPS,
            None => crate::video::fps(req.get("fps").and_then(Value::as_u64)),
        };
        let (width, height, bitrate) = tuned(req, points, mon.map_or(1.0, |m| m.scale), fps);
        let flag = |k: &str, default: bool| req.get(k).and_then(Value::as_bool).unwrap_or(default);
        // Never in a timelapse, as on Windows.
        let webcam = every
            .is_none()
            .then(|| crate::bubble::Corner::parse(req.get("webcam").and_then(Value::as_str)))
            .flatten();
        let plan = capture::Plan {
            target,
            width,
            height,
            fps,
            every,
            bitrate,
            cursor: flag("cursor", true),
            // A timelapse is silent: sound at 10x or 300x speed is noise.
            sound: every.is_none() && flag("sound", true),
            mic: every.is_none() && flag("mic", false),
            webcam,
            path,
        };
        let (recording, opened) = capture::start(plan, notify)?;
        self.recording = Some(Recording::Kit(recording));
        let sound = match target {
            _ if !opened.sound => Value::Null,
            sck::Target::Window(_) => json!("app"),
            sck::Target::Display(_) => json!("system"),
        };
        let mut info = json!({
            "width": width, "height": height, "fps": fps, "hdr": false,
            "sound": sound, "mic": opened.mic,
            "monitor": mon.map(|m| m.index), "exe": front.exe,
        });
        if let Some(o) = info.as_object_mut() {
            if let Some(s) = every {
                o.insert("every".into(), json!(s));
            }
            if webcam.is_some() {
                o.insert("camera".into(), json!(opened.camera));
            }
        }
        Ok(info)
    }

    /// Instant Replay: `{ monitor?, dir, seconds?, fps?, height?, quality?,
    /// sound?, mic? }`, as on Windows. Records that display (without one, the
    /// one the window in front is on) into a ring of segments in `dir`,
    /// keeping the last `seconds`. One at a time, beside a recording; only
    /// through ScreenCaptureKit (`unsupported` before macOS 12.3).
    pub fn replay_start(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        if self.replaying() {
            return Err(Fail::code("already_running"));
        }
        if !sck::available() {
            return Err(Fail::code("unsupported"));
        }
        let dir = edit::text(req, "dir")?;
        std::fs::create_dir_all(&dir).map_err(|e| Fail::new("write_failed", e))?;
        let list = monitors();
        let m = pick_monitor(&list, req, &front())?;
        if m.display == 0 {
            return Err(Fail::code("no_monitor"));
        }
        let fps = crate::video::fps(req.get("fps").and_then(Value::as_u64));
        let (width, height, bitrate) = tuned(req, (m.width, m.height), m.scale, fps);
        let flag = |k: &str, default: bool| req.get(k).and_then(Value::as_bool).unwrap_or(default);
        let plan = replay::Plan {
            target: sck::Target::Display(m.display),
            dir: dir.into(),
            width,
            height,
            fps,
            bitrate,
            cursor: flag("cursor", true),
            sound: flag("sound", true),
            mic: flag("mic", false),
            keep: crate::ring::keep_seconds(req.get("seconds").and_then(Value::as_u64)),
        };
        let (replay, opened) = replay::start(plan, notify)?;
        self.replay = Some(replay);
        Ok(replay_plan::start_answer((width, height), fps, bitrate, opened.sound, opened.mic, m.index))
    }

    /// `{ path, seconds?, token }`: answers `{ saving: true }` at once; the
    /// clip comes as the event `replay_saved`, as on Windows.
    pub fn replay_save(&mut self, req: &Value) -> Result<Value, Fail> {
        let replay = self.running_replay()?;
        let path = edit::text(req, "path")?;
        let seconds = req
            .get("seconds")
            .and_then(Value::as_u64)
            .map_or(crate::ring::MAX_SECONDS, |s| crate::ring::keep_seconds(Some(s)));
        let token = req.get("token").and_then(Value::as_str).unwrap_or("").chars().take(64).collect();
        replay.save(path, seconds, token)?;
        Ok(json!({ "saving": true }))
    }

    /// `{ seconds }`: a new length for the running replay.
    pub fn replay_keep(&mut self, req: &Value) -> Result<Value, Fail> {
        let replay = self.running_replay()?;
        let seconds = crate::ring::keep_seconds(req.get("seconds").and_then(Value::as_u64));
        replay.set_keep(seconds);
        Ok(json!({ "seconds": seconds }))
    }

    /// Ends the replay and deletes its ring.
    pub fn replay_stop(&mut self) -> Result<Value, Fail> {
        match self.replay.take() {
            Some(r) if r.active() => Ok(r.stop()),
            _ => Err(Fail::code("not_running")),
        }
    }

    fn running_replay(&self) -> Result<&replay::Replay, Fail> {
        self.replay.as_ref().filter(|r| r.active()).ok_or(Fail::code("not_running"))
    }

    fn replaying(&self) -> bool {
        self.replay.as_ref().is_some_and(replay::Replay::active)
    }

    /// The system's folder dialog: `{ title?, start? }` answers `{ open: true }`
    /// at once; the choice comes as the event `folder_picked`.
    pub fn pick_folder(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        if self.picking.swap(true, Ordering::SeqCst) {
            return Ok(json!({ "open": true }));
        }
        let text = |k: &str| -> String {
            req.get(k)
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(HINT_MAX)
                .collect()
        };
        let args = vec![
            text("title"),
            req.get("start")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        ];
        let picking = self.picking.clone();
        std::thread::spawn(move || {
            let answer = run::jxa(scripts::PICK_FOLDER, &args, FOLDER_DEADLINE);
            let event = match answer.map(|o| tools::parse_picked(&o.stdout)) {
                Some(tools::Picked::Folder(path)) => {
                    json!({ "event": "folder_picked", "path": path })
                }
                // Left open too long is a change of mind, as on Windows.
                Some(tools::Picked::Cancelled) | None => {
                    json!({ "event": "folder_picked", "cancelled": true })
                }
                Some(tools::Picked::Failed) => {
                    json!({ "event": "folder_picked", "error": "failed" })
                }
            };
            picking.store(false, Ordering::SeqCst);
            notify(event);
        });
        Ok(json!({ "open": true }))
    }

    pub fn thumb(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        edit::start_thumb(req, notify, &self.edits)
    }
    pub fn trim(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        edit::start_trim(req, notify, &self.edits)
    }
    pub fn export(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        export::start_export(req, notify, &self.edits)
    }
    pub fn export_cancel(&mut self) -> Result<Value, Fail> {
        Ok(export::cancel_export())
    }
    pub fn cover(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        cover::start(req, notify, &self.edits)
    }
    pub fn speech(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        edit::start_speech(req, notify, &self.edits)
    }

    /// `{ paths: [...] }`: saved files onto the clipboard, as Finder copies them.
    pub fn copy_files(&mut self, req: &Value) -> Result<Value, Fail> {
        let paths: Vec<String> = req
            .get("paths")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        if paths.is_empty() {
            return Err(Fail::code("bad_request"));
        }
        let ok = run::jxa(scripts::COPY_FILES, &paths, SCRIPT_DEADLINE)
            .is_some_and(|o| o.ok && o.stdout.trim() == "ok");
        if !ok {
            return Err(Fail::code("clipboard_busy"));
        }
        Ok(json!({ "copied": paths.len() }))
    }

    /// `{ target, monitor?, copy? }`: the text on screen, read by Vision from a
    /// picture that is deleted right after. See win/mod.rs `ocr`.
    pub fn ocr(&mut self, req: &Value) -> Result<Value, Fail> {
        let copy = req.get("copy").and_then(Value::as_bool).unwrap_or(true);
        let tmp = std::env::temp_dir().join(format!("xenon-ocr-{}.png", std::process::id()));
        let tmp = tmp.to_string_lossy().into_owned();
        let shot = take(req, &front(), false, &tmp);
        let read = match shot {
            Ok(Some(shot)) => {
                let lines = run::jxa(scripts::OCR, std::slice::from_ref(&tmp), OCR_DEADLINE)
                    .filter(|o| o.ok)
                    .and_then(|o| tools::parse_ocr(&o.stdout));
                Ok(Some((shot, lines)))
            }
            Ok(None) => Ok(None),
            Err(f) => Err(f),
        };
        let _ = std::fs::remove_file(&tmp);
        let Some((shot, lines)) = read? else {
            return Ok(json!({ "cancelled": true }));
        };
        let lines = lines.ok_or(Fail::code("ocr_failed"))?;
        let text = lines.join("\n");
        let copied = copy && !text.is_empty() && copy_text(&text);
        Ok(json!({
            "text": text, "lines": lines.len(), "lang": "", "copied": copied,
            "monitor": shot.monitor,
        }))
    }

    /// `{ mode: "colour" | "measure", format? }`, answered as on Windows
    /// (win/mod.rs `inspect`). The colour is the system's sampler: a click
    /// picks, Esc leaves (`cancelled`). There is no ruler: `measure` is
    /// `unsupported`.
    pub fn inspect(&mut self, req: &Value) -> Result<Value, Fail> {
        match req.get("mode").and_then(Value::as_str) {
            Some("colour") => {}
            Some("measure") => return measure(),
            _ => return Err(Fail::code("bad_request")),
        }
        let format = match req.get("format").and_then(Value::as_str) {
            None => crate::inspect::Format::Hex,
            Some(f) => crate::inspect::Format::parse(f).ok_or(Fail::code("bad_request"))?,
        };
        let limit = SAMPLER_OPEN.as_secs().to_string();
        let answer = run::jxa(scripts::COLOR_SAMPLER, &[limit], PICK_DEADLINE)
            .filter(|o| o.ok)
            .map_or(tools::Sampled::Failed, |o| tools::parse_sampled(&o.stdout));
        match answer {
            tools::Sampled::Colour { rgb, at } => {
                let text = crate::inspect::text(rgb, format);
                let monitor = tools::monitor_at(&monitors(), at).map(|m| m.index);
                Ok(json!({
                    "rgb": rgb, "hex": crate::inspect::hex(rgb), "text": text,
                    "copied": copy_text(&text), "monitor": monitor,
                }))
            }
            tools::Sampled::Cancelled => Ok(json!({ "cancelled": true })),
            tools::Sampled::Unsupported => Err(Fail::code("unsupported")),
            tools::Sampled::Failed => Err(Fail::code("capture_failed")),
        }
    }
    pub fn draw(&mut self, _req: &Value, _notify: Notify) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    /// `{ action: start|stop|toggle, dir }`: answers `{ steps }`; each step
    /// and the end come as events (steps.rs).
    pub fn steps(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        let running = self.steps.as_ref().is_some_and(steps::Steps::active);
        let start = match req.get("action").and_then(Value::as_str) {
            Some("start") => true,
            Some("stop") => false,
            Some("toggle") => !running,
            _ => return Err(Fail::code("bad_request")),
        };
        if !start {
            self.steps = None;
            return Ok(json!({ "steps": false }));
        }
        if running {
            return Err(Fail::code("already_running"));
        }
        let dir = edit::text(req, "dir")?;
        let monitors = monitors();
        if monitors.is_empty() {
            return Err(Fail::code("no_monitor"));
        }
        let plan = steps::Plan { dir: std::path::PathBuf::from(dir), monitors };
        self.steps = Some(steps::Steps::start(plan, notify)?);
        Ok(json!({ "steps": true }))
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

/// The encoded size and bitrate for something `points` big at `scale`
/// pixels per point, as the request's height and quality ask.
fn tuned(req: &Value, points: (i64, i64), scale: f64, fps: u32) -> (u32, u32, u32) {
    let source = (
        (points.0 as f64 * scale).round().max(2.0) as u32,
        (points.1 as f64 * scale).round().max(2.0) as u32,
    );
    let cap = crate::video::height_cap(req.get("height").and_then(Value::as_u64));
    let (width, height) = crate::video::encode_size(source.0, source.1, cap);
    let quality = crate::video::Quality::parse(req.get("quality").and_then(Value::as_str));
    (width, height, crate::video::bitrate(width, height, fps, quality))
}

/// What a ScreenCaptureKit recording aims at.
struct Aimed<'a> {
    target: sck::Target,
    /// The monitor it is on.
    monitor: Option<&'a Monitor>,
    /// Its size in points.
    points: (i64, i64),
}

fn kit_target<'a>(req: &Value, list: &'a [Monitor], front: &tools::Front) -> Result<Aimed<'a>, Fail> {
    match req.get("target").and_then(Value::as_str).unwrap_or("screen") {
        "window" => {
            let id = u32::try_from(front.id).ok().filter(|&i| i != 0);
            let id = id.ok_or(Fail::code("no_window"))?;
            let frame = sck::window_frame(id).ok_or(Fail::code("no_window"))?;
            let size = (frame.size.width.round() as i64, frame.size.height.round() as i64);
            Ok(Aimed {
                target: sck::Target::Window(id),
                monitor: tools::monitor_at(list, front.centre),
                points: size,
            })
        }
        "screen" => {
            let m = pick_monitor(list, req, front)?;
            if m.display == 0 {
                return Err(Fail::code("no_monitor"));
            }
            Ok(Aimed {
                target: sck::Target::Display(m.display),
                monitor: Some(m),
                points: (m.width, m.height),
            })
        }
        _ => Err(Fail::code("bad_request")),
    }
}

fn monitors() -> Vec<Monitor> {
    run::jxa(scripts::MONITORS, &[], SCRIPT_DEADLINE)
        .filter(|o| o.ok)
        .map(|o| tools::parse_monitors(&o.stdout))
        .unwrap_or_default()
}

fn front() -> tools::Front {
    run::jxa(scripts::FRONT_WINDOW, &[], SCRIPT_DEADLINE)
        .filter(|o| o.ok)
        .map(|o| tools::parse_front(&o.stdout))
        .unwrap_or_default()
}

/// The monitor asked for, or the one the window in front is on.
fn pick_monitor<'a>(
    list: &'a [Monitor],
    req: &Value,
    front: &tools::Front,
) -> Result<&'a Monitor, Fail> {
    match req.get("monitor").and_then(Value::as_u64) {
        Some(i) => list.iter().find(|m| m.index as u64 == i),
        None => tools::monitor_at(list, front.centre),
    }
    .ok_or(Fail::code("no_monitor"))
}

/// One picture to `path` (through `path.part`); None when the user left the
/// area picker without picking.
fn take(req: &Value, front: &tools::Front, cursor: bool, path: &str) -> Result<Option<Shot>, Fail> {
    let (aim, monitor, deadline) = match req
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or("screen")
    {
        "window" if front.id != 0 => {
            let list = monitors();
            let m = tools::monitor_at(&list, front.centre).map(|m| m.index);
            (Aim::Window(front.id), m, SHOT_DEADLINE)
        }
        "window" => return Err(Fail::code("no_window")),
        "screen" => {
            let list = monitors();
            let m = pick_monitor(&list, req, front)?;
            (Aim::Display(m.index), Some(m.index), SHOT_DEADLINE)
        }
        "region" => (Aim::Pick, None, PICK_DEADLINE),
        _ => return Err(Fail::code("bad_request")),
    };
    let part = format!("{path}.part");
    let _ = std::fs::remove_file(&part);
    let ran = run::run(
        run::SCREENCAPTURE,
        &tools::screenshot_args(&aim, cursor, &part),
        None,
        deadline,
    );
    let head = std::fs::read(&part)
        .ok()
        .map(|b| b[..b.len().min(32)].to_vec());
    let Some((width, height)) = head.as_deref().and_then(tools::png_size) else {
        let _ = std::fs::remove_file(&part);
        // The picker closed with Esc writes nothing: a change of mind, not a failure.
        if aim == Aim::Pick && ran.is_some() {
            return Ok(None);
        }
        return Err(Fail::code("capture_failed"));
    };
    std::fs::rename(&part, path).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        Fail::new("write_failed", e)
    })?;
    Ok(Some(Shot {
        width,
        height,
        monitor,
    }))
}

/// The ruler: an area picked with the screenshot's own picker (the space bar
/// picks a window), measured in pixels and deleted. Nothing is saved.
fn measure() -> Result<Value, Fail> {
    let tmp = std::env::temp_dir().join(format!("xenon-ruler-{}.png", std::process::id()));
    let tmp = tmp.to_string_lossy().into_owned();
    let shot = take(&json!({ "target": "region" }), &tools::Front::default(), false, &tmp);
    let _ = std::fs::remove_file(&tmp);
    let Some(shot) = shot? else {
        return Ok(json!({ "cancelled": true }));
    };
    let (w, h) = (shot.width as i32, shot.height as i32);
    let text = crate::inspect::size_text(w, h);
    Ok(json!({ "width": w, "height": h, "text": text, "copied": copy_text(&text), "monitor": null }))
}

fn copy_image(path: &str) -> bool {
    run::jxa(scripts::COPY_IMAGE, &[path.to_owned()], SCRIPT_DEADLINE)
        .is_some_and(|o| o.ok && o.stdout.trim() == "ok")
}

fn copy_text(text: &str) -> bool {
    run::run(run::PBCOPY, &[], Some(text), SCRIPT_DEADLINE).is_some_and(|o| o.ok)
}
