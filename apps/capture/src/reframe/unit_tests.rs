// Tests of the sizes, crops and frame pacing of a copy.

use super::{Crop, fit, FIT_MIN_VIDEO_BPS, Focus, gif_size, Pace, retry_bitrate, vertical, vertical_split};
use super::resample::{nv12_to_bgrx, Resampler, Yuv};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_split_copy_puts_the_face_on_top_and_the_game_below() {
        let bubble = crate::bubble::place(1920, 1080, crate::bubble::Corner::BottomRight);
        let s = vertical_split(1920, 1080, Focus::Center, bubble);
        let (plain, size) = vertical(1920, 1080, Focus::Center);
        assert_eq!(plain.h, 1080);
        // Same copy size as the plain vertical one, cut in two.
        assert_eq!(s.cam.1 .0, size.0);
        assert_eq!(s.game.1 .0, size.0);
        assert_eq!(s.cam.1 .1 + s.game.1 .1, size.1);
        assert_eq!(s.cam.1 .1 % 2, 0);
        // The game keeps the full height, wider than the plain 9:16 crop.
        let (game, gsize) = s.game;
        assert_eq!(game.h, 1080);
        assert!(game.w > plain.w && game.x + game.w <= 1920);
        let ratio = |c: Crop| c.w as f64 / c.h as f64;
        let out = |(w, h): (u32, u32)| w as f64 / h as f64;
        assert!((ratio(game) - out(gsize)).abs() < 0.02);
        // The webcam part is inside the circle (corners included) and keeps the shape.
        let (cam, csize) = s.cam;
        assert!((ratio(cam) - out(csize)).abs() < 0.05);
        let px = [bubble[0] * 1920.0, bubble[1] * 1080.0, bubble[2] * 1920.0];
        let (cx, cy, r) = (
            (px[0] + px[2]) / 2.0,
            px[1] + (px[2] - px[0]) / 2.0,
            (px[2] - px[0]) / 2.0,
        );
        for (x, y) in [(cam.x, cam.y), (cam.x + cam.w, cam.y + cam.h)] {
            let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
            assert!(d < r, "corner {x},{y} is {d} from the centre, radius {r}");
        }
        for c in [cam, game] {
            assert!(
                c.x % 2 == 0 && c.y % 2 == 0 && c.w % 2 == 0 && c.h % 2 == 0,
                "{c:?}"
            );
        }
        // Every corner, a small recording and a tall window stay in the frame.
        for corner in [
            crate::bubble::Corner::TopLeft,
            crate::bubble::Corner::TopRight,
            crate::bubble::Corner::BottomLeft,
        ] {
            for (w, h) in [(1280, 720), (3840, 2160), (600, 1200), (2, 2)] {
                let s = vertical_split(w, h, Focus::Left, crate::bubble::place(w, h, corner));
                for (c, _) in [s.cam, s.game] {
                    assert!(
                        c.x + c.w <= w.max(2) && c.y + c.h <= h.max(2),
                        "{w}x{h} {corner:?} {c:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_wide_frame_keeps_its_chosen_nine_by_sixteen() {
        let (c, size) = vertical(1920, 1080, Focus::Center);
        assert_eq!(
            c,
            Crop {
                x: 657,
                y: 0,
                w: 606,
                h: 1080
            }
        );
        assert_eq!(size, (606, 1080), "never scaled up");
        assert_eq!(vertical(1920, 1080, Focus::Left).0.x, 0);
        assert_eq!(vertical(1920, 1080, Focus::Right).0.x, 1920 - 606);
        // 4K: scaled down to the tallest phone picture.
        let (c, size) = vertical(3840, 2160, Focus::Center);
        assert_eq!((c.w, c.h), (1214, 2160));
        assert_eq!(size, (1078, 1920));
        // Already taller than 9:16: the middle band, nothing lost sideways.
        let (c, _) = vertical(600, 1200, Focus::Left);
        assert_eq!((c.x, c.w), (0, 600));
        assert_eq!((c.y, c.h), (67, 1066));
        let (c, size) = vertical(0, 0, Focus::Center);
        assert!(c.w >= 2 && c.h >= 2 && size.0 >= 2 && size.1 >= 2);
    }

    #[test]
    fn a_copy_that_must_fit_picks_the_largest_sharp_size() {
        const MB: u64 = 1024 * 1024;
        // 30 s of 1080p60 into 10 MB: 720p at 30 is what stays sharp.
        let f = fit((1920, 1080), 60, 30.0, 10 * MB, 192_000).unwrap();
        assert_eq!((f.width, f.height, f.fps), (1280, 720, 30), "{f:?}");
        let budget = 10.0 * MB as f64 * 8.0 * 0.9 / 30.0 - 192_000.0;
        assert_eq!(f.video_bps, budget as u32);
        // Short and roomy: full size and frame rate.
        let f = fit((1920, 1080), 60, 5.0, 50 * MB, 192_000).unwrap();
        assert_eq!((f.width, f.height, f.fps), (1920, 1080, 60));
        // Tight: the smallest size, not mush below it.
        let f = fit((3840, 2160), 60, 120.0, 10 * MB, 192_000).unwrap();
        assert_eq!((f.width, f.height, f.fps), (640, 360, 30));
        assert!(fit((1920, 1080), 60, 600.0, 10 * MB, 192_000).is_none());
        // A vertical source stays vertical.
        let f = fit((1080, 1920), 30, 20.0, 10 * MB, 0).unwrap();
        assert!(f.height > f.width && f.fps == 30);
        assert!(fit((1920, 1080), 60, 0.0, 10 * MB, 0).is_none());
    }

    #[test]
    fn an_overshoot_is_made_again_smaller() {
        assert_eq!(retry_bitrate(1_000_000, 100, 0), 1_000_000);
        let b = retry_bitrate(1_000_000, 10_000_000, 11_000_000);
        assert!(b < 1_000_000 * 10 / 11, "{b}");
        assert_eq!(retry_bitrate(200_000, 1, 1_000_000), FIT_MIN_VIDEO_BPS);
    }

    #[test]
    fn a_gif_is_small_and_keeps_its_shape() {
        assert_eq!(gif_size(1920, 1080), (480, 270));
        assert_eq!(gif_size(1080, 1920), (270, 480));
        assert_eq!(gif_size(320, 200), (320, 200));
        assert_eq!(gif_size(0, 0), (1, 1));
    }

    #[test]
    fn the_pace_keeps_one_frame_per_tick() {
        let mut p = Pace::every(30);
        let frame = 10_000_000 / 60;
        let kept = (0..60).filter(|i| p.take(i * frame)).count();
        assert_eq!(kept, 30);
        // A long gap: one frame after it, not a burst.
        let mut p = Pace::every(10);
        assert!(p.take(0));
        assert!(p.take(50_000_000));
        assert!(!p.take(50_100_000));
    }

    #[test]
    fn the_resampler_keeps_flat_colour_and_picks_the_crop() {
        // 8x4: left half red, right half blue (BGRX).
        let (w, h) = (8u32, 4u32);
        let mut src = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                src[i..i + 4].copy_from_slice(if x < 4 {
                    &[0, 0, 255, 255]
                } else {
                    &[255, 0, 0, 255]
                });
            }
        }
        let run = |r: Resampler, src: &[u8], stride: usize| {
            let mut out = vec![7u8; r.len()];
            r.run(src, stride, &mut out);
            out
        };
        let stride = (w * 4) as usize;
        let right = run(
            Resampler::new(
                4,
                Crop {
                    x: 4,
                    y: 0,
                    w: 4,
                    h: 4,
                },
                (2, 2),
            ),
            &src,
            stride,
        );
        assert!(right.chunks(4).all(|p| p == [255, 0, 0, 255]), "{right:?}");
        let up = run(
            Resampler::new(
                4,
                Crop {
                    x: 0,
                    y: 0,
                    w: 4,
                    h: 4,
                },
                (8, 8),
            ),
            &src,
            stride,
        );
        assert!(up.chunks(4).all(|p| p == [0, 0, 255, 255]));
        // Halving across the edge: the middle pixel mixes the two.
        let half = run(Resampler::new(4, Crop::whole(w, h), (3, 1)), &src, stride);
        assert_eq!(&half[0..4], &[0, 0, 255, 255]);
        assert!(half[4] > 60 && half[6] > 60, "{half:?}");
        // Rows wider than the picture (a decoder's padded pitch) are skipped over.
        let mut padded = vec![9u8; (stride + 16) * h as usize];
        for y in 0..h as usize {
            padded[y * (stride + 16)..y * (stride + 16) + stride]
                .copy_from_slice(&src[y * stride..(y + 1) * stride]);
        }
        let again = run(
            Resampler::new(
                4,
                Crop {
                    x: 4,
                    y: 0,
                    w: 4,
                    h: 4,
                },
                (2, 2),
            ),
            &padded,
            stride + 16,
        );
        assert_eq!(again, right);
        // One byte a pixel (luma) and two (paired chroma) keep their values.
        let luma = run(Resampler::new(1, Crop::whole(4, 2), (2, 1)), &[50; 8], 4);
        assert_eq!(luma, [50, 50]);
        let chroma = run(
            Resampler::new(2, Crop::whole(2, 2), (1, 1)),
            &[90, 200, 90, 200, 90, 200, 90, 200],
            4,
        );
        assert_eq!(chroma, [90, 200]);
        // Too little source: a black frame, never a panic.
        let none = run(
            Resampler::new(4, Crop::whole(w, h), (2, 2)),
            &src[..10],
            stride,
        );
        assert_eq!(none, vec![0; 16]);
    }

    #[test]
    fn nv12_turns_back_into_the_colours_it_was_made_from() {
        // BT.709 limited range: pure red, green, blue and grey.
        let yuv = Yuv {
            bt601: false,
            full: false,
        };
        for (ycc, bgr) in [
            ([63u8, 102, 240], [0u8, 0, 255]),
            ([173, 42, 26], [0, 255, 0]),
            ([32, 240, 118], [255, 0, 0]),
            ([126, 128, 128], [128, 128, 128]),
        ] {
            let px = nv12_to_bgrx(&[ycc[0]; 4], &[ycc[1], ycc[2], ycc[1], ycc[2]], (2, 2), yuv);
            for p in px.chunks(4) {
                assert!(
                    p[..3].iter().zip(bgr).all(|(a, b)| a.abs_diff(b) <= 3),
                    "{ycc:?} -> {p:?}"
                );
                assert_eq!(p[3], 255);
            }
        }
        // Too short planes: white, never a panic.
        assert_eq!(nv12_to_bgrx(&[0; 2], &[], (2, 2), yuv).len(), 16);
    }
}
