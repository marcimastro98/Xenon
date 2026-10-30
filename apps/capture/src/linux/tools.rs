//! Which desktop this is, which of the system's tools it has, their argv and
//! the reading of what they write: pure, so it is tested on every OS (the
//! tools themselves only run on Linux).

use crate::video::{self, Quality};

/// The kind of session, which decides the tools that can see the screen.
/// X11 tools on a Wayland session see only X clients, so they are never mixed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Desk {
    X11,
    /// Sway, Hyprland, river and the other wlroots compositors (grim, slurp, wf-recorder).
    Wlroots,
    Kde,
    Gnome,
    /// No display the engine can reach (a server started without one).
    None,
}

/// From the session's own variables: XDG_SESSION_TYPE, WAYLAND_DISPLAY,
/// DISPLAY and XDG_CURRENT_DESKTOP.
pub fn desk(session: &str, wayland: &str, display: &str, current: &str) -> Desk {
    let wayland_session = session.eq_ignore_ascii_case("wayland")
        || (!wayland.is_empty() && !session.eq_ignore_ascii_case("x11"));
    if !wayland_session {
        return if display.is_empty() {
            Desk::None
        } else {
            Desk::X11
        };
    }
    let current = current.to_ascii_uppercase();
    if current.split(':').any(|d| d == "GNOME") {
        Desk::Gnome
    } else if current.split(':').any(|d| d == "KDE") {
        Desk::Kde
    } else {
        Desk::Wlroots
    }
}

/// The tools found on PATH, each as its absolute path.
#[derive(Debug, Default, Clone)]
pub struct Kit {
    pub maim: Option<String>,
    pub import: Option<String>,
    pub xdotool: Option<String>,
    pub xrandr: Option<String>,
    pub grim: Option<String>,
    pub slurp: Option<String>,
    pub wf_recorder: Option<String>,
    pub spectacle: Option<String>,
    pub gnome_screenshot: Option<String>,
    pub ffmpeg: Option<String>,
    pub ffprobe: Option<String>,
    pub tesseract: Option<String>,
    pub xclip: Option<String>,
    pub wl_copy: Option<String>,
    pub zenity: Option<String>,
    pub kdialog: Option<String>,
    pub pactl: Option<String>,
    pub kill: Option<String>,
    /// Reads the session's clicks for the steps recorder (X11).
    pub xinput: Option<String>,
    /// The app's window inside a frame, for the step's app name (X11).
    pub xwininfo: Option<String>,
    /// The screens of sway or Hyprland (wlroots has no common way to list them).
    pub swaymsg: Option<String>,
    pub hyprctl: Option<String>,
    /// What this ffmpeg was built with (`ffmpeg -encoders` / `-devices`).
    pub encoder: Option<&'static str>,
    pub x11grab: bool,
    pub pulse: bool,
    /// gst-launch-1.0, set only when it has every element of the portal's
    /// picture reader (portal_plan.rs; looked for on GNOME and KDE on Wayland).
    pub gst_launch: Option<String>,
}

/// The tool that takes pictures on this desktop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shooter {
    Maim,
    Import,
    Grim,
    Spectacle,
    GnomeShot,
}

/// The tool that records the screen on this desktop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recorder {
    /// ffmpeg's x11grab.
    Ffmpeg,
    /// wf-recorder (wlroots).
    Wf,
    /// GNOME and KDE on Wayland: the desktop's ScreenCast portal, recorded by
    /// gst-launch (portal.rs).
    Portal,
}

impl Kit {
    pub fn shooter(&self, desk: Desk) -> Option<Shooter> {
        match desk {
            Desk::X11 if self.maim.is_some() => Some(Shooter::Maim),
            Desk::X11 if self.import.is_some() => Some(Shooter::Import),
            Desk::Wlroots if self.grim.is_some() => Some(Shooter::Grim),
            Desk::Kde if self.spectacle.is_some() => Some(Shooter::Spectacle),
            Desk::Gnome if self.gnome_screenshot.is_some() => Some(Shooter::GnomeShot),
            _ => None,
        }
    }

