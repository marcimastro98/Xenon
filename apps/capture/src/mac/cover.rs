//! The private spots of a saved picture (crate::private_spots), read by
//! Vision on a thread of its own, answered as on Windows (win/cover.rs): the
//! gallery's editor proposes them as covers, and with `out` a copy is written
//! with them painted black (the original is never touched). The words never
//! leave this file; only rectangles do.

use std::path::Path;

use serde_json::{json, Value};

use super::edit::{self, Jobs};
use super::{image, run, scripts, tools, OCR_DEADLINE};
use crate::private_spots;
use crate::proto::{Fail, Notify};

/// A spot's kind and its padded rectangle (x, y, w, h) in the picture.
type Found = (&'static str, (u32, u32, u32, u32));

fn spots(src: &str, size: (u32, u32)) -> Option<Vec<Found>> {
    let read = run::jxa(scripts::OCR_WORDS, &[src.to_owned()], OCR_DEADLINE).filter(|o| o.ok)?;
    let lines = tools::parse_ocr_words(&read.stdout, size)?;
    Some(
        private_spots::find(&lines)
            .into_iter()
            .map(|s| (s.kind.name(), s.rect.padded(size.0, size.1)))
            .filter(|(_, (_, _, w, h))| *w > 0 && *h > 0)
            .collect(),
    )
}

/// The covered copy at `out`, through `out.part`.
fn write(picture: &image::Image, found: &[Found], out: &str) -> bool {
    let rects: Vec<_> = found.iter().map(|(_, r)| *r).collect();
    let Some(covered) = image::covered(picture, &rects) else {
        return false;
    };
    let part = format!("{out}.part");
    let written =
        image::write_png(&covered, Path::new(&part)) && std::fs::rename(&part, out).is_ok();
    if !written {
        let _ = std::fs::remove_file(&part);
    }
    written
}

fn work(src: &str, out: Option<&str>) -> Value {
    let Some(picture) = image::open(src) else {
        return json!({ "error": "cover_failed" });
    };
    let (width, height) = image::size(&picture);
    let Some(found) = spots(src, (width, height)) else {
        return json!({ "error": "cover_failed" });
    };
    // Nothing to cover: no copy that would only repeat the original.
    if let Some(out) = out.filter(|_| !found.is_empty()) {
        if !write(&picture, &found, out) {
            return json!({ "error": "write_failed" });
        }
    }
    let list: Vec<Value> = found
        .iter()
        .map(|(kind, (x, y, w, h))| json!({ "kind": kind, "x": x, "y": y, "w": w, "h": h }))
        .collect();
    json!({ "width": width, "height": height, "spots": list })
}

/// `{ src, out?, token }`: see win/cover.rs `start`. The event `cover_done`
/// carries `{ width, height, spots: [{ kind, x, y, w, h }] }` or `error`
/// (cover_failed, write_failed).
pub fn start(req: &Value, notify: Notify, jobs: &Jobs) -> Result<Value, Fail> {
    let src = edit::text(req, "src")?;
    let out = req
        .get("out")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let token = req.get("token").cloned().unwrap_or(Value::Null);
    edit::spawn(jobs, notify, "cover_done", token, move || {
        work(&src, out.as_deref())
    })
}
