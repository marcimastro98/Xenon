//! Which desktop this is, which of the system's tools it has, their argv and
//! the reading of what they write: pure, so it is tested on every OS (the
//! tools themselves only run on Linux).

#[cfg(test)]
use crate::video::{self, Quality};

// This file is also built by path for the tests of the other systems, where Rust looks for child files next to
// it: so each one is named in full, and a name handed on below may go unused there.
#[path = "tools/kit.rs"]
mod kit;
#[path = "tools/screens.rs"]
mod screens;
#[path = "tools/shot.rs"]
mod shot;
#[path = "tools/record.rs"]
mod record;
#[path = "tools/files.rs"]
mod files;

#[allow(unused_imports)]
pub use files::{folder_args, ocr_langs, ocr_lines, parse_size, png_size, probe_size_args, speech_args, thumb_args, trim_args, uri_list, wav_seconds};
#[allow(unused_imports)]
pub use kit::{desk, Desk, Kit, Recorder, Shooter};
#[allow(unused_imports)]
pub use record::{ffmpeg_pipe_args, ffmpeg_record_args, has_device, parse_default_sink_monitor, pick_encoder, Sound, Tuning, wf_record_args};
#[allow(unused_imports)]
pub use screens::{clip_to_screen, Front, Monitor, monitor_at, parse_display_geometry, parse_wl_outputs, parse_xdotool_geometry, parse_xrandr};
#[cfg(test)]
use screens::parse_geometry;
#[allow(unused_imports)]
pub use shot::{Aim, parse_slurp, shot_args};

#[cfg(test)]
mod tests {
    use super::*;

    fn some(s: &str) -> Option<String> {
        Some(s.to_owned())
    }

    #[test]
    fn tells_the_session_from_its_variables() {
        assert_eq!(desk("x11", "", ":0", "XFCE"), Desk::X11);
        assert_eq!(desk("", "", ":0", ""), Desk::X11);
        assert_eq!(desk("", "", "", ""), Desk::None);
        assert_eq!(
            desk("wayland", "wayland-0", ":0", "ubuntu:GNOME"),
            Desk::Gnome
        );
        assert_eq!(desk("wayland", "wayland-0", ":1", "KDE"), Desk::Kde);
        assert_eq!(desk("", "wayland-1", "", "sway"), Desk::Wlroots);
        assert_eq!(desk("wayland", "", "", "Hyprland"), Desk::Wlroots);
        // An X11 session that inherited a stray WAYLAND_DISPLAY stays X11.
        assert_eq!(desk("x11", "wayland-0", ":0", "GNOME"), Desk::X11);
    }