    /// Who records here (on X11 xrandr, or xdotool for the whole screen, gives the area to record). GNOME and KDE on
    /// Wayland share the screen only through their portal, so there GStreamer records what it hands over.
    pub fn recorder(&self, desk: Desk) -> Option<Recorder> {
        match desk {
            Desk::X11
                if self.ffmpeg.is_some()
                    && self.x11grab
                    && self.encoder.is_some()
                    && (self.xrandr.is_some() || self.xdotool.is_some()) =>
            {
                Some(Recorder::Ffmpeg)
            }
            Desk::Wlroots if self.wf_recorder.is_some() && self.kill.is_some() => {
                Some(Recorder::Wf)
            }
            // gst-launch reads the portal's stream, ffmpeg encodes it.
            Desk::Gnome | Desk::Kde
                if self.gst_launch.is_some()
                    && self.ffmpeg.is_some()
                    && self.encoder.is_some()
                    && self.kill.is_some() =>
            {
                Some(Recorder::Portal)
            }
            _ => None,
        }
    }

    pub fn clipboard(&self, desk: Desk) -> Option<&str> {
        match desk {
            Desk::X11 => self.xclip.as_deref(),
            Desk::None => None,
            _ => self.wl_copy.as_deref(),
        }
    }

    /// Whether an area can be picked (and a window, where the tool can).
    fn picks_area(&self, desk: Desk) -> bool {
        match self.shooter(desk) {
            Some(Shooter::Grim) => self.slurp.is_some(),
            Some(_) => true,
            None => false,
        }
    }

    /// Whether a colour can be picked: a click read back as one pixel.
    pub fn picks_colour(&self, desk: Desk) -> bool {
        match desk {
            Desk::X11 => {
                self.xdotool.is_some()
                    && (self.import.is_some() || (self.ffmpeg.is_some() && self.x11grab))
            }
            Desk::Wlroots => self.slurp.is_some() && self.grim.is_some(),
            _ => false,
        }
    }

    /// Whether clicks can become steps: X11 only (xinput reads the session's
    /// presses, xdotool where they landed), pictures by maim or import, the
    /// ring and the JPEG through ffmpeg.
    pub fn records_steps(&self, desk: Desk) -> bool {
        desk == Desk::X11
            && self.xinput.is_some()
            && self.xdotool.is_some()
            && self.ffmpeg.is_some()
            && matches!(self.shooter(desk), Some(Shooter::Maim | Shooter::Import))
    }

    fn picks_window(&self, desk: Desk) -> bool {
        match self.shooter(desk) {
            Some(Shooter::Maim | Shooter::Import) => self.xdotool.is_some(),
            Some(Shooter::Spectacle | Shooter::GnomeShot) => true,
            _ => false,
        }
    }

    /// The capture-host feature names this desktop and these tools can serve.
    pub fn features(&self, desk: Desk) -> Vec<&'static str> {
        let mut f = Vec::new();
        let shoots = self.shooter(desk).is_some();
        if shoots {
            f.push("screenshot");
        }
        if self.picks_area(desk) {
            f.push("region");
        }
        if self.picks_window(desk) {
            f.push("window");
        }
        if let Some(r) = self.recorder(desk) {
            f.extend(["record", "tuning"]);
            // A portal recording has no timelapse and no ring (one stream, one file).
            if r != Recorder::Portal {
                f.push("lapse");
                // The ring is cut and joined by ffmpeg (wf-recorder streams into it).
                if self.ffmpeg.is_some() {
                    f.push("replay");
                }
            }
            match r {
                // Both take the sound through ffmpeg's pulse device.
                Recorder::Ffmpeg | Recorder::Portal if self.pulse => {
                    f.push("mic");
                    if self.pactl.is_some() {
                        f.push("sound");
                    }
                }
                Recorder::Wf => f.push("mic"),
                Recorder::Ffmpeg | Recorder::Portal => {}
            }
        }
        if shoots && self.tesseract.is_some() {
            f.push("ocr");
        }
        if self.picks_colour(desk) {
            f.push("inspect");
        }
        if self.picks_area(desk) {
            f.push("measure");
        }
        if self.ffmpeg.is_some() && self.ffprobe.is_some() {
            f.extend(["thumb", "trim", "speech"]);
            if self.encoder.is_some() {
                f.push("export");
            }
            if self.tesseract.is_some() {
                f.push("cover");
            }
        }
        if self.records_steps(desk) {
            f.push("steps");
        }
        if self.clipboard(desk).is_some() {
            f.push("copy_files");
        }
        if desk != Desk::None && (self.zenity.is_some() || self.kdialog.is_some()) {
            f.push("pick_folder");
        }
        f
    }
}

