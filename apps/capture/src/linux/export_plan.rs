//! The gallery's exports on Linux, the part that only builds ffmpeg's
//! arguments and reads its answers (export.rs runs them). The sizes, crops and
//! bitrates are crate::reframe's, the same as on Windows.

use serde_json::Value;

use crate::bubble::{self, Corner};
use crate::reframe::{self, Crop, Fit, Focus};

// This file is also built by path for the tests of the other systems, where Rust looks for child files next to
// it: so each one is named in full, and a name handed on below may go unused there.
#[path = "export_plan/progress.rs"]
mod progress;
#[cfg(test)]
#[path = "export_plan/unit_tests.rs"]
mod unit_tests;

#[allow(unused_imports)]
pub use progress::{failure, progress, Tick};

/// The sound's bitrate when the file does not say (what Xenon records).
const AUDIO_BPS: u32 = 192_000;
/// A frame rate past this is a variable-rate file's time base, not its pace.
const MAX_FPS: u32 = 240;
/// A vertical copy's frame rate is never above this (as win/export.rs).
const VERTICAL_MAX_FPS: u32 = 60;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    /// The part kept, and the corner of the webcam bubble to put on top.
    Vertical(Focus, Option<Corner>),
    /// The bytes the copy must fit in.
    Fit(u64),
    Gif,
}

/// What ffprobe says about a saved video.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Probe {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// 0 when the file does not say.
    pub seconds: f64,
    /// The first sound track's bitrate, when there is one.
    pub audio_bps: Option<u32>,
}

