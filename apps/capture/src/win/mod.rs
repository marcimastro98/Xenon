//! Windows backend: Windows.Graphics.Capture, Direct3D 11, WIC and Media Foundation.

mod clipboard;
mod cover;
mod d3d;
mod dib;
mod draw;
mod edit;
mod export;
mod folder;
mod grab;
mod loupe;
mod monitors;
mod ocr;
mod picker;
mod png;
mod record;
mod speech;
mod steps;
mod window;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use serde_json::{json, Value};
use windows::Graphics::Capture::GraphicsCaptureAccess;
use windows::Graphics::Capture::GraphicsCaptureAccessKind;
use windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};

use crate::inspect;
use crate::proto::{Fail, Notify};
use crate::region::{self, Rect};

/// The hint line the server sends for the area picker, in the user's language.
const HINT_MAX: usize = 160;

/// How long a window may take to be captured on its own before its monitor is
/// used instead. A window that answers gives its frame in well under 200 ms.
const WINDOW_ALONE_DEADLINE: Duration = Duration::from_secs(1);
/// The window alone gives up on its first frame before that deadline, so a
/// window that never sends one leaves the worker free for the next capture.
const WINDOW_ALONE_WAIT: Duration = Duration::from_millis(700);

type WindowJob = (isize, grab::Options, mpsc::Sender<Option<grab::Image>>);

/// Captures windows on a thread of its own, with a device of its own: an app
/// that freezes while its window is being captured can block a capture call
/// for many seconds (measured past 15 s). The engine stops waiting at the
/// deadline and starts a fresh worker; the stuck one ends by itself once its
/// call returns and finds nobody listening.
struct WindowWorker {
    jobs: mpsc::Sender<WindowJob>,
}

impl WindowWorker {
    fn start() -> WindowWorker {
        let (jobs, rx) = mpsc::channel::<WindowJob>();
        std::thread::spawn(move || {
            unsafe {
                let _ = RoInitialize(RO_INIT_MULTITHREADED);
            }
            let mut dev = None;
            for (raw, opts, reply) in rx {
                if dev.is_none() {
                    dev = d3d::create().ok();
                }
                let target = grab::Target::Window(HWND(raw as *mut core::ffi::c_void));
                let shot = dev
                    .as_ref()
                    .and_then(|d| grab::grab(d, &target, &opts).ok());
                if reply.send(shot).is_err() {
                    return;
                }
            }
        });
        WindowWorker { jobs }
    }
}

struct Shot {
    image: grab::Image,
    hdr: bool,
    monitor: Option<usize>,
    /// Put on the clipboard too (`copy`: the area picker does it while its
    /// window, the clipboard's owner, still exists).
    copied: bool,
}

/// Writes the PNG next to its final name first, so a half-written file never
/// carries the real name.
fn save(path: &str, image: &grab::Image) -> Result<(), Fail> {
    let part = format!("{path}.part");
    png::write(&part, image.width, image.height, &image.bgr)
        .map_err(|e| Fail::new("write_failed", e))?;
    std::fs::rename(&part, path).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        Fail::new("write_failed", e)
    })
}

pub struct Backend {
    device: Option<d3d::Device>,
    window_worker: Option<WindowWorker>,
    recording: Option<record::Recording>,
    replay: Option<record::replay::Replay>,
    /// Drawing on the screen, while open.
    drawing: Option<draw::Drawing>,
    /// The steps recorder, while it runs.
    steps: Option<steps::Steps>,
    borderless: bool,
    /// The folder dialog is open (one at a time).
    picking: Arc<AtomicBool>,
    /// Gallery previews and trims running now.
    edits: edit::Jobs,
}

