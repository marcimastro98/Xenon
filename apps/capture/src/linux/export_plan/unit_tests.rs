// Tests of the Linux export plan.

use crate::bubble::Corner;
use crate::reframe::Focus;
use super::{ffmpeg_args, fit, gif, Kind, parse_probe, Probe, vertical};
use super::progress::{failure, progress, Tick};

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(w: u32, h: u32, fps: u32, seconds: f64, audio: Option<u32>) -> Probe {
        Probe {
            width: w,
            height: h,
            fps,
            seconds,
            audio_bps: audio,
        }
    }

    #[test]
    fn ffprobe_json_gives_the_first_video_and_sound() {
        let json = r#"{"streams":[
            {"codec_type":"audio","bit_rate":"128000"},
            {"codec_type":"video","width":1920,"height":1080,"r_frame_rate":"60/1","avg_frame_rate":"60/1"},
            {"codec_type":"audio","bit_rate":"64000"}],
            "format":{"duration":"5.080000"}}"#;
        assert_eq!(
            parse_probe(json),
            Some(probe(1920, 1080, 60, 5.08, Some(128_000)))
        );
        // A variable-rate file's time base is not its pace; no sound, no length.
        let vfr = r#"{"streams":[{"codec_type":"video","width":1280,"height":720,
            "r_frame_rate":"1000/1","avg_frame_rate":"30000/1001"}],"format":{}}"#;
        assert_eq!(parse_probe(vfr), Some(probe(1280, 720, 30, 0.0, None)));
        // Sound without a bitrate counts as what Xenon records.
        let quiet = r#"{"streams":[{"codec_type":"video","width":640,"height":480},
            {"codec_type":"audio"}],"format":{"duration":"N/A"}}"#;
        assert_eq!(parse_probe(quiet), Some(probe(640, 480, 30, 0.0, Some(192_000))));
        assert_eq!(parse_probe(r#"{"streams":[{"codec_type":"audio"}]}"#), None);
        assert_eq!(parse_probe("not json"), None);
    }

    #[test]
    fn a_vertical_copy_crops_the_middle_at_up_to_60_fps() {
        let pic = vertical(&probe(1920, 1080, 120, 10.0, None), Focus::Center, None);
        assert_eq!(pic.size, (606, 1080));
        assert_eq!(pic.fps, 60);
        assert_eq!(
            pic.filter,
            "[0:v]crop=606:1080:656:0,scale=606:1080:flags=lanczos,fps=60,format=yuv420p[v]"
        );
        let left = vertical(&probe(1920, 1080, 30, 10.0, None), Focus::Left, None);
        assert!(left.filter.starts_with("[0:v]crop=606:1080:0:0,"));
        assert!(!left.filter.contains("fps="));
    }

    #[test]
    fn a_vertical_copy_with_the_webcam_stacks_two_parts() {
        let pic = vertical(
            &probe(1920, 1080, 60, 10.0, None),
            Focus::Center,
            Some(Corner::BottomRight),
        );
        assert_eq!(pic.size.0 % 2, 0);
        assert_eq!(pic.size.1, 1080);
        assert!(pic.filter.starts_with("[0:v]split=2[c][g];[c]crop="));
        assert!(pic.filter.contains("[top][bottom]vstack=inputs=2,format=yuv420p[v]"));
    }

    #[test]
    fn a_copy_that_must_fit_scales_down_and_keeps_the_sound() {
        let p = probe(3840, 2160, 60, 30.0, Some(192_000));
        let pic = fit(&p, 10_000_000, 0.0).expect("fits");
        assert!(pic.size.1 < 2160);
        assert!(pic.bps as f64 * 30.0 / 8.0 < 10_000_000.0);
        assert!(pic.filter.starts_with("[0:v]scale="));
        let args = ffmpeg_args("in.mp4", "out.part", &pic, Kind::Fit(10_000_000), "libx264");
        let at = |k: &str| args.iter().position(|a| a == k).expect(k);
        assert_eq!(args[at("-b:v") + 1], pic.bps.to_string());
        assert_eq!(args[at("-maxrate") + 1], pic.bps.to_string());
        assert_eq!(args[at("-c:a") + 1], "copy");
        assert_eq!(args.last().map(String::as_str), Some("out.part"));
        // The length from the server when the file does not say; none at all = no copy.
        assert!(fit(&probe(1920, 1080, 30, 0.0, None), 10_000_000, 20.0).is_some());
        assert_eq!(fit(&probe(1920, 1080, 30, 0.0, None), 10_000_000, 0.0), None);
        // An hour in one megabyte does not fit.
        assert_eq!(fit(&probe(1920, 1080, 30, 3600.0, None), 1_000_000, 0.0), None);
    }

    #[test]
    fn openh264_gets_only_the_bitrate() {
        let pic = vertical(&probe(1280, 720, 30, 5.0, None), Focus::Center, None);
        let args = ffmpeg_args("a", "b", &pic, Kind::Vertical(Focus::Center, None), "libopenh264");
        assert!(args.iter().any(|a| a == "libopenh264"));
        assert!(!args.iter().any(|a| a == "-preset" || a == "-maxrate"));
    }

    #[test]
    fn a_gif_has_a_palette_per_frame_and_no_sound() {
        let pic = gif(&probe(1920, 1080, 60, 10.0, Some(192_000)));
        assert_eq!(pic.size, (480, 270));
        assert_eq!(pic.fps, 12);
        assert!(pic.filter.contains("fps=100/8,scale=480:270"));
        assert!(pic.filter.contains("palettegen=stats_mode=single"));
        let args = ffmpeg_args("a", "b", &pic, Kind::Gif, "libx264");
        assert!(!args.iter().any(|a| a == "-c:a" || a == "-c:v"));
        assert_eq!(&args[args.len() - 5..], ["-loop", "0", "-f", "gif", "b"]);
    }

    #[test]
    fn progress_lines_give_the_share_done_and_the_bytes() {
        assert_eq!(progress("out_time_us=2500000", 10.0), Some(Tick::Done(0.25)));
        assert_eq!(progress("out_time_ms=20000000\n", 10.0), Some(Tick::Done(1.0)));
        assert_eq!(progress("out_time_us=N/A", 10.0), None);
        assert_eq!(progress("out_time_us=100", 0.0), None);
        assert_eq!(progress("total_size=4096", 10.0), Some(Tick::Bytes(4096)));
        assert_eq!(progress("progress=continue", 10.0), None);
    }

    #[test]
    fn a_full_disk_is_said() {
        assert_eq!(failure("out.part: No space left on device"), "disk_full");
        assert_eq!(failure("Invalid data found"), "export_failed");
    }
}
