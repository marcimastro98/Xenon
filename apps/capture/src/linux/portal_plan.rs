//! A recording through the desktop's ScreenCast portal (GNOME and KDE on
//! Wayland), its pure parts. gst-launch only reads the PipeWire stream the
//! portal hands over (on file descriptor `PIPEWIRE_FD` of the child) and
//! writes raw pictures to its standard output; ffmpeg encodes them with the
//! sound, the same way as on X11 (tools.rs). ffmpeg ends its file cleanly on
//! an interrupt, which gst-launch with keepalive does not (pipewiresrc then
//! never sends the end of the stream).

#[cfg(target_os = "linux")]
use super::tools::Tuning;
// Its tests also run on the other systems, beside the tools they use (main.rs).
#[cfg(not(target_os = "linux"))]
use crate::linux_tools::Tuning;

/// Where the portal's PipeWire connection sits in gst-launch.
pub const PIPEWIRE_FD: i32 = 3;

/// The GStreamer elements the reader needs, all from gstreamer1.0-pipewire
/// and plugins-base.
pub const READER: [&str; 4] = ["pipewiresrc", "videoconvert", "videorate", "videoscale"];

/// The picture size when the portal does not say the stream's.
const FALLBACK: (i64, i64) = (1920, 1080);

/// Whether this system has every element of the reader (`has` answers
/// `gst-inspect-1.0 --exists <name>`).
pub fn reader_found(has: impl Fn(&str) -> bool) -> bool {
    READER.iter().all(|e| has(e))
}

/// The size of the pictures the reader writes: the stream's (or the fallback,
/// bordered to keep its shape) brought to the asked height, always even.
pub fn reader_size(size: Option<(i64, i64)>, tuning: &Tuning) -> (u32, u32) {
    let (w, h) = size.unwrap_or(FALLBACK);
    tuning.size(w, h)
}

/// gst-launch's argv: the portal's stream `node` as I420 pictures of `size`
/// at a constant `fps` on standard output. keepalive-time repeats the last
/// picture while the screen stands still (GNOME sends none then), so the
/// video keeps time with the sound. `-q` keeps gst-launch's own messages
/// off the picture stream.
pub fn reader_args(node: u32, size: (u32, u32), fps: u32) -> Vec<String> {
    let (w, h) = size;
    let fps = fps.max(1);
    format!(
        "-q pipewiresrc fd={PIPEWIRE_FD} path={node} do-timestamp=true keepalive-time=1000 \
         ! videoconvert ! videorate ! videoscale add-borders=true \
         ! video/x-raw,format=I420,width={w},height={h},framerate={fps}/1,pixel-aspect-ratio=1/1 \
         ! fdsink fd=1"
    )
    .split(' ')
    .filter(|s| !s.is_empty())
    .map(str::to_owned)
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reader_needs_every_element() {
        assert!(reader_found(|_| true));
        for missing in READER {
            assert!(!reader_found(|e| e != missing), "{missing}");
        }
        // The encoders are ffmpeg's, so no GStreamer encoder is asked for.
        assert!(reader_found(|e| READER.contains(&e)));
    }

    #[test]
    fn the_size_is_the_streams_brought_to_the_asked_height() {
        let any = Tuning::parse(Some(60), None, None, None);
        assert_eq!(reader_size(Some((3840, 2160)), &any), (3840, 2160));
        assert_eq!(reader_size(Some((1281, 721)), &any), (1280, 720), "even");
        let small = Tuning::parse(Some(30), Some(1080), None, None);
        assert_eq!(reader_size(Some((3840, 2160)), &small), (1920, 1080));
        assert_eq!(reader_size(None, &any), (1920, 1080));
    }

    #[test]
    fn the_reader_writes_raw_pictures_to_its_output() {
        let a = reader_args(42, (1280, 720), 30);
        let line = a.join(" ");
        assert_eq!(a[0], "-q");
        assert!(!a.contains(&"-e".to_owned()), "ffmpeg ends the file, not gst-launch");
        assert!(line.starts_with("-q pipewiresrc fd=3 path=42 do-timestamp=true keepalive-time=1000 ! videoconvert"));
        assert!(line.contains("video/x-raw,format=I420,width=1280,height=720,framerate=30/1,pixel-aspect-ratio=1/1"));
        assert!(line.ends_with("! fdsink fd=1"), "{line}");
        assert!(a.iter().all(|w| !w.is_empty() && !w.contains(' ')));
        assert!(reader_args(1, (2, 2), 0).join(" ").contains("framerate=1/1"));
    }
}
