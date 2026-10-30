//! The private spots of a saved picture on Linux (as win/cover.rs): tesseract
//! reads the words, crate::private_spots finds the e-mails, IBANs and long
//! numbers, and with `out` ffmpeg writes a copy with them painted over (the
//! original is never touched). The words never leave this file; only
//! rectangles do.

use std::time::Duration;

use serde_json::{json, Value};

use super::cover_plan;
use super::edit::{self, Ffmpeg, Jobs};
use super::export_plan;
use super::run;
use crate::private_spots;
use crate::proto::{Fail, Notify};

const PROBE_DEADLINE: Duration = Duration::from_secs(30);
const OCR_DEADLINE: Duration = Duration::from_secs(60);
const PAINT_DEADLINE: Duration = Duration::from_secs(60);

/// A spot's kind and its padded rectangle (x, y, w, h) in the picture.
type Found = (&'static str, (u32, u32, u32, u32));

fn size(ff: &Ffmpeg, src: &str) -> Option<(u32, u32)> {
    let out = run::run(&ff.ffprobe, &export_plan::probe_args(src), None, PROBE_DEADLINE)?;
    let p = export_plan::parse_probe(&out.stdout).filter(|_| out.ok)?;
    Some((p.width, p.height))
}

fn spots(tesseract: &str, langs: &str, src: &str, (w, h): (u32, u32)) -> Option<Vec<Found>> {
    let args = [src, "stdout", "-l", langs, "tsv"].map(String::from);
    let out = run::run(tesseract, &args, None, OCR_DEADLINE).filter(|o| o.ok)?;
    let lines = cover_plan::tsv_lines(&out.stdout);
    Some(
        private_spots::find(&lines)
            .into_iter()
            .map(|s| (s.kind.name(), s.rect.padded(w, h)))
            .filter(|(_, (_, _, w, h))| *w > 0 && *h > 0)
            .collect(),
    )
}

fn work(ff: &Ffmpeg, tesseract: &str, langs: &str, src: &str, out: Option<&str>) -> Value {
    let Some((width, height)) = size(ff, src) else {
        return json!({ "error": "cover_failed" });
    };
    let Some(found) = spots(tesseract, langs, src, (width, height)) else {
        return json!({ "error": "cover_failed" });
    };
    let list: Vec<Value> = found
        .iter()
        .map(|(kind, (x, y, w, h))| json!({ "kind": kind, "x": x, "y": y, "w": w, "h": h }))
        .collect();
    // Nothing to cover: no copy that would only repeat the original.
    if let Some(out) = out.filter(|_| !found.is_empty()) {
        let part = format!("{out}.part");
        let rects: Vec<_> = found.iter().map(|(_, r)| *r).collect();
        let args = cover_plan::paint_args(src, &part, &rects);
        let written = run::run(&ff.ffmpeg, &args, None, PAINT_DEADLINE).is_some_and(|o| o.ok)
            && std::fs::rename(&part, out).is_ok();
        if !written {
            let _ = std::fs::remove_file(&part);
            return json!({ "error": "write_failed" });
        }
    }
    json!({ "width": width, "height": height, "spots": list })
}

/// The same request and event as win/cover.rs `start`: `{ src, out?, token }`
/// answered by `cover_done` `{ width, height, spots: [{ kind, x, y, w, h }] }`
/// or `error`.
pub fn start(
    req: &Value,
    notify: Notify,
    jobs: &Jobs,
    ff: &Ffmpeg,
    tesseract: &str,
    langs: String,
) -> Result<Value, Fail> {
    let src = edit::text(req, "src")?;
    let out = req
        .get("out")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let token = req.get("token").cloned().unwrap_or(Value::Null);
    let (ff, tesseract) = (ff.clone(), tesseract.to_owned());
    edit::spawn(jobs, notify, "cover_done", token, move || {
        work(&ff, &tesseract, &langs, &src, out.as_deref())
    })
}
