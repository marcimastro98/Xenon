// Tests of the drawing toolbar.

use super::{BACK_ALPHA, finish_hint, hit, Item, layout, Layout, Look, paint, place};
use super::super::canvas::Tool;

#[cfg(test)]
mod tests {
    use super::*;

    fn look() -> Look {
        Look {
            colour: 0,
            tool: Tool::Pen,
            hover: None,
            can_undo: false,
        }
    }

    fn at(buf: &[u8], l: &Layout, x: f32, y: f32) -> [u8; 4] {
        let o = ((y as u32 * l.width + x as u32) * 4) as usize;
        [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]
    }

    #[test]
    fn every_button_is_hit_where_it_is_drawn_and_none_overlap() {
        let l = layout(1.0, None);
        assert_eq!(l.items.len(), 13);
        let side = l.side();
        for &(item, x, y) in &l.items {
            assert_eq!(hit(&l, x + side / 2.0, y + side / 2.0), Some(item));
        }
        for pair in l.items.windows(2) {
            assert!(pair[0].1 + side <= pair[1].1, "{pair:?}");
        }
        let last = l.items.last().unwrap();
        assert!(last.1 + side <= l.width as f32);
        assert_eq!(hit(&l, 1.0, 1.0), None, "the rounded end is not a button");
    }

    #[test]
    fn the_layout_grows_with_the_scale_and_makes_room_for_the_hint() {
        let a = layout(1.0, None);
        assert_eq!(a.height, 46);
        let b = layout(1.5, None);
        assert_eq!(b.height, 69);
        assert!(b.width > a.width);
        let wide = layout(1.0, Some((900, 18)));
        assert_eq!(wide.width, 928, "a long hint widens the window");
        let ((hx, hy, hw, _), (tx, ty)) = wide.hint.unwrap();
        assert!(hy >= 46.0 && tx as f32 > hx && (ty as f32) > hy);
        assert!(hx + hw <= wide.width as f32);
        // The bar stays centred over a wide hint.
        let (bx, _, bw, _) = wide.bar;
        assert!((bx + bw / 2.0 - wide.width as f32 / 2.0).abs() <= 1.0);
    }

    #[test]
    fn the_chosen_colour_has_a_ring_and_the_chosen_tool_a_background() {
        let l = layout(1.0, None);
        let mut buf = vec![0u8; (l.width * l.height * 4) as usize];
        paint(&mut buf, &l, &look());
        let side = l.side();
        let (_, rx, ry) = l.items[0];
        let red = at(&buf, &l, rx + side / 2.0, ry + side / 2.0);
        assert_eq!(red, [64, 64, 232, 255]);
        let ring = at(&buf, &l, rx + side / 2.0 + 13.5, ry + side / 2.0);
        assert!(ring[0] > 200, "the ring round red: {ring:?}");
        let (_, yx, yy) = l.items[1];
        assert!(
            at(&buf, &l, yx + side / 2.0 + 13.5, yy + side / 2.0)[0] < 100,
            "no ring round yellow"
        );
        let (_, px, py) = l.items[6];
        assert_eq!(
            at(&buf, &l, px + 3.0, py + side / 2.0),
            [70, 70, 70, 255],
            "pen chosen"
        );
        let (_, mx, my) = l.items[7];
        assert_ne!(at(&buf, &l, mx + 3.0, my + side / 2.0), [70, 70, 70, 255]);
        for p in buf.chunks_exact(4) {
            assert!(
                p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3],
                "premultiplied"
            );
        }
    }

    #[test]
    fn undo_and_clear_are_dim_with_nothing_drawn() {
        let l = layout(1.0, None);
        let side = l.side();
        let (_, ux, uy) = l
            .items
            .iter()
            .find(|i| i.0 == Item::Clear)
            .copied()
            .unwrap();
        // The middle of the bin's bottom line.
        let spot = (ux + side / 2.0, uy + side / 2.0 + 7.0);
        let mut dim = vec![0u8; (l.width * l.height * 4) as usize];
        paint(&mut dim, &l, &look());
        let mut lit = dim.clone();
        paint(
            &mut lit,
            &l,
            &Look {
                can_undo: true,
                ..look()
            },
        );
        assert!(at(&lit, &l, spot.0, spot.1)[0] > at(&dim, &l, spot.0, spot.1)[0] + 60);
    }

    #[test]
    fn the_hint_text_stays_opaque_and_its_ends_are_round() {
        let l = layout(1.0, Some((200, 18)));
        let mut buf = vec![0u8; (l.width * l.height * 4) as usize];
        paint(&mut buf, &l, &look());
        let ((hx, hy, hw, hh), (tx, ty)) = l.hint.unwrap();
        let o = ((ty as u32 + 5) * l.width + tx as u32 + 5) as usize * 4;
        buf[o..o + 3].copy_from_slice(&[230, 230, 230]); // a text pixel
        finish_hint(&mut buf, &l);
        assert_eq!(&buf[o..o + 4], &[230, 230, 230, 255]);
        assert_eq!(
            at(&buf, &l, hx, hy),
            [0, 0, 0, 0],
            "corner outside the round end"
        );
        let mid = at(&buf, &l, hx + hw / 2.0, hy + hh - 2.0);
        assert_eq!(mid[3], (BACK_ALPHA * 255.0).round() as u8);
    }

    #[test]
    fn placed_centred_below_the_top_of_the_work_area() {
        let l = layout(1.0, None);
        assert_eq!(
            place((0, 0, 1920, 1040), &l),
            ((1920 - l.width as i32) / 2, 10)
        );
        let big = layout(2.0, None);
        assert_eq!(place((-3840, 0, 0, 2160), &big).1, 20);
    }
}
