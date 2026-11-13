//! What is drawn on the screen: the finished strokes, the one under the
//! pointer, and the picture the window shows. A stroke is kept as points, so
//! undo draws the rest again; while one is drawn only the pixels it touches
//! are worked on, so a 4K screen stays smooth.

use super::raster::{self, Area};

#[cfg(test)]
mod unit_tests;


/// Every pixel nobody drew on: invisible, but a layered window takes the mouse
/// only where a pixel is not fully clear.
pub const BASE: [u8; 4] = [0, 0, 0, 1];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Pen,
    Marker,
    Arrow,
    Box,
}

impl Tool {
    /// Half the thickness at 100% scale.
    fn radius(self) -> f32 {
        match self {
            Tool::Pen | Tool::Box => 2.5,
            Tool::Arrow => 3.0,
            Tool::Marker => 11.0,
        }
    }

    /// The marker shows what is under it.
    fn alpha(self) -> f32 {
        match self {
            Tool::Marker => 0.4,
            _ => 1.0,
        }
    }

    /// Arrows and boxes go from where the press started to the pointer.
    fn shaped(self) -> bool {
        matches!(self, Tool::Arrow | Tool::Box)
    }
}

#[derive(Debug, Clone)]
struct Stroke {
    tool: Tool,
    rgb: [u8; 3],
    radius: f32,
    /// A pen or marker held straight (Shift): a line from start to pointer.
    straight: bool,
    points: Vec<(f32, f32)>,
}

impl Stroke {
    fn follows_pointer(&self) -> bool {
        !(self.tool.shaped() || self.straight)
    }

    /// Marks the whole stroke into `cov`; the pixels it may have changed.
    fn shape(&self, cov: &mut [u8], w: u32, h: u32) -> Option<Area> {
        let r = self.radius;
        let mut seg = |a, b| raster::segment(cov, w, h, a, b, r);
        let (a, b) = (self.points[0], *self.points.last().unwrap());
        let parts: Vec<Option<Area>> = match self.tool {
            Tool::Box => {
                let (c, d) = ((b.0, a.1), (a.0, b.1));
                vec![seg(a, c), seg(c, b), seg(b, d), seg(d, a)]
            }
            Tool::Arrow => {
                let mut v = vec![seg(a, b)];
                v.extend(arrow_head(a, b, r).into_iter().map(|p| seg(b, p)));
                v
            }
            _ if self.straight => vec![seg(a, b)],
            _ if self.points.len() == 1 => vec![seg(a, a)],
            _ => self.points.windows(2).map(|p| seg(p[0], p[1])).collect(),
        };
        parts.into_iter().flatten().reduce(Area::union)
    }
}

/// The two short lines of an arrow's head at `b`, pointing away from `a`.
fn arrow_head(a: (f32, f32), b: (f32, f32), r: f32) -> Vec<(f32, f32)> {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1.0 {
        return Vec::new();
    }
    let size = (r * 6.0).max(14.0).min(len * 0.6);
    let (ux, uy) = (dx / len, dy / len);
    let (c, s) = (0.5f32.cos(), 0.5f32.sin()); // about 29 degrees each side
    [(c, s), (c, -s)]
        .iter()
        .map(|&(c, s)| {
            (
                b.0 - size * (ux * c - uy * s),
                b.1 - size * (uy * c + ux * s),
            )
        })
        .collect()
}

pub struct Canvas {
    pub width: u32,
    pub height: u32,
    /// The finished strokes over `BASE`.
    done: Vec<u8>,
    /// Coverage of the stroke being drawn.
    cov: Vec<u8>,
    strokes: Vec<Stroke>,
    /// The stroke being drawn and the pixels it has covered so far.
    current: Option<(Stroke, Option<Area>)>,
}

impl Canvas {
    pub fn new(width: u32, height: u32) -> Canvas {
        Canvas {
            width,
            height,
            done: BASE.repeat((width * height) as usize),
            cov: vec![0; (width * height) as usize],
            strokes: Vec::new(),
            current: None,
        }
    }

    pub fn has_strokes(&self) -> bool {
        !self.strokes.is_empty()
    }

    /// The whole picture, into the window's pixels.
    pub fn show(&self, out: &mut [u8]) {
        out.copy_from_slice(&self.done);
    }

