//! The sound of a recording, the same on every platform: every source (the
//! sound of the PC or of one app, the microphone) is placed on one timeline
//! that starts with the video, gaps filled with silence and late or doubled
//! audio trimmed, so each track lasts as long as the video and stays in sync.
//! Sources hand in packets stamped with when the device took them; the
//! `Mixer` lines them up and gives back finished pieces of each track.

use std::collections::VecDeque;

#[cfg(test)]
mod unit_tests;


/// Samples per second per channel, and channels: what every source is asked
/// for and what the AAC encoder takes.
pub const RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;

/// 100-nanosecond units per second, the clock the devices stamp packets with.
const TICKS_PER_SECOND: i64 = 10_000_000;

/// A packet this close to where the track already is continues it: device
/// clocks wander by a few milliseconds and a click every packet is worse.
const JITTER: i64 = (RATE / 100) as i64;

/// How far behind the present a quiet source fills silence: audio stamped
/// earlier than this may still be on its way.
pub const LATENCY_TICKS: i64 = 2_000_000;

/// The timeline position (in frames, one sample per channel) of a moment
/// `ticks` after the start. Before the start is negative.
pub fn frame_at(ticks: i64) -> i64 {
    (ticks as i128 * RATE as i128 / TICKS_PER_SECOND as i128) as i64
}

/// When timeline frame `frame` plays, in 100-ns units from the start.
pub fn ticks_at(frame: u64) -> i64 {
    (frame as i128 * TICKS_PER_SECOND as i128 / RATE as i128) as i64
}

/// What a source hands in. `lane` is the source's place in the mixer.
#[derive(Debug, Clone, PartialEq)]
pub enum Packet {
    /// Interleaved stereo samples the device took starting at frame `at`.
    Sound {
        lane: usize,
        at: i64,
        samples: Vec<i16>,
    },
    /// Nothing to hand in: the source was quiet up to frame `until`.
    Quiet { lane: usize, until: i64 },
}

/// What a track is made of.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Track {
    /// One source as it is.
    Lane(usize),
    /// Every source added together: the track every player plays.
    Mix,
}

/// A finished piece of track `track`, starting at timeline frame `at`.
#[derive(Debug, PartialEq)]
pub struct Piece {
    pub track: usize,
    pub at: u64,
    pub samples: Vec<i16>,
}

struct Lane {
    /// Samples placed but not yet given out; they start at `Mixer::out`.
    pending: VecDeque<i16>,
}

pub struct Mixer {
    lanes: Vec<Lane>,
    tracks: Vec<Track>,
    /// The timeline frame every lane's pending samples start at.
    out: u64,
}

impl Mixer {
    pub fn new(lanes: usize, tracks: Vec<Track>) -> Mixer {
        Mixer {
            lanes: (0..lanes)
                .map(|_| Lane {
                    pending: VecDeque::new(),
                })
                .collect(),
            tracks,
            out: 0,
        }
    }

    /// Where lane `i` is up to, in frames.
    fn end(&self, i: usize) -> u64 {
        self.out + (self.lanes[i].pending.len() / CHANNELS) as u64
    }

    fn silence(&mut self, i: usize, until: u64) {
        let gap = until.saturating_sub(self.end(i)) as usize * CHANNELS;
        self.lanes[i].pending.extend(std::iter::repeat_n(0, gap));
    }

    /// Places a packet on its lane.
    pub fn push(&mut self, packet: Packet) {
        match packet {
            Packet::Quiet { lane, until } if lane < self.lanes.len() => {
                self.silence(lane, until.max(0) as u64);
            }
            Packet::Sound { lane, at, samples } if lane < self.lanes.len() => {
                let end = self.end(lane) as i64;
                let frames = (samples.len() / CHANNELS) as i64;
                // Late by more than the jitter: the gap is silence.
                if at > end + JITTER {
                    self.silence(lane, at as u64);
                }
                // Early (overlapping what is placed, or before the start):
                // the part already covered is dropped.
                let skip = if at < end - JITTER || at < 0 {
                    (end - at).clamp(0, frames)
                } else {
                    0
                };
                let from = skip as usize * CHANNELS;
                let to = frames as usize * CHANNELS;
                self.lanes[lane].pending.extend(&samples[from..to]);
            }
            _ => {}
        }
    }

    /// The pieces every lane has reached, one per track.
    pub fn take(&mut self) -> Vec<Piece> {
        let ready = (0..self.lanes.len())
            .map(|i| self.end(i))
            .min()
            .unwrap_or(self.out);
        self.give(ready)
    }

    /// Every track brought to exactly `end` frames (the length of the video):
    /// silence where a source said nothing, the rest dropped.
    pub fn finish(&mut self, end: u64) -> Vec<Piece> {
        for i in 0..self.lanes.len() {
            self.silence(i, end);
        }
        self.give(end)
    }

    fn give(&mut self, until: u64) -> Vec<Piece> {
        let frames = until.saturating_sub(self.out) as usize;
        if frames == 0 {
            return Vec::new();
        }
        let n = frames * CHANNELS;
        let parts: Vec<Vec<i16>> = self
            .lanes
            .iter_mut()
            .map(|l| l.pending.drain(..n).collect())
            .collect();
        let at = self.out;
        self.out = until;
        self.tracks
            .iter()
            .enumerate()
            .map(|(track, kind)| Piece {
                track,
                at,
                samples: match *kind {
                    Track::Lane(i) => parts[i].clone(),
                    Track::Mix => mix(&parts, n),
                },
            })
            .collect()
    }
}

/// Sources added together, held at full scale instead of wrapping around.
fn mix(parts: &[Vec<i16>], n: usize) -> Vec<i16> {
    (0..n)
        .map(|k| {
            let sum: i32 = parts.iter().map(|p| p[k] as i32).sum();
            sum.clamp(i16::MIN as i32, i16::MAX as i32) as i16
        })
        .collect()
}

/// The tracks a recording gets for the sources that opened: one source is
/// one track; the sound and the microphone together are the mix (what every
/// player plays) then each on its own, for editing.
pub fn tracks(lanes: usize) -> Vec<Track> {
    match lanes {
        0 => Vec::new(),
        1 => vec![Track::Lane(0)],
        n => std::iter::once(Track::Mix)
            .chain((0..n).map(Track::Lane))
            .collect(),
    }
}
