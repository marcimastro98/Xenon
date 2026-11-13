// macOS: starting and stopping a recording and the replay buffer.

use serde_json::{json, Value};
use crate::proto::{Fail, Notify};
use super::{Backend, capture, edit, record, Recording, replay, replay_plan, sck, tools};
use super::shots::{Aimed, front, kit_target, monitors, pick_monitor, tuned};
use super::tools::Aim;

impl Backend {
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

    pub(super) fn replaying(&self) -> bool {
        self.replay.as_ref().is_some_and(replay::Replay::active)
    }
}