/// A monitor as `xrandr --listmonitors` lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct Monitor {
    pub index: usize,
    pub name: String,
    pub primary: bool,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// ` 0: +*DP-1 2560/597x1440/336+0+0  DP-1` lines; anything else is skipped.
pub fn parse_xrandr(out: &str) -> Vec<Monitor> {
    out.lines()
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            parts.next()?.strip_suffix(':')?.parse::<usize>().ok()?;
            let flags = parts.next()?;
            let (w, h, x, y) = parse_geometry(parts.next()?)?;
            let name: String = flags
                .trim_start_matches(['+', '*'])
                .chars()
                .take(64)
                .collect();
            Some((name, flags.contains('*'), w, h, x, y))
        })
        .enumerate()
        .map(|(index, (name, primary, width, height, x, y))| Monitor {
            index,
            name,
            primary,
            x,
            y,
            width,
            height,
        })
        .collect()
}

/// `2560/597x1440/336+0+0` (the /mm parts optional): width, height, x, y.
fn parse_geometry(g: &str) -> Option<(i64, i64, i64, i64)> {
    let (w, rest) = g.split_once('x')?;
    let w = w.split('/').next()?.parse::<i64>().ok()?;
    let at = rest.find(['+', '-'])?;
    let h = rest[..at].split('/').next()?.parse::<i64>().ok()?;
    let offsets = signed_numbers(&rest[at..]);
    let (&x, &y) = (offsets.first()?, offsets.get(1)?);
    (w > 0 && h > 0).then_some((w, h, x, y))
}

/// `+0+0`, `-1920+0`, `+-1920+0` as numbers.
fn signed_numbers(s: &str) -> Vec<i64> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in s.chars() {
        match c {
            '+' | '-' if !cur.is_empty() && cur != "-" => {
                out.extend(cur.parse::<i64>().ok());
                cur.clear();
                if c == '-' {
                    cur.push('-');
                }
            }
            '+' => {}
            '-' => cur = "-".into(),
            d if d.is_ascii_digit() => cur.push(d),
            _ => break,
        }
    }
    out.extend(cur.parse::<i64>().ok());
    out
}

pub fn monitor_at(list: &[Monitor], point: Option<(i64, i64)>) -> Option<&Monitor> {
    let by_point = point.and_then(|(px, py)| {
        list.iter()
            .find(|m| px >= m.x && py >= m.y && px < m.x + m.width && py < m.y + m.height)
    });
    by_point
        .or_else(|| list.iter().find(|m| m.primary))
        .or(list.first())
}

/// `xdotool getdisplaygeometry` ("3200 1080"): the whole X screen as one
/// monitor, for a desktop without xrandr.
pub fn parse_display_geometry(out: &str) -> Option<Monitor> {
    let mut it = out.split_whitespace().map(|n| n.parse::<i64>().ok());
    let (Some(Some(width)), Some(Some(height))) = (it.next(), it.next()) else {
        return None;
    };
    (width > 0 && height > 0).then(|| Monitor {
        index: 0,
        name: "screen".into(),
        primary: true,
        x: 0,
        y: 0,
        width,
        height,
    })
}

