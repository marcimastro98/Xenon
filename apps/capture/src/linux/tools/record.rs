// Linux: the command lines of a recording, its sound and its encoder.

use crate::video::{self, Quality};
use super::shot::wl_geometry;

/// The audio a recording takes, as the engine answers it.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Sound {
    /// The default output's monitor source, for the computer's own sound.
    pub monitor: Option<String>,
    pub mic: bool,
}

/// What a recording is asked for, the same numbers as on Windows (video.rs):
/// frames per second, the height to bring it down to (0 = the source's), the
/// detail kept, and for a timelapse the seconds between pictures.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tuning {
    pub fps: u32,
    pub height: u32,
    pub quality: Quality,
    pub every: Option<u32>,
}

impl Tuning {
    /// From the request's `fps`, `height`, `quality` and `every`. A timelapse
    /// plays at video::LAPSE_FPS whatever was asked.
    pub fn parse(fps: Option<u64>, height: Option<u64>, quality: Option<&str>, every: Option<u64>) -> Tuning {
        let every = video::lapse_every(every);
        Tuning {
            fps: if every.is_some() { video::LAPSE_FPS } else { video::fps(fps) },
            height: video::height_cap(height),
            quality: Quality::parse(quality),
            every,
        }
    }

    /// The encoded size of a `w` x `h` source.
    pub fn size(&self, w: i64, h: i64) -> (u32, u32) {
        video::encode_size(w.max(2) as u32, h.max(2) as u32, self.height)
    }

    /// libx264's constant quality for each level (lower is sharper).
    pub fn crf(&self) -> u32 {
        match self.quality {
            Quality::Small => 28,
            Quality::Normal => 23,
            Quality::High => 18,
        }
    }

    /// The filters after the even crop: the scale to `size` when it differs
    /// from the source, and a timelapse's clock (picture N shown at N/30 s).
    fn filters(&self, size: Option<((i64, i64), (u32, u32))>) -> Vec<String> {
        let mut f = Vec::new();
        match size {
            Some(((w, h), (ew, eh))) if (ew as i64, eh as i64) != (w - w % 2, h - h % 2) => {
                f.push(format!("scale={ew}:{eh}"));
            }
            None if self.height > 0 => f.push(format!("scale=-2:'min(ih,{})'", self.height)),
            _ => {}
        }
        if self.every.is_some() {
            f.push(format!("settb=1/{},setpts=N", video::LAPSE_FPS));
        }
        f
    }
}

/// ffmpeg's argv for an x11grab recording of `rect` on `display` to `out`
/// (fragmented MP4, so a crash still leaves a file that plays), until it gets
/// `q` on its input.
pub fn ffmpeg_record_args(
    display: &str,
    rect: (i64, i64, i64, i64),
    tuning: &Tuning,
    encoder: &str,
    sound: &Sound,
    out: &str,
) -> Vec<String> {
    let (x, y, w, h) = rect;
    // A timelapse grabs one picture every N seconds; x11grab takes the rate as a fraction.
    let rate = match tuning.every {
        Some(s) => format!("1/{s}"),
        None => tuning.fps.to_string(),
    };
    let input = [
        "-f".into(),
        "x11grab".into(),
        "-framerate".into(),
        rate,
        "-video_size".into(),
        format!("{w}x{h}"),
        "-i".into(),
        format!("{display}+{x},{y}"),
    ];
    encode_args(input, (w, h), tuning, encoder, sound, out)
}

/// ffmpeg's argv for the portal's pictures: I420 of `size` on its standard
/// input at the asked rate (portal_plan.rs), until it is interrupted. When
/// the stream ends (the user stops sharing) the file ends with it.
pub fn ffmpeg_pipe_args(size: (u32, u32), tuning: &Tuning, encoder: &str, sound: &Sound, out: &str) -> Vec<String> {
    let (w, h) = (size.0 as i64, size.1 as i64);
    let input = [
        "-thread_queue_size".into(),
        "512".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-video_size".into(),
        format!("{w}x{h}"),
        "-framerate".into(),
        tuning.fps.max(1).to_string(),
        "-i".into(),
        "pipe:0".into(),
    ];
    let mut a = encode_args(input, (w, h), tuning, encoder, sound, out);
    // The sound sources never end by themselves.
    let at = a.len() - 1;
    a.insert(at, "-shortest".into());
    a
}