impl Backend {
    pub fn new() -> Backend {
        unsafe {
            // Physical pixels everywhere, so a window rect matches its frame.
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
        // Without this the capture draws a yellow frame round the screen for the
        // instant it runs. Windows 11 grants it to a desktop app without asking;
        // Windows 10 has no such call and keeps its border.
        let borderless =
            GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless)
                .and_then(|op| op.join())
                .map(|s| s == AppCapabilityAccessStatus::Allowed)
                .unwrap_or(false);
        Backend {
            device: None,
            window_worker: None,
            recording: None,
            replay: None,
            drawing: None,
            steps: None,
            borderless,
            picking: Arc::new(AtomicBool::new(false)),
            edits: edit::Jobs::default(),
        }
    }

    fn device(&mut self) -> Result<&d3d::Device, Fail> {
        if self.device.is_none() {
            self.device = Some(d3d::create().map_err(|e| Fail::new("no_gpu", e))?);
        }
        Ok(self.device.as_ref().unwrap())
    }

    pub fn monitors(&self) -> Value {
        let list: Vec<Value> = monitors::list()
            .iter()
            .map(|m| {
                json!({
                    "index": m.index, "name": m.name, "primary": m.primary, "hdr": m.hdr,
                    "x": m.rect.left, "y": m.rect.top,
                    "width": m.rect.right - m.rect.left, "height": m.rect.bottom - m.rect.top,
                })
            })
            .collect();
        json!({
            "monitors": list, "supported": grab::supported(), "borderless": self.borderless,
            "ocr": ocr::available(),
        })
    }

    /// `{ target: "screen" | "window" | "region", monitor?: index, path, cursor?, copy?, hint? }`;
    /// `copy` and `hint` are for "region".
    /// "screen" without a monitor is the one the foreground window is on;
    /// "region" lets the user pick an area on the frozen screens and answers
    /// `{ cancelled: true }` when they change their mind.
    pub fn screenshot(&mut self, req: &Value) -> Result<Value, Fail> {
        if !grab::supported() {
            return Err(Fail::code("unsupported"));
        }
        let path = req
            .get("path")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
            .ok_or(Fail::code("bad_request"))?;
        let cursor = req.get("cursor").and_then(Value::as_bool).unwrap_or(false);
        let copy = req.get("copy").and_then(Value::as_bool).unwrap_or(false);
        let exe = window::foreground()
            .map(window::exe_name)
            .unwrap_or_default();
        let Some(shot) = self.take(req, cursor, copy)? else {
            return Ok(json!({ "cancelled": true }));
        };
        save(path, &shot.image)?;
        Ok(json!({
            "width": shot.image.width, "height": shot.image.height, "hdr": shot.hdr,
            "monitor": shot.monitor, "exe": exe, "copied": shot.copied,
        }))
    }

