//! The colour picker on Linux, the pure part: where the user clicked (slurp's
//! point on wlroots, xdotool's pointer on X11), the one-pixel picture's
//! arguments, and that pixel read back from a PPM.

/// slurp `-p`'s answer (`x,y 1x1`) as the point; anything else is a cancel.
pub fn parse_point(out: &str) -> Option<(i64, i64)> {
    let (at, size) = out.trim().split_once(' ')?;
    let (x, y) = at.split_once(',')?;
    (size == "1x1").then_some(())?;
    Some((x.parse().ok()?, y.parse().ok()?))
}

/// `xdotool getmouselocation --shell` as the pointer's place.
pub fn parse_mouse(out: &str) -> Option<(i64, i64)> {
    let value = |key: &str| {
        out.lines()
            .find_map(|l| l.trim().strip_prefix(key)?.strip_prefix('='))
            .and_then(|v| v.trim().parse().ok())
    };
    Some((value("X")?, value("Y")?))
}

/// grim's argv for the pixel at `(x, y)` into `out` (PPM).
pub fn grim_args((x, y): (i64, i64), out: &str) -> Vec<String> {
    vec![
        "-g".into(),
        format!("{x},{y} 1x1"),
        "-t".into(),
        "ppm".into(),
        out.into(),
    ]
}

/// ImageMagick `import`'s argv for the pixel at `(x, y)` of the X screen into `out` (PPM).
pub fn import_args((x, y): (i64, i64), out: &str) -> Vec<String> {
    vec![
        "-window".into(),
        "root".into(),
        "-crop".into(),
        format!("1x1+{x}+{y}"),
        "+repage".into(),
        "-depth".into(),
        "8".into(),
        format!("ppm:{out}"),
    ]
}

/// ffmpeg's argv for the pixel at `(x, y)` of the X `display` into `out` (PPM).
pub fn x11grab_args(display: &str, (x, y): (i64, i64), out: &str) -> Vec<String> {
    [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "x11grab",
        "-video_size",
        "1x1",
        "-i",
        &format!("{display}+{x},{y}"),
        "-frames:v",
        "1",
        "-c:v",
        "ppm",
        "-f",
        "image2",
        out,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// The first pixel of a binary PPM (P6), 8 or 16 bits a channel.
pub fn ppm_pixel(bytes: &[u8]) -> Option<[u8; 3]> {
    // The header: magic, width, height, maxval, each after whitespace or a comment.
    let mut fields = Vec::with_capacity(4);
    let mut i = 0;
    while fields.len() < 4 {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if bytes.get(i) == Some(&b'#') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        let start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if start == i {
            return None;
        }
        fields.push(std::str::from_utf8(&bytes[start..i]).ok()?);
    }
    if fields[0] != "P6" {
        return None;
    }
    let (w, h): (u32, u32) = (fields[1].parse().ok()?, fields[2].parse().ok()?);
    let max: u32 = fields[3].parse().ok()?;
    if w == 0 || h == 0 || max == 0 || max > 65535 {
        return None;
    }
    // One whitespace byte ends the header.
    let data = bytes.get(i + 1..)?;
    let scale = |v: u32| ((v * 255 + max / 2) / max) as u8;
    if max < 256 {
        let p = data.get(..3)?;
        Some([scale(p[0] as u32), scale(p[1] as u32), scale(p[2] as u32)])
    } else {
        let p = data.get(..6)?;
        let c = |k: usize| scale(u16::from_be_bytes([p[k], p[k + 1]]) as u32);
        Some([c(0), c(2), c(4)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_slurps_point_and_drops_a_cancel() {
        assert_eq!(parse_point("120,-40 1x1\n"), Some((120, -40)));
        assert_eq!(parse_point("10,20 300x200"), None);
        assert_eq!(parse_point("selection cancelled"), None);
        assert_eq!(parse_point(""), None);
    }

    #[test]
    fn reads_the_pointer_from_xdotool() {
        assert_eq!(
            parse_mouse("X=812\nY=33\nSCREEN=0\nWINDOW=123\n"),
            Some((812, 33))
        );
        assert_eq!(parse_mouse("SCREEN=0\n"), None);
    }

    #[test]
    fn one_pixel_arguments() {
        assert_eq!(grim_args((5, 6), "/t/p.ppm"), ["-g", "5,6 1x1", "-t", "ppm", "/t/p.ppm"]);
        assert_eq!(
            import_args((5, 6), "/t/p.ppm"),
            ["-window", "root", "-crop", "1x1+5+6", "+repage", "-depth", "8", "ppm:/t/p.ppm"]
        );
        let ff = x11grab_args(":0", (5, 6), "/t/p.ppm");
        assert_eq!(&ff[5..11], ["-f", "x11grab", "-video_size", "1x1", "-i", ":0+5,6"]);
        assert_eq!(ff.last().map(String::as_str), Some("/t/p.ppm"));
    }

    #[test]
    fn reads_the_first_pixel_of_a_ppm() {
        assert_eq!(ppm_pixel(b"P6\n1 1\n255\n\x1e\x90\xff"), Some([30, 144, 255]));
        // A comment, a 2x2 picture from a scaled output: the first pixel.
        assert_eq!(
            ppm_pixel(b"P6 # grim\n2 2 255\n\x01\x02\x03\x04\x05\x06\0\0\0\0\0\0"),
            Some([1, 2, 3])
        );
        // 16 bits a channel.
        assert_eq!(ppm_pixel(b"P6\n1 1\n65535\n\xff\xff\x80\x00\x00\x00"), Some([255, 128, 0]));
        assert_eq!(ppm_pixel(b"P5\n1 1\n255\n\x10"), None);
        assert_eq!(ppm_pixel(b"P6\n1 1\n255\n\x10"), None);
        assert_eq!(ppm_pixel(b""), None);
    }
}