/// What follows the video input: the sound inputs, the filters, the encoders
/// and the fragmented MP4 at `out` (last). `(w, h)` is the input's size.
fn encode_args<const N: usize>(
    input: [String; N],
    (w, h): (i64, i64),
    tuning: &Tuning,
    encoder: &str,
    sound: &Sound,
    out: &str,
) -> Vec<String> {
    let mut a: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-y".into()];
    a.extend(input);
    let mut inputs = 0;
    // A timelapse is silent: sound at 30x or 1800x speed is noise.
    let silent = Sound::default();
    let sound = if tuning.every.is_some() { &silent } else { sound };
    for source in sound
        .monitor
        .iter()
        .map(String::as_str)
        .chain(sound.mic.then_some("default"))
    {
        a.extend([
            "-thread_queue_size".into(),
            "1024".into(),
            "-f".into(),
            "pulse".into(),
        ]);
        a.extend(["-i".into(), source.into()]);
        inputs += 1;
    }
    // yuv420p needs an even size; a window can be any size.
    let size = tuning.size(w, h);
    let mut chain = vec!["crop=trunc(iw/2)*2:trunc(ih/2)*2".to_owned()];
    chain.extend(tuning.filters(Some(((w, h), size))));
    // x11grab's pictures last N seconds each: without this the encoder repeats
    // every one of them for N seconds of video (wf-recorder needs no such step).
    if tuning.every.is_some() {
        chain.push(format!("fps={}", video::LAPSE_FPS));
    }
    let mut graph = format!("[0:v]{}[v]", chain.join(","));
    if inputs == 2 {
        graph.push_str(";[1:a][2:a]amix=inputs=2:duration=longest[a]");
    }
    a.extend(["-filter_complex".into(), graph, "-map".into(), "[v]".into()]);
    match inputs {
        2 => a.extend(["-map".into(), "[a]".into()]),
        1 => a.extend(["-map".into(), "1:a".into()]),
        _ => {}
    }
    a.extend(["-c:v".into(), encoder.into()]);
    if encoder == "libx264" {
        a.extend([
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            tuning.crf().to_string(),
        ]);
    } else {
        let bits = video::bitrate(size.0, size.1, tuning.fps, tuning.quality);
        a.extend(["-b:v".into(), bits.to_string()]);
    }
    if tuning.every.is_some() {
        a.extend(["-r".into(), video::LAPSE_FPS.to_string()]);
    }
    a.extend(["-pix_fmt".into(), "yuv420p".into()]);
    if inputs > 0 {
        a.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "160k".into()]);
    }
    a.extend([
        "-movflags".into(),
        "+frag_keyframe+empty_moov+default_base_moof".into(),
        "-f".into(),
        "mp4".into(),
        out.into(),
    ]);
    a
}

/// wf-recorder's argv: one audio source at most (it cannot mix two), none in
/// a timelapse. Its frames come when the screen changes, so a recording asks
/// for a constant rate and a timelapse keeps one picture every N seconds.
pub fn wf_record_args(
    rect: Option<(i64, i64, i64, i64)>,
    audio: Option<&str>,
    tuning: &Tuning,
    out: &str,
) -> Vec<String> {
    let mut a: Vec<String> = vec!["-y".into(), "-f".into(), out.into()];
    if let Some(r) = rect {
        a.extend(["-g".into(), wl_geometry(r)]);
    }
    a.extend([
        "-c".into(),
        "libx264".into(),
        "-p".into(),
        "preset=veryfast".into(),
        "-p".into(),
        format!("crf={}", tuning.crf()),
    ]);
    let mut filters = Vec::new();
    match tuning.every {
        Some(s) => filters.push(format!("fps=1/{s}")),
        None => a.extend(["-r".into(), tuning.fps.to_string()]),
    }
    filters.extend(tuning.filters(rect.map(|(_, _, w, h)| ((w, h), tuning.size(w, h)))));
    if !filters.is_empty() {
        a.extend(["-F".into(), filters.join(",")]);
    }
    let audio = audio.filter(|_| tuning.every.is_none());
    if let Some(source) = audio {
        a.push(if source == "default" {
            "-a".to_owned()
        } else {
            format!("--audio={source}")
        });
    }
    a
}

/// `pactl info` (in the C locale): the default output's monitor source.
pub fn parse_default_sink_monitor(out: &str) -> Option<String> {
    let sink = out
        .lines()
        .find_map(|l| l.trim().strip_prefix("Default Sink:"))?
        .trim();
    let ok = !sink.is_empty() && sink.chars().all(|c| c.is_ascii_graphic());
    ok.then(|| format!("{sink}.monitor"))
}

/// The H.264 encoder an `ffmpeg -encoders` listing offers, best first.
pub fn pick_encoder(encoders: &str) -> Option<&'static str> {
    let has = |name: &str| {
        encoders
            .lines()
            .any(|l| l.split_whitespace().nth(1) == Some(name))
    };
    ["libx264", "libopenh264"].into_iter().find(|e| has(e))
}

/// Whether an `ffmpeg -devices` listing has `name` (x11grab, pulse).
pub fn has_device(devices: &str, name: &str) -> bool {
    devices
        .lines()
        .any(|l| l.split_whitespace().nth(1) == Some(name))
}
