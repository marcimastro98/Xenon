// Linux: the other things the engine is asked for: a folder, copies, edits, reading text, drawing, steps.

use std::sync::atomic::Ordering;
use serde_json::{json, Value};
use crate::proto::{Fail, Notify};
use super::{Backend, cover, edit, export, FOLDER_DEADLINE, HINT_MAX, OCR_DEADLINE, ocr_langs, run, steps, tools};
use super::tools::{Desk, Shooter};

impl Backend {
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

    pub(super) fn ffmpeg(&self) -> Result<edit::Ffmpeg, Fail> {
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
}
