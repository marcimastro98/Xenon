// Linux: finding which of the system's tools are installed.

use super::{env, portal_plan, run, TOOL_DEADLINE, tools};
use super::tools::{Desk, Kit};

pub(super) fn detect(desk: Desk) -> Kit {
    let w = run::which;
    let mut kit = Kit {
        maim: w("maim"),
        import: w("import"),
        xdotool: w("xdotool"),
        xrandr: w("xrandr"),
        grim: w("grim"),
        slurp: w("slurp"),
        wf_recorder: w("wf-recorder"),
        spectacle: w("spectacle"),
        gnome_screenshot: w("gnome-screenshot"),
        ffmpeg: w("ffmpeg"),
        ffprobe: w("ffprobe"),
        tesseract: w("tesseract"),
        xclip: w("xclip"),
        wl_copy: w("wl-copy"),
        zenity: w("zenity"),
        kdialog: w("kdialog"),
        pactl: w("pactl"),
        kill: w("kill"),
        xinput: w("xinput"),
        xwininfo: w("xwininfo"),
        // Only when the session is theirs: a sway installed beside another
        // desktop knows nothing of its screens.
        swaymsg: w("swaymsg").filter(|_| !env("SWAYSOCK").is_empty()),
        hyprctl: w("hyprctl").filter(|_| !env("HYPRLAND_INSTANCE_SIGNATURE").is_empty()),
        ..Kit::default()
    };
    if let Some(ff) = kit.ffmpeg.clone() {
        let list = |flag: &str| {
            run::run(
                &ff,
                &["-hide_banner".into(), flag.into()],
                None,
                TOOL_DEADLINE,
            )
            .map(|o| o.stdout)
            .unwrap_or_default()
        };
        kit.encoder = tools::pick_encoder(&list("-encoders"));
        let devices = list("-devices");
        kit.x11grab = tools::has_device(&devices, "x11grab");
        kit.pulse = tools::has_device(&devices, "pulse");
    }
    // Only where the portal is the way to record: each element is one
    // gst-inspect call.
    if matches!(desk, Desk::Gnome | Desk::Kde) {
        if let (Some(launch), Some(inspect)) = (w("gst-launch-1.0"), w("gst-inspect-1.0")) {
            let has = |e: &str| {
                let args = vec!["--exists".to_owned(), e.to_owned()];
                run::run(&inspect, &args, None, TOOL_DEADLINE).is_some_and(|o| o.ok)
            };
            kit.gst_launch = portal_plan::reader_found(has).then_some(launch);
        }
    }
    kit
}
