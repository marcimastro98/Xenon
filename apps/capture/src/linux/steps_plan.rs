//! The steps recorder's pure parts on X11: the presses and the typing read
//! from `xinput test-xi2 --root`, the size of a step's picture, ffmpeg's argv
//! to decode it to raw pixels and to write the JPEG, and xdotool's answer
//! for where the pointer is. Keys are never kept: a key press only says that
//! typing happened.

pub use crate::steps::picture_size;

/// One thing the user did, as xinput reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    /// A left or right press; `time` is the X server's clock in ms.
    Press { right: bool, time: u64 },
    Typed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Button,
    Key,
}

/// Reads `xinput test-xi2 --root` one line at a time. An event is a header
/// line, `EVENT type 15 (RawButtonPress)`, then indented fields; it is known
/// once its `detail:` line arrives.
#[derive(Debug, Default)]
pub struct Xi2 {
    kind: Option<Kind>,
    time: u64,
}

impl Xi2 {
    pub fn feed(&mut self, line: &str) -> Option<Input> {
        let line = line.trim();
        if line.starts_with("EVENT type") {
            self.kind = if line.ends_with("(RawButtonPress)") {
                Some(Kind::Button)
            } else if line.ends_with("(RawKeyPress)") {
                Some(Kind::Key)
            } else {
                None
            };
            self.time = 0;
            return None;
        }
        if let Some(t) = line.strip_prefix("time:") {
            self.time = t.trim().parse().unwrap_or(0);
            return None;
        }
        let detail = line.strip_prefix("detail:")?.trim();
        match self.kind.take()? {
            Kind::Key => Some(Input::Typed),
            // 1 = left, 3 = right; the middle button and the wheel are not steps.
            Kind::Button => match detail {
                "1" => Some(Input::Press {
                    right: false,
                    time: self.time,
                }),
                "3" => Some(Input::Press {
                    right: true,
                    time: self.time,
                }),
                _ => None,
            },
        }
    }
}

/// ffmpeg's argv: the PNG at `src`, scaled to `width`×`height`, as tight BGR
/// rows on stdout.
pub fn decode_args(src: &str, width: u32, height: u32) -> Vec<String> {
    let scale = format!("scale={width}:{height}:flags=bicubic");
    [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-i", src, "-vf", &scale,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "bgr24", "-",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect()
}

/// ffmpeg's argv: BGR rows of `width`×`height` on stdin, one JPEG to `out`.
pub fn encode_args(width: u32, height: u32, out: &str) -> Vec<String> {
    let size = format!("{width}x{height}");
    [
        "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", &size,
        "-i", "-", "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2", "-y", out,
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect()
}

/// Where the pointer is and the window under it, from `xdotool
/// getmouselocation --shell` (X=, Y=, SCREEN=, WINDOW= lines).
pub fn parse_mouse(out: &str) -> Option<(i64, i64, u64)> {
    let field = |key: &str| {
        out.lines()
            .find_map(|l| l.trim().strip_prefix(key)?.strip_prefix('='))
            .map(str::trim)
    };
    let x = field("X")?.parse().ok()?;
    let y = field("Y")?.parse().ok()?;
    let window = field("WINDOW").and_then(|w| w.parse().ok()).unwrap_or(0);
    Some((x, y, window))
}

/// The child window ids `xwininfo -children` lists, in its order: a window
/// manager's frame holds the app's own window, which carries its process id.
/// The names after the ids (window titles) are not read.
pub fn parse_children(out: &str) -> Vec<u64> {
    out.lines()
        .filter_map(|l| l.split_whitespace().next()?.strip_prefix("0x"))
        .filter_map(|hex| u64::from_str_radix(hex, 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(text: &str) -> Vec<Input> {
        let mut xi = Xi2::default();
        text.lines().filter_map(|l| xi.feed(l)).collect()
    }

    #[test]
    fn presses_and_typing_are_read_and_keys_are_not_kept() {
        let out = "EVENT type 15 (RawButtonPress)\n    device: 2 (4)\n    time:   28496665\n    detail: 1\n    flags: \n\
                   EVENT type 16 (RawButtonRelease)\n    device: 2 (4)\n    time:   28496700\n    detail: 1\n\
                   EVENT type 15 (RawButtonPress)\n    device: 2 (4)\n    time:   28497070\n    detail: 3\n\
                   EVENT type 13 (RawKeyPress)\n    device: 3 (5)\n    time:   28497475\n    detail: 38\n    valuators:\n";
        assert_eq!(
            read(out),
            vec![
                Input::Press { right: false, time: 28496665 },
                Input::Press { right: true, time: 28497070 },
                Input::Typed,
            ]
        );
    }

    #[test]
    fn the_wheel_the_middle_button_and_motion_are_not_steps() {
        let out = "EVENT type 15 (RawButtonPress)\n    detail: 4\n\
                   EVENT type 15 (RawButtonPress)\n    detail: 2\n\
                   EVENT type 17 (RawMotion)\n    detail: 0\n\
                   detail: 1\n";
        assert!(read(out).is_empty(), "a detail with no event before it counts for nothing");
    }

    #[test]
    fn pictures_keep_their_shape_and_stay_even() {
        assert_eq!(picture_size(1920, 1080), (1600, 900));
        assert_eq!(picture_size(3840, 2160), (1600, 900));
        assert_eq!(picture_size(1280, 1024), (1280, 1024));
        assert_eq!(picture_size(1366, 767), (1366, 766));
        assert_eq!(picture_size(2560, 1081), (1600, 674));
        assert_eq!(picture_size(0, 0), (2, 2));
    }

    #[test]
    fn ffmpeg_decodes_to_bgr_and_encodes_one_jpeg() {
        let d = decode_args("/t/s.png", 1600, 900);
        assert_eq!(d[d.len() - 1], "-", "raw pixels on stdout");
        assert!(d.windows(2).any(|w| w == ["-pix_fmt", "bgr24"]));
        assert!(d.contains(&"scale=1600:900:flags=bicubic".to_owned()));
        let e = encode_args(1600, 900, "/t/step-001.jpg.part");
        assert!(e.windows(2).any(|w| w == ["-s", "1600x900"]));
        assert!(e.windows(2).any(|w| w == ["-i", "-"]));
        assert_eq!(e[e.len() - 1], "/t/step-001.jpg.part");
    }

    #[test]
    fn a_frame_lists_its_children_and_never_the_parent_or_root() {
        let out = "
xwininfo: Window id: 0x200006d (has no name)

  Root window id: 0x3ae (the root window) (has no name)
                     Parent window id: 0x3ae (the root window) (has no name)
     2 children:
                        0x2000071 (has no name): ()  1x1+-1+-1  +99+99
     0xa00004 \"Secret title\": (\"zenity\" \"Zenity\")  300x100+0+20  +100+120
";
        assert_eq!(parse_children(out), vec![0x2000071, 0xa00004]);
        assert!(parse_children("").is_empty());
    }

    #[test]
    fn the_pointer_is_read_from_xdotool() {
        assert_eq!(
            parse_mouse("X=100\nY=200\nSCREEN=0\nWINDOW=2097525\n"),
            Some((100, 200, 2097525))
        );
        assert_eq!(parse_mouse("X=-5\nY=7\n"), Some((-5, 7, 0)));
        assert_eq!(parse_mouse("XY=1\n"), None);
        assert_eq!(parse_mouse(""), None);
    }
}
