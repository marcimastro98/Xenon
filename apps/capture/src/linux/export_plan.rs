//! The gallery's exports on Linux, the part that only builds ffmpeg's
//! arguments and reads its answers (export.rs runs them). The sizes, crops and
//! bitrates are crate::reframe's, the same as on Windows.

use serde_json::Value;

use crate::bubble::{self, Corner};
use crate::reframe::{self, Crop, Fit, Focus};

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

/// One line of `-progress` output: how far the copy is (0..1 of `total`
/// seconds) or how many bytes it has written.
#[derive(Debug, PartialEq)]
pub enum Tick {
    Done(f64),
    Bytes(u64),
}

pub fn progress(line: &str, total: f64) -> Option<Tick> {
    let (key, value) = line.trim().split_once('=')?;
    match key {
        // Microseconds under both names (ffmpeg's out_time_ms is misnamed).
        "out_time_us" | "out_time_ms" if total > 0.0 => {
            let us: f64 = value.parse().ok()?;
            Some(Tick::Done((us / 1e6 / total).clamp(0.0, 1.0)))
        }
        "total_size" => value.parse().ok().map(Tick::Bytes),
        _ => None,
    }
}

/// The error code for what a failed ffmpeg said.
pub fn failure(stderr: &str) -> &'static str {
    if stderr.contains("No space left on device") {
        "disk_full"
    } else {
        "export_failed"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(w: u32, h: u32, fps: u32, seconds: f64, audio: Option<u32>) -> Probe {
        Probe {
            width: w,
            height: h,
            fps,
            seconds,
            audio_bps: audio,
        }
    }

    #[test]
    fn ffprobe_json_gives_the_first_video_and_sound() {
        let json = r#"{"streams":[
            {"codec_type":"audio","bit_rate":"128000"},
            {"codec_type":"video","width":1920,"height":1080,"r_frame_rate":"60/1","avg_frame_rate":"60/1"},
            {"codec_type":"audio","bit_rate":"64000"}],
            "format":{"duration":"5.080000"}}"#;
        assert_eq!(
            parse_probe(json),
            Some(probe(1920, 1080, 60, 5.08, Some(128_000)))
        );
        // A variable-rate file's time base is not its pace; no sound, no length.
        let vfr = r#"{"streams":[{"codec_type":"video","width":1280,"height":720,
            "r_frame_rate":"1000/1","avg_frame_rate":"30000/1001"}],"format":{}}"#;
        assert_eq!(parse_probe(vfr), Some(probe(1280, 720, 30, 0.0, None)));
        // Sound without a bitrate counts as what Xenon records.
        let quiet = r#"{"streams":[{"codec_type":"video","width":640,"height":480},
            {"codec_type":"audio"}],"format":{"duration":"N/A"}}"#;
        assert_eq!(parse_probe(quiet), Some(probe(640, 480, 30, 0.0, Some(192_000))));
        assert_eq!(parse_probe(r#"{"streams":[{"codec_type":"audio"}]}"#), None);
        assert_eq!(parse_probe("not json"), None);
    }

    #[test]
    fn a_vertical_copy_crops_the_middle_at_up_to_60_fps() {
        let pic = vertical(&probe(1920, 1080, 120, 10.0, None), Focus::Center, None);
        assert_eq!(pic.size, (606, 1080));
        assert_eq!(pic.fps, 60);
        assert_eq!(
            pic.filter,
            "[0:v]crop=606:1080:656:0,scale=606:1080:flags=lanczos,fps=60,format=yuv420p[v]"
        );
        let left = vertical(&probe(1920, 1080, 30, 10.0, None), Focus::Left, None);
        assert!(left.filter.starts_with("[0:v]crop=606:1080:0:0,"));
        assert!(!left.filter.contains("fps="));
    }

    #[test]
    fn a_vertical_copy_with_the_webcam_stacks_two_parts() {
        let pic = vertical(
            &probe(1920, 1080, 60, 10.0, None),
            Focus::Center,
            Some(Corner::BottomRight),
        );
        assert_eq!(pic.size.0 % 2, 0);
        assert_eq!(pic.size.1, 1080);
        assert!(pic.filter.starts_with("[0:v]split=2[c][g];[c]crop="));
        assert!(pic.filter.contains("[top][bottom]vstack=inputs=2,format=yuv420p[v]"));
    }

    #[test]
    fn a_copy_that_must_fit_scales_down_and_keeps_the_sound() {
        let p = probe(3840, 2160, 60, 30.0, Some(192_000));
        let pic = fit(&p, 10_000_000, 0.0).expect("fits");
        assert!(pic.size.1 < 2160);
        assert!(pic.bps as f64 * 30.0 / 8.0 < 10_000_000.0);
        assert!(pic.filter.starts_with("[0:v]scale="));
        let args = ffmpeg_args("in.mp4", "out.part", &pic, Kind::Fit(10_000_000), "libx264");
        let at = |k: &str| args.iter().position(|a| a == k).expect(k);
        assert_eq!(args[at("-b:v") + 1], pic.bps.to_string());
        assert_eq!(args[at("-maxrate") + 1], pic.bps.to_string());
        assert_eq!(args[at("-c:a") + 1], "copy");
        assert_eq!(args.last().map(String::as_str), Some("out.part"));
        // The length from the server when the file does not say; none at all = no copy.
        assert!(fit(&probe(1920, 1080, 30, 0.0, None), 10_000_000, 20.0).is_some());
        assert_eq!(fit(&probe(1920, 1080, 30, 0.0, None), 10_000_000, 0.0), None);
        // An hour in one megabyte does not fit.
        assert_eq!(fit(&probe(1920, 1080, 30, 3600.0, None), 1_000_000, 0.0), None);
    }

    #[test]
    fn openh264_gets_only_the_bitrate() {
        let pic = vertical(&probe(1280, 720, 30, 5.0, None), Focus::Center, None);
        let args = ffmpeg_args("a", "b", &pic, Kind::Vertical(Focus::Center, None), "libopenh264");
        assert!(args.iter().any(|a| a == "libopenh264"));
        assert!(!args.iter().any(|a| a == "-preset" || a == "-maxrate"));
    }

    #[test]
    fn a_gif_has_a_palette_per_frame_and_no_sound() {
        let pic = gif(&probe(1920, 1080, 60, 10.0, Some(192_000)));
        assert_eq!(pic.size, (480, 270));
        assert_eq!(pic.fps, 12);
        assert!(pic.filter.contains("fps=100/8,scale=480:270"));
        assert!(pic.filter.contains("palettegen=stats_mode=single"));
        let args = ffmpeg_args("a", "b", &pic, Kind::Gif, "libx264");
        assert!(!args.iter().any(|a| a == "-c:a" || a == "-c:v"));
        assert_eq!(&args[args.len() - 5..], ["-loop", "0", "-f", "gif", "b"]);
    }

    #[test]
    fn progress_lines_give_the_share_done_and_the_bytes() {
        assert_eq!(progress("out_time_us=2500000", 10.0), Some(Tick::Done(0.25)));
        assert_eq!(progress("out_time_ms=20000000\n", 10.0), Some(Tick::Done(1.0)));
        assert_eq!(progress("out_time_us=N/A", 10.0), None);
        assert_eq!(progress("out_time_us=100", 0.0), None);
        assert_eq!(progress("total_size=4096", 10.0), Some(Tick::Bytes(4096)));
        assert_eq!(progress("progress=continue", 10.0), None);
    }

    #[test]
    fn a_full_disk_is_said() {
        assert_eq!(failure("out.part: No space left on device"), "disk_full");
        assert_eq!(failure("Invalid data found"), "export_failed");
    }
}
