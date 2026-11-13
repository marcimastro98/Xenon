// macOS: the other things the engine is asked for: a folder, copies, edits, reading text, inspecting, drawing, steps.

use std::sync::atomic::Ordering;
use serde_json::{json, Value};
use crate::proto::{Fail, Notify};
use super::{Backend, cover, edit, export, FOLDER_DEADLINE, HINT_MAX, OCR_DEADLINE, PICK_DEADLINE, run, SAMPLER_OPEN, SCRIPT_DEADLINE, scripts, steps, tools};
use super::shots::{copy_text, front, measure, monitors, take};

impl Backend {
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
}
