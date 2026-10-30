//! The numbers of a recording, the same on every platform: frame rate, the
//! size the encoder gets, the bitrate, the clock, and where the picture sits
//! inside the frame when the window being recorded changes shape.

/// Frames per second when the request names none, and the only other choice.
pub const DEFAULT_FPS: u32 = 60;
const OTHER_FPS: u32 = 30;

/// The widest picture an H.264 encoder takes everywhere (NVENC, AMF and
/// Quick Sync all stop at 4096); a wider screen is scaled down to fit.
const MAX_SIDE: u32 = 4096;

/// The heights a recording can be brought down to; anything else keeps the
/// size of the source.
const HEIGHTS: [u32; 3] = [720, 1080, 1440];
const MIN_BITRATE: u32 = 4_000_000;
const MAX_BITRATE: u32 = 80_000_000;

/// 100-nanosecond units per second, the clock Media Foundation counts in.
pub const TICKS_PER_SECOND: i64 = 10_000_000;

/// How much detail a recording keeps, as bits per pixel per frame.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Quality {
    /// Smaller files for sharing.
    Small,
    /// Sharp text and fast games at a size people keep.
    #[default]
    Normal,
    High,
}

impl Quality {
    pub fn parse(asked: Option<&str>) -> Quality {
        match asked {
            Some("small") => Quality::Small,
            Some("high") => Quality::High,
            _ => Quality::Normal,
        }
    }

    fn bits_per_pixel(self) -> f64 {
        match self {
            Quality::Small => 0.06,
            Quality::Normal => 0.12,
            Quality::High => 0.2,
        }
    }
}

/// The height asked for (720, 1080 or 1440), or 0: the size of the source.
pub fn height_cap(asked: Option<u64>) -> u32 {
    asked
        .and_then(|h| HEIGHTS.into_iter().find(|&k| k as u64 == h))
        .unwrap_or(0)
}

pub fn fps(asked: Option<u64>) -> u32 {
    if asked == Some(OTHER_FPS as u64) {
        OTHER_FPS
    } else {
        DEFAULT_FPS
    }
}

/// The encoded size for a source of `width` x `height`: scaled to fit
/// `MAX_SIDE` and, with a `cap` (height_cap), to bring its short side down to
/// it, keeping its shape; even on both sides (4:2:0 halves them). Never larger
/// than the source.
pub fn encode_size(width: u32, height: u32, cap: u32) -> (u32, u32) {
    let (w, h) = (width.max(2) as f64, height.max(2) as f64);
    let short = if cap > 0 { cap as f64 / w.min(h) } else { 1.0 };
    let k = (MAX_SIDE as f64 / w.max(h)).min(short).min(1.0);
    let even = |v: f64| ((v * k).round() as u32 & !1).max(2);
    (even(w), even(h))
}

pub fn bitrate(width: u32, height: u32, fps: u32, quality: Quality) -> u32 {
    let bits = width as f64 * height as f64 * fps as f64 * quality.bits_per_pixel();
    (bits as u32).clamp(MIN_BITRATE, MAX_BITRATE)
}

/// When frame `index` is shown, in 100-ns units from the start. Rounded up,
/// so the moment a frame starts belongs to that frame (`frame_index`).
pub fn frame_time(index: u64, fps: u32) -> i64 {
    let fps = fps.max(1) as i128;
    ((index as i128 * TICKS_PER_SECOND as i128 + fps - 1) / fps) as i64
}

/// The frame a moment `elapsed` (100-ns units) belongs to.
pub fn frame_index(elapsed: i64, fps: u32) -> u64 {
    (elapsed.max(0) as i128 * fps.max(1) as i128 / TICKS_PER_SECOND as i128) as u64
}

/// A timelapse takes one picture every N seconds (these, nothing else) and
/// plays them at this rate: a minute at "every 2 s" is one second of video.
const LAPSE_EVERY: [u32; 6] = [1, 2, 5, 10, 30, 60];
pub const LAPSE_FPS: u32 = 30;

/// The interval asked for, or None: a normal recording.
pub fn lapse_every(asked: Option<u64>) -> Option<u32> {
    asked.and_then(|s| LAPSE_EVERY.into_iter().find(|&k| k as u64 == s))
}

/// When picture `index` is taken, in 100-ns units from the start: on the frame
/// clock for a recording, every `every` seconds for a timelapse.
pub fn shot_time(index: u64, fps: u32, every: Option<u32>) -> i64 {
    match every {
        Some(s) => (index as i64).saturating_mul(s as i64 * TICKS_PER_SECOND),
        None => frame_time(index, fps),
    }
}

/// The picture a moment `elapsed` (100-ns units) belongs to.
pub fn shot_index(elapsed: i64, fps: u32, every: Option<u32>) -> u64 {
    match every {
        Some(s) => (elapsed.max(0) / (s.max(1) as i64 * TICKS_PER_SECOND)) as u64,
        None => frame_index(elapsed, fps),
    }
}

