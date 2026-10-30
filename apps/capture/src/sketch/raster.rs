//! Pixels for drawing on the screen: how much of each pixel a thick line with
//! round ends (or a ring) covers, and laying a colour over a picture by that
//! amount. Coverage is one byte per pixel; pictures are premultiplied BGRA,
//! top-down, `w` pixels a row.

/// A block of pixels, `x0..x1` by `y0..y1` (the far edges left out).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Area {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
}

impl Area {
    /// The pixels a line from `a` to `b`, `r` thick on each side, can touch.
    pub fn around(a: (f32, f32), b: (f32, f32), r: f32) -> Area {
        let pad = r + 1.0;
        Area {
            x0: (a.0.min(b.0) - pad).floor() as i32,
            y0: (a.1.min(b.1) - pad).floor() as i32,
            x1: (a.0.max(b.0) + pad).ceil() as i32,
            y1: (a.1.max(b.1) + pad).ceil() as i32,
        }
    }

    pub fn union(self, o: Area) -> Area {
        Area {
            x0: self.x0.min(o.x0),
            y0: self.y0.min(o.y0),
            x1: self.x1.max(o.x1),
            y1: self.y1.max(o.y1),
        }
    }

    /// The part inside a `w` × `h` picture; None when nothing is left.
    pub fn clip(self, w: u32, h: u32) -> Option<Area> {
        let a = Area {
            x0: self.x0.max(0),
            y0: self.y0.max(0),
            x1: self.x1.min(w as i32),
            y1: self.y1.min(h as i32),
        };
        (a.x0 < a.x1 && a.y0 < a.y1).then_some(a)
    }
}

