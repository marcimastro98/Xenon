// Tests of the ring that keeps the last seconds of video.

use crate::video;
use super::{is_ring_file, keep_seconds, MAX_SECONDS, MIN_SECONDS, Ring, Segment, SEGMENT_SECONDS, split_sound, ts_id, ts_name, ts_pattern};

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(id: u64, fps: u32) -> Segment {
        let n = (SEGMENT_SECONDS * fps) as u64;
        Segment {
            id,
            first: id * n,
            end: (id + 1) * n,
        }
    }

    #[test]
    fn keeps_the_length_plus_one_segment() {
        let mut r = Ring::new(10, 60);
        let mut gone = Vec::new();
        for id in 0..10 {
            gone.extend(r.push(seg(id, 60), u64::MAX));
        }
        // 10 s = five 2 s segments, plus one spare.
        assert_eq!(r.len(), 6);
        assert_eq!(
            gone.iter().map(|s| s.id).collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
        assert_eq!(r.held(), 12 * video::TICKS_PER_SECOND);
    }

    #[test]
    fn a_pinned_segment_waits_for_the_save() {
        let mut r = Ring::new(4, 60);
        for id in 0..4 {
            r.push(seg(id, 60), u64::MAX);
        }
        // A save holds segments 1 on: nothing from 1 goes, even when old.
        let gone = r.push(seg(4, 60), 1);
        assert!(gone.iter().all(|s| s.id < 1));
        assert!(r.push(seg(5, 60), 1).is_empty());
        // Save done: the backlog goes at the next segment.
        let gone = r.push(seg(6, 60), u64::MAX);
        assert_eq!(gone.iter().map(|s| s.id).collect::<Vec<_>>(), vec![1, 2, 3]);
    }

    #[test]
    fn a_clip_takes_the_newest_segments_that_cover_it() {
        let mut r = Ring::new(60, 60);
        for id in 0..10 {
            r.push(seg(id, 60), u64::MAX);
        }
        let ids = |v: Vec<Segment>| v.iter().map(|s| s.id).collect::<Vec<_>>();
        assert_eq!(ids(r.clip(4)), vec![8, 9]);
        // 5 s needs three segments (6 s): never shorter than asked.
        assert_eq!(ids(r.clip(5)), vec![7, 8, 9]);
        // More than held: everything.
        assert_eq!(r.clip(600).len(), 10);
    }

    #[test]
    fn a_short_last_segment_counts_for_what_it_holds() {
        let mut r = Ring::new(60, 60);
        r.push(seg(0, 60), u64::MAX);
        // Cut short by a save after half a second.
        r.push(
            Segment {
                id: 1,
                first: 120,
                end: 150,
            },
            u64::MAX,
        );
        assert_eq!(
            r.clip(1).iter().map(|s| s.id).collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert_eq!(r.held(), 25_000_000);
    }

    #[test]
    fn lengths_are_held_to_what_the_engine_takes() {
        assert_eq!(keep_seconds(None), 30);
        assert_eq!(keep_seconds(Some(1)), MIN_SECONDS);
        assert_eq!(keep_seconds(Some(90)), 90);
        assert_eq!(keep_seconds(Some(1_000_000)), MAX_SECONDS);
    }

    #[test]
    fn sound_spans_meet_exactly() {
        let a = Segment {
            id: 0,
            first: 0,
            end: 120,
        };
        let b = Segment {
            id: 1,
            first: 120,
            end: 240,
        };
        assert_eq!(a.sound_span(60), (0, 96_000));
        assert_eq!(a.sound_span(60).1, b.sound_span(60).0);
        // 30 fps: no gap or overlap either.
        let c = Segment {
            id: 2,
            first: 7,
            end: 19,
        };
        let d = Segment {
            id: 3,
            first: 19,
            end: 31,
        };
        assert_eq!(c.sound_span(30).1, d.sound_span(30).0);
    }

    #[test]
    fn only_ring_files_are_recognised() {
        assert!(is_ring_file("seg-000012.mp4"));
        assert!(is_ring_file("seg-000012-0.pcm"));
        assert!(is_ring_file("seg-000012-2.pcm"));
        assert!(is_ring_file("seg-000012.ts"));
        assert_eq!(ts_id(&ts_name(12)), Some(12));
        assert_eq!(ts_pattern().replace("%06d", "000012"), ts_name(12));
        for name in [
            "seg-000012.ts.part",
            "seg-12.ts",
            "seg-12.mp4",
            "seg-000012.mp4.part",
            "seg-000012-.pcm",
            "seg-000012-a.pcm",
            "notes.txt",
            "seg-0000123.mp4",
            "Seg-000012.mp4",
            "seg-000012.MP4",
            "seg-000012-0.wav",
        ] {
            assert!(!is_ring_file(name), "{name}");
        }
    }

    #[test]
    fn sound_is_split_at_segment_starts() {
        let starts = [100, 200, 300];
        // Inside one segment.
        assert_eq!(split_sound(120, 10, 5, &starts), vec![(5, 20, 0, 10)]);
        // Across two.
        assert_eq!(
            split_sound(190, 20, 5, &starts),
            vec![(5, 90, 0, 10), (6, 0, 10, 10)]
        );
        // The last segment runs on.
        assert_eq!(split_sound(350, 100, 5, &starts), vec![(7, 50, 0, 100)]);
        // Before the oldest kept segment: that part is dropped.
        assert_eq!(split_sound(80, 30, 5, &starts), vec![(5, 0, 20, 10)]);
        assert!(split_sound(10, 30, 5, &starts).is_empty());
        assert!(split_sound(10, 30, 5, &[]).is_empty());
    }
}
