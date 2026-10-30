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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::proto::{Fail, Notify};
use tools::{Aim, Desk, Front, Kit, Monitor, Recorder, Shooter, Sound, Tuning};

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

/// The portal recording's picture reader and its session: both end when the
/// recording does (ffmpeg has finished its file by then). When the desktop
/// closes the session first, the reader is stopped, its pictures end and
/// ffmpeg ends the file by itself.
struct Reader {
    child: Arc<Mutex<std::process::Child>>,
    _session: portal::Session,
}

impl Reader {
    fn new(child: std::process::Child, session: portal::Session, closed: mpsc::Receiver<()>) -> Reader {
        let child = Arc::new(Mutex::new(child));
        let watched = child.clone();
        std::thread::spawn(move || {
            // Err: the session ended from this side, the reader is already stopped.
            if closed.recv().is_ok() {
                if let Ok(mut c) = watched.lock() {
                    let _ = c.kill();
                }
            }
        });
        Reader { child, _session: session }
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        // A reaped child is never signalled again (Child::kill), so the
        // watcher cannot hit a reused pid.
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// gst-launch with the portal's PipeWire connection as its descriptor
/// `PIPEWIRE_FD` (portal_plan.rs); every other descriptor stays closed.
fn gst_command(launch: &str, args: &[String], fd: &std::os::fd::OwnedFd) -> std::process::Command {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    let raw = fd.as_raw_fd();
    let mut cmd = std::process::Command::new(launch);
    cmd.args(args);
    // SAFETY: between fork and exec only dup2 and fcntl run, both
    // async-signal-safe, on a descriptor this process owns.
    unsafe {
        cmd.pre_exec(move || {
            let target = portal_plan::PIPEWIRE_FD;
            let ok = if raw == target {
                // dup2 onto itself would keep close-on-exec.
                libc::fcntl(raw, libc::F_SETFD, 0) == 0
            } else {
                libc::dup2(raw, target) == target
            };
            if ok {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
    cmd
}

/// wf-recorder's arguments streaming to the replay's cutter.
fn plan_stream(args: Vec<String>, fps: u32) -> Result<Vec<String>, Fail> {
    replay_plan::wf_to_stream(args, fps).ok_or(Fail::code("replay_failed"))
}

fn detect(desk: Desk) -> Kit {
    let w = run::which;
    let mut kit = Kit {
        maim: w("maim"),
        import: w("import"),
        xdotool: w("xdotool"),
        xrandr: w("xrandr"),
        grim: w("grim"),
        slurp: w("slurp"),
        wf_recorder: w("wf-recorder"),
        spectacle: w("spectacle"),
        gnome_screenshot: w("gnome-screenshot"),
        ffmpeg: w("ffmpeg"),
        ffprobe: w("ffprobe"),
        tesseract: w("tesseract"),
        xclip: w("xclip"),
        wl_copy: w("wl-copy"),
        zenity: w("zenity"),
        kdialog: w("kdialog"),
        pactl: w("pactl"),
        kill: w("kill"),
        xinput: w("xinput"),
        xwininfo: w("xwininfo"),
        // Only when the session is theirs: a sway installed beside another
        // desktop knows nothing of its screens.
        swaymsg: w("swaymsg").filter(|_| !env("SWAYSOCK").is_empty()),
        hyprctl: w("hyprctl").filter(|_| !env("HYPRLAND_INSTANCE_SIGNATURE").is_empty()),
        ..Kit::default()
    };
    if let Some(ff) = kit.ffmpeg.clone() {
        let list = |flag: &str| {
            run::run(
                &ff,
                &["-hide_banner".into(), flag.into()],
                None,
                TOOL_DEADLINE,
            )
            .map(|o| o.stdout)
            .unwrap_or_default()
        };
        kit.encoder = tools::pick_encoder(&list("-encoders"));
        let devices = list("-devices");
        kit.x11grab = tools::has_device(&devices, "x11grab");
        kit.pulse = tools::has_device(&devices, "pulse");
    }
    // Only where the portal is the way to record: each element is one
    // gst-inspect call.
    if matches!(desk, Desk::Gnome | Desk::Kde) {
        if let (Some(launch), Some(inspect)) = (w("gst-launch-1.0"), w("gst-inspect-1.0")) {
            let has = |e: &str| {
                let args = vec!["--exists".to_owned(), e.to_owned()];
                run::run(&inspect, &args, None, TOOL_DEADLINE).is_some_and(|o| o.ok)
            };
            kit.gst_launch = portal_plan::reader_found(has).then_some(launch);
        }
    }
    kit
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

    /// `{ target: "screen" | "window", monitor?, path, sound?, mic?, fps?,
    /// height?, quality?, every? }`, as on Windows (`every` = a timelapse,
    /// always silent). The answer says `sound: "system"` when the computer's
    /// sound is recorded.
    pub fn record_start(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        if self.recording() {
            return Err(Fail::code("already_recording"));
        }
        let path = edit::text(req, "path")?;
        let n = |k: &str| req.get(k).and_then(Value::as_u64);
        let tuning = Tuning::parse(n("fps"), n("height"), req.get("quality").and_then(Value::as_str), n("every"));
        let recorder = self
            .kit
            .recorder(self.desk)
            .ok_or(Fail::code("unsupported"))?;
        let flag = |k: &str| tuning.every.is_none() && req.get(k).and_then(Value::as_bool).unwrap_or(false);
        let front = self.front();
        let target = req
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or("screen");
        let part = format!("{path}.part.mp4");
        let (rect, monitor, sound, started) = match recorder {
            Recorder::Ffmpeg => {
                let (rect, monitor) = self.record_rect(req, target, &front)?;
                let sound = Sound {
                    monitor: self.sink_monitor().filter(|_| flag("sound")),
                    mic: flag("mic") && self.kit.pulse,
                };
                let ffmpeg = self.kit.ffmpeg.clone().unwrap_or_default();
                let encoder = self.kit.encoder.unwrap_or("libx264");
                let args = tools::ffmpeg_record_args(&self.display, rect, &tuning, encoder, &sound, &part);
                let r = record::start(&ffmpeg, &args, record::Ending::Quit, &path, &part, tuning.every, notify)?;
                (Some(rect), monitor, sound, r)
            }
            Recorder::Wf => {
                if target != "screen" {
                    return Err(Fail::code("no_window"));
                }
                // The screen asked for, or the focused one. Where the screens
                // cannot be listed, wf-recorder would ask on its input which
                // one: slurp lets the user click the screen to record.
                let listed = self.record_rect(req, target, &front).ok();
                let area = match listed {
                    Some(_) => None,
                    None => self.slurp(true),
                };
                if listed.is_none() && self.kit.slurp.is_some() && area.is_none() {
                    return Err(Fail::code("cancelled"));
                }
                let sound = if flag("mic") {
                    Sound {
                        monitor: None,
                        mic: true,
                    }
                } else {
                    Sound {
                        monitor: self.sink_monitor().filter(|_| flag("sound")),
                        mic: false,
                    }
                };
                let source = if sound.mic {
                    Some("default")
                } else {
                    sound.monitor.as_deref()
                };
                let mut args = tools::wf_record_args(listed.map(|(r, _)| r), source, &tuning, &part);
                if let Some(g) = &area {
                    args.extend(["-g".into(), g.clone()]);
                }
                let kill = self.kit.kill.clone().unwrap_or_default();
                let wf = self.kit.wf_recorder.clone().unwrap_or_default();
                let r = record::start(
                    &wf,
                    &args,
                    record::Ending::Interrupt(kill),
                    &path,
                    &part,
                    tuning.every,
                    notify,
                )?;
                (
                    listed.map(|(r, _)| r),
                    listed.and_then(|(_, m)| m),
                    sound,
                    r,
                )
            }
            Recorder::Portal => {
                // The desktop's dialog picks the screen; no window, no timelapse.
                if target != "screen" {
                    return Err(Fail::code("no_window"));
                }
                if tuning.every.is_some() {
                    return Err(Fail::code("unsupported"));
                }
                let unsupported = || Fail::code("unsupported");
                let launch = self.kit.gst_launch.clone().ok_or_else(unsupported)?;
                let ffmpeg = self.kit.ffmpeg.clone().ok_or_else(unsupported)?;
                let encoder = self.kit.encoder.ok_or_else(unsupported)?;
                let kill = self.kit.kill.clone().unwrap_or_default();
                let sound = Sound {
                    monitor: self.sink_monitor().filter(|_| flag("sound")),
                    mic: flag("mic") && self.kit.pulse,
                };
                let (stream, session) = portal::open()?;
                let size = portal_plan::reader_size(stream.size, &tuning);
                let reader_args = portal_plan::reader_args(stream.node, size, tuning.fps);
                let mut child = gst_command(&launch, &reader_args, &stream.fd)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|e| Fail::new("capture_failed", e))?;
                // gst-launch has its copy of the connection now.
                drop(stream.fd);
                let frames = child.stdout.take();
                // From here on every way out stops the reader (Reader's drop).
                let reader = Reader::new(child, session, stream.closed);
                let frames = frames.ok_or_else(|| Fail::code("capture_failed"))?;
                let keep: Box<dyn Send> = Box::new(reader);
                let mut cmd = std::process::Command::new(&ffmpeg);
                cmd.args(tools::ffmpeg_pipe_args(size, &tuning, encoder, &sound, &part));
                let rect = Some((0, 0, size.0 as i64, size.1 as i64));
                let r = record::start_command(
                    cmd,
                    std::process::Stdio::from(frames),
                    record::Ending::Interrupt(kill),
                    &path,
                    &part,
                    None,
                    Some(keep),
                    notify,
                )?;
                (rect, None, sound, r)
            }
        };
        self.recording = Some(started);
        let (w, h) = rect.map_or((0, 0), |(_, _, w, h)| tuning.size(w, h));
        let mut info = json!({
            "width": w, "height": h, "fps": tuning.fps, "hdr": false, "mic": sound.mic,
            "monitor": monitor, "exe": front.exe,
        });
        if let Some(o) = info.as_object_mut() {
            if sound.monitor.is_some() {
                o.insert("sound".into(), json!("system"));
            }
            if req.get("webcam").is_some() && tuning.every.is_none() {
                o.insert("camera".into(), json!(false));
            }
            if let Some(s) = tuning.every {
                o.insert("every".into(), json!(s));
            }
        }
        Ok(info)
    }

    pub fn record_stop(&mut self) -> Result<Value, Fail> {
        match self.recording.take() {
            Some(r) if r.active() => Ok(r.stop()),
            _ => Err(Fail::code("not_recording")),
        }
    }

    /// `{ dir, seconds, monitor?, fps?, height?, quality?, sound?, mic? }`, as
    /// on Windows: the whole screen, kept as a ring of segments in `dir`.
    pub fn replay_start(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        if self.replaying() {
            return Err(Fail::code("already_running"));
        }
        let recorder = self.kit.recorder(self.desk).ok_or(Fail::code("unsupported"))?;
        let ffmpeg = self.kit.ffmpeg.clone().ok_or(Fail::code("unsupported"))?;
        let dir = edit::text(req, "dir")?;
        let n = |k: &str| req.get(k).and_then(Value::as_u64);
        let tuning = Tuning::parse(n("fps"), n("height"), req.get("quality").and_then(Value::as_str), None);
        let flag = |k: &str, default: bool| req.get(k).and_then(Value::as_bool).unwrap_or(default);
        let front = self.front();
        let screen = self.record_rect(req, "screen", &front);
        let (rect, monitor, sound, source) = match recorder {
            Recorder::Ffmpeg => {
                let (rect, monitor) = screen?;
                let sound = Sound {
                    monitor: self.sink_monitor().filter(|_| flag("sound", true)),
                    mic: flag("mic", false) && self.kit.pulse,
                };
                let encoder = self.kit.encoder.unwrap_or("libx264");
                let args = tools::ffmpeg_record_args(&self.display, rect, &tuning, encoder, &sound, "ring.mp4");
                (Some(rect), monitor, sound, replay::Source::Ffmpeg { program: ffmpeg.clone(), args })
            }
            Recorder::Wf => {
                // The screen asked for, or the focused one; wf-recorder picks
                // the only screen there is when they cannot be listed.
                let listed = screen.ok();
                let sound = Sound {
                    monitor: self.sink_monitor().filter(|_| flag("sound", true) && !flag("mic", false)),
                    mic: flag("mic", false),
                };
                let audio = if sound.mic { Some("default") } else { sound.monitor.as_deref() };
                let args = tools::wf_record_args(listed.map(|(r, _)| r), audio, &tuning, "ring.mp4");
                let args = plan_stream(args, tuning.fps)?;
                let source = replay::Source::Wf {
                    program: self.kit.wf_recorder.clone().unwrap_or_default(),
                    args,
                    kill: self.kit.kill.clone().unwrap_or_default(),
                };
                (listed.map(|(r, _)| r), listed.and_then(|(_, m)| m), sound, source)
            }
            // One portal stream makes one file; there is no ring through it.
            Recorder::Portal => return Err(Fail::code("unsupported")),
        };
        let keep = crate::ring::keep_seconds(n("seconds"));
        let plan = replay::Plan { dir: dir.into(), keep, ffmpeg, source };
        self.replay = Some(replay::start(plan, notify)?);
        let (w, h) = rect.map_or((0, 0), |(_, _, w, h)| tuning.size(w, h));
        let bitrate = crate::video::bitrate(w, h, tuning.fps, tuning.quality);
        let mut info = json!({
            "width": w, "height": h, "fps": tuning.fps, "hdr": false, "bitrate": bitrate,
            "mic": sound.mic, "monitor": monitor,
        });
        if let (Some(o), true) = (info.as_object_mut(), sound.monitor.is_some()) {
            o.insert("sound".into(), json!("system"));
        }
        Ok(info)
    }

    /// `{ path, seconds?, token }`: answers `{ saving: true }` at once; the clip
    /// comes as the event `replay_saved`, as on Windows.
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
        let zenity = self
            .kit
            .zenity
            .clone()
            .filter(|_| self.desk != Desk::Kde || self.kit.kdialog.is_none());
        let Some((program, is_zenity)) =
            zenity
                .map(|z| (z, true))
                .or(self.kit.kdialog.clone().map(|k| (k, false)))
        else {
            return Err(Fail::code("unsupported"));
        };
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
        let start = req
            .get("start")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let args = tools::folder_args(is_zenity, &text("title"), &start);
        let picking = self.picking.clone();
        std::thread::spawn(move || {
            let event = match run::run(&program, &args, None, FOLDER_DEADLINE) {
                Some(o) if o.ok => match o.stdout.trim().trim_end_matches('/') {
                    p if p.starts_with('/') && p.len() > 1 => {
                        json!({ "event": "folder_picked", "path": p })
                    }
                    _ => json!({ "event": "folder_picked", "error": "failed" }),
                },
                // Closed, or left open too long: a change of mind, as on Windows.
                _ => json!({ "event": "folder_picked", "cancelled": true }),
            };
            picking.store(false, Ordering::SeqCst);
            notify(event);
        });
        Ok(json!({ "open": true }))
    }

    fn ffmpeg(&self) -> Result<edit::Ffmpeg, Fail> {
        match (&self.kit.ffmpeg, &self.kit.ffprobe) {
            (Some(ffmpeg), Some(ffprobe)) => Ok(edit::Ffmpeg {
                ffmpeg: ffmpeg.clone(),
                ffprobe: ffprobe.clone(),
            }),
            _ => Err(Fail::code("unsupported")),
        }
    }

    pub fn thumb(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        edit::start_thumb(req, notify, &self.edits, &self.ffmpeg()?)
    }
    pub fn trim(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        edit::start_trim(req, notify, &self.edits, &self.ffmpeg()?)
    }
    pub fn export(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        let encoder = self.kit.encoder.ok_or_else(|| Fail::code("unsupported"))?;
        export::start(req, notify, &self.edits, &self.ffmpeg()?, encoder)
    }
    pub fn export_cancel(&mut self) -> Result<Value, Fail> {
        Ok(export::cancel())
    }
    /// The private spots of a saved picture, or a copy with them covered: see
    /// `cover::start`.
    pub fn cover(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        let tesseract = self.kit.tesseract.clone().ok_or(Fail::code("unsupported"))?;
        let langs = ocr_langs(&tesseract)?;
        cover::start(req, notify, &self.edits, &self.ffmpeg()?, &tesseract, langs)
    }
    pub fn speech(&mut self, req: &Value, notify: Notify) -> Result<Value, Fail> {
        edit::start_speech(req, notify, &self.edits, &self.ffmpeg()?)
    }

    /// `{ paths: [...] }`: saved files onto the clipboard as a file list.
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
        if !self.to_clipboard("text/uri-list", tools::uri_list(&paths).as_bytes()) {
            return Err(Fail::code("clipboard_busy"));
        }
        Ok(json!({ "copied": paths.len() }))
    }

    /// `{ target, monitor?, copy? }`: the text on screen, read by tesseract
    /// from a picture that is deleted right after.
    pub fn ocr(&mut self, req: &Value) -> Result<Value, Fail> {
        let tesseract = self
            .kit
            .tesseract
            .clone()
            .ok_or(Fail::code("unsupported"))?;
        let langs = ocr_langs(&tesseract)?;
        let copy = req.get("copy").and_then(Value::as_bool).unwrap_or(true);
        let tmp = std::env::temp_dir().join(format!("xenon-ocr-{}.png", std::process::id()));
        let tmp = tmp.to_string_lossy().into_owned();
        let read = self.take(req, &self.front(), false, &tmp).map(|shot| {
            shot.map(|shot| {
                let args = vec![tmp.clone(), "stdout".into(), "-l".into(), langs.clone()];
                let lines = run::run(&tesseract, &args, None, OCR_DEADLINE)
                    .filter(|o| o.ok)
                    .map(|o| tools::ocr_lines(&o.stdout));
                (shot, lines)
            })
        });
        let _ = std::fs::remove_file(&tmp);
        let Some((shot, lines)) = read? else {
            return Ok(json!({ "cancelled": true }));
        };
        let lines = lines.ok_or(Fail::code("ocr_failed"))?;
        let text = lines.join("\n");
        let copied = copy
            && !text.is_empty()
            && self.to_clipboard("text/plain;charset=utf-8", text.as_bytes());
        Ok(json!({
            "text": text, "lines": lines.len(), "lang": "", "copied": copied,
            "monitor": shot.monitor,
        }))
    }

    pub fn draw(&mut self, _req: &Value, _notify: Notify) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    /// `{ action: start|stop|toggle, dir }`: see `steps::Steps::start`. X11
    /// only (xinput reads the session's clicks); the pill's words are not used,
    /// there is no pill here.
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
        let tools = self.steps_tools().ok_or(Fail::code("unsupported"))?;
        let dir = req
            .get("dir")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
            .ok_or(Fail::code("bad_request"))?;
        let monitors = self.monitor_list();
        if monitors.is_empty() {
            return Err(Fail::code("no_monitor"));
        }
        let plan = steps::Plan {
            dir: std::path::PathBuf::from(dir),
            tools,
            monitors,
        };
        self.steps = Some(steps::Steps::start(plan, notify)?);
        Ok(json!({ "steps": true }))
    }

    fn steps_tools(&self) -> Option<steps::Tools> {
        if !self.kit.records_steps(self.desk) {
            return None;
        }
        let shooter = self.kit.shooter(self.desk)?;
        let shoot = match shooter {
            Shooter::Maim => self.kit.maim.clone(),
            Shooter::Import => self.kit.import.clone(),
            _ => None,
        }?;
        Some(steps::Tools {
            xinput: self.kit.xinput.clone()?,
            xdotool: self.kit.xdotool.clone()?,
            xwininfo: self.kit.xwininfo.clone(),
            ffmpeg: self.kit.ffmpeg.clone()?,
            shooter,
            shoot,
        })
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

    /// The monitors, where the session can list them: X11 (without xrandr the
    /// whole screen counts as one), sway and Hyprland.
    fn monitor_list(&self) -> Vec<Monitor> {
        let ask = |program: &Option<String>, args: &[&str]| {
            let args: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
            run::run(program.as_deref()?, &args, None, TOOL_DEADLINE)
                .filter(|o| o.ok)
                .map(|o| o.stdout)
        };
        match self.desk {
            Desk::X11 if self.kit.xrandr.is_some() => ask(&self.kit.xrandr, &["--listmonitors"])
                .map(|out| tools::parse_xrandr(&out))
                .unwrap_or_default(),
            Desk::X11 => ask(&self.kit.xdotool, &["getdisplaygeometry"])
                .and_then(|out| tools::parse_display_geometry(&out))
                .into_iter()
                .collect(),
            Desk::Wlroots => ask(&self.kit.swaymsg, &["-t", "get_outputs", "-r"])
                .or_else(|| ask(&self.kit.hyprctl, &["-j", "monitors"]))
                .map(|out| tools::parse_wl_outputs(&out))
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    /// The window in front (X11, through xdotool); its title is never read.
    fn front(&self) -> Front {
        let Some(xdotool) = self
            .kit
            .xdotool
            .as_deref()
            .filter(|_| self.desk == Desk::X11)
        else {
            return Front::default();
        };
        let ask = |args: &[&str]| {
            let args: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
            run::run(xdotool, &args, None, TOOL_DEADLINE)
                .filter(|o| o.ok)
                .map(|o| o.stdout.trim().to_owned())
        };
        let Some(id) = ask(&["getactivewindow"]).and_then(|s| s.parse::<u64>().ok()) else {
            return Front::default();
        };
        let id_s = id.to_string();
        let rect = ask(&["getwindowgeometry", "--shell", &id_s])
            .and_then(|g| tools::parse_xdotool_geometry(&g));
        let exe = ask(&["getwindowpid", &id_s])
            .and_then(|pid| pid.parse::<u32>().ok())
            .and_then(|pid| std::fs::read_to_string(format!("/proc/{pid}/comm")).ok())
            .map(|c| c.trim().chars().take(64).collect())
            .unwrap_or_default();
        Front { id, exe, rect }
    }

    /// The monitor asked for, or the one the window in front is on.
    fn pick_monitor<'a>(
        list: &'a [Monitor],
        req: &Value,
        front: &Front,
    ) -> Result<&'a Monitor, Fail> {
        match req.get("monitor").and_then(Value::as_u64) {
            Some(i) => list.iter().find(|m| m.index as u64 == i),
            None => tools::monitor_at(list, front.centre()),
        }
        .ok_or(Fail::code("no_monitor"))
    }

    fn record_rect(
        &self,
        req: &Value,
        target: &str,
        front: &Front,
    ) -> Result<(Rect, Option<usize>), Fail> {
        let list = self.monitor_list();
        match target {
            "window" => {
                let rect = front
                    .rect
                    .and_then(|r| tools::clip_to_screen(r, &list))
                    .ok_or(Fail::code("no_window"))?;
                Ok((
                    rect,
                    tools::monitor_at(&list, front.centre()).map(|m| m.index),
                ))
            }
            "screen" => {
                let m = Self::pick_monitor(&list, req, front)?;
                Ok(((m.x, m.y, m.width, m.height), Some(m.index)))
            }
            _ => Err(Fail::code("bad_request")),
        }
    }

    /// slurp's area (or, with `output`, a click on a screen); None when the
    /// user left it, or there is no slurp.
    fn slurp(&self, output: bool) -> Option<String> {
        let slurp = self.kit.slurp.as_deref()?;
        let args: Vec<String> = if output {
            vec!["-o".into()]
        } else {
            Vec::new()
        };
        run::run(slurp, &args, None, PICK_DEADLINE)
            .filter(|o| o.ok)
            .and_then(|o| tools::parse_slurp(&o.stdout))
    }

    fn sink_monitor(&self) -> Option<String> {
        if !self.kit.pulse && self.kit.wf_recorder.is_none() {
            return None;
        }
        let pactl = self.kit.pactl.as_deref()?;
        run::run(pactl, &["info".into()], None, TOOL_DEADLINE)
            .filter(|o| o.ok)
            .and_then(|o| tools::parse_default_sink_monitor(&o.stdout))
    }

    /// The aim of one picture, its monitor and how long it may take; None when
    /// the user left the area picker.
    fn plan(&self, req: &Value, front: &Front) -> Result<Option<Plan>, Fail> {
        let shooter = self.kit.shooter(self.desk);
        let target = req
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or("screen");
        let plan = |aim, monitor, area, deadline| Plan {
            aim,
            monitor,
            area,
            deadline,
        };
        Ok(Some(match (target, shooter) {
            ("window", Some(Shooter::Maim | Shooter::Import)) if front.id != 0 => {
                let list = self.monitor_list();
                let m = tools::monitor_at(&list, front.centre()).map(|m| m.index);
                plan(Aim::Window(front.id), m, None, SHOT_DEADLINE)
            }
            ("window", Some(Shooter::Spectacle | Shooter::GnomeShot)) => {
                plan(Aim::Window(0), None, None, SHOT_DEADLINE)
            }
            ("window", _) => return Err(Fail::code("no_window")),
            ("screen", _) => {
                let list = self.monitor_list();
                if list.is_empty() {
                    plan(Aim::Screen(None), None, None, SHOT_DEADLINE)
                } else {
                    let m = Self::pick_monitor(&list, req, front)?;
                    plan(
                        Aim::Screen(Some((m.x, m.y, m.width, m.height))),
                        Some(m.index),
                        None,
                        SHOT_DEADLINE,
                    )
                }
            }
            ("region", Some(Shooter::Grim)) => match self.slurp(false) {
                Some(area) => plan(Aim::Pick, None, Some(area), SHOT_DEADLINE),
                None => return Ok(None),
            },
            ("region", _) => plan(Aim::Pick, None, None, PICK_DEADLINE),
            _ => return Err(Fail::code("bad_request")),
        }))
    }

    /// One picture to `path` (through `path.part.png`, the tools pick the
    /// format by the name); None when the user left the area picker.
    fn take(
        &self,
        req: &Value,
        front: &Front,
        cursor: bool,
        path: &str,
    ) -> Result<Option<Shot>, Fail> {
        let shooter = self
            .kit
            .shooter(self.desk)
            .ok_or(Fail::code("unsupported"))?;
        let program = match shooter {
            Shooter::Maim => self.kit.maim.clone(),
            Shooter::Import => self.kit.import.clone(),
            Shooter::Grim => self.kit.grim.clone(),
            Shooter::Spectacle => self.kit.spectacle.clone(),
            Shooter::GnomeShot => self.kit.gnome_screenshot.clone(),
        }
        .unwrap_or_default();
        let Some(Plan {
            aim,
            monitor,
            area,
            deadline,
        }) = self.plan(req, front)?
        else {
            return Ok(None);
        };
        let part = format!("{path}.part.png");
        let _ = std::fs::remove_file(&part);
        let ran = run::run(
            &program,
            &tools::shot_args(shooter, &aim, cursor, &part, area.as_deref()),
            None,
            deadline,
        );
        let head = std::fs::read(&part)
            .ok()
            .map(|b| b[..b.len().min(32)].to_vec());
        let Some((width, height)) = head.as_deref().and_then(tools::png_size) else {
            let _ = std::fs::remove_file(&part);
            // A picker closed with Esc writes nothing: a change of mind, not a failure.
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

    fn to_clipboard(&self, mime: &str, bytes: &[u8]) -> bool {
        let Some(tool) = self.kit.clipboard(self.desk) else {
            return false;
        };
        let args: Vec<String> = if self.desk == Desk::X11 {
            vec![
                "-selection".into(),
                "clipboard".into(),
                "-t".into(),
                mime.into(),
            ]
        } else {
            vec!["--type".into(), mime.into()]
        };
        run::run_quiet(tool, &args, Some(bytes), TOOL_DEADLINE)
    }

    fn copy_image(&self, path: &str) -> bool {
        std::fs::read(path).is_ok_and(|bytes| self.to_clipboard("image/png", &bytes))
    }
}
