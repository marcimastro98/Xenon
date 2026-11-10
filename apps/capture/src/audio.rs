//! The sound of a recording, the same on every platform: every source (the
//! sound of the PC or of one app, the microphone) is placed on one timeline
//! that starts with the video, gaps filled with silence and late or doubled
//! audio trimmed, so each track lasts as long as the video and stays in sync.
//! Sources hand in packets stamped with when the device took them; the
//! `Mixer` lines them up and gives back finished pieces of each track.

use std::collections::VecDeque;

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

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(frames: usize, v: i16) -> Vec<i16> {
        vec![v; frames * CHANNELS]
    }

    fn sound(lane: usize, at: i64, samples: Vec<i16>) -> Packet {
        Packet::Sound { lane, at, samples }
    }

    #[test]
    fn the_clock_converts_both_ways() {
        assert_eq!(frame_at(TICKS_PER_SECOND), RATE as i64);
        assert_eq!(frame_at(-TICKS_PER_SECOND / 2), -(RATE as i64) / 2);
        assert_eq!(ticks_at(RATE as u64 * 3), 3 * TICKS_PER_SECOND);
        assert_eq!(ticks_at(480), 100_000);
    }

    #[test]
    fn one_source_continuous_comes_out_as_it_went_in() {
        let mut m = Mixer::new(1, tracks(1));
        m.push(sound(0, 0, tone(480, 7)));
        m.push(sound(0, 480, tone(480, 9)));
        let out = m.take();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].at, 0);
        assert_eq!(out[0].samples.len(), 960 * CHANNELS);
        assert_eq!(out[0].samples[0], 7);
        assert_eq!(out[0].samples[480 * CHANNELS], 9);
    }

    #[test]
    fn a_late_packet_leaves_silence_before_it() {
        let mut m = Mixer::new(1, tracks(1));
        m.push(sound(0, 4800, tone(100, 5)));
        let out = m.take();
        assert_eq!(out[0].samples.len(), 4900 * CHANNELS);
        assert!(out[0].samples[..4800 * CHANNELS].iter().all(|&s| s == 0));
        assert_eq!(out[0].samples[4800 * CHANNELS], 5);
    }

    #[test]
    fn small_clock_wander_is_not_a_gap_or_an_overlap() {
        let mut m = Mixer::new(1, tracks(1));
        m.push(sound(0, 0, tone(480, 1)));
        m.push(sound(0, 480 + 200, tone(480, 2)));
        m.push(sound(0, 960 - 300, tone(480, 3)));
        let out = m.take();
        assert_eq!(
            out[0].samples.len(),
            1440 * CHANNELS,
            "no silence, nothing dropped"
        );
    }

    #[test]
    fn audio_from_before_the_start_or_already_covered_is_dropped() {
        let mut m = Mixer::new(1, tracks(1));
        m.push(sound(0, -1000, tone(1500, 4)));
        m.push(sound(0, 0, tone(2000, 6)));
        let out = m.take();
        // 500 frames survive of the first; the second overlaps by 500 beyond jitter.
        assert_eq!(out[0].samples.len(), 2000 * CHANNELS);
        assert_eq!(out[0].samples[0], 4);
        assert_eq!(out[0].samples[499 * CHANNELS], 4);
        assert_eq!(out[0].samples[500 * CHANNELS], 6);
    }

    #[test]
    fn quiet_sources_move_the_track_on_with_silence() {
        let mut m = Mixer::new(1, tracks(1));
        m.push(Packet::Quiet {
            lane: 0,
            until: 960,
        });
        m.push(Packet::Quiet { lane: 0, until: -5 });
        let out = m.take();
        assert_eq!(out[0].samples, tone(960, 0));
    }

    #[test]
    fn two_sources_wait_for_each_other_and_mix_without_wrapping() {
        let mut m = Mixer::new(2, tracks(2));
        m.push(sound(0, 0, tone(960, 30000)));
        assert!(
            m.take().is_empty(),
            "the microphone has not reached anything yet"
        );
        m.push(sound(1, 0, tone(480, 10000)));
        let out = m.take();
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].samples, tone(480, i16::MAX), "the mix clamps");
        assert_eq!(out[1].samples, tone(480, 30000));
        assert_eq!(out[2].samples, tone(480, 10000));
        assert!(out.iter().all(|p| p.at == 0));
        m.push(Packet::Quiet {
            lane: 1,
            until: 960,
        });
        let next = m.take();
        assert_eq!(next[0].at, 480);
        assert_eq!(next[0].samples, tone(480, 30000));
    }

    #[test]
    fn finish_brings_every_track_to_the_length_of_the_video() {
        let mut m = Mixer::new(2, tracks(2));
        m.push(sound(0, 0, tone(2000, 3)));
        let out = m.finish(1000);
        assert!(out.iter().all(|p| p.samples.len() == 1000 * CHANNELS));
        assert_eq!(
            out[2].samples,
            tone(1000, 0),
            "a silent microphone is silence"
        );
        assert!(m.finish(1000).is_empty(), "nothing twice");
    }

    #[test]
    fn tracks_for_the_sources_that_opened() {
        assert!(tracks(0).is_empty());
        assert_eq!(tracks(1), vec![Track::Lane(0)]);
        assert_eq!(tracks(2), vec![Track::Mix, Track::Lane(0), Track::Lane(1)]);
    }

    #[test]
    fn a_packet_for_a_lane_that_does_not_exist_is_ignored() {
        let mut m = Mixer::new(1, tracks(1));
        m.push(sound(3, 0, tone(10, 1)));
        m.push(Packet::Quiet {
            lane: 9,
            until: 100,
        });
        assert!(m.take().is_empty());
    }
}