/// `swaymsg -t get_outputs -r` (sway) or `hyprctl -j monitors` (Hyprland):
/// the screens in desktop coordinates, the focused one first in line. grim
/// and wf-recorder take areas in those (scaled) coordinates.
pub fn parse_wl_outputs(json: &str) -> Vec<Monitor> {
    let Ok(serde_json::Value::Array(list)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let int = |v: &serde_json::Value, k: &str| v.get(k).and_then(serde_json::Value::as_i64);
    let mut out = Vec::new();
    for o in &list {
        let on = o.get("active").and_then(serde_json::Value::as_bool) != Some(false)
            && o.get("disabled").and_then(serde_json::Value::as_bool) != Some(true);
        let name = o
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        // sway nests the area in `rect`; Hyprland gives pixels and a scale.
        let area = match o.get("rect") {
            Some(r) => (int(r, "x"), int(r, "y"), int(r, "width"), int(r, "height")),
            None => {
                let scale = o
                    .get("scale")
                    .and_then(serde_json::Value::as_f64)
                    .filter(|s| *s > 0.0)
                    .unwrap_or(1.0);
                let logical = |k| int(o, k).map(|n| (n as f64 / scale).round() as i64);
                (
                    int(o, "x"),
                    int(o, "y"),
                    logical("width"),
                    logical("height"),
                )
            }
        };
        let (Some(x), Some(y), Some(width), Some(height)) = area else {
            continue;
        };
        if !on || name.is_empty() || width <= 0 || height <= 0 {
            continue;
        }
        out.push(Monitor {
            index: out.len(),
            name: name.chars().take(64).collect(),
            primary: o.get("focused").and_then(serde_json::Value::as_bool) == Some(true),
            x,
            y,
            width,
            height,
        });
    }
    out
}

/// `rect` cut to the X screen (every monitor together, from 0,0): x11grab
/// refuses an area that runs past it, and a window can. None when nothing is left.
pub fn clip_to_screen(
    rect: (i64, i64, i64, i64),
    list: &[Monitor],
) -> Option<(i64, i64, i64, i64)> {
    let (x, y, w, h) = rect;
    let right = list.iter().map(|m| m.x + m.width).max().unwrap_or(x + w);
    let bottom = list.iter().map(|m| m.y + m.height).max().unwrap_or(y + h);
    let (left, top) = (x.max(0), y.max(0));
    let (width, height) = ((x + w).min(right) - left, (y + h).min(bottom) - top);
    (width > 1 && height > 1).then_some((left, top, width, height))
}

/// The window in front, as xdotool reports it (X11 only).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Front {
    pub id: u64,
    pub exe: String,
    pub rect: Option<(i64, i64, i64, i64)>,
}

impl Front {
    pub fn centre(&self) -> Option<(i64, i64)> {
        self.rect.map(|(x, y, w, h)| (x + w / 2, y + h / 2))
    }
}

/// `xdotool getwindowgeometry --shell` output: x, y, width, height.
pub fn parse_xdotool_geometry(out: &str) -> Option<(i64, i64, i64, i64)> {
    let read = |key: &str| {
        out.lines()
            .find_map(|l| l.trim().strip_prefix(key)?.parse::<i64>().ok())
    };
    let (w, h) = (read("WIDTH=")?, read("HEIGHT=")?);
    (w > 0 && h > 0).then_some((read("X=")?, read("Y=")?, w, h))
}

/// What one picture or recording is aimed at.
#[derive(Debug, Clone, PartialEq)]
pub enum Aim {
    /// One monitor's rectangle; None = the whole desktop (or the monitor
    /// under the pointer, for the tools that cannot be told which).
    Screen(Option<(i64, i64, i64, i64)>),
    /// An X11 window id; 0 = the window in front, for the tools that find it.
    Window(u64),
    /// The user picks an area (or a window, with a click) on screen.
    Pick,
}

