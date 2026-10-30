//! The argv of each Apple tool and the reading of what they write: pure, so it
//! is tested on every OS (the tools themselves only run on a Mac).

use serde_json::Value;

use crate::private_spots::{Rect, Word};

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

#[cfg(test)]
mod tests {
    use super::*;

    fn strs(a: &[String]) -> Vec<&str> {
        a.iter().map(String::as_str).collect()
    }

    #[test]
    fn reads_monitors_and_drops_junk() {
        let list = parse_monitors(
            r#"[{"index":0,"name":"Built-in","primary":true,"x":0,"y":0,"width":1512,"height":982},
                {"index":1,"x":1512,"y":-200,"width":2560,"height":1440},
                {"index":2,"width":0,"height":10},{"nope":1}]"#,
        );
        assert_eq!(list.len(), 2);
        assert!(list[0].primary);
        assert_eq!(
            (list[1].x, list[1].y, list[1].name.as_str()),
            (1512, -200, "")
        );
        assert!(parse_monitors("not json").is_empty());
        assert!(parse_monitors("{}").is_empty());
    }

    #[test]
    fn reads_the_display_id_and_a_sane_scale() {
        let list = parse_monitors(
            r#"[{"index":0,"x":0,"y":0,"width":1512,"height":982,"display":1,"scale":2},
                {"index":1,"x":0,"y":0,"width":10,"height":10,"display":-4,"scale":40},
                {"index":2,"x":0,"y":0,"width":10,"height":10,"display":5000000000}]"#,
        );
        assert_eq!((list[0].display, list[0].scale), (1, 2.0));
        assert_eq!((list[1].display, list[1].scale), (0, 1.0));
        assert_eq!((list[2].display, list[2].scale), (0, 1.0));
    }

    #[test]
    fn finds_the_display_under_a_point() {
        let list = parse_monitors(
            r#"[{"index":0,"primary":true,"x":0,"y":0,"width":100,"height":100},
                {"index":1,"x":100,"y":0,"width":100,"height":100}]"#,
        );
        assert_eq!(monitor_at(&list, Some((150, 50))).unwrap().index, 1);
        assert_eq!(monitor_at(&list, Some((900, 900))).unwrap().index, 0);
        assert_eq!(monitor_at(&list, None).unwrap().index, 0);
        assert!(monitor_at(&[], None).is_none());
    }

    #[test]
    fn reads_the_front_window() {
        let f = parse_front(r#"{"exe":"Safari","id":42,"x":10,"y":20,"width":100,"height":40}"#);
        assert_eq!(
            (f.exe.as_str(), f.id, f.centre),
            ("Safari", 42, Some((60, 40)))
        );
        let none = parse_front(r#"{"exe":"Finder","id":0}"#);
        assert_eq!((none.id, none.centre), (0, None));
        assert_eq!(parse_front("garbage"), Front::default());
    }

    #[test]
    fn screenshot_argv_per_aim() {
        assert_eq!(
            strs(&screenshot_args(&Aim::Display(1), false, "/t/a.png")),
            ["-x", "-t", "png", "-D2", "/t/a.png"]
        );
        assert_eq!(
            strs(&screenshot_args(&Aim::Window(77), true, "/t/a.png")),
            ["-x", "-t", "png", "-C", "-o", "-l77", "/t/a.png"]
        );
        assert_eq!(
            strs(&screenshot_args(&Aim::Pick, false, "/t/a.png")),
            ["-x", "-t", "png", "-i", "-o", "/t/a.png"]
        );
    }

    #[test]
    fn record_argv_adds_the_microphone_only_when_asked() {
        assert_eq!(
            strs(&record_args(&Aim::Display(0), false, "/v.mov")),
            ["-v", "-x", "-D1", "/v.mov"]
        );
        assert_eq!(
            strs(&record_args(&Aim::Window(5), true, "/v.mov")),
            ["-v", "-x", "-g", "-l5", "/v.mov"]
        );
    }

    #[test]
    fn reads_png_and_sips_sizes() {
        let mut head = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        head.extend_from_slice(b"IHDR");
        head.extend_from_slice(&3024u32.to_be_bytes());
        head.extend_from_slice(&1964u32.to_be_bytes());
        assert_eq!(png_size(&head), Some((3024, 1964)));
        assert_eq!(png_size(b"GIF89a.................."), None);
        assert_eq!(png_size(&head[..20]), None);
        let out = "/x/a.png\n  pixelWidth: 1920\n  pixelHeight: 1080\n";
        assert_eq!(sips_size(out), Some((1920, 1080)));
        assert_eq!(sips_size("  pixelWidth: 1920\n"), None);
    }

    #[test]
    fn edit_and_speech_argv() {
        let t = trim_args("/a.mov", "/b.mov", 2.0, 4.5);
        assert_eq!(
            strs(&t)[5..10],
            [
                "PresetPassthrough",
                "--start",
                "2.000",
                "--duration",
                "4.500"
            ]
        );
        assert_eq!(strs(&speech_args("/a.mov", "/a.wav"))[3], "LEI16@16000");
        assert_eq!(
            strs(&sound_only_args("/a.mov", "/a.m4a"))[5],
            "PresetAppleM4A"
        );
        assert_eq!(
            strs(&thumb_args("/a.png", 480, "/a.jpg"))[7..],
            ["480", "/a.png", "--out", "/a.jpg"]
        );
        assert_eq!(
            strs(&video_frame_args("/a.mov", 480, "/tmp/x")),
            ["-t", "-s", "480", "-o", "/tmp/x", "/a.mov"]
        );
    }

    #[test]
    fn wav_length_from_its_size() {
        assert_eq!(wav_seconds(44), 0.0);
        assert_eq!(wav_seconds(44 + 32_000 * 3), 3.0);
        assert_eq!(wav_seconds(10), 0.0);
    }

    #[test]
    fn reads_ocr_and_folder_answers() {
        assert_eq!(
            parse_ocr(r#"{"lines":["Hello "," ","world"]}"#),
            Some(vec!["Hello".into(), "world".into()])
        );
        assert_eq!(parse_ocr(r#"{"error":"ocr_failed"}"#), None);
        assert_eq!(
            parse_picked("/Users/m/Movies/\n"),
            Picked::Folder("/Users/m/Movies".into())
        );
        assert_eq!(parse_picked("cancelled\n"), Picked::Cancelled);
        assert_eq!(parse_picked("failed"), Picked::Failed);
        assert_eq!(parse_picked("/"), Picked::Failed);
        assert_eq!(parse_picked("relative/path"), Picked::Failed);
    }

    #[test]
    fn reads_word_boxes_in_pixels() {
        let lines = parse_ocr_words(
            r#"{"lines":[[{"t":"IBAN","x":0.1,"y":0.5,"w":0.2,"h":0.1},
                          {"t":"","x":0,"y":0,"w":1,"h":1},
                          {"t":"x","x":0.5,"y":0.5,"w":0,"h":0.1}],
                         [{"t":"a@b.it","x":-0.5,"y":1.5,"w":0.25,"h":0.05}],
                         [{"nope":1}], "junk"]}"#,
            (200, 100),
        )
        .unwrap();
        let rect = |x, y, w, h| Rect { x, y, w, h };
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].len(), 1);
        assert_eq!(lines[0][0].text, "IBAN");
        assert_eq!(lines[0][0].rect, rect(20.0, 50.0, 40.0, 10.0));
        assert_eq!(lines[1][0].rect, rect(0.0, 100.0, 50.0, 5.0));
        assert!(parse_ocr_words(r#"{"error":"ocr_failed"}"#, (10, 10)).is_none());
        assert!(parse_ocr_words("not json", (10, 10)).is_none());
    }

    #[test]
    fn reads_the_colour_samplers_answer() {
        let colour = |rgb, at| Sampled::Colour { rgb, at };
        assert_eq!(
            parse_sampled("{\"rgb\":[255,0,16],\"x\":10,\"y\":-20}\n"),
            colour([255, 0, 16], Some((10, -20)))
        );
        assert_eq!(parse_sampled(r#"{"rgb":[1,2,3]}"#), colour([1, 2, 3], None));
        assert_eq!(parse_sampled("cancelled\n"), Sampled::Cancelled);
        assert_eq!(parse_sampled("unsupported"), Sampled::Unsupported);
        assert_eq!(parse_sampled(r#"{"rgb":[1,2]}"#), Sampled::Failed);
        assert_eq!(parse_sampled(r#"{"rgb":[1,2,300]}"#), Sampled::Failed);
        assert_eq!(parse_sampled("failed"), Sampled::Failed);
    }
}
