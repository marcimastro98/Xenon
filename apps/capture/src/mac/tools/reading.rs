// macOS: reading what the helper scripts print: the text found on screen, a picked region, a sampled colour.

use serde_json::Value;
use crate::private_spots::{Rect, Word};

/// What scripts::OCR read: its lines, or None when it failed.
pub fn parse_ocr(json: &str) -> Option<Vec<String>> {
    let v: Value = serde_json::from_str(json.trim()).ok()?;
    let lines = v.get("lines")?.as_array()?;
    Some(
        lines
            .iter()
            .filter_map(Value::as_str)
            .map(|l| l.trim().to_owned())
            .filter(|l| !l.is_empty())
            .collect(),
    )
}

/// The folder dialog's answer.
#[derive(Debug, PartialEq)]
pub enum Picked {
    Folder(String),
    Cancelled,
    Failed,
}

pub fn parse_picked(out: &str) -> Picked {
    match out.trim() {
        "cancelled" => Picked::Cancelled,
        p if p.starts_with('/') && p.len() > 1 => {
            Picked::Folder(p.trim_end_matches('/').to_owned())
        }
        _ => Picked::Failed,
    }
}

/// What scripts::OCR_WORDS read, in pixels of a `width` x `height` picture:
/// the words of each line. None when it failed.
pub fn parse_ocr_words(json: &str, (width, height): (u32, u32)) -> Option<Vec<Vec<Word>>> {
    let v: Value = serde_json::from_str(json.trim()).ok()?;
    let lines = v.get("lines")?.as_array()?;
    let (fw, fh) = (width as f32, height as f32);
    let word = |w: &Value| -> Option<Word> {
        let n = |k: &str| {
            w.get(k)
                .and_then(Value::as_f64)
                .filter(|f| f.is_finite())
                .map(|f| f as f32)
        };
        let (x, y, ww, wh) = (n("x")?, n("y")?, n("w")?, n("h")?);
        let text = w.get("t")?.as_str()?;
        (ww > 0.0 && wh > 0.0 && !text.is_empty()).then(|| Word {
            text: text.to_owned(),
            rect: Rect {
                x: x.clamp(0.0, 1.0) * fw,
                y: y.clamp(0.0, 1.0) * fh,
                w: ww * fw,
                h: wh * fh,
            },
        })
    };
    Some(
        lines
            .iter()
            .filter_map(Value::as_array)
            .map(|l| l.iter().filter_map(word).collect::<Vec<_>>())
            .filter(|l| !l.is_empty())
            .collect(),
    )
}

/// The colour sampler's answer (scripts::COLOR_SAMPLER).
#[derive(Debug, PartialEq)]
pub enum Sampled {
    /// The colour, and where the pointer was (top-left origin, points).
    Colour {
        rgb: [u8; 3],
        at: Option<(i64, i64)>,
    },
    Cancelled,
    Unsupported,
    Failed,
}

pub fn parse_sampled(out: &str) -> Sampled {
    match out.trim() {
        "cancelled" => Sampled::Cancelled,
        "unsupported" => Sampled::Unsupported,
        s => {
            let Ok(v) = serde_json::from_str::<Value>(s) else {
                return Sampled::Failed;
            };
            let rgb: Vec<u8> = v
                .get("rgb")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_u64)
                        .filter_map(|c| u8::try_from(c).ok())
                        .collect()
                })
                .unwrap_or_default();
            let Ok(rgb) = <[u8; 3]>::try_from(rgb) else {
                return Sampled::Failed;
            };
            let at = v
                .get("x")
                .and_then(Value::as_i64)
                .zip(v.get("y").and_then(Value::as_i64));
            Sampled::Colour { rgb, at }
        }
    }
}