/// The argv of one picture to `out` (PNG). `area` is slurp's answer for grim.
pub fn shot_args(
    shooter: Shooter,
    aim: &Aim,
    cursor: bool,
    out: &str,
    area: Option<&str>,
) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    match shooter {
        Shooter::Maim => {
            a.extend(["-f".into(), "png".into()]);
            if !cursor {
                a.push("-u".into());
            }
            match aim {
                Aim::Screen(Some(r)) => a.extend(["-g".into(), x_geometry(*r)]),
                Aim::Screen(None) => {}
                Aim::Window(id) => a.extend(["-i".into(), id.to_string()]),
                Aim::Pick => a.push("-s".into()),
            }
        }
        Shooter::Import => match aim {
            Aim::Screen(r) => {
                a.extend(["-window".into(), "root".into()]);
                if let Some(r) = r {
                    a.extend(["-crop".into(), x_geometry(*r), "+repage".into()]);
                }
            }
            Aim::Window(id) => a.extend(["-window".into(), id.to_string()]),
            Aim::Pick => {}
        },
        Shooter::Grim => {
            if cursor {
                a.push("-c".into());
            }
            if let Some(g) = area {
                a.extend(["-g".into(), g.into()]);
            } else if let Aim::Screen(Some(r)) = aim {
                a.extend(["-g".into(), wl_geometry(*r)]);
            }
        }
        Shooter::Spectacle => {
            a.extend(["-b".into(), "-n".into()]);
            if cursor {
                a.push("-p".into());
            }
            a.push(
                match aim {
                    Aim::Screen(_) => "-m",
                    Aim::Window(_) => "-a",
                    Aim::Pick => "-r",
                }
                .into(),
            );
            a.push("-o".into());
        }
        Shooter::GnomeShot => {
            if cursor {
                a.push("-p".into());
            }
            match aim {
                Aim::Screen(_) => {}
                Aim::Window(_) => a.push("-w".into()),
                Aim::Pick => a.push("-a".into()),
            }
            a.push("-f".into());
        }
    }
    a.push(out.into());
    a
}

fn x_geometry((x, y, w, h): (i64, i64, i64, i64)) -> String {
    format!("{w}x{h}+{x}+{y}")
}

fn wl_geometry((x, y, w, h): (i64, i64, i64, i64)) -> String {
    format!("{x},{y} {w}x{h}")
}

/// slurp's answer (`x,y wxh`) when it is one; anything else is a cancel.
pub fn parse_slurp(out: &str) -> Option<String> {
    let g = out.trim();
    let (pos, size) = g.split_once(' ')?;
    let (x, y) = pos.split_once(',')?;
    let (w, h) = size.split_once('x')?;
    let ok = [x, y].iter().all(|n| n.parse::<i64>().is_ok())
        && [w, h].iter().all(|n| n.parse::<u32>().is_ok_and(|v| v > 0));
    ok.then(|| g.to_owned())
}

/// The audio a recording takes, as the engine answers it.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Sound {
    /// The default output's monitor source, for the computer's own sound.
    pub monitor: Option<String>,
    pub mic: bool,
}

/// What a recording is asked for, the same numbers as on Windows (video.rs):
/// frames per second, the height to bring it down to (0 = the source's), the
/// detail kept, and for a timelapse the seconds between pictures.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tuning {
    pub fps: u32,
    pub height: u32,
    pub quality: Quality,
    pub every: Option<u32>,
}

impl Tuning {
    /// From the request's `fps`, `height`, `quality` and `every`. A timelapse
    /// plays at video::LAPSE_FPS whatever was asked.
    pub fn parse(fps: Option<u64>, height: Option<u64>, quality: Option<&str>, every: Option<u64>) -> Tuning {
        let every = video::lapse_every(every);
        Tuning {
            fps: if every.is_some() { video::LAPSE_FPS } else { video::fps(fps) },
            height: video::height_cap(height),
            quality: Quality::parse(quality),
            every,
        }
    }

    /// The encoded size of a `w` x `h` source.
    pub fn size(&self, w: i64, h: i64) -> (u32, u32) {
        video::encode_size(w.max(2) as u32, h.max(2) as u32, self.height)
    }

    /// libx264's constant quality for each level (lower is sharper).
    pub fn crf(&self) -> u32 {
        match self.quality {
            Quality::Small => 28,
            Quality::Normal => 23,
            Quality::High => 18,
        }
    }

    /// The filters after the even crop: the scale to `size` when it differs
    /// from the source, and a timelapse's clock (picture N shown at N/30 s).
    fn filters(&self, size: Option<((i64, i64), (u32, u32))>) -> Vec<String> {
        let mut f = Vec::new();
        match size {
            Some(((w, h), (ew, eh))) if (ew as i64, eh as i64) != (w - w % 2, h - h % 2) => {
                f.push(format!("scale={ew}:{eh}"));
            }
            None if self.height > 0 => f.push(format!("scale=-2:'min(ih,{})'", self.height)),
            _ => {}
        }
        if self.every.is_some() {
            f.push(format!("settb=1/{},setpts=N", video::LAPSE_FPS));
        }
        f
    }
}