/// The arguments ffprobe is run with, for `parse_probe`.
pub fn probe_args(src: &str) -> Vec<String> {
    [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,width,height,r_frame_rate,avg_frame_rate,bit_rate:format=duration",
        "-of",
        "json",
        src,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn rate(v: Option<&Value>) -> Option<u32> {
    let (n, d) = v?.as_str()?.split_once('/')?;
    let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
    let fps = (n / d).round();
    (fps.is_finite() && fps >= 1.0 && fps <= MAX_FPS as f64).then_some(fps as u32)
}

fn number(v: Option<&Value>) -> Option<f64> {
    let v = v?;
    v.as_f64()
        .or_else(|| v.as_str()?.parse().ok())
        .filter(|n: &f64| n.is_finite() && *n > 0.0)
}

/// ffprobe's JSON: the first video stream's size and pace, the length, and the
/// first sound track. None without a video stream.
pub fn parse_probe(json: &str) -> Option<Probe> {
    let v: Value = serde_json::from_str(json).ok()?;
    let streams = v.get("streams")?.as_array()?;
    let kind = |s: &&Value, k: &str| s.get("codec_type").and_then(Value::as_str) == Some(k);
    let video = streams.iter().find(|s| kind(s, "video"))?;
    let width = video.get("width")?.as_u64()? as u32;
    let height = video.get("height")?.as_u64()? as u32;
    if width < 2 || height < 2 {
        return None;
    }
    let fps = rate(video.get("r_frame_rate"))
        .or_else(|| rate(video.get("avg_frame_rate")))
        .unwrap_or(30);
    let audio_bps = streams.iter().find(|s| kind(s, "audio")).map(|a| {
        number(a.get("bit_rate")).map_or(AUDIO_BPS, |b| b.min(u32::MAX as f64) as u32)
    });
    let seconds = number(v.get("format").and_then(|f| f.get("duration"))).unwrap_or(0.0);
    Some(Probe {
        width,
        height,
        fps,
        seconds,
        audio_bps,
    })
}

/// The copy's size, its frame rate and video bitrate, and the filter that
/// makes its picture (`[v]`).
#[derive(Clone, Debug, PartialEq)]
pub struct Picture {
    pub size: (u32, u32),
    pub fps: u32,
    pub bps: u32,
    pub filter: String,
}

/// `crop` kept inside a `w` x `h` frame, on even pixels.
fn inside(crop: Crop, w: u32, h: u32) -> Crop {
    let cw = crop.w.clamp(2, w) & !1;
    let ch = crop.h.clamp(2, h) & !1;
    Crop {
        x: crop.x.min(w - cw) & !1,
        y: crop.y.min(h - ch) & !1,
        w: cw,
        h: ch,
    }
}

fn even(n: u32) -> u32 {
    (n & !1).max(2)
}

fn part(crop: Crop, (w, h): (u32, u32)) -> String {
    format!(
        "crop={}:{}:{}:{},scale={}:{}:flags=lanczos",
        crop.w,
        crop.h,
        crop.x,
        crop.y,
        even(w),
        even(h)
    )
}

/// The frame-rate step, when the copy is slower than the source.
fn pace(src: u32, fps: u32) -> String {
    if fps < src {
        format!(",fps={fps}")
    } else {
        String::new()
    }
}

pub fn vertical(p: &Probe, focus: Focus, webcam: Option<Corner>) -> Picture {
    let (w, h) = (p.width, p.height);
    let fps = p.fps.min(VERTICAL_MAX_FPS);
    let tail = format!("{},format=yuv420p[v]", pace(p.fps, fps));
    let (size, filter) = match webcam {
        Some(corner) => {
            let s = reframe::vertical_split(w, h, focus, bubble::place(w, h, corner));
            let (cam, game) = (inside(s.cam.0, w, h), inside(s.game.0, w, h));
            let size = (even(s.cam.1 .0), even(s.cam.1 .1) + even(s.game.1 .1));
            let filter = format!(
                "[0:v]split=2[c][g];[c]{}[top];[g]{}[bottom];[top][bottom]vstack=inputs=2{tail}",
                part(cam, s.cam.1),
                part(game, s.game.1),
            );
            (size, filter)
        }
        None => {
            let (crop, size) = reframe::vertical(w, h, focus);
            let size = (even(size.0), even(size.1));
            (size, format!("[0:v]{}{tail}", part(inside(crop, w, h), size)))
        }
    };
    Picture {
        size,
        fps,
        bps: reframe::vertical_bitrate(size.0, size.1, fps),
        filter,
    }
}

/// The copy that fits in `target` bytes; `seconds` is the clip's length when
/// the file does not say. None when even the smallest would not fit.
pub fn fit(p: &Probe, target: u64, seconds: f64) -> Option<Picture> {
    let length = if p.seconds > 0.0 { p.seconds } else { seconds };
    let Fit {
        width,
        height,
        fps,
        video_bps,
    } = reframe::fit(
        (p.width, p.height),
        p.fps.min(VERTICAL_MAX_FPS),
        length,
        target,
        p.audio_bps.unwrap_or(0),
    )?;
    let size = (even(width), even(height));
    Some(Picture {
        size,
        fps,
        bps: video_bps,
        filter: format!(
            "[0:v]scale={}:{}:flags=lanczos{},format=yuv420p[v]",
            size.0,
            size.1,
            pace(p.fps, fps)
        ),
    })
}

/// A looping GIF at reframe's size and pace, a palette of its own for each
/// frame (as win/export.rs): nothing is held back for a palette of the whole clip.
pub fn gif(p: &Probe) -> Picture {
    let size = reframe::gif_size(p.width, p.height);
    let fps = (100 / reframe::GIF_DELAY_CS as u32).max(1);
    Picture {
        size,
        fps,
        bps: 0,
        filter: format!(
            "[0:v]fps=100/{},scale={}:{}:flags=lanczos,split[a][b];\
             [a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1[v]",
            reframe::GIF_DELAY_CS,
            size.0,
            size.1
        ),
    }
}

/// ffmpeg's arguments for `pic` from `src` into `part`: progress on stdout,
/// the first sound track copied as stored (none in a GIF).
pub fn ffmpeg_args(src: &str, part: &str, pic: &Picture, kind: Kind, encoder: &str) -> Vec<String> {
    let mut a: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-progress",
        "pipe:1",
        "-nostats",
        "-i",
        src,
        "-filter_complex",
        &pic.filter,
        "-map",
        "[v]",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    if kind == Kind::Gif {
        a.extend(s(&["-loop", "0", "-f", "gif", part]));
        return a;
    }
    let bps = pic.bps.to_string();
    a.extend(s(&["-c:v", encoder, "-b:v", &bps]));
    if encoder == "libx264" {
        let buf = (pic.bps as u64 * 2).to_string();
        a.extend(s(&["-preset", "veryfast", "-maxrate", &bps, "-bufsize", &buf]));
    }
    a.extend(s(&[
        "-map",
        "0:a:0?",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        part,
    ]));
    a
}
