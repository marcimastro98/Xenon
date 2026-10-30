//! Where the webcam goes in a recording, the same on every platform: a round
//! bubble in the corner the user picked, sized on the short side of the
//! frame, and the square middle of the camera picture that fills it.

/// The bubble's diameter as a share of the frame's short side, and the gap
/// to the edges as a share of the same side.
const SIZE: f32 = 0.24;
const MARGIN: f32 = 0.03;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl Corner {
    /// The corner asked for, or None: no webcam.
    pub fn parse(asked: Option<&str>) -> Option<Corner> {
        match asked? {
            "tl" => Some(Corner::TopLeft),
            "tr" => Some(Corner::TopRight),
            "bl" => Some(Corner::BottomLeft),
            "br" => Some(Corner::BottomRight),
            _ => None,
        }
    }
}

/// The bubble in a `w` x `h` frame, as fractions of the frame (left, top,
/// right, bottom), what the shader takes. Square in pixels.
pub fn place(w: u32, h: u32, corner: Corner) -> [f32; 4] {
    let (fw, fh) = (w.max(1) as f32, h.max(1) as f32);
    let short = fw.min(fh);
    let (d, m) = (short * SIZE, short * MARGIN);
    let left = match corner {
        Corner::TopLeft | Corner::BottomLeft => m,
        _ => fw - m - d,
    };
    let top = match corner {
        Corner::TopLeft | Corner::TopRight => m,
        _ => fh - m - d,
    };
    [left / fw, top / fh, (left + d) / fw, (top + d) / fh]
}

/// The square middle of a `w` x `h` camera picture, as fractions of it
/// (left, top, right, bottom): a wide camera loses its sides, not its shape.
pub fn crop(w: u32, h: u32) -> [f32; 4] {
    let (fw, fh) = (w.max(1) as f32, h.max(1) as f32);
    let side = fw.min(fh);
    let (x, y) = ((fw - side) / 2.0 / fw, (fh - side) / 2.0 / fh);
    [x, y, 1.0 - x, 1.0 - y]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_four_corners_turn_the_webcam_on() {
        assert_eq!(Corner::parse(Some("br")), Some(Corner::BottomRight));
        assert_eq!(Corner::parse(Some("tl")), Some(Corner::TopLeft));
        assert_eq!(Corner::parse(Some("off")), None);
        assert_eq!(Corner::parse(Some("")), None);
        assert_eq!(Corner::parse(None), None);
    }

    #[test]
    fn the_bubble_is_square_inside_the_frame_in_its_corner() {
        let px = |b: [f32; 4], w: f32, h: f32| [b[0] * w, b[1] * h, b[2] * w, b[3] * h];
        let [l, t, r, b] = px(place(1920, 1080, Corner::BottomRight), 1920.0, 1080.0);
        assert!((r - l - (b - t)).abs() < 0.01, "square");
        assert!((r - l - 259.2).abs() < 0.01, "24% of 1080");
        assert!((1920.0 - r - 32.4).abs() < 0.01 && (1080.0 - b - 32.4).abs() < 0.01);
        let [l, t, _, _] = px(place(1920, 1080, Corner::TopLeft), 1920.0, 1080.0);
        assert!((l - 32.4).abs() < 0.01 && (t - 32.4).abs() < 0.01);
        // A portrait window: sized on its width.
        let [l, t, r, b] = px(place(600, 1200, Corner::TopRight), 600.0, 1200.0);
        assert!((r - l - 144.0).abs() < 0.01 && (b - t - 144.0).abs() < 0.01);
        for c in [
            Corner::TopLeft,
            Corner::TopRight,
            Corner::BottomLeft,
            Corner::BottomRight,
        ] {
            let [l, t, r, b] = place(2, 2, c);
            assert!(l >= 0.0 && t >= 0.0 && r <= 1.0 && b <= 1.0);
        }
    }

    #[test]
    fn the_camera_keeps_its_middle_square() {
        assert_eq!(crop(640, 480), [0.125, 0.0, 0.875, 1.0]);
        assert_eq!(crop(480, 640), [0.0, 0.125, 1.0, 0.875]);
        assert_eq!(crop(500, 500), [0.0, 0.0, 1.0, 1.0]);
        assert_eq!(crop(0, 0), [0.0, 0.0, 1.0, 1.0]);
    }
}
