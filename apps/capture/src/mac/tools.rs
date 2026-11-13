//! The argv of each Apple tool and the reading of what they write: pure, so it
//! is tested on every OS (the tools themselves only run on a Mac).

use serde_json::Value;

// This file is also built by path for the tests of the other systems, where Rust looks for child files next to
// it: so each one is named in full, and a name handed on below may go unused there.
#[path = "tools/reading.rs"]
mod reading;
#[cfg(test)]
#[path = "tools/unit_tests.rs"]
mod unit_tests;

#[allow(unused_imports)]
pub use reading::{parse_ocr, parse_ocr_words, parse_picked, parse_sampled, Picked, Sampled};

/// A display as scripts::MONITORS reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct Monitor {
    pub index: usize,
    pub name: String,
    pub primary: bool,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    /// The CoreGraphics display id (ScreenCaptureKit names displays by it); 0 unknown.
    pub display: u32,
    /// Pixels per point (2 on a Retina panel).
    pub scale: f64,
}

pub fn parse_monitors(json: &str) -> Vec<Monitor> {
    let Ok(Value::Array(list)) = serde_json::from_str::<Value>(json.trim()) else {
        return Vec::new();
    };
    let int = |v: &Value, k: &str| {
        v.get(k)
            .and_then(Value::as_f64)
            .map_or(0, |n| n.round() as i64)
    };
    list.iter()
        .filter_map(|v| {
            let m = Monitor {
                index: v.get("index")?.as_u64()? as usize,
                name: v
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .take(64)
                    .collect(),
                primary: v.get("primary").and_then(Value::as_bool).unwrap_or(false),
                x: int(v, "x"),
                y: int(v, "y"),
                width: int(v, "width"),
                height: int(v, "height"),
                display: v
                    .get("display")
                    .and_then(Value::as_u64)
                    .and_then(|d| u32::try_from(d).ok())
                    .unwrap_or(0),
                scale: v
                    .get("scale")
                    .and_then(Value::as_f64)
                    .filter(|s| s.is_finite() && *s >= 1.0 && *s <= 4.0)
                    .unwrap_or(1.0),
            };
            (m.width > 0 && m.height > 0).then_some(m)
        })
        .collect()
}

/// The window in front as scripts::FRONT_WINDOW reports it.
#[derive(Debug, Default, PartialEq)]
pub struct Front {
    pub exe: String,
    /// The CoreGraphics window number; 0 when the app has no window on screen.
    pub id: u64,
    pub centre: Option<(i64, i64)>,
}

pub fn parse_front(json: &str) -> Front {
    let Ok(v) = serde_json::from_str::<Value>(json.trim()) else {
        return Front::default();
    };
    let num = |k: &str| v.get(k).and_then(Value::as_f64);
    let centre = match (num("x"), num("y"), num("width"), num("height")) {
        (Some(x), Some(y), Some(w), Some(h)) => Some(((x + w / 2.0) as i64, (y + h / 2.0) as i64)),
        _ => None,
    };
    Front {
        exe: v
            .get("exe")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(128)
            .collect(),
        id: v.get("id").and_then(Value::as_u64).unwrap_or(0),
        centre,
    }
}

/// The display a point is on, else the main one.
pub fn monitor_at(list: &[Monitor], point: Option<(i64, i64)>) -> Option<&Monitor> {
    point
        .and_then(|(px, py)| {
            list.iter()
                .find(|m| px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height)
        })
        .or_else(|| list.iter().find(|m| m.primary))
        .or(list.first())
}

/// What a capture is aimed at.
#[derive(Debug, PartialEq)]
pub enum Aim {
    /// `index` from scripts::MONITORS.
    Display(usize),
    Window(u64),
    /// The user picks an area (or, with the space bar, a window) on screen.
    Pick,
}

