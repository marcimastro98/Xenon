// Tests of the macOS command lines and of the reading of their output.

use crate::private_spots::Rect;
use super::{Aim, Front, monitor_at, parse_front, parse_monitors, png_size, record_args, screenshot_args, sips_size, sound_only_args, speech_args, thumb_args, trim_args, video_frame_args, wav_seconds};
use super::reading::{parse_ocr, parse_ocr_words, parse_picked, parse_sampled, Picked, Sampled};

#[cfg(test)]
mod tests {
    use super::*;

    fn strs(a: &[String]) -> Vec<&str> {
        a.iter().map(String::as_str).collect()
    }

    #[test]
    fn reads_monitors_and_drops_junk() {
        let list = parse_monitors(
            r#"[{"index":0,"name":"Built-in","primary":true,"x":0,"y":0,"width":1512,"height":982},
                {"index":1,"x":1512,"y":-200,"width":2560,"height":1440},
                {"index":2,"width":0,"height":10},{"nope":1}]"#,
        );
        assert_eq!(list.len(), 2);
        assert!(list[0].primary);
        assert_eq!(
            (list[1].x, list[1].y, list[1].name.as_str()),
            (1512, -200, "")
        );
        assert!(parse_monitors("not json").is_empty());
        assert!(parse_monitors("{}").is_empty());
    }

    #[test]
    fn reads_the_display_id_and_a_sane_scale() {
        let list = parse_monitors(
            r#"[{"index":0,"x":0,"y":0,"width":1512,"height":982,"display":1,"scale":2},
                {"index":1,"x":0,"y":0,"width":10,"height":10,"display":-4,"scale":40},
                {"index":2,"x":0,"y":0,"width":10,"height":10,"display":5000000000}]"#,
        );
        assert_eq!((list[0].display, list[0].scale), (1, 2.0));
        assert_eq!((list[1].display, list[1].scale), (0, 1.0));
        assert_eq!((list[2].display, list[2].scale), (0, 1.0));
    }

    #[test]
    fn finds_the_display_under_a_point() {
        let list = parse_monitors(
            r#"[{"index":0,"primary":true,"x":0,"y":0,"width":100,"height":100},
                {"index":1,"x":100,"y":0,"width":100,"height":100}]"#,
        );
        assert_eq!(monitor_at(&list, Some((150, 50))).unwrap().index, 1);
        assert_eq!(monitor_at(&list, Some((900, 900))).unwrap().index, 0);
        assert_eq!(monitor_at(&list, None).unwrap().index, 0);
        assert!(monitor_at(&[], None).is_none());
    }

    #[test]
    fn reads_the_front_window() {
        let f = parse_front(r#"{"exe":"Safari","id":42,"x":10,"y":20,"width":100,"height":40}"#);
        assert_eq!(
            (f.exe.as_str(), f.id, f.centre),
            ("Safari", 42, Some((60, 40)))
        );
        let none = parse_front(r#"{"exe":"Finder","id":0}"#);
        assert_eq!((none.id, none.centre), (0, None));
        assert_eq!(parse_front("garbage"), Front::default());
    }

    #[test]
    fn screenshot_argv_per_aim() {
        assert_eq!(
            strs(&screenshot_args(&Aim::Display(1), false, "/t/a.png")),
            ["-x", "-t", "png", "-D2", "/t/a.png"]
        );
        assert_eq!(
            strs(&screenshot_args(&Aim::Window(77), true, "/t/a.png")),
            ["-x", "-t", "png", "-C", "-o", "-l77", "/t/a.png"]
        );
        assert_eq!(
            strs(&screenshot_args(&Aim::Pick, false, "/t/a.png")),
            ["-x", "-t", "png", "-i", "-o", "/t/a.png"]
        );
    }

    #[test]
    fn record_argv_adds_the_microphone_only_when_asked() {
        assert_eq!(
            strs(&record_args(&Aim::Display(0), false, "/v.mov")),
            ["-v", "-x", "-D1", "/v.mov"]
        );
        assert_eq!(
            strs(&record_args(&Aim::Window(5), true, "/v.mov")),
            ["-v", "-x", "-g", "-l5", "/v.mov"]
        );
    }

    #[test]
    fn reads_png_and_sips_sizes() {
        let mut head = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        head.extend_from_slice(b"IHDR");
        head.extend_from_slice(&3024u32.to_be_bytes());
        head.extend_from_slice(&1964u32.to_be_bytes());
        assert_eq!(png_size(&head), Some((3024, 1964)));
        assert_eq!(png_size(b"GIF89a.................."), None);
        assert_eq!(png_size(&head[..20]), None);
        let out = "/x/a.png\n  pixelWidth: 1920\n  pixelHeight: 1080\n";
        assert_eq!(sips_size(out), Some((1920, 1080)));
        assert_eq!(sips_size("  pixelWidth: 1920\n"), None);
    }

    #[test]
    fn edit_and_speech_argv() {
        let t = trim_args("/a.mov", "/b.mov", 2.0, 4.5);
        assert_eq!(
            strs(&t)[5..10],
            [
                "PresetPassthrough",
                "--start",
                "2.000",
                "--duration",
                "4.500"
            ]
        );
        assert_eq!(strs(&speech_args("/a.mov", "/a.wav"))[3], "LEI16@16000");
        assert_eq!(
            strs(&sound_only_args("/a.mov", "/a.m4a"))[5],
            "PresetAppleM4A"
        );
        assert_eq!(
            strs(&thumb_args("/a.png", 480, "/a.jpg"))[7..],
            ["480", "/a.png", "--out", "/a.jpg"]
        );
        assert_eq!(
            strs(&video_frame_args("/a.mov", 480, "/tmp/x")),
            ["-t", "-s", "480", "-o", "/tmp/x", "/a.mov"]
        );
    }

    #[test]
    fn wav_length_from_its_size() {
        assert_eq!(wav_seconds(44), 0.0);
        assert_eq!(wav_seconds(44 + 32_000 * 3), 3.0);
        assert_eq!(wav_seconds(10), 0.0);
    }

    #[test]
    fn reads_ocr_and_folder_answers() {
        assert_eq!(
            parse_ocr(r#"{"lines":["Hello "," ","world"]}"#),
            Some(vec!["Hello".into(), "world".into()])
        );
        assert_eq!(parse_ocr(r#"{"error":"ocr_failed"}"#), None);
        assert_eq!(
            parse_picked("/Users/m/Movies/\n"),
            Picked::Folder("/Users/m/Movies".into())
        );
        assert_eq!(parse_picked("cancelled\n"), Picked::Cancelled);
        assert_eq!(parse_picked("failed"), Picked::Failed);
        assert_eq!(parse_picked("/"), Picked::Failed);
        assert_eq!(parse_picked("relative/path"), Picked::Failed);
    }

    #[test]
    fn reads_word_boxes_in_pixels() {
        let lines = parse_ocr_words(
            r#"{"lines":[[{"t":"IBAN","x":0.1,"y":0.5,"w":0.2,"h":0.1},
                          {"t":"","x":0,"y":0,"w":1,"h":1},
                          {"t":"x","x":0.5,"y":0.5,"w":0,"h":0.1}],
                         [{"t":"a@b.it","x":-0.5,"y":1.5,"w":0.25,"h":0.05}],
                         [{"nope":1}], "junk"]}"#,
            (200, 100),
        )
        .unwrap();
        let rect = |x, y, w, h| Rect { x, y, w, h };
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].len(), 1);
        assert_eq!(lines[0][0].text, "IBAN");
        assert_eq!(lines[0][0].rect, rect(20.0, 50.0, 40.0, 10.0));
        assert_eq!(lines[1][0].rect, rect(0.0, 100.0, 50.0, 5.0));
        assert!(parse_ocr_words(r#"{"error":"ocr_failed"}"#, (10, 10)).is_none());
        assert!(parse_ocr_words("not json", (10, 10)).is_none());
    }

    #[test]
    fn reads_the_colour_samplers_answer() {
        let colour = |rgb, at| Sampled::Colour { rgb, at };
        assert_eq!(
            parse_sampled("{\"rgb\":[255,0,16],\"x\":10,\"y\":-20}\n"),
            colour([255, 0, 16], Some((10, -20)))
        );
        assert_eq!(parse_sampled(r#"{"rgb":[1,2,3]}"#), colour([1, 2, 3], None));
        assert_eq!(parse_sampled("cancelled\n"), Sampled::Cancelled);
        assert_eq!(parse_sampled("unsupported"), Sampled::Unsupported);
        assert_eq!(parse_sampled(r#"{"rgb":[1,2]}"#), Sampled::Failed);
        assert_eq!(parse_sampled(r#"{"rgb":[1,2,300]}"#), Sampled::Failed);
        assert_eq!(parse_sampled("failed"), Sampled::Failed);
    }
}
