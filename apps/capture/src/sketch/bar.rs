//! The small bar at the top of the screen while drawing: six colours, the four
//! tools, undo, clear and close, with a one-line hint under it at first.
//! Layout, hit test and pixels live here; the window only draws the hint's
//! text with the system font, then `finish_hint` gives it its shape.

use super::canvas::Tool;
use super::raster::{self, Area};

pub const PALETTE: [[u8; 3]; 6] = [
    [232, 64, 64],   // red
    [245, 197, 24],  // yellow
    [46, 184, 114],  // green
    [47, 128, 237],  // blue
    [255, 255, 255], // white
    [17, 17, 17],    // black
];
pub const TOOLS: [Tool; 4] = [Tool::Pen, Tool::Marker, Tool::Arrow, Tool::Box];

/// Sizes at 100% scale, in pixels.
const BUTTON: f32 = 34.0;
const PAD: f32 = 6.0;
const GAP: f32 = 2.0;
const SEP: f32 = 12.0;
const HINT_GAP: f32 = 8.0;
const HINT_PAD: (f32, f32) = (14.0, 7.0);
/// The hint's text size the window uses, at 100% scale.
pub const HINT_TEXT: f32 = 14.0;
/// Distance from the top of the work area.
pub const TOP: f32 = 10.0;

pub const BACK: [u8; 3] = [30, 30, 30];
const HOVER: [u8; 3] = [52, 52, 52];
const PICKED: [u8; 3] = [70, 70, 70];
pub const INK: [u8; 3] = [240, 240, 240];
const BACK_ALPHA: f32 = 0.94;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Item {
    Colour(usize),
    Tool(Tool),
    Undo,
    Clear,
    Close,
}

/// What the bar shows as chosen.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Look {
    pub colour: usize,
    pub tool: Tool,
    pub hover: Option<Item>,
    pub can_undo: bool,
}

/// Left, top, width, height.
pub type Rect = (f32, f32, f32, f32);

#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    /// The bar: left, top, width, height.
    pub bar: Rect,
    /// Each button: what it is, and its left and top (all are `BUTTON` square).
    pub items: Vec<(Item, f32, f32)>,
    /// The hint under the bar, and where its text starts.
    pub hint: Option<(Rect, (i32, i32))>,
}

impl Layout {
    fn side(&self) -> f32 {
        BUTTON * self.scale
    }
}

/// The layout at `scale` (1.0 = 96 dpi); `hint` is the size of the hint's text
/// as the window measured it, or None once it is gone.
pub fn layout(scale: f32, hint: Option<(i32, i32)>) -> Layout {
    let s = scale.max(0.5);
    let side = BUTTON * s;
    let mut items = Vec::new();
    let mut x = PAD * s;
    let groups: [Vec<Item>; 4] = [
        (0..PALETTE.len()).map(Item::Colour).collect(),
        TOOLS.iter().map(|&t| Item::Tool(t)).collect(),
        vec![Item::Undo, Item::Clear],
        vec![Item::Close],
    ];
    for (g, group) in groups.iter().enumerate() {
        if g > 0 {
            x += SEP * s - GAP * s;
        }
        for &item in group {
            items.push((item, x, PAD * s));
            x += side + GAP * s;
        }
    }
    let bar_w = (x - GAP * s + PAD * s).ceil();
    let bar_h = (side + 2.0 * PAD * s).ceil();
    let hint_box = hint.map(|(tw, th)| {
        let (w, h) = (
            tw as f32 + 2.0 * HINT_PAD.0 * s,
            th as f32 + 2.0 * HINT_PAD.1 * s,
        );
        (w.ceil(), h.ceil())
    });
    let width = hint_box.map_or(bar_w, |(w, _)| w.max(bar_w));
    let bar_x = ((width - bar_w) / 2.0).floor();
    for it in items.iter_mut() {
        it.1 += bar_x;
    }
    let hint_top = bar_h + HINT_GAP * s;
    let hint = hint_box.map(|(w, h)| {
        let x = ((width - w) / 2.0).floor();
        let text = (
            (x + HINT_PAD.0 * s).round() as i32,
            (hint_top + HINT_PAD.1 * s).round() as i32,
        );
        ((x, hint_top, w, h), text)
    });
    let height = hint.map_or(bar_h, |((_, y, _, h), _)| y + h);
    Layout {
        width: width as u32,
        height: height.ceil() as u32,
        scale: s,
        bar: (bar_x, 0.0, bar_w, bar_h),
        items,
        hint,
    }
}