/// Where a `src_w` x `src_h` picture goes inside a `dst_w` x `dst_h` frame:
/// as large as fits with its shape kept, centred, black around it. As
/// fractions of the frame (left, top, right, bottom), what the shader takes.
pub fn letterbox(src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> [f32; 4] {
    let (sw, sh) = (src_w.max(1) as f64, src_h.max(1) as f64);
    let (dw, dh) = (dst_w.max(1) as f64, dst_h.max(1) as f64);
    let k = (dw / sw).min(dh / sh);
    let (w, h) = (sw * k / dw, sh * k / dh);
    let (x, y) = ((1.0 - w) / 2.0, (1.0 - h) / 2.0);
    [x as f32, y as f32, (x + w) as f32, (y + h) as f32]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_timelapse_takes_a_picture_every_n_seconds() {
        assert_eq!(lapse_every(None), None);
        assert_eq!(lapse_every(Some(5)), Some(5));
        assert_eq!(lapse_every(Some(3)), None);
        assert_eq!(lapse_every(Some(0)), None);
        assert_eq!(shot_time(3, 30, Some(5)), 15 * TICKS_PER_SECOND);
        assert_eq!(shot_time(3, 30, None), frame_time(3, 30));
        assert_eq!(shot_index(14 * TICKS_PER_SECOND, 30, Some(5)), 2);
        assert_eq!(shot_index(15 * TICKS_PER_SECOND, 30, Some(5)), 3);
        assert_eq!(shot_index(-1, 30, Some(5)), 0);
        assert_eq!(shot_index(TICKS_PER_SECOND, 60, None), 60);
        // Hours of pictures never overflow the clock.
        assert!(shot_time(u32::MAX as u64, 30, Some(60)) > 0);
    }

    #[test]
    fn sixty_unless_thirty_is_asked() {
        assert_eq!(fps(None), 60);
        assert_eq!(fps(Some(30)), 30);
        assert_eq!(fps(Some(144)), 60);
        assert_eq!(fps(Some(0)), 60);
    }

    #[test]
    fn sizes_are_even_and_fit_the_encoder() {
        assert_eq!(encode_size(1920, 1080, 0), (1920, 1080));
        assert_eq!(encode_size(3840, 2160, 0), (3840, 2160));
        assert_eq!(encode_size(1201, 751, 0), (1200, 750));
        assert_eq!(encode_size(5120, 1440, 0), (4096, 1152));
        assert_eq!(encode_size(7680, 4320, 0), (4096, 2304));
        assert_eq!(encode_size(1440, 5120, 0), (1152, 4096));
        assert_eq!(encode_size(0, 0, 0), (2, 2));
        assert_eq!(encode_size(1, 9999, 0), (2, 4096));
    }

    #[test]
    fn a_height_cap_brings_the_short_side_down_and_never_up() {
        assert_eq!(encode_size(3840, 2160, 1080), (1920, 1080));
        assert_eq!(encode_size(2560, 1440, 720), (1280, 720));
        assert_eq!(encode_size(1200, 750, 1080), (1200, 750), "smaller stays");
        assert_eq!(
            encode_size(1080, 1920, 720),
            (720, 1280),
            "portrait: the width"
        );
        assert_eq!(
            encode_size(7680, 2160, 1440),
            (4096, 1152),
            "the encoder limit still wins"
        );
        assert_eq!(encode_size(3441, 1441, 1440), (3438, 1440));
    }

    #[test]
    fn only_the_offered_heights_and_qualities_are_taken() {
        assert_eq!(height_cap(Some(1080)), 1080);
        assert_eq!(height_cap(Some(720)), 720);
        assert_eq!(height_cap(Some(1440)), 1440);
        assert_eq!(height_cap(Some(2)), 0);
        assert_eq!(height_cap(None), 0);
        assert_eq!(Quality::parse(Some("high")), Quality::High);
        assert_eq!(Quality::parse(Some("small")), Quality::Small);
        assert_eq!(Quality::parse(Some("x")), Quality::Normal);
        assert_eq!(Quality::parse(None), Quality::Normal);
    }

    #[test]
    fn bitrate_follows_the_pixels_within_bounds() {
        let n = Quality::Normal;
        assert_eq!(bitrate(1920, 1080, 60, n), 14_929_920);
        assert_eq!(bitrate(3840, 2160, 60, n), 59_719_680);
        assert_eq!(bitrate(320, 240, 30, n), MIN_BITRATE);
        assert_eq!(bitrate(4096, 4096, 60, n), MAX_BITRATE);
        assert_eq!(bitrate(1920, 1080, 60, Quality::Small), 7_464_960);
        assert_eq!(bitrate(1920, 1080, 60, Quality::High), 24_883_200);
    }

    #[test]
    fn the_clock_round_trips() {
        assert_eq!(frame_time(0, 60), 0);
        assert_eq!(frame_time(60, 60), TICKS_PER_SECOND);
        assert_eq!(frame_time(1, 30), 333_334);
        for i in [0u64, 1, 59, 60, 61, 3599, 216_000] {
            assert_eq!(frame_index(frame_time(i, 60), 60), i, "frame {i}");
        }
        assert_eq!(frame_index(-5, 60), 0);
        assert_eq!(frame_index(TICKS_PER_SECOND / 2, 30), 15);
    }

    #[test]
    fn a_picture_is_centred_with_its_shape() {
        assert_eq!(letterbox(1920, 1080, 1920, 1080), [0.0, 0.0, 1.0, 1.0]);
        // A window that became narrower: bars left and right.
        let [l, t, r, b] = letterbox(960, 1080, 1920, 1080);
        assert_eq!((l, t, r, b), (0.25, 0.0, 0.75, 1.0));
        // Wider: bars top and bottom.
        let [l, t, r, b] = letterbox(1920, 540, 1920, 1080);
        assert_eq!((l, t, r, b), (0.0, 0.25, 1.0, 0.75));
        // Twice as large, same shape: fills, scaled down.
        assert_eq!(letterbox(3840, 2160, 1920, 1080), [0.0, 0.0, 1.0, 1.0]);
        assert_eq!(letterbox(0, 0, 0, 0), [0.0, 0.0, 1.0, 1.0]);
    }
}