/// ffmpeg's argv for an x11grab recording of `rect` on `display` to `out`
/// (fragmented MP4, so a crash still leaves a file that plays), until it gets
/// `q` on its input.
pub fn ffmpeg_record_args(
    display: &str,
    rect: (i64, i64, i64, i64),
    tuning: &Tuning,
    encoder: &str,
    sound: &Sound,
    out: &str,
) -> Vec<String> {
    let (x, y, w, h) = rect;
    // A timelapse grabs one picture every N seconds; x11grab takes the rate as a fraction.
    let rate = match tuning.every {
        Some(s) => format!("1/{s}"),
        None => tuning.fps.to_string(),
    };
    let input = [
        "-f".into(),
        "x11grab".into(),
        "-framerate".into(),
        rate,
        "-video_size".into(),
        format!("{w}x{h}"),
        "-i".into(),
        format!("{display}+{x},{y}"),
    ];
    encode_args(input, (w, h), tuning, encoder, sound, out)
}

/// ffmpeg's argv for the portal's pictures: I420 of `size` on its standard
/// input at the asked rate (portal_plan.rs), until it is interrupted. When
/// the stream ends (the user stops sharing) the file ends with it.
pub fn ffmpeg_pipe_args(size: (u32, u32), tuning: &Tuning, encoder: &str, sound: &Sound, out: &str) -> Vec<String> {
    let (w, h) = (size.0 as i64, size.1 as i64);
    let input = [
        "-thread_queue_size".into(),
        "512".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-video_size".into(),
        format!("{w}x{h}"),
        "-framerate".into(),
        tuning.fps.max(1).to_string(),
        "-i".into(),
        "pipe:0".into(),
    ];
    let mut a = encode_args(input, (w, h), tuning, encoder, sound, out);
    // The sound sources never end by themselves.
    let at = a.len() - 1;
    a.insert(at, "-shortest".into());
    a
}

/// What follows the video input: the sound inputs, the filters, the encoders
/// and the fragmented MP4 at `out` (last). `(w, h)` is the input's size.
fn encode_args<const N: usize>(
    input: [String; N],
    (w, h): (i64, i64),
    tuning: &Tuning,
    encoder: &str,
    sound: &Sound,
    out: &str,
) -> Vec<String> {
    let mut a: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-y".into()];
    a.extend(input);
    let mut inputs = 0;
    // A timelapse is silent: sound at 30x or 1800x speed is noise.
    let silent = Sound::default();
    let sound = if tuning.every.is_some() { &silent } else { sound };
    for source in sound
        .monitor
        .iter()
        .map(String::as_str)
        .chain(sound.mic.then_some("default"))
    {
        a.extend([
            "-thread_queue_size".into(),
            "1024".into(),
            "-f".into(),
            "pulse".into(),
        ]);
        a.extend(["-i".into(), source.into()]);
        inputs += 1;
    }
    // yuv420p needs an even size; a window can be any size.
    let size = tuning.size(w, h);
    let mut chain = vec!["crop=trunc(iw/2)*2:trunc(ih/2)*2".to_owned()];
    chain.extend(tuning.filters(Some(((w, h), size))));
    // x11grab's pictures last N seconds each: without this the encoder repeats
    // every one of them for N seconds of video (wf-recorder needs no such step).
    if tuning.every.is_some() {
        chain.push(format!("fps={}", video::LAPSE_FPS));
    }
    let mut graph = format!("[0:v]{}[v]", chain.join(","));
    if inputs == 2 {
        graph.push_str(";[1:a][2:a]amix=inputs=2:duration=longest[a]");
    }
    a.extend(["-filter_complex".into(), graph, "-map".into(), "[v]".into()]);
    match inputs {
        2 => a.extend(["-map".into(), "[a]".into()]),
        1 => a.extend(["-map".into(), "1:a".into()]),
        _ => {}
    }
    a.extend(["-c:v".into(), encoder.into()]);
    if encoder == "libx264" {
        a.extend([
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            tuning.crf().to_string(),
        ]);
    } else {
        let bits = video::bitrate(size.0, size.1, tuning.fps, tuning.quality);
        a.extend(["-b:v".into(), bits.to_string()]);
    }
    if tuning.every.is_some() {
        a.extend(["-r".into(), video::LAPSE_FPS.to_string()]);
    }
    a.extend(["-pix_fmt".into(), "yuv420p".into()]);
    if inputs > 0 {
        a.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "160k".into()]);
    }
    a.extend([
        "-movflags".into(),
        "+frag_keyframe+empty_moov+default_base_moof".into(),
        "-f".into(),
        "mp4".into(),
        out.into(),
    ]);
    a
}