/// The button under (x, y), in window pixels.
pub fn hit(l: &Layout, x: f32, y: f32) -> Option<Item> {
    let side = l.side();
    l.items
        .iter()
        .find(|&&(_, ix, iy)| x >= ix && x < ix + side && y >= iy && y < iy + side)
        .map(|&(item, _, _)| item)
}

/// Where the window goes: centred at the top of the work area `work` (left,
/// top, right, bottom).
pub fn place(work: (i32, i32, i32, i32), l: &Layout) -> (i32, i32) {
    let (left, top, right, _) = work;
    (
        left + (right - left - l.width as i32) / 2,
        top + (TOP * l.scale).round() as i32,
    )
}

/// Fills the buffer (premultiplied BGRA, `l.width` × `l.height`) with the bar,
/// and the hint's background (alpha 0) for the window to write on.
pub fn paint(buf: &mut [u8], l: &Layout, look: &Look) {
    buf.fill(0);
    let (w, h, s) = (l.width, l.height, l.scale);
    let mut cov = vec![0u8; (w * h) as usize];
    let fill = |buf: &mut [u8], area: Option<Area>, rgb: [u8; 3], alpha: f32, cov: &mut Vec<u8>| {
        if let Some(a) = area {
            raster::lay(buf, None, cov, w, a, rgb, alpha);
            raster::wipe(cov, w, a);
        }
    };
    let a = raster::rounded(&mut cov, w, h, l.bar, l.bar.3 / 2.0);
    fill(buf, a, BACK, BACK_ALPHA, &mut cov);
    let side = l.side();
    for &(item, x, y) in &l.items {
        let chosen = matches!(item, Item::Tool(t) if t == look.tool);
        let dim = matches!(item, Item::Undo | Item::Clear) && !look.can_undo;
        let back = if chosen {
            Some(PICKED)
        } else if look.hover == Some(item) && !dim {
            Some(HOVER)
        } else {
            None
        };
        if let Some(rgb) = back {
            let a = raster::rounded(&mut cov, w, h, (x, y, side, side), 8.0 * s);
            fill(buf, a, rgb, 1.0, &mut cov);
        }
        let c = (x + side / 2.0, y + side / 2.0);
        let (rgb, alpha, area) = match item {
            Item::Colour(i) => {
                let area = raster::segment(&mut cov, w, h, c, c, 9.0 * s);
                fill(buf, area, PALETTE[i], 1.0, &mut cov);
                // A faint edge, so the black dot shows on the dark bar.
                let edge = raster::ring(&mut cov, w, h, c, 9.0 * s, 0.6 * s);
                fill(buf, edge, INK, 0.35, &mut cov);
                if i != look.colour {
                    continue;
                }
                (INK, 1.0, raster::ring(&mut cov, w, h, c, 13.5 * s, 1.2 * s))
            }
            _ => (
                INK,
                if dim { 0.35 } else { 1.0 },
                icon(&mut cov, w, h, item, c, s),
            ),
        };
        fill(buf, area, rgb, alpha, &mut cov);
    }
    if let Some(((x, y, hw, hh), _)) = l.hint {
        // The window's text goes on an opaque colour; `finish_hint` shapes it.
        for py in y as u32..(y + hh) as u32 {
            for px in x as u32..(x + hw) as u32 {
                let o = ((py * w + px) * 4) as usize;
                buf[o..o + 4].copy_from_slice(&[BACK[2], BACK[1], BACK[0], 0]);
            }
        }
    }
}