    /// `{ target: "screen" | "window", monitor?: index, path, fps?: 30 | 60,
    /// height?: 720 | 1080 | 1440, quality?: "small" | "normal" | "high",
    /// badge?: bool, sound?: bool, mic?: bool, every?: 1 | 2 | 5 | 10 | 30 | 60,
    /// webcam?: "tl" | "tr" | "bl" | "br" }`.
    /// `every` makes a timelapse: one silent picture that often, played at 30 fps.
    /// `webcam` puts the camera in a round bubble in that corner (never in a
    /// timelapse); the answer says `camera: false` when none could be opened.
    /// One recording at a time; a second start answers `already_recording`.
    pub fn record_start(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        if self.recording() {
            return Err(Fail::code("already_recording"));
        }
        if !grab::supported() {
            return Err(Fail::code("unsupported"));
        }
        let path = req
            .get("path")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
            .ok_or(Fail::code("bad_request"))?;
        let list = monitors::list();
        let exe = window::foreground()
            .map(window::exe_name)
            .unwrap_or_default();
        let (aim, mon) = match req
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or("screen")
        {
            "window" => {
                let h = window::foreground().ok_or(Fail::code("no_window"))?;
                let hm = unsafe { MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) };
                let mon = list.iter().find(|m| m.handle == hm);
                (record::Aim::Window(h.0 as isize), mon)
            }
            "screen" => {
                let m = pick_monitor(&list, req.get("monitor").and_then(Value::as_u64))?;
                (record::Aim::Monitor(m.handle.0 as isize), Some(m))
            }
            _ => return Err(Fail::code("bad_request")),
        };
        let every = crate::video::lapse_every(req.get("every").and_then(Value::as_u64));
        let plan = record::Plan {
            aim,
            hdr_white: mon.filter(|m| m.hdr).map(|m| m.white),
            room: mon.map_or((0, 0), |m| {
                let r = m.rect;
                (
                    (r.right - r.left).max(0) as u32,
                    (r.bottom - r.top).max(0) as u32,
                )
            }),
            path: path.to_string(),
            fps: match every {
                Some(_) => crate::video::LAPSE_FPS,
                None => crate::video::fps(req.get("fps").and_then(Value::as_u64)),
            },
            height: crate::video::height_cap(req.get("height").and_then(Value::as_u64)),
            quality: crate::video::Quality::parse(req.get("quality").and_then(Value::as_str)),
            badge: req.get("badge").and_then(Value::as_bool).unwrap_or(true),
            // A timelapse is silent: sound at 10x or 300x speed is noise.
            audio: record::Wanted {
                sound: every.is_none() && req.get("sound").and_then(Value::as_bool).unwrap_or(true),
                mic: every.is_none() && req.get("mic").and_then(Value::as_bool).unwrap_or(false),
            },
            every,
            webcam: every
                .is_none()
                .then(|| crate::bubble::Corner::parse(req.get("webcam").and_then(Value::as_str)))
                .flatten(),
        };
        let (recording, mut info) = record::start(plan, notify)?;
        self.recording = Some(recording);
        if let Some(o) = info.as_object_mut() {
            o.insert("monitor".into(), json!(mon.map(|m| m.index)));
            o.insert("exe".into(), json!(exe));
            if let Some(s) = every {
                o.insert("every".into(), json!(s));
            }
        }
        Ok(info)
    }

    /// Ends the recording: `{ reason, seconds, frames, dropped, bytes }`.
    pub fn record_stop(&mut self) -> Result<Value, Fail> {
        match self.recording.take() {
            Some(r) if r.active() => Ok(r.stop()),
            // It already ended by itself and said so with an event.
            _ => Err(Fail::code("not_recording")),
        }
    }

    /// Instant Replay: `{ monitor?: index, dir, seconds?, fps?, height?, quality?,
    /// sound?: bool, mic?: bool }`. Records that monitor (without one, the one
    /// the window in front is on) into a ring of segments in `dir`, keeping
    /// the last `seconds`. One at a time, beside a recording.
    pub fn replay_start(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        if self.replaying() {
            return Err(Fail::code("already_running"));
        }
        if !grab::supported() {
            return Err(Fail::code("unsupported"));
        }
        let dir = req
            .get("dir")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
            .ok_or(Fail::code("bad_request"))?;
        std::fs::create_dir_all(dir).map_err(|e| Fail::new("write_failed", e))?;
        let list = monitors::list();
        let m = pick_monitor(&list, req.get("monitor").and_then(Value::as_u64))?;
        let r = m.rect;
        let plan = record::replay::Plan {
            monitor: m.handle.0 as isize,
            hdr_white: m.hdr.then_some(m.white),
            room: (
                (r.right - r.left).max(0) as u32,
                (r.bottom - r.top).max(0) as u32,
            ),
            dir: std::path::PathBuf::from(dir),
            fps: crate::video::fps(req.get("fps").and_then(Value::as_u64)),
            height: crate::video::height_cap(req.get("height").and_then(Value::as_u64)),
            quality: crate::video::Quality::parse(req.get("quality").and_then(Value::as_str)),
            audio: record::Wanted {
                sound: req.get("sound").and_then(Value::as_bool).unwrap_or(true),
                mic: req.get("mic").and_then(Value::as_bool).unwrap_or(false),
            },
            keep: crate::ring::keep_seconds(req.get("seconds").and_then(Value::as_u64)),
        };
        let (replay, mut info) = record::replay::start(plan, notify)?;
        self.replay = Some(replay);
        if let Some(o) = info.as_object_mut() {
            o.insert("monitor".into(), json!(m.index));
        }
        Ok(info)
    }

    /// `{ path, seconds?, token }`: answers `{ saving: true }` at once; the
    /// clip comes as an event `{ event: "replay_saved", token, ok, seconds,
    /// bytes }` or `{ ..., ok: false, error }`. `seconds` (default: all that
    /// is kept) may be shorter than the replay's length.
    pub fn replay_save(&mut self, req: &Value) -> Result<Value, Fail> {
        let replay = self
            .replay
            .as_ref()
            .filter(|r| r.active())
            .ok_or(Fail::code("not_running"))?;
        let path = req
            .get("path")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
            .ok_or(Fail::code("bad_request"))?;
        let seconds = req
            .get("seconds")
            .and_then(Value::as_u64)
            .map_or(crate::ring::MAX_SECONDS, |s| {
                crate::ring::keep_seconds(Some(s))
            });
        let token = req
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(64)
            .collect();
        replay.save(path.to_string(), seconds, token)?;
        Ok(json!({ "saving": true }))
    }

    /// `{ seconds }`: a new length for the running replay.
    pub fn replay_keep(&mut self, req: &Value) -> Result<Value, Fail> {
        let replay = self
            .replay
            .as_ref()
            .filter(|r| r.active())
            .ok_or(Fail::code("not_running"))?;
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

    pub fn replaying(&self) -> bool {
        self.replay
            .as_ref()
            .is_some_and(record::replay::Replay::active)
    }

    /// The system's folder dialog, for the recordings folder: `{ title?, start? }`
    /// answers `{ open: true }` at once (also when it is already open); the
    /// choice comes as an event line `{ event: "folder_picked", path }`, or
    /// `cancelled: true` (also when left open too long), or `error`.
    pub fn pick_folder(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        if self.picking.swap(true, Ordering::SeqCst) {
            return Ok(json!({ "open": true }));
        }
        let text = |k: &str| {
            req.get(k)
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(HINT_MAX)
                .collect::<String>()
        };
        let title = text("title");
        let start = req
            .get("start")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let picking = self.picking.clone();
        std::thread::spawn(move || {
            let event = match folder::pick(&title, &start) {
                Ok(folder::Picked::Folder(path)) => {
                    json!({ "event": "folder_picked", "path": path })
                }
                Ok(folder::Picked::Cancelled) => {
                    json!({ "event": "folder_picked", "cancelled": true })
                }
                Err(_) => json!({ "event": "folder_picked", "error": "failed" }),
            };
            picking.store(false, Ordering::SeqCst);
            notify(event);
        });
        Ok(json!({ "open": true }))
    }

    /// A gallery preview: see `edit::start_thumb`.
    pub fn thumb(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        edit::start_thumb(req, notify, &self.edits)
    }

    /// A trimmed copy of a video: see `edit::start_trim`.
    pub fn trim(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        edit::start_trim(req, notify, &self.edits)
    }

    /// A vertical, smaller or GIF copy of a video: see `export::start_export`.
    pub fn export(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        export::start_export(req, notify, &self.edits)
    }

    pub fn export_cancel(&mut self) -> Result<Value, Fail> {
        Ok(export::cancel_export())
    }

    /// The private spots of a saved picture, or a copy with them covered: see
    /// `cover::start`.
    pub fn cover(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        cover::start(req, notify, &self.edits)
    }

    /// A saved video's sound as a WAV for speech recognition: see `speech::start`.
    pub fn speech(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        speech::start(req, notify, &self.edits)
    }

    /// `{ paths: [...] }`: saved files onto the clipboard, as Explorer copies them.
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
        if !clipboard::copy_files(&paths) {
            return Err(Fail::code("clipboard_busy"));
        }
        Ok(json!({ "copied": paths.len() }))
    }

    /// `{ target: "screen" | "window" | "region", monitor?, hint?, copy? }`: the
    /// text on screen, read by Windows' own OCR. Nothing is saved; the text goes
    /// on the clipboard unless `copy` is false, and comes back in the answer.
    /// `{ cancelled: true }` when the user leaves the area picker.
    pub fn ocr(&mut self, req: &Value) -> Result<Value, Fail> {
        if !grab::supported() {
            return Err(Fail::code("unsupported"));
        }
        // Before the picker: no language pack means nothing to pick for.
        let engine = ocr::engine().ok_or(Fail::code("no_ocr_language"))?;
        let copy = req.get("copy").and_then(Value::as_bool).unwrap_or(true);
        let Some(shot) = self.take(req, false, false)? else {
            return Ok(json!({ "cancelled": true }));
        };
        let read = ocr::read(&engine, &shot.image)?;
        let copied = copy && !read.text.is_empty() && clipboard::copy_text(&read.text);
        Ok(json!({
            "text": read.text, "lines": read.lines, "lang": read.lang, "copied": copied,
            "monitor": shot.monitor,
        }))
    }

    /// `{ mode: "colour" | "measure", format?: "hex" | "rgb" | "hsl", hint? }`: the
    /// colour picker or the ruler on the frozen screen. The colour (in `format`)
    /// or the size goes on the clipboard and comes back in the answer; nothing
    /// is saved. `{ cancelled: true }` when the user leaves.
    pub fn inspect(&mut self, req: &Value) -> Result<Value, Fail> {
        if !grab::supported() {
            return Err(Fail::code("unsupported"));
        }
        let mode = match req.get("mode").and_then(Value::as_str) {
            Some("colour") => picker::Mode::Colour,
            Some("measure") => picker::Mode::Measure,
            _ => return Err(Fail::code("bad_request")),
        };
        let format = match req.get("format").and_then(Value::as_str) {
            None => inspect::Format::Hex,
            Some(f) => inspect::Format::parse(f).ok_or(Fail::code("bad_request"))?,
        };
        let hint: String = req
            .get("hint")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(HINT_MAX)
            .collect();
        let frozen = self.freeze(&monitors::list())?;
        Ok(match picker::inspect(&frozen, &hint, mode) {
            None => json!({ "cancelled": true }),
            Some(picker::Inspected::Colour { monitor, rgb }) => {
                let text = inspect::text(rgb, format);
                json!({
                    "rgb": rgb, "hex": inspect::hex(rgb), "text": text,
                    "copied": clipboard::copy_text(&text), "monitor": monitor,
                })
            }
            Some(picker::Inspected::Size {
                monitor,
                width,
                height,
            }) => {
                let text = inspect::size_text(width, height);
                json!({
                    "width": width, "height": height, "text": text,
                    "copied": clipboard::copy_text(&text), "monitor": monitor,
                })
            }
        })
    }

    /// `{ action: "start" | "stop" | "toggle", hint? }`: drawing on the monitor
    /// under the pointer. Answers `{ drawing }`; when it ends by itself the
    /// event `draw_ended` says why ("closed" by the user, "stopped" by us).
    pub fn draw(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        let open = self.drawing();
        let start = match req.get("action").and_then(Value::as_str) {
            Some("start") => true,
            Some("stop") => false,
            Some("toggle") => !open,
            _ => return Err(Fail::code("bad_request")),
        };
        if !start {
            self.drawing = None;
            return Ok(json!({ "drawing": false }));
        }
        if open {
            return Ok(json!({ "drawing": true }));
        }
        let hint: String = req
            .get("hint")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(HINT_MAX)
            .collect();
        let on_end: draw::OnEnd = Box::new(move |reason| {
            notify(json!({ "event": "draw_ended", "reason": reason }));
        });
        self.drawing = Some(draw::Drawing::show(hint, on_end).ok_or(Fail::code("draw_failed"))?);
        Ok(json!({ "drawing": true }))
    }

    /// `{ action: "start" | "stop" | "toggle", dir?, badge? }`: the steps
    /// recorder. `dir` (for a start) is the folder the steps are saved in,
    /// `badge` the pill's words with `{n}` for the count. Answers `{ steps }`;
    /// each step and the end come as events (`step`, `steps_ended`).
    pub fn steps(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        let running = self.steps_running();
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
        if !grab::supported() {
            return Err(Fail::code("unsupported"));
        }
        let dir = req
            .get("dir")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
            .ok_or(Fail::code("bad_request"))?;
        let template: String = req
            .get("badge")
            .and_then(Value::as_str)
            .unwrap_or("{n}")
            .chars()
            .take(HINT_MAX)
            .collect();
        let plan = steps::Plan {
            dir: std::path::PathBuf::from(dir),
            template,
        };
        self.steps = Some(steps::Steps::start(plan, notify)?);
        Ok(json!({ "steps": true }))
    }

    pub fn steps_running(&self) -> bool {
        self.steps.as_ref().is_some_and(steps::Steps::active)
    }

    pub fn drawing(&self) -> bool {
        self.drawing.as_ref().is_some_and(draw::Drawing::active)
    }

    /// The picture a screenshot or a text read starts from; None when the user
    /// left the area picker.
    fn take(&mut self, req: &Value, cursor: bool, copy: bool) -> Result<Option<Shot>, Fail> {
        let list = monitors::list();
        match req
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or("screen")
        {
            "window" => self.shot_window(&list, cursor).map(Some),
            "screen" => self
                .shot_screen(&list, req.get("monitor").and_then(Value::as_u64), cursor)
                .map(Some),
            "region" => {
                let hint: String = req
                    .get("hint")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .take(HINT_MAX)
                    .collect();
                self.shot_region(&list, &hint, copy)
            }
            _ => Err(Fail::code("bad_request")),
        }
    }

    /// Recording, recording steps, drawing, the folder dialog open or a gallery job running: the engine
    /// must not exit for idleness.
    pub fn busy(&self) -> bool {
        self.recording()
            || self.replaying()
            || self.drawing()
            || self.steps_running()
            || self.picking.load(Ordering::SeqCst)
            || self.edits.load(Ordering::SeqCst) > 0
    }

    pub fn recording(&self) -> bool {
        self.recording
            .as_ref()
            .is_some_and(record::Recording::active)
    }

    /// The server went away: a recording in progress is finished properly.
    pub fn shutdown(&mut self) {
        if let Some(r) = self.recording.take() {
            r.stop();
        }
        if let Some(r) = self.replay.take() {
            r.stop();
        }
        self.drawing = None;
        self.steps = None;
    }

    fn shot_window(&mut self, list: &[monitors::Monitor], cursor: bool) -> Result<Shot, Fail> {
        let h: HWND = window::foreground().ok_or(Fail::code("no_window"))?;
        let hm = unsafe { MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) };
        let mon = list.iter().find(|m| m.handle == hm);
        let hdr_white = mon.filter(|m| m.hdr).map(|m| m.white);
        let opts = grab::Options {
            hdr_white,
            cursor,
            crop: None,
            wait: grab::FIRST_FRAME_TIMEOUT,
        };
        let image = self.grab_window(h, mon, opts)?;
        Ok(Shot {
            image,
            hdr: hdr_white.is_some(),
            monitor: mon.map(|m| m.index),
            copied: false,
        })
    }

    fn shot_screen(
        &mut self,
        list: &[monitors::Monitor],
        index: Option<u64>,
        cursor: bool,
    ) -> Result<Shot, Fail> {
        let m = pick_monitor(list, index)?;
        let hdr_white = m.hdr.then_some(m.white);
        let opts = grab::Options {
            hdr_white,
            cursor,
            crop: None,
            wait: grab::FIRST_FRAME_TIMEOUT,
        };
        let image = self.grab(&grab::Target::Monitor(m.handle), &opts)?;
        Ok(Shot {
            image,
            hdr: m.hdr,
            monitor: Some(m.index),
            copied: false,
        })
    }

    /// Freezes every monitor, then lets the user pick on the frozen images.
    /// The windows a click can pick are read at the same moment, so they
    /// match the picture even when they move meanwhile.
    fn shot_region(
        &mut self,
        list: &[monitors::Monitor],
        hint: &str,
        copy: bool,
    ) -> Result<Option<Shot>, Fail> {
        let frozen = self.freeze(list)?;
        let stack = window::stack();
        let Some(p) = picker::pick(&frozen, stack, hint, copy) else {
            return Ok(None);
        };
        let hdr = list.iter().any(|m| m.index == p.monitor && m.hdr);
        Ok(Some(Shot {
            image: p.image,
            hdr,
            monitor: Some(p.monitor),
            copied: p.copied,
        }))
    }

    /// Every monitor as it is now, for the pickers.
    fn freeze(&mut self, list: &[monitors::Monitor]) -> Result<Vec<picker::Frozen>, Fail> {
        let mut frozen = Vec::new();
        for m in list {
            let opts = grab::Options {
                hdr_white: m.hdr.then_some(m.white),
                cursor: false,
                crop: None,
                wait: grab::FIRST_FRAME_TIMEOUT,
            };
            // A monitor that cannot be captured is left out, not the whole pick.
            if let Ok(image) = self.grab(&grab::Target::Monitor(m.handle), &opts) {
                let r = m.rect;
                frozen.push(picker::Frozen {
                    monitor: m.index,
                    rect: Rect {
                        left: r.left,
                        top: r.top,
                        right: r.right,
                        bottom: r.bottom,
                    },
                    image,
                });
            }
        }
        if frozen.is_empty() {
            return Err(Fail::code("capture_failed"));
        }
        Ok(frozen)
    }

    /// One frame with the engine's own device.
    fn grab(&mut self, target: &grab::Target, opts: &grab::Options) -> Result<grab::Image, Fail> {
        let shot = grab::grab(self.device()?, target, opts);
        shot.map_err(|e| {
            // A lost GPU (driver reset, adapter unplugged) is recreated next time.
            self.device = None;
            Fail::new("capture_failed", e)
        })
    }

    /// A window on its own; cut out of its monitor when its app is frozen, or the
    /// window alone gives no frame in time. The monitor still shows what the
    /// window last drew, which is what the user sees.
    fn grab_window(
        &mut self,
        h: HWND,
        mon: Option<&monitors::Monitor>,
        opts: grab::Options,
    ) -> Result<grab::Image, Fail> {
        if window::responsive(h) {
            if let Some(image) = self.window_alone(h, opts) {
                return Ok(image);
            }
        }
        let m = mon.ok_or(Fail::code("capture_failed"))?;
        let r = m.rect;
        let crop = window::bounds(h)
            .and_then(|b| {
                region::within(
                    b,
                    Rect {
                        left: r.left,
                        top: r.top,
                        right: r.right,
                        bottom: r.bottom,
                    },
                )
            })
            .ok_or(Fail::code("capture_failed"))?;
        self.grab(
            &grab::Target::Monitor(m.handle),
            &grab::Options {
                crop: Some(crop),
                ..opts
            },
        )
    }

    fn window_alone(&mut self, h: HWND, opts: grab::Options) -> Option<grab::Image> {
        let worker = self.window_worker.get_or_insert_with(WindowWorker::start);
        let (reply, rx) = mpsc::channel();
        let job = (
            h.0 as isize,
            grab::Options {
                wait: WINDOW_ALONE_WAIT,
                ..opts
            },
            reply,
        );
        if worker.jobs.send(job).is_err() {
            self.window_worker = None;
            return None;
        }
        rx.recv_timeout(WINDOW_ALONE_DEADLINE).unwrap_or_else(|_| {
            self.window_worker = None; // stuck in a call: a fresh worker next time
            None
        })
    }
}

/// The monitor asked for, or the one the foreground window is on.
fn pick_monitor(
    list: &[monitors::Monitor],
    index: Option<u64>,
) -> Result<&monitors::Monitor, Fail> {
    match index {
        Some(i) => list.iter().find(|m| m.index as u64 == i),
        None => {
            let active = window::active_monitor();
            list.iter().find(|m| m.handle == active).or(list.first())
        }
    }
    .ok_or(Fail::code("no_monitor"))
}