/// screencapture's argv for one picture to `out` (PNG).
pub fn screenshot_args(aim: &Aim, cursor: bool, out: &str) -> Vec<String> {
    // -x: no shutter sound. -o: a window without its shadow.
    let mut a: Vec<String> = vec!["-x".into(), "-t".into(), "png".into()];
    if cursor {
        a.push("-C".into());
    }
    match aim {
        Aim::Display(i) => a.push(format!("-D{}", i + 1)),
        Aim::Window(id) => {
            a.push("-o".into());
            a.push(format!("-l{id}"));
        }
        Aim::Pick => {
            a.push("-i".into());
            a.push("-o".into());
        }
    }
    a.push(out.into());
    a
}

/// screencapture's argv for a video to `out` (QuickTime), until it is stopped.
/// `mic` records the default input; the system's own sound is not something
/// screencapture can record.
pub fn record_args(aim: &Aim, mic: bool, out: &str) -> Vec<String> {
    let mut a: Vec<String> = vec!["-v".into(), "-x".into()];
    if mic {
        a.push("-g".into());
    }
    match aim {
        Aim::Display(i) => a.push(format!("-D{}", i + 1)),
        Aim::Window(id) => a.push(format!("-l{id}")),
        Aim::Pick => {}
    }
    a.push(out.into());
    a
}

/// A PNG's size from its header; None when it is not a PNG.
pub fn png_size(head: &[u8]) -> Option<(u32, u32)> {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if head.len() < 24 || head[..8] != SIG || &head[12..16] != b"IHDR" {
        return None;
    }
    let be = |b: &[u8]| u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
    Some((be(&head[16..20]), be(&head[20..24])))
}

/// `sips -g pixelWidth -g pixelHeight` output: the picture's size.
pub fn sips_size(out: &str) -> Option<(u32, u32)> {
    let read = |key: &str| {
        out.lines()
            .find_map(|l| l.trim().strip_prefix(key)?.trim().parse::<u32>().ok())
    };
    Some((read("pixelWidth:")?, read("pixelHeight:")?))
}

/// sips' argv for a JPEG preview `width` wide.
pub fn thumb_args(src: &str, width: u32, out: &str) -> Vec<String> {
    [
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        "80",
        "--resampleWidth",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([width.to_string(), src.into(), "--out".into(), out.into()])
    .collect()
}

/// qlmanage's argv for a video's preview frame, written as `<name>.png` in `dir`.
pub fn video_frame_args(src: &str, width: u32, dir: &str) -> Vec<String> {
    vec![
        "-t".into(),
        "-s".into(),
        width.to_string(),
        "-o".into(),
        dir.into(),
        src.into(),
    ]
}

/// avconvert's argv for a copy of `src` from `start` lasting `seconds`, streams
/// passed through as stored.
pub fn trim_args(src: &str, out: &str, start: f64, seconds: f64) -> Vec<String> {
    vec![
        "--source".into(),
        src.into(),
        "--output".into(),
        out.into(),
        "--preset".into(),
        "PresetPassthrough".into(),
        "--start".into(),
        format!("{start:.3}"),
        "--duration".into(),
        format!("{seconds:.3}"),
        "--replace".into(),
    ]
}

/// afconvert's argv for the 16 kHz mono WAV whisper reads.
pub fn speech_args(src: &str, out: &str) -> Vec<String> {
    vec![
        "-f".into(),
        "WAVE".into(),
        "-d".into(),
        format!("LEI16@{}", crate::speech::RATE),
        "-c".into(),
        "1".into(),
        src.into(),
        out.into(),
    ]
}

/// avconvert's argv for the sound alone (an M4A), when afconvert cannot open
/// the video's container itself.
pub fn sound_only_args(src: &str, out: &str) -> Vec<String> {
    vec![
        "--source".into(),
        src.into(),
        "--output".into(),
        out.into(),
        "--preset".into(),
        "PresetAppleM4A".into(),
        "--replace".into(),
    ]
}

/// Seconds of 16 kHz mono 16-bit sound in a WAV of `bytes`.
pub fn wav_seconds(bytes: u64) -> f64 {
    let data = bytes.saturating_sub(crate::speech::HEADER_LEN as u64);
    data as f64 / (crate::speech::RATE as f64 * 2.0)
}
