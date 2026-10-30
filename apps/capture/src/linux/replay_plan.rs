//! Instant Replay on Linux, the pure part: the recorder's output turned into
//! ffmpeg's segment muxer (a ring of MPEG-TS files, each starting on a
//! keyframe), its list of finished segments read back, and the arguments that
//! join the newest segments into one MP4 without decoding anything.

use crate::ring::{self, Segment};

/// The ring's clock: segments are measured in milliseconds (`Segment` frames
/// at this rate), whatever the picture's frame rate.
pub const CLOCK: u32 = 1000;

/// The last arguments of `tools::ffmpeg_record_args`: its MP4 output.
const MP4_TAIL: usize = 5;

/// ffmpeg's arguments for the segments, after the encoder's: a keyframe every
/// segment, the list of finished segments on stdout (`file,start,end`).
fn segment_args(dir: &str) -> Vec<String> {
    let every = ring::SEGMENT_SECONDS;
    [
        "-force_key_frames".to_owned(),
        format!("expr:gte(t,n_forced*{every})"),
    ]
    .into_iter()
    .chain(muxer_args(dir))
    .collect()
}

fn muxer_args(dir: &str) -> Vec<String> {
    let every = ring::SEGMENT_SECONDS.to_string();
    [
        "-f",
        "segment",
        "-segment_time",
        &every,
        "-segment_format",
        "mpegts",
        "-reset_timestamps",
        "1",
        "-segment_list",
        "pipe:1",
        "-segment_list_type",
        "csv",
        &format!("{dir}/{}", ring::ts_pattern()),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// A recording's ffmpeg arguments (x11grab, `tools::ffmpeg_record_args`)
/// writing the ring in `dir` instead of one file. None when they do not end
/// on the MP4 output this expects.
pub fn ring_from_record(mut args: Vec<String>, dir: &str) -> Option<Vec<String>> {
    let tail = args.len().checked_sub(MP4_TAIL)?;
    (args[tail] == "-movflags" && args[tail + 2] == "-f" && args[tail + 3] == "mp4").then_some(())?;
    args.truncate(tail);
    args.extend(segment_args(dir));
    Some(args)
}

/// wf-recorder's arguments to stream MPEG-TS on its stdout, for the ffmpeg
/// that cuts the ring (`ring_from_stream`). A keyframe every segment, so the
/// cuts land where they should.
pub fn wf_to_stream(mut args: Vec<String>, fps: u32) -> Option<Vec<String>> {
    let at = args.iter().position(|a| a == "-f")?;
    *args.get_mut(at + 1)? = "/dev/stdout".into();
    args.extend([
        "-m".into(),
        "mpegts".into(),
        "-p".into(),
        format!("g={}", fps * ring::SEGMENT_SECONDS),
    ]);
    Some(args)
}

/// ffmpeg's arguments to cut the stream on its stdin into the ring in `dir`.
pub fn ring_from_stream(dir: &str) -> Vec<String> {
    let mut a: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "mpegts",
        "-i",
        "pipe:0",
        "-map",
        "0",
        "-c",
        "copy",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.extend(muxer_args(dir));
    a
}

/// One line of the segment list (`seg-000004.ts,8.000000,10.033333`) as the
/// ring's segment; the file name is only its id.
pub fn parse_list_line(line: &str) -> Option<Segment> {
    let mut cols = line.trim().split(',');
    let id = ring::ts_id(cols.next()?)?;
    let ms = |c: Option<&str>| -> Option<u64> {
        let s: f64 = c?.trim().parse().ok()?;
        (s.is_finite() && s >= 0.0).then(|| (s * CLOCK as f64).round() as u64)
    };
    let (first, end) = (ms(cols.next())?, ms(cols.next())?);
    (end > first).then_some(Segment { id, first, end })
}

/// The concat list of the segments in `dir`, one `file '…'` line each.
pub fn concat_list(dir: &str, segs: &[Segment]) -> String {
    segs.iter()
        .map(|s| {
            let path = format!("{dir}/{}", ring::ts_name(s.id));
            format!("file '{}'\n", path.replace('\'', "'\\''"))
        })
        .collect()
}

/// ffmpeg's arguments to join the segments listed in `list` into `part` (MP4,
/// playable from the first byte).
pub fn join_args(list: &str, part: &str) -> Vec<String> {
    [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-map",
        "0",
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        part,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// How long the segments last together, in seconds.
pub fn seconds(segs: &[Segment]) -> f64 {
    segs.iter().map(|s| (s.end - s.first) as f64).sum::<f64>() / CLOCK as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record_like() -> Vec<String> {
        ["-f", "x11grab", "-i", ":0+0,0", "-c:v", "libx264", "-movflags", "+frag", "-f", "mp4", "/r/out.part.mp4"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn a_recording_writes_the_ring_instead() {
        let a = ring_from_record(record_like(), "/tmp/ring").unwrap();
        assert_eq!(&a[..6], &record_like()[..6]);
        assert!(!a.iter().any(|x| x == "mp4" || x.ends_with(".part.mp4")));
        let at = |k: &str| a[a.iter().position(|x| x == k).unwrap() + 1].clone();
        assert_eq!(at("-force_key_frames"), "expr:gte(t,n_forced*2)");
        assert_eq!(at("-segment_format"), "mpegts");
        assert_eq!(at("-segment_list"), "pipe:1");
        assert_eq!(a.last().unwrap(), "/tmp/ring/seg-%06d.ts");
        let mut odd = record_like();
        odd[9] = "matroska".into();
        assert_eq!(ring_from_record(odd, "/x"), None);
        assert_eq!(ring_from_record(vec!["-y".into()], "/x"), None);
    }

    #[test]
    fn wf_recorder_streams_to_the_cutter() {
        let wf: Vec<String> = ["-y", "-f", "/r/out.part.mp4", "-c", "libx264", "-r", "60"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let a = wf_to_stream(wf, 60).unwrap();
        assert_eq!(&a[..3], ["-y", "-f", "/dev/stdout"]);
        assert_eq!(&a[a.len() - 4..], ["-m", "mpegts", "-p", "g=120"]);
        assert_eq!(wf_to_stream(vec!["-y".into()], 60), None);
        let cut = ring_from_stream("/tmp/ring");
        assert_eq!(&cut[4..8], ["-f", "mpegts", "-i", "pipe:0"]);
        assert!(cut.windows(2).any(|w| w == ["-c", "copy"]));
    }

    #[test]
    fn reads_the_segment_list() {
        assert_eq!(
            parse_list_line("seg-000004.ts,8.000000,10.033333\n"),
            Some(Segment { id: 4, first: 8000, end: 10033 })
        );
        assert_eq!(parse_list_line("seg-000004.ts,8.0"), None);
        assert_eq!(parse_list_line("other.ts,0,2"), None);
        assert_eq!(parse_list_line("seg-000001.ts,2,2"), None);
        assert_eq!(parse_list_line("seg-000001.ts,-1,2"), None);
    }

    #[test]
    fn joins_the_newest_segments() {
        let segs = [Segment { id: 7, first: 0, end: 2000 }, Segment { id: 8, first: 2000, end: 3500 }];
        assert_eq!(
            concat_list("/tmp/it's", &segs),
            "file '/tmp/it'\\''s/seg-000007.ts'\nfile '/tmp/it'\\''s/seg-000008.ts'\n"
        );
        assert_eq!(seconds(&segs), 3.5);
        let j = join_args("/t/list.txt", "/v/clip.mp4.part");
        assert!(j.windows(2).any(|w| w == ["-f", "concat"]));
        assert_eq!(&j[j.len() - 3..], ["-f", "mp4", "/v/clip.mp4.part"]);
    }
}