/// wf-recorder's argv: one audio source at most (it cannot mix two), none in
/// a timelapse. Its frames come when the screen changes, so a recording asks
/// for a constant rate and a timelapse keeps one picture every N seconds.
pub fn wf_record_args(
    rect: Option<(i64, i64, i64, i64)>,
    audio: Option<&str>,
    tuning: &Tuning,
    out: &str,
) -> Vec<String> {
    let mut a: Vec<String> = vec!["-y".into(), "-f".into(), out.into()];
    if let Some(r) = rect {
        a.extend(["-g".into(), wl_geometry(r)]);
    }
    a.extend([
        "-c".into(),
        "libx264".into(),
        "-p".into(),
        "preset=veryfast".into(),
        "-p".into(),
        format!("crf={}", tuning.crf()),
    ]);
    let mut filters = Vec::new();
    match tuning.every {
        Some(s) => filters.push(format!("fps=1/{s}")),
        None => a.extend(["-r".into(), tuning.fps.to_string()]),
    }
    filters.extend(tuning.filters(rect.map(|(_, _, w, h)| ((w, h), tuning.size(w, h)))));
    if !filters.is_empty() {
        a.extend(["-F".into(), filters.join(",")]);
    }
    let audio = audio.filter(|_| tuning.every.is_none());
    if let Some(source) = audio {
        a.push(if source == "default" {
            "-a".to_owned()
        } else {
            format!("--audio={source}")
        });
    }
    a
}

/// `pactl info` (in the C locale): the default output's monitor source.
pub fn parse_default_sink_monitor(out: &str) -> Option<String> {
    let sink = out
        .lines()
        .find_map(|l| l.trim().strip_prefix("Default Sink:"))?
        .trim();
    let ok = !sink.is_empty() && sink.chars().all(|c| c.is_ascii_graphic());
    ok.then(|| format!("{sink}.monitor"))
}

/// The H.264 encoder an `ffmpeg -encoders` listing offers, best first.
pub fn pick_encoder(encoders: &str) -> Option<&'static str> {
    let has = |name: &str| {
        encoders
            .lines()
            .any(|l| l.split_whitespace().nth(1) == Some(name))
    };
    ["libx264", "libopenh264"].into_iter().find(|e| has(e))
}

/// Whether an `ffmpeg -devices` listing has `name` (x11grab, pulse).
pub fn has_device(devices: &str, name: &str) -> bool {
    devices
        .lines()
        .any(|l| l.split_whitespace().nth(1) == Some(name))
}

/// ffmpeg's argv for a JPEG preview `width` wide of a picture or a video.
pub fn thumb_args(src: &str, width: u32, video: bool, out: &str) -> Vec<String> {
    let scale = format!("scale='min({width},iw)':-2");
    let filter = if video {
        format!("thumbnail=60,{scale}")
    } else {
        scale
    };
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-i".into(),
        src.into(),
        "-vf".into(),
        filter,
        "-frames:v".into(),
        "1".into(),
        "-f".into(),
        "image2".into(),
        "-c:v".into(),
        "mjpeg".into(),
        "-q:v".into(),
        "4".into(),
        out.into(),
    ]
}

/// ffprobe's argv for the first video stream's size.
pub fn probe_size_args(src: &str) -> Vec<String> {
    [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0:s=x",
        src,
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect()
}

/// `1920x1080` as ffprobe writes it.
pub fn parse_size(out: &str) -> Option<(u32, u32)> {
    let (w, h) = out.lines().next()?.trim().split_once('x')?;
    let (w, h) = (w.parse::<u32>().ok()?, h.parse::<u32>().ok()?);
    (w > 0 && h > 0).then_some((w, h))
}

/// ffmpeg's argv for a copy of `seconds` from `start`, streams as stored (the
/// cut starts on the keyframe before `start`, as on Windows).
pub fn trim_args(src: &str, out: &str, start: f64, seconds: f64) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-ss".into(),
        format!("{start:.3}"),
        "-i".into(),
        src.into(),
        "-t".into(),
        format!("{seconds:.3}"),
        "-map".into(),
        "0".into(),
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-f".into(),
        "mp4".into(),
        out.into(),
    ]
}

