//! A rectangle in desktop pixels and the part of a monitor it covers. A window
//! that cannot be captured on its own is cut out of its monitor's image, and
//! the area picker turns a drag or a click into one of these.

/// A press that moves less than this many pixels either way is a click.
pub const CLICK_SLOP: i32 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// The part of the image, in pixels from its top-left corner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// `area` inside `monitor`, clipped to it; None when they do not overlap.
pub fn within(area: Rect, monitor: Rect) -> Option<Crop> {
    let (l, t) = (area.left.max(monitor.left), area.top.max(monitor.top));
    let (r, b) = (
        area.right.min(monitor.right),
        area.bottom.min(monitor.bottom),
    );
    if r <= l || b <= t {
        return None;
    }
    Some(Crop {
        x: (l - monitor.left) as u32,
        y: (t - monitor.top) as u32,
        width: (r - l) as u32,
        height: (b - t) as u32,
    })
}

impl Rect {
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }

    /// The overlap of the two, or None.
    pub fn clip(&self, to: Rect) -> Option<Rect> {
        let r = Rect {
            left: self.left.max(to.left),
            top: self.top.max(to.top),
            right: self.right.min(to.right),
            bottom: self.bottom.min(to.bottom),
        };
        (r.right > r.left && r.bottom > r.top).then_some(r)
    }

    pub fn offset(&self, dx: i32, dy: i32) -> Rect {
        Rect {
            left: self.left + dx,
            top: self.top + dy,
            right: self.right + dx,
            bottom: self.bottom + dy,
        }
    }
}

/// Where a window of this size goes to sit whole in the middle of `work`
/// (a monitor's work area): shrunk to fit first, then centred. The folder
/// dialog is placed with it, because left to itself it opened with its
/// buttons below the bottom of the screen.
pub fn centred_in(width: i32, height: i32, work: Rect) -> Rect {
    let w = width.clamp(1, (work.right - work.left).max(1));
    let h = height.clamp(1, (work.bottom - work.top).max(1));
    let left = work.left + (work.right - work.left - w) / 2;
    let top = work.top + (work.bottom - work.top - h) / 2;
    Rect {
        left,
        top,
        right: left + w,
        bottom: top + h,
    }
}

pub fn is_click(from: (i32, i32), to: (i32, i32)) -> bool {
    (to.0 - from.0).abs() < CLICK_SLOP && (to.1 - from.1).abs() < CLICK_SLOP
}

/// The rectangle dragged out from `from` to `to`, both pixels included, kept
/// inside `bound` (the monitor the drag started on).
pub fn span(from: (i32, i32), to: (i32, i32), bound: Rect) -> Rect {
    let clamp_x = |x: i32| x.clamp(bound.left, bound.right - 1);
    let clamp_y = |y: i32| y.clamp(bound.top, bound.bottom - 1);
    let (x0, x1) = (clamp_x(from.0.min(to.0)), clamp_x(from.0.max(to.0)));
    let (y0, y1) = (clamp_y(from.1.min(to.1)), clamp_y(from.1.max(to.1)));
    Rect {
        left: x0,
        top: y0,
        right: x1 + 1,
        bottom: y1 + 1,
    }
}

/// The first rectangle of `stack` (top of the z-order first) under the point.
pub fn hit(stack: &[Rect], x: i32, y: i32) -> Option<Rect> {
    stack.iter().copied().find(|r| r.contains(x, y))
}

