// Windows: starting and stopping a recording and the replay buffer.

use serde_json::{json, Value};
use windows::Win32::Graphics::Gdi::{MONITOR_DEFAULTTONEAREST, MonitorFromWindow};
use crate::proto::{Fail, Notify};
use super::{Backend, grab, monitors, pick_monitor, record, window};

impl Backend {
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
}