/// An icon centred on `c`, drawn as lines into `cov`.
fn icon(cov: &mut [u8], w: u32, h: u32, item: Item, c: (f32, f32), s: f32) -> Option<Area> {
    let p = |dx: f32, dy: f32| (c.0 + dx * s, c.1 + dy * s);
    // Each line: from, to, half thickness.
    type Line = ((f32, f32), (f32, f32), f32);
    let lines: Vec<Line> = match item {
        Item::Tool(Tool::Pen) => vec![(p(-6.0, 6.0), p(6.0, -6.0), 1.4)],
        Item::Tool(Tool::Marker) => vec![(p(-5.0, 5.0), p(5.0, -5.0), 4.0)],
        Item::Tool(Tool::Arrow) => vec![
            (p(-7.0, 7.0), p(7.0, -7.0), 1.4),
            (p(7.0, -7.0), p(7.0, -1.0), 1.4),
            (p(7.0, -7.0), p(1.0, -7.0), 1.4),
        ],
        Item::Tool(Tool::Box) => vec![
            (p(-7.0, -6.0), p(7.0, -6.0), 1.4),
            (p(7.0, -6.0), p(7.0, 6.0), 1.4),
            (p(7.0, 6.0), p(-7.0, 6.0), 1.4),
            (p(-7.0, 6.0), p(-7.0, -6.0), 1.4),
        ],
        Item::Undo => {
            // A hook: across, round the right, back along the bottom.
            let mut v = vec![
                (p(-7.0, -3.0), p(3.0, -3.0), 1.4),
                (p(-7.0, -3.0), p(-3.5, -6.5), 1.4),
                (p(-7.0, -3.0), p(-3.5, 0.5), 1.4),
                (p(3.0, 7.0), p(-4.0, 7.0), 1.4),
            ];
            let arc: Vec<(f32, f32)> = (0..=8)
                .map(|i| {
                    let t = -std::f32::consts::FRAC_PI_2 + std::f32::consts::PI * i as f32 / 8.0;
                    p(3.0 + 5.0 * t.cos(), 2.0 + 5.0 * t.sin())
                })
                .collect();
            v.extend(arc.windows(2).map(|a| (a[0], a[1], 1.4)));
            v
        }
        Item::Clear => vec![
            (p(-7.0, -4.5), p(7.0, -4.5), 1.4),
            (p(-2.5, -7.0), p(2.5, -7.0), 1.4),
            (p(-5.0, -4.5), p(-4.0, 7.0), 1.4),
            (p(5.0, -4.5), p(4.0, 7.0), 1.4),
            (p(-4.0, 7.0), p(4.0, 7.0), 1.4),
        ],
        Item::Close => vec![
            (p(-6.0, -6.0), p(6.0, 6.0), 1.5),
            (p(-6.0, 6.0), p(6.0, -6.0), 1.5),
        ],
        Item::Colour(_) => Vec::new(),
    };
    lines
        .into_iter()
        .filter_map(|(a, b, r)| raster::segment(cov, w, h, a, b, r * s))
        .reduce(Area::union)
}

/// After the window wrote the hint's text: the text opaque, the rest the bar's
/// colour with rounded ends, premultiplied.
pub fn finish_hint(buf: &mut [u8], l: &Layout) {
    let Some((rect, _)) = l.hint else {
        return;
    };
    let mut cov = vec![0u8; (l.width * l.height) as usize];
    let Some(area) = raster::rounded(&mut cov, l.width, l.height, rect, rect.3 / 2.0) else {
        return;
    };
    for y in area.y0..area.y1 {
        for x in area.x0..area.x1 {
            let i = (y as u32 * l.width + x as u32) as usize;
            let p = &mut buf[i * 4..i * 4 + 4];
            let text = [p[2], p[1], p[0]] != BACK;
            let a = if text { 1.0 } else { BACK_ALPHA } * cov[i] as f32 / 255.0;
            for c in p.iter_mut().take(3) {
                *c = (*c as f32 * a).round() as u8;
            }
            p[3] = (a * 255.0).round() as u8;
        }
    }
}

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