/// ffmpeg's argv for the sound as a 16 kHz mono WAV with a plain 44-byte header.
pub fn speech_args(src: &str, out: &str) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-i".into(),
        src.into(),
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        crate::speech::RATE.to_string(),
        "-c:a".into(),
        "pcm_s16le".into(),
        "-bitexact".into(),
        "-map_metadata".into(),
        "-1".into(),
        "-f".into(),
        "wav".into(),
        out.into(),
    ]
}

pub fn wav_seconds(bytes: u64) -> f64 {
    let data = bytes.saturating_sub(crate::speech::HEADER_LEN as u64);
    data as f64 / (crate::speech::RATE as f64 * 2.0)
}

/// A PNG's size from its header; None when it is not a PNG.
pub fn png_size(head: &[u8]) -> Option<(u32, u32)> {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if head.len() < 24 || head[..8] != SIG || &head[12..16] != b"IHDR" {
        return None;
    }
    let be = |b: &[u8]| u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
    Some((be(&head[16..20]), be(&head[20..24])))
}

/// The locale's tesseract language plus English, among those installed
/// (`tesseract --list-langs`); None when none is.
pub fn ocr_langs(listing: &str, locale: &str) -> Option<String> {
    let have: Vec<&str> = listing
        .lines()
        .skip_while(|l| !l.starts_with("List of available languages"))
        .skip(1)
        .map(str::trim)
        .filter(|l| !l.is_empty() && *l != "osd")
        .collect();
    let lang = locale.split(['_', '.', '-']).next().unwrap_or("");
    const CODES: &[(&str, &str)] = &[
        ("it", "ita"),
        ("de", "deu"),
        ("fr", "fra"),
        ("es", "spa"),
        ("pt", "por"),
        ("nl", "nld"),
        ("pl", "pol"),
        ("ru", "rus"),
        ("ja", "jpn"),
        ("ko", "kor"),
        ("zh", "chi_sim"),
        ("tr", "tur"),
        ("sv", "swe"),
        ("cs", "ces"),
        ("uk", "ukr"),
    ];
    let mine = CODES.iter().find(|(l, _)| *l == lang).map(|(_, c)| *c);
    let mut pick: Vec<&str> = mine
        .into_iter()
        .chain(["eng"])
        .filter(|c| have.contains(c))
        .collect();
    if pick.is_empty() {
        pick.extend(have.first());
    }
    (!pick.is_empty()).then(|| pick.join("+"))
}

/// tesseract's text as lines, blank ones dropped.
pub fn ocr_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The argv of the folder dialog: zenity, or kdialog on KDE.
pub fn folder_args(zenity: bool, title: &str, start: &str) -> Vec<String> {
    let start = if start.starts_with('/') { start } else { "" };
    if zenity {
        let mut a = vec![
            "--file-selection".to_owned(),
            "--directory".to_owned(),
            format!("--title={title}"),
        ];
        if !start.is_empty() {
            a.push(format!("--filename={}/", start.trim_end_matches('/')));
        }
        a
    } else {
        let mut a = vec!["--getexistingdirectory".to_owned()];
        a.push(if start.is_empty() {
            "~".to_owned()
        } else {
            start.to_owned()
        });
        a.extend(["--title".to_owned(), title.to_owned()]);
        a
    }
}

/// A file list as `text/uri-list` (RFC 2483), each path percent-encoded.
pub fn uri_list(paths: &[String]) -> String {
    let mut out = String::new();
    for p in paths {
        out.push_str("file://");
        for b in p.bytes() {
            if b.is_ascii_alphanumeric() || b"/-_.~".contains(&b) {
                out.push(b as char);
            } else {
                out.push_str(&format!("%{b:02X}"));
            }
        }
        out.push_str("\r\n");
    }
    out
}

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