    #[test]
    fn offers_only_what_the_tools_can_do() {
        let none = Kit::default();
        assert!(none.features(Desk::X11).is_empty());
        let x11 = Kit {
            maim: some("/usr/bin/maim"),
            xrandr: some("/usr/bin/xrandr"),
            xdotool: some("/usr/bin/xdotool"),
            ffmpeg: some("/usr/bin/ffmpeg"),
            ffprobe: some("/usr/bin/ffprobe"),
            tesseract: some("/usr/bin/tesseract"),
            xclip: some("/usr/bin/xclip"),
            zenity: some("/usr/bin/zenity"),
            pactl: some("/usr/bin/pactl"),
            encoder: Some("libx264"),
            x11grab: true,
            pulse: true,
            ..Kit::default()
        };
        assert_eq!(
            x11.features(Desk::X11),
            [
                "screenshot",
                "region",
                "window",
                "record",
                "tuning",
                "lapse",
                "replay",
                "mic",
                "sound",
                "ocr",
                "inspect",
                "measure",
                "thumb",
                "trim",
                "speech",
                "export",
                "cover",
                "copy_files",
                "pick_folder"
            ]
        );
        // The same tools on GNOME Wayland see nothing: X11 tools there see only X clients.
        assert_eq!(
            x11.features(Desk::Gnome),
            ["thumb", "trim", "speech", "export", "cover", "pick_folder"]
        );
        // Steps need xinput to read the clicks; X11 only.
        let with_xinput = Kit { xinput: some("/usr/bin/xinput"), ..x11.clone() };
        let f = with_xinput.features(Desk::X11);
        assert_eq!(&f[f.len() - 3..], ["steps", "copy_files", "pick_folder"]);
        assert!(!with_xinput.features(Desk::Gnome).contains(&"steps"));
        assert!(!Kit { ffmpeg: None, ..with_xinput.clone() }.features(Desk::X11).contains(&"steps"));
        let no_xdotool = Kit {
            xdotool: None,
            encoder: None,
            ..x11.clone()
        };
        let f = no_xdotool.features(Desk::X11);
        assert!(!f.contains(&"window") && !f.contains(&"record") && !f.contains(&"export"));
        // The colour needs the click (xdotool); the ruler only the area picker.
        assert!(!f.contains(&"inspect") && f.contains(&"measure"));
        let no_reader = Kit { ffmpeg: None, ..x11.clone() };
        assert!(!no_reader.features(Desk::X11).contains(&"inspect"));
        let with_import = Kit { import: some("/usr/bin/import"), ..no_reader };
        assert!(with_import.features(Desk::X11).contains(&"inspect"));
        let sway = Kit {
            grim: some("/usr/bin/grim"),
            wf_recorder: some("/usr/bin/wf-recorder"),
            kill: some("/usr/bin/kill"),
            wl_copy: some("/usr/bin/wl-copy"),
            ..Kit::default()
        };
        assert_eq!(
            sway.features(Desk::Wlroots),
            ["screenshot", "record", "tuning", "lapse", "mic", "copy_files"]
        );
        let slurp = Kit { slurp: some("/usr/bin/slurp"), ..sway.clone() };
        let f = slurp.features(Desk::Wlroots);
        assert!(f.contains(&"region") && f.contains(&"inspect") && f.contains(&"measure"));
        // The replay's ring is ffmpeg's: wf-recorder alone has none.
        assert!(!f.contains(&"replay"));
        let with_ffmpeg = Kit { ffmpeg: some("/usr/bin/ffmpeg"), ..slurp };
        assert!(with_ffmpeg.features(Desk::Wlroots).contains(&"replay"));
        let gnome = Kit {
            gnome_screenshot: some("/usr/bin/gnome-screenshot"),
            ..Kit::default()
        };
        assert_eq!(
            gnome.features(Desk::Gnome),
            ["screenshot", "region", "window", "measure"]
        );
        // GNOME and KDE on Wayland record through the portal: gst-launch reads
        // the stream, ffmpeg encodes it with the sound; no timelapse, no replay.
        let portal = Kit {
            gst_launch: some("/usr/bin/gst-launch-1.0"),
            kill: some("/usr/bin/kill"),
            pactl: some("/usr/bin/pactl"),
            ffmpeg: some("/usr/bin/ffmpeg"),
            encoder: Some("libx264"),
            pulse: true,
            ..gnome.clone()
        };
        let f = portal.features(Desk::Gnome);
        assert!(f.contains(&"record") && f.contains(&"tuning") && f.contains(&"sound") && f.contains(&"mic"));
        assert!(!f.contains(&"lapse") && !f.contains(&"replay"), "{f:?}");
        assert!(portal.features(Desk::Kde).contains(&"record"));
        assert!(!portal.features(Desk::X11).contains(&"record"), "no x11grab");
        let silent = Kit { pulse: false, ..portal.clone() };
        let f = silent.features(Desk::Gnome);
        assert!(f.contains(&"record") && !f.contains(&"sound") && !f.contains(&"mic"));
        assert!(!Kit { gst_launch: None, ..portal.clone() }.features(Desk::Gnome).contains(&"record"));
        assert!(!Kit { encoder: None, ..portal }.features(Desk::Gnome).contains(&"record"));
        assert_eq!(
            x11.features(Desk::None),
            ["thumb", "trim", "speech", "export", "cover"]
        );
    }