/// Joins the horizontal bands Windows splits a window region into back into
/// the rectangles that made it: a band continues the one right above it when
/// both have the same left and right edges.
pub fn merge_bands(bands: &[Rect]) -> Vec<Rect> {
    let mut out: Vec<Rect> = Vec::new();
    for b in bands {
        match out
            .iter_mut()
            .find(|r| r.left == b.left && r.right == b.right && r.bottom == b.top)
        {
            Some(r) => r.bottom = b.bottom,
            None => out.push(*b),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn rect(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
        Rect {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn a_dialog_sits_whole_in_the_middle_of_the_work_area() {
        // A monitor left of and below the primary, as on a three-screen desk.
        let work = rect(-3840, 1080, -1920, 2120);
        assert_eq!(centred_in(1890, 981, work), rect(-3825, 1109, -1935, 2090));
        // Bigger than the work area: shrunk to it, never off the screen.
        assert_eq!(centred_in(2500, 1400, work), work);
        // A broken size still gives a real window inside the area.
        let r = centred_in(0, -5, work);
        assert!(r.right > r.left && r.bottom > r.top);
        assert!(work.contains(r.left, r.top));
    }

    #[test]
    fn a_window_inside_the_monitor_keeps_its_size() {
        let c = within(rect(300, 200, 1500, 950), rect(0, 0, 3840, 2160)).unwrap();
        assert_eq!(
            c,
            Crop {
                x: 300,
                y: 200,
                width: 1200,
                height: 750
            }
        );
    }

    #[test]
    fn a_monitor_left_of_the_primary_has_negative_coordinates() {
        let c = within(rect(-1800, 100, -1000, 600), rect(-1920, 0, 0, 1080)).unwrap();
        assert_eq!(
            c,
            Crop {
                x: 120,
                y: 100,
                width: 800,
                height: 500
            }
        );
    }

    #[test]
    fn a_window_hanging_off_the_edge_is_clipped() {
        let c = within(rect(3500, 2000, 4200, 2600), rect(0, 0, 3840, 2160)).unwrap();
        assert_eq!(
            c,
            Crop {
                x: 3500,
                y: 2000,
                width: 340,
                height: 160
            }
        );
    }

    #[test]
    fn no_overlap_or_an_empty_window_is_none() {
        assert_eq!(
            within(rect(4000, 0, 4500, 500), rect(0, 0, 3840, 2160)),
            None
        );
        assert_eq!(within(rect(10, 10, 10, 400), rect(0, 0, 3840, 2160)), None);
    }

    #[test]
    fn a_drag_either_way_gives_the_same_area_with_both_ends_included() {
        let m = rect(0, 0, 1920, 1080);
        assert_eq!(span((100, 50), (300, 250), m), rect(100, 50, 301, 251));
        assert_eq!(span((300, 250), (100, 50), m), rect(100, 50, 301, 251));
    }

    #[test]
    fn a_drag_past_the_edge_stops_at_the_monitor() {
        let m = rect(-1920, 0, 0, 1080);
        assert_eq!(span((-100, 900), (400, 1500), m), rect(-100, 900, 0, 1080));
    }

    #[test]
    fn small_moves_are_clicks() {
        assert!(is_click((10, 10), (13, 7)));
        assert!(!is_click((10, 10), (14, 10)));
        assert!(!is_click((10, 10), (10, 6)));
    }

    #[test]
    fn the_topmost_window_under_the_point_wins() {
        let stack = [rect(100, 100, 200, 200), rect(0, 0, 1000, 1000)];
        assert_eq!(hit(&stack, 150, 150), Some(stack[0]));
        assert_eq!(hit(&stack, 50, 50), Some(stack[1]));
        assert_eq!(
            hit(&stack, 200, 150),
            Some(stack[1]),
            "right edge is outside"
        );
        assert_eq!(hit(&stack, 1000, 5), None);
    }

    #[test]
    fn clip_and_offset() {
        assert_eq!(
            rect(-10, -10, 50, 50).clip(rect(0, 0, 40, 100)),
            Some(rect(0, 0, 40, 50))
        );
        assert_eq!(rect(0, 0, 10, 10).clip(rect(10, 0, 20, 10)), None);
        assert_eq!(rect(0, 0, 10, 10).offset(5, -5), rect(5, -5, 15, 5));
    }

    #[test]
    fn region_bands_join_back_into_their_tiles() {
        // Tile A (0,0)-(100,100) and tile B (200,50)-(300,150): Windows stores
        // three bands, A alone, A and B side by side, B alone.
        let bands = [
            rect(0, 0, 100, 50),
            rect(0, 50, 100, 100),
            rect(200, 50, 300, 100),
            rect(200, 100, 300, 150),
        ];
        assert_eq!(
            merge_bands(&bands),
            vec![rect(0, 0, 100, 100), rect(200, 50, 300, 150)]
        );
    }
}
