// Tests of the camera bubble drawn into a video frame.

use crate::bubble::Corner;
use crate::stack::{Plane, PlaneMut};
use super::{copy_plane, Picture, RING_GREY, Stamp};

#[cfg(test)]
mod tests {
    use super::*;

    /// A camera picture of one colour.
    fn flat(w: u32, h: u32, [b, g, r]: [u8; 3]) -> Vec<u8> {
        (0..w * h).flat_map(|_| [b, g, r, 255]).collect()
    }

    fn frame(w: usize, h: usize) -> (Vec<u8>, Vec<u8>) {
        (vec![16u8; w * h], vec![128u8; w * h / 2])
    }

    fn draw(stamp: &Stamp, y: &mut [u8], uv: &mut [u8], stride: usize) {
        stamp.draw([
            PlaneMut { data: y, stride },
            PlaneMut { data: uv, stride },
        ]);
    }

    #[test]
    fn a_white_camera_fills_the_middle_and_leaves_the_rest() {
        let bgra = flat(64, 48, [255, 255, 255]);
        let cam = Picture { width: 64, height: 48, stride: 64 * 4, bgra: &bgra };
        let (w, h) = (200usize, 100usize);
        let stamp = Stamp::new((w as u32, h as u32), Corner::BottomRight, &cam).unwrap();
        let (mut y, mut uv) = frame(w, h);
        draw(&stamp, &mut y, &mut uv, w);
        // 24% of 100 is 24 px, 3 px from the bottom right corner.
        let (cx, cy) = (200 - 3 - 12, 100 - 3 - 12);
        assert_eq!(y[cy * w + cx], 235, "white in the middle");
        assert_eq!(uv[(cy / 2) * w + (cx & !1)], 128, "no colour in white");
        assert_eq!(y[0], 16, "the top left is untouched");
        assert_eq!(y[74 * w + 174], 16, "outside the circle, in its box corner");
        assert_eq!(y[cy * w + 200 - 3 - 24 - 2], 16, "left of the box");
    }

    #[test]
    fn the_edge_is_soft_and_the_ring_is_light_grey() {
        // A black camera: what is not black is the ring.
        let bgra = flat(32, 32, [0, 0, 0]);
        let cam = Picture { width: 32, height: 32, stride: 32 * 4, bgra: &bgra };
        let (w, h) = (1000usize, 1000usize);
        let stamp = Stamp::new((w as u32, h as u32), Corner::TopLeft, &cam).unwrap();
        let (mut y, mut uv) = frame(w, h);
        draw(&stamp, &mut y, &mut uv, w);
        // 240 px wide from 30, so the middle row is 150.
        let row = &y[150 * w..150 * w + 300];
        assert_eq!(row[150], 16, "the black middle");
        let grey = 16 + (219.0f32 * RING_GREY).round() as u8;
        let ring = row[30..40].iter().copied().max().unwrap();
        assert!(ring >= grey - 2, "a light ring at the edge, got {ring}");
        // Soft: some pixel at the very edge is between frame and ring.
        assert!(row[28..34].iter().any(|&v| v > 16 && v < ring));
        assert_eq!(row[25], 16, "before the bubble");
    }

    #[test]
    fn a_red_camera_keeps_its_colour_in_the_chroma() {
        let bgra = flat(8, 8, [0, 0, 255]);
        let cam = Picture { width: 8, height: 8, stride: 32, bgra: &bgra };
        let stamp = Stamp::new((400, 400), Corner::TopRight, &cam).unwrap();
        let (mut y, mut uv) = frame(400, 400);
        draw(&stamp, &mut y, &mut uv, 400);
        // Middle of the bubble: 400 - 12 - 48.
        let (cx, cy) = (340usize, 60usize);
        let at = (cy / 2) * 400 + (cx & !1);
        // BT.709 limited red: Y 63, Cb 102, Cr 240.
        assert!((y[cy * 400 + cx] as i32 - 63).abs() <= 1);
        assert!((uv[at] as i32 - 102).abs() <= 1);
        assert!((uv[at + 1] as i32 - 240).abs() <= 1);
    }

    #[test]
    fn padded_rows_and_odd_or_tiny_frames_stay_in_bounds() {
        let bgra = flat(4, 4, [10, 200, 30]);
        let cam = Picture { width: 4, height: 4, stride: 16, bgra: &bgra };
        // Rows padded to 64 bytes, as CoreVideo hands them.
        let stamp = Stamp::new((50, 30), Corner::TopRight, &cam).unwrap();
        let (mut y, mut uv) = (vec![16u8; 64 * 30], vec![128u8; 64 * 15]);
        draw(&stamp, &mut y, &mut uv, 64);
        assert!(y.chunks(64).all(|r| r[50..].iter().all(|&v| v == 16)), "padding untouched");
        let stamp = Stamp::new((7, 5), Corner::BottomRight, &cam);
        if let Some(s) = stamp {
            let (mut y, mut uv) = (vec![16u8; 8 * 5], vec![128u8; 8 * 3]);
            draw(&s, &mut y, &mut uv, 8);
        }
        let empty = Picture { width: 0, height: 0, stride: 0, bgra: &[] };
        assert!(Stamp::new((100, 100), Corner::TopLeft, &empty).is_none());
    }

    #[test]
    fn a_frame_is_copied_row_by_row_across_paddings() {
        let src: Vec<u8> = (0..12).collect();
        let mut dst = vec![0u8; 10];
        let from = Plane { data: &src, stride: 4 };
        assert!(copy_plane(&from, &mut PlaneMut { data: &mut dst, stride: 5 }, 2, 3));
        assert_eq!(dst, vec![0, 1, 2, 0, 0, 4, 5, 6, 0, 0]);
        // Too few rows on either side: refused, not a panic.
        assert!(!copy_plane(&from, &mut PlaneMut { data: &mut dst, stride: 5 }, 3, 3));
        assert!(!copy_plane(&from, &mut PlaneMut { data: &mut dst, stride: 2 }, 1, 3));
    }
}
