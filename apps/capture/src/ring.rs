//! Instant Replay's ring, the same on every platform: the picture is written
//! in short segments, each a file of its own that starts on a keyframe, so the
//! last minutes can be saved without decoding anything and the oldest
//! segments deleted as new ones arrive. The disk holds the ring, not memory.
//!
//! A segment covers video frames `first..end` of the replay's clock (frame 0
//! is the start). Its sound covers the same span on the sound timeline.

use std::collections::VecDeque;

use crate::{audio, video};

#[cfg(test)]
mod unit_tests;


/// How long a segment lasts. Short, so a save starts at most this far before
/// the time asked for; long enough that opening an encoder is rare.
pub const SEGMENT_SECONDS: u32 = 2;

/// The replay lengths the engine takes, in seconds. The server holds the
/// user's choice to the disk space they allow.
pub const MIN_SECONDS: u32 = 5;
pub const MAX_SECONDS: u32 = 3600;

/// The length asked for, held to what the engine takes; 30 s when absent.
pub fn keep_seconds(asked: Option<u64>) -> u32 {
    asked.map_or(30, |s| {
        s.clamp(MIN_SECONDS as u64, MAX_SECONDS as u64) as u32
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct Segment {
    pub id: u64,
    /// The first video frame, and the one after the last.
    pub first: u64,
    pub end: u64,
}

impl Segment {
    /// Where it starts and ends, in 100-ns units from the replay's start.
    pub fn span(&self, fps: u32) -> (i64, i64) {
        (
            video::frame_time(self.first, fps),
            video::frame_time(self.end, fps),
        )
    }

    /// The sound frames it holds: `first..end` on the sound timeline.
    pub fn sound_span(&self, fps: u32) -> (u64, u64) {
        let (a, b) = self.span(fps);
        (
            audio::frame_at(a).max(0) as u64,
            audio::frame_at(b).max(0) as u64,
        )
    }
}

/// The finished segments, oldest first.
pub struct Ring {
    done: VecDeque<Segment>,
    keep_ticks: i64,
    fps: u32,
}

impl Ring {
    pub fn new(keep_seconds: u32, fps: u32) -> Ring {
        Ring {
            done: VecDeque::new(),
            keep_ticks: keep_seconds as i64 * video::TICKS_PER_SECOND,
            fps,
        }
    }

    /// A new length to keep, from the next `push` on.
    pub fn set_keep(&mut self, seconds: u32) {
        self.keep_ticks = seconds as i64 * video::TICKS_PER_SECOND;
    }

    pub fn len(&self) -> usize {
        self.done.len()
    }

    /// How much is held, in 100-ns units.
    #[cfg(test)]
    pub fn held(&self) -> i64 {
        self.done.iter().map(|s| duration(s, self.fps)).sum()
    }

    /// Adds a finished segment and gives back the ones no longer needed: the
    /// newest that together reach the length kept stay, plus one more so a
    /// save never comes up short while the next segment is being written.
    /// Segments from `pinned` on are in a save and stay until a later call.
    pub fn push(&mut self, seg: Segment, pinned: u64) -> Vec<Segment> {
        self.done.push_back(seg);
        let mut total = 0i64;
        let mut keep = 0usize;
        for s in self.done.iter().rev() {
            keep += 1;
            if total >= self.keep_ticks {
                break;
            }
            total += duration(s, self.fps);
        }
        let mut gone = Vec::new();
        while self.done.len() > keep && self.done.front().is_some_and(|s| s.id < pinned) {
            gone.extend(self.done.pop_front());
        }
        gone
    }

    /// The newest segments that together last at least `seconds` (all of
    /// them when the ring holds less), oldest first.
    pub fn clip(&self, seconds: u32) -> Vec<Segment> {
        let want = seconds as i64 * video::TICKS_PER_SECOND;
        let mut total = 0i64;
        let mut picked = Vec::new();
        for s in self.done.iter().rev() {
            if total >= want {
                break;
            }
            total += duration(s, self.fps);
            picked.push(s.clone());
        }
        picked.reverse();
        picked
    }
}

fn duration(s: &Segment, fps: u32) -> i64 {
    let (a, b) = s.span(fps);
    b - a
}

/// The file of segment `id` and of its sound track `track`.
pub fn video_name(id: u64) -> String {
    format!("seg-{id:06}.mp4")
}

pub fn sound_name(id: u64, track: usize) -> String {
    format!("seg-{id:06}-{track}.pcm")
}

/// The ring on Linux: ffmpeg's segment muxer writes MPEG-TS files named by
/// this pattern, which `ts_name` and `ts_id` read back.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn ts_pattern() -> &'static str {
    "seg-%06d.ts"
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn ts_name(id: u64) -> String {
    format!("seg-{id:06}.ts")
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn ts_id(name: &str) -> Option<u64> {
    let digits = name.strip_prefix("seg-")?.strip_suffix(".ts")?;
    (digits.len() == 6 && digits.chars().all(|c| c.is_ascii_digit()))
        .then(|| digits.parse().ok())
        .flatten()
}

/// A file this engine wrote into the ring folder (and may delete): nothing
/// else in that folder is ever touched.
pub fn is_ring_file(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("seg-") else {
        return false;
    };
    let (digits, tail) = rest.split_at(
        rest.find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len()),
    );
    if digits.len() != 6 {
        return false;
    }
    tail == ".mp4"
        || tail == ".ts"
        || tail
            .strip_prefix('-')
            .and_then(|t| t.strip_suffix(".pcm"))
            .is_some_and(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_digit()))
}

/// Splits a piece of sound starting at timeline frame `at`, `frames` long,
/// at the segment starts `starts` (ascending sound frames, one per segment
/// id from `first_id`): (segment id, offset in its file in frames, start in
/// the piece, length). Frames before the first known start are dropped.
pub fn split_sound(
    at: u64,
    frames: u64,
    first_id: u64,
    starts: &[u64],
) -> Vec<(u64, u64, u64, u64)> {
    let mut out = Vec::new();
    let end = at + frames;
    let mut pos = at;
    while pos < end {
        let Some(i) = starts.iter().rposition(|&s| s <= pos) else {
            // Before every segment still kept: skip to the first one.
            match starts.first() {
                Some(&s) if s < end => {
                    pos = s;
                    continue;
                }
                _ => break,
            }
        };
        let stop = starts.get(i + 1).map_or(end, |&n| n.min(end));
        out.push((first_id + i as u64, pos - starts[i], pos - at, stop - pos));
        pos = stop;
    }
    out
}
