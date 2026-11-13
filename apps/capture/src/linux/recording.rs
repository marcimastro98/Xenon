// Linux: starting and stopping a recording and the replay buffer.

use serde_json::{json, Value};
use crate::proto::{Fail, Notify};
use super::{Backend, edit, plan_stream, portal, portal_plan, record, replay, tools};
use super::reader::{gst_command, Reader};
use super::tools::{Recorder, Sound, Tuning};

impl Backend {
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

    pub(super) fn replaying(&self) -> bool {
        self.replay.as_ref().is_some_and(replay::Replay::active)
    }
}
