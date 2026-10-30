//! Instant Replay on macOS, the pure part: when the frame clock cuts a
//! segment, how a saved clip's sound is fed in pieces, and the answers and
//! events, the Windows ones. Its tests run on every OS.

use serde_json::{json, Value};

use crate::ring::{self, Segment};
use crate::video;

/// Sound frames per buffer handed to the clip's AAC encoder: about 21 ms,
/// close to a frame of video, so the writer interleaves evenly.
pub const SOUND_PIECE: u64 = 1024;

/// The frames a segment holds before it is cut.
pub fn segment_frames(fps: u32) -> u64 {
    (ring::SEGMENT_SECONDS * fps.max(1)) as u64
}

/// The segment being written ends before frame `index`: it is full, or a
/// save waits for it. Never an empty one.
pub fn cut_due(index: u64, first: u64, written: u64, fps: u32, save_waiting: bool) -> bool {
    written > 0 && (save_waiting || index >= first + segment_frames(fps))
}

/// Where a segment sits in a clip that starts with `clip_first`, in 100-ns
/// units: its frames are stamped from 0 in its own file.
pub fn offset_in_clip(seg: &Segment, clip_first: &Segment, fps: u32) -> i64 {
    seg.span(fps).0 - clip_first.span(fps).0
}

/// A segment's own length, in 100-ns units: where its file ends.
pub fn own_length(seg: &Segment, fps: u32) -> i64 {
    video::frame_time(seg.end.saturating_sub(seg.first), fps)
}

/// A clip's length in 100-ns units.
pub fn clip_length(segs: &[Segment], fps: u32) -> i64 {
    match (segs.first(), segs.last()) {
        (Some(a), Some(b)) => b.span(fps).1 - a.span(fps).0,
        _ => 0,
    }
}

/// `frames` of sound cut into pieces of at most `piece`: (start, length).
pub fn pieces(frames: u64, piece: u64) -> Vec<(u64, u64)> {
    let piece = piece.max(1);
    (0..frames.div_ceil(piece))
        .map(|i| {
            let at = i * piece;
            (at, piece.min(frames - at))
        })
        .collect()
}

/// The written part of a save: next to the clip, renamed once whole.
pub fn part_path(path: &str) -> String {
    format!("{path}.part.mp4")
}

/// The answer to `replay_start`, as on Windows: `sound` is "system" when the
/// Mac's sound is kept, null otherwise.
pub fn start_answer(size: (u32, u32), fps: u32, bitrate: u32, sound: bool, mic: bool, monitor: usize) -> Value {
    json!({
        "width": size.0, "height": size.1, "fps": fps, "hdr": false, "bitrate": bitrate,
        "sound": if sound { json!("system") } else { Value::Null }, "mic": mic,
        "monitor": monitor,
    })
}

/// The `replay_saved` event: the clip's seconds and bytes, or why it failed.
pub fn saved_event(token: &str, result: Result<(i64, u64), (&'static str, String)>) -> Value {
    match result {
        Ok((ticks, bytes)) => json!({
            "event": "replay_saved", "token": token, "ok": true,
            "seconds": ticks as f64 / video::TICKS_PER_SECOND as f64, "bytes": bytes,
        }),
        Err((code, detail)) => json!({
            "event": "replay_saved", "token": token, "ok": false, "error": code, "detail": detail,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(id: u64, first: u64, end: u64) -> Segment {
        Segment { id, first, end }
    }

    #[test]
    fn a_segment_is_cut_when_full_or_for_a_save_never_empty() {
        assert_eq!(segment_frames(60), 120);
        assert!(!cut_due(119, 0, 119, 60, false));
        assert!(cut_due(120, 0, 120, 60, false));
        assert!(cut_due(30, 0, 30, 60, true));
        assert!(!cut_due(30, 0, 0, 60, true));
        assert!(!cut_due(500, 0, 0, 60, false));
        assert_eq!(segment_frames(0), 2);
    }

    #[test]
    fn segments_sit_where_they_were_recorded() {
        let (a, b) = (seg(4, 480, 600), seg(5, 600, 690));
        assert_eq!(offset_in_clip(&a, &a, 60), 0);
        assert_eq!(offset_in_clip(&b, &a, 60), 20_000_000);
        assert_eq!(own_length(&b, 60), 15_000_000);
        assert_eq!(clip_length(&[a.clone(), b], 60), 35_000_000);
        assert_eq!(clip_length(&[a], 60), 20_000_000);
        assert_eq!(clip_length(&[], 60), 0);
        // 30 fps: the joints meet without a gap.
        let (c, d) = (seg(0, 0, 60), seg(1, 60, 125));
        assert_eq!(offset_in_clip(&d, &c, 30), own_length(&c, 30));
    }

    #[test]
    fn sound_is_fed_in_even_pieces() {
        assert_eq!(pieces(2500, 1024), vec![(0, 1024), (1024, 1024), (2048, 452)]);
        assert_eq!(pieces(1024, 1024), vec![(0, 1024)]);
        assert!(pieces(0, 1024).is_empty());
        assert_eq!(pieces(3, 0), vec![(0, 1), (1, 1), (2, 1)]);
        let total: u64 = pieces(96_000, SOUND_PIECE).iter().map(|p| p.1).sum();
        assert_eq!(total, 96_000);
    }

    #[test]
    fn answers_match_the_other_engines() {
        let a = start_answer((1920, 1080), 60, 12_000_000, true, false, 1);
        assert_eq!(a["sound"], "system");
        assert_eq!(a["mic"], false);
        assert_eq!(a["hdr"], false);
        assert_eq!(a["monitor"], 1);
        assert!(start_answer((2, 2), 30, 1, false, true, 0)["sound"].is_null());
        let ok = saved_event("t1", Ok((15_000_000, 42)));
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["seconds"], 1.5);
        assert_eq!(ok["bytes"], 42);
        let bad = saved_event("t2", Err(("too_short", String::new())));
        assert_eq!(bad["error"], "too_short");
        assert_eq!(bad["event"], "replay_saved");
        assert_eq!(part_path("/m/clip.mp4"), "/m/clip.mp4.part.mp4");
    }
}
