// Tests of mixing the sound tracks.

use super::{CHANNELS, frame_at, Mixer, Packet, RATE, ticks_at, TICKS_PER_SECOND, Track, tracks};

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
