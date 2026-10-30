//! The colour picker and the ruler, the parts with no window: the text put on
//! the clipboard, and where the magnifier sits and what it shows.

/// How a picked colour is written.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Format {
    Hex,
    Rgb,
    Hsl,
}

impl Format {
    pub fn parse(s: &str) -> Option<Format> {
        match s {
            "hex" => Some(Format::Hex),
            "rgb" => Some(Format::Rgb),
            "hsl" => Some(Format::Hsl),
            _ => None,
        }
    }
}

pub fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2])
}

/// Hue in degrees, saturation and lightness in percent, rounded as design apps show them.
pub fn hsl(rgb: [u8; 3]) -> (u32, u32, u32) {
    let [r, g, b] = rgb.map(|v| v as f64 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d == 0.0 {
        return (0, 0, (l * 100.0).round() as u32);
    }
    let s = d / (1.0 - (2.0 * l - 1.0).abs());
    let h = if max == r {
        60.0 * (((g - b) / d).rem_euclid(6.0))
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    (
        (h.round() as u32) % 360,
        (s * 100.0).round() as u32,
        (l * 100.0).round() as u32,
    )
}

/// The colour as it is pasted into CSS or a design app.
pub fn text(rgb: [u8; 3], format: Format) -> String {
    match format {
        Format::Hex => hex(rgb),
        Format::Rgb => format!("rgb({}, {}, {})", rgb[0], rgb[1], rgb[2]),
        Format::Hsl => {
            let (h, s, l) = hsl(rgb);
            format!("hsl({h}, {s}%, {l}%)")
        }
    }
}

/// The colour at (x, y) of a top-down BGRA image `width` pixels wide.
pub fn pixel(bgra: &[u8], width: u32, x: i32, y: i32) -> Option<[u8; 3]> {
    if x < 0 || y < 0 || x as u32 >= width {
        return None;
    }
    let i = (y as usize * width as usize + x as usize) * 4;
    bgra.get(i..i + 3).map(|p| [p[2], p[1], p[0]])
}

/// A measured area, in screen pixels.
pub fn size_text(width: i32, height: i32) -> String {
    format!("{width} \u{00D7} {height}")
}

/// The magnifier: `CELLS` pixels across, each drawn as a square of `cell` px.
pub const CELLS: i32 = 11;

/// Where the magnifier box goes for the cursor at `pt` on a surface of
/// `size`: below right of the cursor, flipped to the other side when it
/// would leave the surface. `box_` is its width and height.
pub fn place(pt: (i32, i32), size: (i32, i32), box_: (i32, i32), gap: i32) -> (i32, i32) {
    let side = |p: i32, len: i32, total: i32| {
        if p + gap + len <= total {
            p + gap
        } else {
            (p - gap - len).max(0)
        }
    };
    (side(pt.0, box_.0, size.0), side(pt.1, box_.1, size.1))
}

/// Where the size label of the area (left, top, right, bottom) goes on a
/// surface of `size`: centred under it, above it when there is no room
/// below, inside it when there is room on neither side.
pub fn label_at(
    area: (i32, i32, i32, i32),
    label: (i32, i32),
    size: (i32, i32),
    gap: i32,
) -> (i32, i32) {
    let (l, t, r, b) = area;
    let top = if b + gap + label.1 <= size.1 {
        b + gap
    } else if t - gap - label.1 >= 0 {
        t - gap - label.1
    } else {
        (b - gap - label.1).max(0)
    };
    let left = ((l + r) / 2 - label.0 / 2).clamp(0, (size.0 - label.0).max(0));
    (left, top)
}

/// (left, top, width, height) of the source pixels, and the cells they start in by.
pub type Source = ((i32, i32, i32, i32), (i32, i32));

/// The part of the `CELLS`-wide square centred on `pt` that lies on an image
/// of `size`: (source left, top, width, height) and how many cells it starts
/// in from the magnifier's own left and top edge. None when nothing does.
pub fn source(pt: (i32, i32), size: (i32, i32)) -> Option<Source> {
    let half = CELLS / 2;
    let (x0, y0) = (pt.0 - half, pt.1 - half);
    let (left, top) = (x0.max(0), y0.max(0));
    let right = (x0 + CELLS).min(size.0);
    let bottom = (y0 + CELLS).min(size.1);
    if right <= left || bottom <= top {
        return None;
    }
    Some((
        (left, top, right - left, bottom - top),
        (left - x0, top - y0),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_are_written_as_css_and_design_apps_write_them() {
        assert_eq!(text([30, 144, 255], Format::Hex), "#1E90FF");
        assert_eq!(text([30, 144, 255], Format::Rgb), "rgb(30, 144, 255)");
        assert_eq!(text([30, 144, 255], Format::Hsl), "hsl(210, 100%, 56%)");
        assert_eq!(text([0, 0, 0], Format::Hsl), "hsl(0, 0%, 0%)");
        assert_eq!(text([255, 255, 255], Format::Hsl), "hsl(0, 0%, 100%)");
        assert_eq!(text([128, 128, 128], Format::Hsl), "hsl(0, 0%, 50%)");
        assert_eq!(text([255, 0, 0], Format::Hsl), "hsl(0, 100%, 50%)");
        assert_eq!(text([0, 255, 0], Format::Hsl), "hsl(120, 100%, 50%)");
        assert_eq!(text([0, 0, 255], Format::Hsl), "hsl(240, 100%, 50%)");
        assert_eq!(text([255, 0, 128], Format::Hsl), "hsl(330, 100%, 50%)");
    }

    #[test]
    fn only_the_three_formats_parse() {
        assert_eq!(Format::parse("hex"), Some(Format::Hex));
        assert_eq!(Format::parse("rgb"), Some(Format::Rgb));
        assert_eq!(Format::parse("hsl"), Some(Format::Hsl));
        assert_eq!(Format::parse("HEX"), None);
        assert_eq!(Format::parse(""), None);
    }

    #[test]
    fn a_pixel_is_read_from_bgra_rows() {
        // 2 x 2: blue, green / red, white.
        let img = [
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];
        assert_eq!(pixel(&img, 2, 0, 0), Some([0, 0, 255]));
        assert_eq!(pixel(&img, 2, 1, 0), Some([0, 255, 0]));
        assert_eq!(pixel(&img, 2, 0, 1), Some([255, 0, 0]));
        assert_eq!(pixel(&img, 2, 1, 1), Some([255, 255, 255]));
        assert_eq!(pixel(&img, 2, 2, 0), None);
        assert_eq!(pixel(&img, 2, 0, 2), None);
        assert_eq!(pixel(&img, 2, -1, 0), None);
    }

    #[test]
    fn a_size_reads_width_by_height() {
        assert_eq!(size_text(1200, 750), "1200 \u{00D7} 750");
    }

    #[test]
    fn the_magnifier_stays_on_the_surface() {
        assert_eq!(place((100, 100), (1920, 1080), (150, 180), 20), (120, 120));
        // Near the right and bottom edges it goes to the other side of the cursor.
        assert_eq!(
            place((1900, 1070), (1920, 1080), (150, 180), 20),
            (1730, 870)
        );
        // A surface smaller than the box: pinned to its left/top edge.
        assert_eq!(place((10, 10), (100, 100), (150, 180), 20), (0, 0));
    }

    #[test]
    fn the_size_label_sits_under_the_area_and_stays_on_screen() {
        assert_eq!(
            label_at((100, 100, 300, 200), (80, 30), (1920, 1080), 8),
            (160, 208)
        );
        // No room below: above.
        assert_eq!(
            label_at((100, 1000, 300, 1070), (80, 30), (1920, 1080), 8),
            (160, 962)
        );
        // The whole screen: inside, at the bottom.
        assert_eq!(
            label_at((0, 0, 1920, 1080), (80, 30), (1920, 1080), 8),
            (920, 1042)
        );
        // Against the left edge it does not leave the screen.
        assert_eq!(
            label_at((0, 100, 20, 200), (80, 30), (1920, 1080), 8),
            (0, 208)
        );
    }

    #[test]
    fn the_magnified_square_is_cut_to_the_image() {
        assert_eq!(
            source((100, 100), (1920, 1080)),
            Some(((95, 95, 11, 11), (0, 0)))
        );
        // At the top left corner only the cells on the image are drawn, shifted in.
        assert_eq!(source((0, 0), (1920, 1080)), Some(((0, 0, 6, 6), (5, 5))));
        assert_eq!(
            source((1919, 1079), (1920, 1080)),
            Some(((1914, 1074, 6, 6), (0, 0)))
        );
        assert_eq!(source((-20, 5), (1920, 1080)), None);
    }
}
