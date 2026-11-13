// Tests of the drawing canvas.

use super::{BASE, Canvas, Tool};

#[cfg(test)]
mod tests {
    use super::*;

    const RED: [u8; 3] = [232, 64, 64];

    fn px(out: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
        let o = ((y * w + x) * 4) as usize;
        [out[o], out[o + 1], out[o + 2], out[o + 3]]
    }

    fn canvas() -> (Canvas, Vec<u8>) {
        let c = Canvas::new(100, 60);
        let mut out = vec![0u8; 100 * 60 * 4];
        c.show(&mut out);
        (c, out)
    }

    #[test]
    fn a_new_canvas_is_invisible_but_takes_the_mouse() {
        let (_, out) = canvas();
        assert!(out.chunks_exact(4).all(|p| p == BASE));
    }

    #[test]
    fn a_pen_stroke_follows_the_pointer_and_only_its_pixels_change() {
        let (mut c, mut out) = canvas();
        assert!(
            c.begin(&mut out, Tool::Pen, RED, 1.0, false, (10.0, 10.0))
                .is_some(),
            "a dot at once"
        );
        let area = c.extend(&mut out, (50.0, 10.0)).unwrap();
        assert!(area.x1 - area.x0 < 50, "only the new piece: {area:?}");
        c.extend(&mut out, (50.0, 40.0));
        c.end(&out);
        assert_eq!(px(&out, 100, 30, 10), [64, 64, 232, 255]);
        assert_eq!(px(&out, 100, 50, 30), [64, 64, 232, 255]);
        assert_eq!(px(&out, 100, 30, 30), BASE);
        assert!(c.has_strokes());
    }

    #[test]
    fn a_box_follows_the_pointer_and_leaves_no_trail() {
        let (mut c, mut out) = canvas();
        assert!(c
            .begin(&mut out, Tool::Box, RED, 1.0, false, (10.0, 10.0))
            .is_none());
        c.extend(&mut out, (90.0, 50.0));
        c.extend(&mut out, (40.0, 30.0));
        c.end(&out);
        assert_eq!(px(&out, 100, 25, 10), [64, 64, 232, 255], "top edge");
        assert_eq!(
            px(&out, 100, 40, 20),
            [64, 64, 232, 255],
            "right edge where it ended"
        );
        assert_eq!(
            px(&out, 100, 90, 30),
            BASE,
            "the bigger box it passed through is gone"
        );
        assert_eq!(px(&out, 100, 25, 20), BASE, "hollow");
    }

    #[test]
    fn a_click_with_the_arrow_draws_nothing() {
        let (mut c, mut out) = canvas();
        c.begin(&mut out, Tool::Arrow, RED, 1.0, false, (10.0, 10.0));
        c.end(&out);
        assert!(!c.has_strokes());
        assert!(out.chunks_exact(4).all(|p| p == BASE));
    }

    #[test]
    fn an_arrow_has_a_head_at_the_pointer_end() {
        let (mut c, mut out) = canvas();
        c.begin(&mut out, Tool::Arrow, RED, 1.0, false, (10.0, 30.0));
        c.extend(&mut out, (80.0, 30.0));
        c.end(&out);
        assert_eq!(px(&out, 100, 70, 24)[3], 255, "upper line of the head");
        assert_eq!(px(&out, 100, 70, 36)[3], 255, "lower line of the head");
        assert_eq!(px(&out, 100, 20, 24), BASE, "no head at the start");
    }

    #[test]
    fn a_straight_marker_is_one_see_through_line() {
        let (mut c, mut out) = canvas();
        c.begin(
            &mut out,
            Tool::Marker,
            [255, 255, 255],
            1.0,
            true,
            (10.0, 30.0),
        );
        c.extend(&mut out, (50.0, 5.0));
        c.extend(&mut out, (90.0, 30.0));
        c.end(&out);
        let mid = px(&out, 100, 50, 30);
        assert!(mid[3] > 90 && mid[3] < 120, "see-through: {mid:?}");
        assert_eq!(
            px(&out, 100, 50, 5),
            BASE,
            "the bend it passed through is gone"
        );
    }

    #[test]
    fn undo_and_clear_take_strokes_back() {
        let (mut c, mut out) = canvas();
        for y in [10.0, 40.0] {
            c.begin(&mut out, Tool::Pen, RED, 1.0, false, (10.0, y));
            c.extend(&mut out, (90.0, y));
            c.end(&out);
        }
        assert!(c.undo(&mut out));
        assert_eq!(px(&out, 100, 50, 10)[3], 255, "the first stays");
        assert_eq!(px(&out, 100, 50, 40), BASE, "the last is gone");
        assert!(c.clear(&mut out));
        assert!(out.chunks_exact(4).all(|p| p == BASE));
        assert!(
            !c.undo(&mut out) && !c.clear(&mut out),
            "nothing left to take back"
        );
    }

    #[test]
    fn scale_makes_the_line_thicker() {
        let (mut c, mut out) = canvas();
        c.begin(&mut out, Tool::Pen, RED, 2.0, false, (10.0, 30.0));
        c.extend(&mut out, (90.0, 30.0));
        assert_eq!(px(&out, 100, 50, 34)[3], 255, "5 px at 200%");
        let (mut thin, mut out2) = canvas();
        thin.begin(&mut out2, Tool::Pen, RED, 1.0, false, (10.0, 30.0));
        thin.extend(&mut out2, (90.0, 30.0));
        assert_eq!(px(&out2, 100, 50, 34), BASE);
    }
}
