// Linux: which desktop this is, and which of the system's tools it has.

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