    /// Starts a stroke at `p` (a dot for the pen and marker).
    pub fn begin(
        &mut self,
        out: &mut [u8],
        tool: Tool,
        rgb: [u8; 3],
        scale: f32,
        straight: bool,
        p: (f32, f32),
    ) -> Option<Area> {
        self.end(out);
        let stroke = Stroke {
            tool,
            rgb,
            radius: tool.radius() * scale,
            straight,
            points: vec![p],
        };
        let marks = !tool.shaped();
        self.current = Some((stroke, None));
        if marks {
            self.redraw_current(out, p)
        } else {
            None
        }
    }

    /// Moves the stroke to `p`; the pixels to show again.
    pub fn extend(&mut self, out: &mut [u8], p: (f32, f32)) -> Option<Area> {
        let (stroke, _) = self.current.as_mut()?;
        if stroke.points.last() == Some(&p) {
            return None;
        }
        if stroke.follows_pointer() {
            let a = *stroke.points.last().unwrap();
            stroke.points.push(p);
            let (rgb, alpha, r) = (stroke.rgb, stroke.tool.alpha(), stroke.radius);
            let area = raster::segment(&mut self.cov, self.width, self.height, a, p, r)?;
            raster::lay(
                out,
                Some(&self.done),
                &self.cov,
                self.width,
                area,
                rgb,
                alpha,
            );
            let (_, so_far) = self.current.as_mut().unwrap();
            *so_far = Some(so_far.map_or(area, |s| s.union(area)));
            return Some(area);
        }
        self.redraw_current(out, p)
    }

    /// Draws the whole current stroke again, ending at `p`.
    fn redraw_current(&mut self, out: &mut [u8], p: (f32, f32)) -> Option<Area> {
        let (stroke, so_far) = self.current.as_mut()?;
        if stroke.points.len() > 1 {
            stroke.points.truncate(1);
        }
        if stroke.points[0] != p {
            stroke.points.push(p);
        }
        let old = so_far.take();
        if let Some(o) = old {
            raster::wipe(&mut self.cov, self.width, o);
        }
        let new = stroke.shape(&mut self.cov, self.width, self.height);
        *so_far = new;
        let dirty = match (old, new) {
            (Some(o), Some(n)) => o.union(n),
            (o, n) => o.or(n)?,
        };
        raster::lay(
            out,
            Some(&self.done),
            &self.cov,
            self.width,
            dirty,
            stroke.rgb,
            stroke.tool.alpha(),
        );
        Some(dirty)
    }

    /// Finishes the stroke being drawn. An arrow or a box of a single point
    /// (a click) is dropped.
    pub fn end(&mut self, out: &[u8]) {
        let Some((stroke, area)) = self.current.take() else {
            return;
        };
        let Some(area) = area else {
            return;
        };
        let w = self.width as usize;
        for y in area.y0..area.y1 {
            let (a, b) = (
                (y as usize * w + area.x0 as usize) * 4,
                (y as usize * w + area.x1 as usize) * 4,
            );
            self.done[a..b].copy_from_slice(&out[a..b]);
        }
        raster::wipe(&mut self.cov, self.width, area);
        self.strokes.push(stroke);
    }

    /// Takes back the last stroke; false when there was none.
    pub fn undo(&mut self, out: &mut [u8]) -> bool {
        self.end(out);
        if self.strokes.pop().is_none() {
            return false;
        }
        self.repaint(out);
        true
    }

    /// Takes every stroke away; false when there was none.
    pub fn clear(&mut self, out: &mut [u8]) -> bool {
        self.end(out);
        if self.strokes.is_empty() {
            return false;
        }
        self.strokes.clear();
        self.repaint(out);
        true
    }

    fn repaint(&mut self, out: &mut [u8]) {
        self.done
            .copy_from_slice(&BASE.repeat((self.width * self.height) as usize));
        for s in &self.strokes {
            if let Some(area) = s.shape(&mut self.cov, self.width, self.height) {
                raster::lay(
                    &mut self.done,
                    None,
                    &self.cov,
                    self.width,
                    area,
                    s.rgb,
                    s.tool.alpha(),
                );
                raster::wipe(&mut self.cov, self.width, area);
            }
        }
        self.show(out);
    }
}