    #[test]
    fn reads_xrandr_monitors() {
        let list = parse_xrandr(
            "Monitors: 3\n 0: +*DP-1 2560/597x1440/336+0+0  DP-1\n 1: +HDMI-1 1920/527x1080/296+2560+0  HDMI-1\n 2: +eDP-1 1366/344x768/193+-1366+200  eDP-1\n junk\n",
        );
        assert_eq!(list.len(), 3);
        assert_eq!(
            (list[0].name.as_str(), list[0].primary, list[0].width),
            ("DP-1", true, 2560)
        );
        assert_eq!((list[1].x, list[1].y, list[1].height), (2560, 0, 1080));
        assert_eq!((list[2].x, list[2].y, list[2].primary), (-1366, 200, false));
        assert!(parse_xrandr("Monitors: 0\n").is_empty());
        assert_eq!(parse_geometry("1024x768+0+0"), Some((1024, 768, 0, 0)));
        assert_eq!(parse_geometry("0x0+0+0"), None);
        let m = &list;
        assert_eq!(monitor_at(m, Some((3000, 10))).map(|m| m.index), Some(1));
        assert_eq!(monitor_at(m, Some((-9000, 10))).map(|m| m.index), Some(0));
        assert_eq!(monitor_at(m, None).map(|m| m.index), Some(0));
        let two = parse_xrandr(
            " 0: +*A 1920/1x1080/1+0+0  A
 1: +B 1280/1x1024/1+1920+0  B
",
        );
        assert_eq!(
            clip_to_screen((-50, -20, 400, 300), &two),
            Some((0, 0, 350, 280))
        );
        assert_eq!(
            clip_to_screen((3000, 900, 400, 300), &two),
            Some((3000, 900, 200, 180))
        );
        assert_eq!(
            clip_to_screen((100, 100, 640, 480), &two),
            Some((100, 100, 640, 480))
        );
        assert_eq!(clip_to_screen((3300, 0, 100, 100), &two), None);
    }

