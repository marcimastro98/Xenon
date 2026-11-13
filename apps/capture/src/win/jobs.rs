// Windows: the other things the engine is asked for: a folder, copies, edits, reading text, inspecting, drawing, steps.

use std::sync::atomic::Ordering;
use serde_json::{json, Value};
use crate::inspect;
use crate::proto::{Fail, Notify};
use super::{Backend, clipboard, cover, draw, edit, export, folder, grab, HINT_MAX, monitors, ocr, picker, speech, steps};

impl Backend {
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
}