/// 1 inside a shape whose signed distance is `d`, 0 outside, a one-pixel ramp
/// at the edge.
fn cover(d: f32) -> u8 {
    ((0.5 - d).clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Marks the coverage of a shape over `area`, keeping the larger of the old and
/// the new value, so the parts of one stroke never add up where they meet.
fn mark(cov: &mut [u8], w: u32, area: Area, dist: impl Fn(f32, f32) -> f32) {
    for y in area.y0..area.y1 {
        let row = (y as u32 * w) as usize;
        let py = y as f32 + 0.5;
        for x in area.x0..area.x1 {
            let c = cover(dist(x as f32 + 0.5, py));
            let p = &mut cov[row + x as usize];
            if c > *p {
                *p = c;
            }
        }
    }
}

/// A line from `a` to `b` with round ends, `r` thick on each side (a dot when
/// `a == b`). Returns the pixels it may have changed.
pub fn segment(
    cov: &mut [u8],
    w: u32,
    h: u32,
    a: (f32, f32),
    b: (f32, f32),
    r: f32,
) -> Option<Area> {
    let area = Area::around(a, b, r).clip(w, h)?;
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    mark(cov, w, area, |px, py| {
        let t = if len2 > 0.0 {
            (((px - a.0) * dx + (py - a.1) * dy) / len2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let (qx, qy) = (a.0 + t * dx - px, a.1 + t * dy - py);
        (qx * qx + qy * qy).sqrt() - r
    });
    Some(area)
}

/// A circle outline of radius `radius` round `c`, `r` thick on each side.
pub fn ring(cov: &mut [u8], w: u32, h: u32, c: (f32, f32), radius: f32, r: f32) -> Option<Area> {
    let area = Area::around(c, c, radius + r).clip(w, h)?;
    mark(cov, w, area, |px, py| {
        (((px - c.0).powi(2) + (py - c.1).powi(2)).sqrt() - radius).abs() - r
    });
    Some(area)
}

/// A filled rectangle at (x, y), `rw` × `rh`, with corners of radius `r`.
pub fn rounded(
    cov: &mut [u8],
    w: u32,
    h: u32,
    (x, y, rw, rh): (f32, f32, f32, f32),
    r: f32,
) -> Option<Area> {
    let (cx, cy) = (x + rw / 2.0, y + rh / 2.0);
    let area = Area::around((x, y), (x + rw, y + rh), 0.0).clip(w, h)?;
    mark(cov, w, area, |px, py| {
        let qx = (px - cx).abs() - (rw / 2.0 - r);
        let qy = (py - cy).abs() - (rh / 2.0 - r);
        (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0) - r
    });
    Some(area)
}

/// Sets the coverage over `area` back to nothing.
pub fn wipe(cov: &mut [u8], w: u32, area: Area) {
    for y in area.y0..area.y1 {
        let row = (y as u32 * w) as usize;
        cov[row + area.x0 as usize..row + area.x1 as usize].fill(0);
    }
}

/// Over `area`, writes into `out` the picture `under` (or what `out` already
/// holds, when None) with `rgb` laid over it at `alpha` times the coverage.
pub fn lay(
    out: &mut [u8],
    under: Option<&[u8]>,
    cov: &[u8],
    w: u32,
    area: Area,
    rgb: [u8; 3],
    alpha: f32,
) {
    let src = [rgb[2] as f32, rgb[1] as f32, rgb[0] as f32, 255.0];
    for y in area.y0..area.y1 {
        let row = (y as u32 * w) as usize;
        for x in area.x0..area.x1 {
            let i = row + x as usize;
            let o = i * 4;
            let base: [u8; 4] = match under {
                Some(u) => [u[o], u[o + 1], u[o + 2], u[o + 3]],
                None => [out[o], out[o + 1], out[o + 2], out[o + 3]],
            };
            let a = alpha * cov[i] as f32 / 255.0;
            for k in 0..4 {
                out[o + k] = if a > 0.0 {
                    (src[k] * a + base[k] as f32 * (1.0 - a)).round() as u8
                } else {
                    base[k]
                };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: u32 = 40;
    const H: u32 = 20;

    fn at(cov: &[u8], x: u32, y: u32) -> u8 {
        cov[(y * W + x) as usize]
    }

    #[test]
    fn a_line_covers_its_middle_and_not_beyond_its_thickness() {
        let mut cov = vec![0u8; (W * H) as usize];
        let area = segment(&mut cov, W, H, (5.0, 10.0), (30.0, 10.0), 2.0).unwrap();
        assert_eq!(at(&cov, 15, 9), 255);
        assert_eq!(at(&cov, 15, 13), 0, "beyond 2 px from the line");
        assert_eq!(at(&cov, 34, 10), 0, "past the round end");
        assert!(
            at(&cov, 6, 10) == 255 && at(&cov, 3, 10) > 0,
            "the end is round, not cut"
        );
        assert!(area.x0 <= 2 && area.x1 >= 33);
    }

    #[test]
    fn a_click_is_a_dot_and_shapes_off_the_picture_are_clipped() {
        let mut cov = vec![0u8; (W * H) as usize];
        segment(&mut cov, W, H, (10.0, 10.0), (10.0, 10.0), 3.0).unwrap();
        assert_eq!(at(&cov, 9, 9), 255);
        assert_eq!(at(&cov, 15, 10), 0);
        let edge = segment(&mut cov, W, H, (-5.0, 0.0), (2.0, 0.0), 3.0).unwrap();
        assert_eq!((edge.x0, edge.y0), (0, 0));
        assert!(segment(&mut cov, W, H, (-50.0, -50.0), (-40.0, -40.0), 2.0).is_none());
    }

    #[test]
    fn crossing_parts_of_one_stroke_keep_the_larger_cover() {
        let mut cov = vec![0u8; (W * H) as usize];
        segment(&mut cov, W, H, (5.0, 10.0), (30.0, 10.0), 2.0);
        let once = cov.clone();
        segment(&mut cov, W, H, (5.0, 10.0), (30.0, 10.0), 2.0);
        assert_eq!(cov, once, "drawing over the same place adds nothing");
    }

    #[test]
    fn a_ring_is_hollow() {
        let mut cov = vec![0u8; (W * H) as usize];
        ring(&mut cov, W, H, (20.0, 10.0), 6.0, 1.0).unwrap();
        assert_eq!(at(&cov, 20, 10), 0, "the middle stays empty");
        assert_eq!(at(&cov, 25, 9), 255);
    }

    #[test]
    fn laying_a_colour_is_premultiplied_and_leaves_uncovered_pixels_alone() {
        let mut cov = vec![0u8; (W * H) as usize];
        let area = segment(&mut cov, W, H, (5.0, 10.0), (30.0, 10.0), 2.0).unwrap();
        let under = [0u8, 0, 0, 1].repeat((W * H) as usize);
        let mut out = under.clone();
        lay(&mut out, Some(&under), &cov, W, area, [232, 64, 64], 1.0);
        let px = |x: u32, y: u32| {
            let o = ((y * W + x) * 4) as usize;
            [out[o], out[o + 1], out[o + 2], out[o + 3]]
        };
        assert_eq!(
            px(15, 10),
            [64, 64, 232, 255],
            "BGRA, fully opaque on the line"
        );
        assert_eq!(px(15, 15), [0, 0, 0, 1], "off the line: as it was");
        // A see-through marker: alpha 0.4 over the invisible base.
        let mut marked = under.clone();
        lay(&mut marked, None, &cov, W, area, [255, 255, 255], 0.4);
        let o = ((10 * W + 15) * 4) as usize;
        assert_eq!(marked[o + 3], 103);
        assert!(
            marked[o] <= marked[o + 3],
            "premultiplied: no channel above alpha"
        );
        wipe(&mut cov, W, area);
        assert!(cov.iter().all(|&c| c == 0));
    }
}