    #[test]
    fn reads_xdotool_geometry() {
        let g = "WINDOW=4194307\nX=100\nY=-20\nWIDTH=1200\nHEIGHT=750\nSCREEN=0\n";
        assert_eq!(parse_xdotool_geometry(g), Some((100, -20, 1200, 750)));
        assert_eq!(parse_xdotool_geometry("X=1\nY=2\nWIDTH=0\nHEIGHT=4"), None);
        let whole = parse_display_geometry("3200 1080\n").unwrap();
        assert_eq!(
            (whole.x, whole.width, whole.height, whole.primary),
            (0, 3200, 1080, true)
        );
        assert!(parse_display_geometry("").is_none());
        assert!(parse_display_geometry("0 1080").is_none());
        let sway = parse_wl_outputs(
            r#"[{"name":"DP-1","active":true,"focused":false,"rect":{"x":0,"y":0,"width":2560,"height":1440}},
                {"name":"HDMI-A-1","active":false,"rect":{"x":0,"y":0,"width":0,"height":0}},
                {"name":"eDP-1","active":true,"focused":true,"rect":{"x":2560,"y":0,"width":1280,"height":800}}]"#,
        );
        assert_eq!(sway.len(), 2);
        assert_eq!(
            (
                sway[1].name.as_str(),
                sway[1].index,
                sway[1].primary,
                sway[1].x
            ),
            ("eDP-1", 1, true, 2560)
        );
        let hypr = parse_wl_outputs(
            r#"[{"name":"DP-2","x":0,"y":0,"width":3840,"height":2160,"scale":2.0,"focused":true,"disabled":false},
                {"name":"DP-3","x":1920,"y":0,"width":1920,"height":1080,"scale":1.0,"disabled":true}]"#,
        );
        assert_eq!(hypr.len(), 1);
        assert_eq!(
            (hypr[0].width, hypr[0].height, hypr[0].primary),
            (1920, 1080, true)
        );
        assert!(parse_wl_outputs("not json").is_empty());
        assert!(parse_wl_outputs("{}").is_empty());
        let f = Front {
            id: 1,
            exe: "x".into(),
            rect: Some((100, 0, 200, 100)),
        };
        assert_eq!(f.centre(), Some((200, 50)));
    }

    #[test]
    fn builds_each_tools_picture_argv() {
        let r = Some((2560, 0, 1920, 1080));
        assert_eq!(
            shot_args(Shooter::Maim, &Aim::Screen(r), false, "/t/a.png", None),
            ["-f", "png", "-u", "-g", "1920x1080+2560+0", "/t/a.png"]
        );
        assert_eq!(
            shot_args(Shooter::Maim, &Aim::Window(42), true, "o", None),
            ["-f", "png", "-i", "42", "o"]
        );
        assert_eq!(
            shot_args(Shooter::Maim, &Aim::Pick, false, "o", None),
            ["-f", "png", "-u", "-s", "o"]
        );
        assert_eq!(
            shot_args(Shooter::Import, &Aim::Screen(r), false, "o", None),
            [
                "-window",
                "root",
                "-crop",
                "1920x1080+2560+0",
                "+repage",
                "o"
            ]
        );
        assert_eq!(
            shot_args(Shooter::Import, &Aim::Pick, false, "o", None),
            ["o"]
        );
        assert_eq!(
            shot_args(Shooter::Grim, &Aim::Pick, true, "o", Some("10,20 300x200")),
            ["-c", "-g", "10,20 300x200", "o"]
        );
        assert_eq!(
            shot_args(Shooter::Grim, &Aim::Screen(None), false, "o", None),
            ["o"]
        );
        assert_eq!(
            shot_args(Shooter::Spectacle, &Aim::Pick, false, "o", None),
            ["-b", "-n", "-r", "-o", "o"]
        );
        assert_eq!(
            shot_args(Shooter::GnomeShot, &Aim::Window(0), true, "o", None),
            ["-p", "-w", "-f", "o"]
        );
    }

    #[test]
    fn reads_slurp_and_drops_a_cancel() {
        assert_eq!(
            parse_slurp("10,20 300x200\n").as_deref(),
            Some("10,20 300x200")
        );
        assert_eq!(parse_slurp("-5,0 10x10").as_deref(), Some("-5,0 10x10"));
        assert_eq!(parse_slurp("selection cancelled"), None);
        assert_eq!(parse_slurp("1,2 0x5"), None);
        assert_eq!(parse_slurp(""), None);
    }

    #[test]
    fn builds_the_recording_argv() {
        let t30 = Tuning::parse(Some(30), None, None, None);
        let silent = ffmpeg_record_args(":0", (0, 0, 1921, 1080), &t30, "libx264", &Sound::default(), "o");
        let s = silent.join(" ");
        assert!(s.contains("-f x11grab -framerate 30 -video_size 1921x1080 -i :0+0,0"));
        assert!(s.contains("[0:v]crop=trunc(iw/2)*2:trunc(ih/2)*2[v]"));
        assert!(s.contains("-map [v] -c:v libx264 -preset veryfast -crf 23"));
        assert!(!s.contains("pulse") && !s.contains("-c:a") && !s.contains(" -r "));
        assert!(s.ends_with("+frag_keyframe+empty_moov+default_base_moof -f mp4 o"));
        let both = Sound {
            monitor: some("alsa_output.pci.monitor"),
            mic: true,
        };
        let s = ffmpeg_record_args(":1", (5, 6, 100, 100), &t30, "libopenh264", &both, "o").join(" ");
        assert!(s.contains("-i :1+5,6"));
        assert!(s.contains("-f pulse -i alsa_output.pci.monitor"));
        assert!(s.contains("-f pulse -i default"));
        assert!(s.contains("amix=inputs=2") && s.contains("-map [a]"));
        // The bitrate comes from the shared numbers (the floor on a tiny picture).
        assert!(s.contains("-b:v 4000000"));
        let mic = Sound {
            monitor: None,
            mic: true,
        };
        let s = ffmpeg_record_args(":0", (0, 0, 10, 10), &t30, "libx264", &mic, "o").join(" ");
        assert!(s.contains("-map 1:a") && !s.contains("amix"));
        assert_eq!(
            wf_record_args(None, None, &t30, "o"),
            ["-y", "-f", "o", "-c", "libx264", "-p", "preset=veryfast", "-p", "crf=23", "-r", "30"]
        );
        let a = wf_record_args(Some((0, 0, 800, 600)), Some("default"), &t30, "o");
        assert_eq!(a[3..5], ["-g", "0,0 800x600"]);
        assert_eq!(a.last().map(String::as_str), Some("-a"));
        assert!(wf_record_args(None, Some("x.monitor"), &t30, "o").contains(&"--audio=x.monitor".to_owned()));
    }

    #[test]
    fn tunes_the_recording_like_windows() {
        // Nothing asked: 60 fps, the source size, normal detail.
        let def = Tuning::parse(None, None, None, None);
        assert_eq!((def.fps, def.height, def.every), (60, 0, None));
        let s = ffmpeg_record_args(":0", (0, 0, 3840, 2160), &def, "libx264", &Sound::default(), "o").join(" ");
        assert!(s.contains("-framerate 60") && !s.contains("scale="));
        // 1080p, high detail: scaled to fit, sharper.
        let hi = Tuning::parse(Some(60), Some(1080), Some("high"), None);
        let s = ffmpeg_record_args(":0", (0, 0, 3840, 2160), &hi, "libx264", &Sound::default(), "o").join(" ");
        assert!(s.contains("crop=trunc(iw/2)*2:trunc(ih/2)*2,scale=1920:1080[v]"));
        assert!(s.contains("-crf 18"));
        assert_eq!(hi.size(3840, 2160), (1920, 1080));
        // A screen already smaller than the cap keeps its size.
        let s = ffmpeg_record_args(":0", (0, 0, 1280, 720), &hi, "libx264", &Sound::default(), "o").join(" ");
        assert!(!s.contains("scale="));
        let small = Tuning::parse(Some(30), Some(720), Some("small"), None);
        let s = ffmpeg_record_args(":0", (0, 0, 1920, 1080), &small, "libopenh264", &Sound::default(), "o").join(" ");
        assert!(s.contains("scale=1280:720"));
        assert!(s.contains(&format!("-b:v {}", video::bitrate(1280, 720, 30, Quality::Small))));
        // wf-recorder: the cap without a known size never enlarges a screen.
        let w = wf_record_args(None, None, &small, "o").join(" ");
        assert!(w.contains("-r 30 -F scale=-2:'min(ih,720)'") && w.contains("crf=28"));
        let w = wf_record_args(Some((0, 0, 2560, 1440)), None, &small, "o").join(" ");
        assert!(w.contains("-F scale=1280:720"));
        // Odd values are ignored, like on Windows.
        assert_eq!(Tuning::parse(Some(45), Some(999), Some("x"), None), def);
    }

    #[test]
    fn records_a_silent_timelapse() {
        let lapse = Tuning::parse(Some(60), None, None, Some(5));
        assert_eq!((lapse.fps, lapse.every), (video::LAPSE_FPS, Some(5)));
        let both = Sound {
            monitor: some("x.monitor"),
            mic: true,
        };
        let s = ffmpeg_record_args(":0", (0, 0, 1920, 1080), &lapse, "libx264", &both, "o").join(" ");
        assert!(s.contains("-framerate 1/5"));
        assert!(s.contains("crop=trunc(iw/2)*2:trunc(ih/2)*2,settb=1/30,setpts=N,fps=30[v]"));
        assert!(s.contains("-r 30") && !s.contains("pulse") && !s.contains("-c:a"));
        let w = wf_record_args(Some((0, 0, 1920, 1080)), Some("default"), &lapse, "o").join(" ");
        assert!(w.contains("-F fps=1/5,settb=1/30,setpts=N"));
        assert!(!w.contains(" -r ") && !w.ends_with("-a"));
        // An interval not offered is a normal recording.
        assert_eq!(Tuning::parse(None, None, None, Some(3)).every, None);
    }

    #[test]
    fn encodes_the_portal_pictures_from_its_input() {
        let t = Tuning::parse(Some(30), None, None, None);
        let both = Sound {
            monitor: some("x.monitor"),
            mic: true,
        };
        let a = ffmpeg_pipe_args((1280, 720), &t, "libx264", &both, "/v/a b.mp4");
        let s = a.join(" ");
        assert!(s.contains("-f rawvideo -pix_fmt yuv420p -video_size 1280x720 -framerate 30 -i pipe:0"), "{s}");
        assert!(s.contains("-f pulse -i x.monitor") && s.contains("-f pulse -i default"));
        assert!(s.contains("amix=inputs=2") && s.contains("-c:a aac"));
        assert!(!s.contains("scale="), "the reader already gave the size: {s}");
        assert_eq!(&a[a.len() - 4..], ["-f", "mp4", "-shortest", "/v/a b.mp4"]);
        let silent = ffmpeg_pipe_args((1920, 1080), &t, "libopenh264", &Sound::default(), "o").join(" ");
        assert!(silent.contains("-c:v libopenh264 -b:v") && !silent.contains("pulse"));
    }

    #[test]
    fn reads_what_ffmpeg_and_pactl_offer() {
        let enc =
            " V..... libopenh264          OpenH264\n V....D libx264              libx264 H.264\n";
        assert_eq!(pick_encoder(enc), Some("libx264"));
        assert_eq!(
            pick_encoder(" V..... libopenh264  x\n"),
            Some("libopenh264")
        );
        assert_eq!(pick_encoder(" V..... mpeg4  x\n"), None);
        let dev = " D  lavfi\n DE pulse           Pulse audio output\n D  x11grab         X11 screen capture\n";
        assert!(has_device(dev, "x11grab") && has_device(dev, "pulse") && !has_device(dev, "v4l2"));
        let info = "Server Name: PulseAudio (on PipeWire 1.0.5)\nDefault Sink: alsa_output.pci-0000_00_1f.3.analog-stereo\n";
        assert_eq!(
            parse_default_sink_monitor(info).as_deref(),
            Some("alsa_output.pci-0000_00_1f.3.analog-stereo.monitor")
        );
        assert_eq!(parse_default_sink_monitor("Default Sink: \n"), None);
        assert_eq!(parse_default_sink_monitor("nothing"), None);
    }

    #[test]
    fn builds_the_gallery_argv() {
        let t = thumb_args("/v.mp4", 480, true, "/t.jpg").join(" ");
        assert!(t.contains("-vf thumbnail=60,scale='min(480,iw)':-2 -frames:v 1"));
        assert!(!thumb_args("/a.png", 480, false, "o")
            .join(" ")
            .contains("thumbnail"));
        assert_eq!(parse_size("1920x1080\n"), Some((1920, 1080)));
        assert_eq!(parse_size("N/A"), None);
        let trim = trim_args("/v.mp4", "o", 2.0, 4.25).join(" ");
        assert!(trim.contains("-ss 2.000 -i /v.mp4 -t 4.250 -map 0 -c copy"));
        let sp = speech_args("/v.mp4", "o").join(" ");
        assert!(sp.contains("-vn -ac 1 -ar 16000 -c:a pcm_s16le -bitexact"));
        assert_eq!(wav_seconds(44 + 32_000), 1.0);
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        png.extend(b"IHDR");
        png.extend(800u32.to_be_bytes());
        png.extend(600u32.to_be_bytes());
        assert_eq!(png_size(&png), Some((800, 600)));
        assert_eq!(png_size(b"not a png at all, not at all"), None);
    }

    #[test]
    fn picks_the_ocr_languages_installed() {
        let list = "List of available languages in \"/usr/share/tesseract-ocr/5/tessdata/\" (3):\neng\nita\nosd\n";
        assert_eq!(ocr_langs(list, "it_IT.UTF-8").as_deref(), Some("ita+eng"));
        assert_eq!(ocr_langs(list, "de_DE.UTF-8").as_deref(), Some("eng"));
        let only = "List of available languages in \"/x\" (2):\nfra\nosd\n";
        assert_eq!(ocr_langs(only, "C").as_deref(), Some("fra"));
        assert_eq!(
            ocr_langs("List of available languages in \"/x\" (1):\nosd\n", "en_US"),
            None
        );
        assert_eq!(ocr_lines("  Hello \n\n world\n\x0c"), ["Hello", "world"]);
    }

    #[test]
    fn builds_the_folder_dialog_and_the_file_list() {
        assert_eq!(
            folder_args(true, "Pick", "/home/u/Videos/"),
            [
                "--file-selection",
                "--directory",
                "--title=Pick",
                "--filename=/home/u/Videos/"
            ]
        );
        assert_eq!(
            folder_args(true, "Pick", "relative"),
            ["--file-selection", "--directory", "--title=Pick"]
        );
        assert_eq!(
            folder_args(false, "Pick", ""),
            ["--getexistingdirectory", "~", "--title", "Pick"]
        );
        assert_eq!(
            uri_list(&["/home/u/Video 1.mp4".into(), "/tmp/é.png".into()]),
            "file:///home/u/Video%201.mp4\r\nfile:///tmp/%C3%A9.png\r\n"
        );
    }
}
