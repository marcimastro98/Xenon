// Linux: the screens, the window in front, and a screenshot from the target to the saved file.

use serde_json::Value;
use crate::proto::Fail;
use super::{Backend, PICK_DEADLINE, Plan, Rect, run, Shot, SHOT_DEADLINE, TOOL_DEADLINE, tools};
use super::tools::{Aim, Desk, Front, Monitor, Shooter};

impl Backend {
    /// The monitors, where the session can list them: X11 (without xrandr the
    /// whole screen counts as one), sway and Hyprland.
    pub(super) fn monitor_list(&self) -> Vec<Monitor> {
        let ask = |program: &Option<String>, args: &[&str]| {
            let args: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
            run::run(program.as_deref()?, &args, None, TOOL_DEADLINE)
                .filter(|o| o.ok)
                .map(|o| o.stdout)
        };
        match self.desk {
            Desk::X11 if self.kit.xrandr.is_some() => ask(&self.kit.xrandr, &["--listmonitors"])
                .map(|out| tools::parse_xrandr(&out))
                .unwrap_or_default(),
            Desk::X11 => ask(&self.kit.xdotool, &["getdisplaygeometry"])
                .and_then(|out| tools::parse_display_geometry(&out))
                .into_iter()
                .collect(),
            Desk::Wlroots => ask(&self.kit.swaymsg, &["-t", "get_outputs", "-r"])
                .or_else(|| ask(&self.kit.hyprctl, &["-j", "monitors"]))
                .map(|out| tools::parse_wl_outputs(&out))
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    /// The window in front (X11, through xdotool); its title is never read.
    pub(super) fn front(&self) -> Front {
        let Some(xdotool) = self
            .kit
            .xdotool
            .as_deref()
            .filter(|_| self.desk == Desk::X11)
        else {
            return Front::default();
        };
        let ask = |args: &[&str]| {
            let args: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
            run::run(xdotool, &args, None, TOOL_DEADLINE)
                .filter(|o| o.ok)
                .map(|o| o.stdout.trim().to_owned())
        };
        let Some(id) = ask(&["getactivewindow"]).and_then(|s| s.parse::<u64>().ok()) else {
            return Front::default();
        };
        let id_s = id.to_string();
        let rect = ask(&["getwindowgeometry", "--shell", &id_s])
            .and_then(|g| tools::parse_xdotool_geometry(&g));
        let exe = ask(&["getwindowpid", &id_s])
            .and_then(|pid| pid.parse::<u32>().ok())
            .and_then(|pid| std::fs::read_to_string(format!("/proc/{pid}/comm")).ok())
            .map(|c| c.trim().chars().take(64).collect())
            .unwrap_or_default();
        Front { id, exe, rect }
    }

    /// The monitor asked for, or the one the window in front is on.
    fn pick_monitor<'a>(
        list: &'a [Monitor],
        req: &Value,
        front: &Front,
    ) -> Result<&'a Monitor, Fail> {
        match req.get("monitor").and_then(Value::as_u64) {
            Some(i) => list.iter().find(|m| m.index as u64 == i),
            None => tools::monitor_at(list, front.centre()),
        }
        .ok_or(Fail::code("no_monitor"))
    }

    pub(super) fn record_rect(
        &self,
        req: &Value,
        target: &str,
        front: &Front,
    ) -> Result<(Rect, Option<usize>), Fail> {
        let list = self.monitor_list();
        match target {
            "window" => {
                let rect = front
                    .rect
                    .and_then(|r| tools::clip_to_screen(r, &list))
                    .ok_or(Fail::code("no_window"))?;
                Ok((
                    rect,
                    tools::monitor_at(&list, front.centre()).map(|m| m.index),
                ))
            }
            "screen" => {
                let m = Self::pick_monitor(&list, req, front)?;
                Ok(((m.x, m.y, m.width, m.height), Some(m.index)))
            }
            _ => Err(Fail::code("bad_request")),
        }
    }

    /// slurp's area (or, with `output`, a click on a screen); None when the
    /// user left it, or there is no slurp.
    pub(super) fn slurp(&self, output: bool) -> Option<String> {
        let slurp = self.kit.slurp.as_deref()?;
        let args: Vec<String> = if output {
            vec!["-o".into()]
        } else {
            Vec::new()
        };
        run::run(slurp, &args, None, PICK_DEADLINE)
            .filter(|o| o.ok)
            .and_then(|o| tools::parse_slurp(&o.stdout))
    }

    pub(super) fn sink_monitor(&self) -> Option<String> {
        if !self.kit.pulse && self.kit.wf_recorder.is_none() {
            return None;
        }
        let pactl = self.kit.pactl.as_deref()?;
        run::run(pactl, &["info".into()], None, TOOL_DEADLINE)
            .filter(|o| o.ok)
            .and_then(|o| tools::parse_default_sink_monitor(&o.stdout))
    }

    /// The aim of one picture, its monitor and how long it may take; None when
    /// the user left the area picker.
    fn plan(&self, req: &Value, front: &Front) -> Result<Option<Plan>, Fail> {
        let shooter = self.kit.shooter(self.desk);
        let target = req
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or("screen");
        let plan = |aim, monitor, area, deadline| Plan {
            aim,
            monitor,
            area,
            deadline,
        };
        Ok(Some(match (target, shooter) {
            ("window", Some(Shooter::Maim | Shooter::Import)) if front.id != 0 => {
                let list = self.monitor_list();
                let m = tools::monitor_at(&list, front.centre()).map(|m| m.index);
                plan(Aim::Window(front.id), m, None, SHOT_DEADLINE)
            }
            ("window", Some(Shooter::Spectacle | Shooter::GnomeShot)) => {
                plan(Aim::Window(0), None, None, SHOT_DEADLINE)
            }
            ("window", _) => return Err(Fail::code("no_window")),
            ("screen", _) => {
                let list = self.monitor_list();
                if list.is_empty() {
                    plan(Aim::Screen(None), None, None, SHOT_DEADLINE)
                } else {
                    let m = Self::pick_monitor(&list, req, front)?;
                    plan(
                        Aim::Screen(Some((m.x, m.y, m.width, m.height))),
                        Some(m.index),
                        None,
                        SHOT_DEADLINE,
                    )
                }
            }
            ("region", Some(Shooter::Grim)) => match self.slurp(false) {
                Some(area) => plan(Aim::Pick, None, Some(area), SHOT_DEADLINE),
                None => return Ok(None),
            },
            ("region", _) => plan(Aim::Pick, None, None, PICK_DEADLINE),
            _ => return Err(Fail::code("bad_request")),
        }))
    }

    /// One picture to `path` (through `path.part.png`, the tools pick the
    /// format by the name); None when the user left the area picker.
    pub(super) fn take(
        &self,
        req: &Value,
        front: &Front,
        cursor: bool,
        path: &str,
    ) -> Result<Option<Shot>, Fail> {
        let shooter = self
            .kit
            .shooter(self.desk)
            .ok_or(Fail::code("unsupported"))?;
        let program = match shooter {
            Shooter::Maim => self.kit.maim.clone(),
            Shooter::Import => self.kit.import.clone(),
            Shooter::Grim => self.kit.grim.clone(),
            Shooter::Spectacle => self.kit.spectacle.clone(),
            Shooter::GnomeShot => self.kit.gnome_screenshot.clone(),
        }
        .unwrap_or_default();
        let Some(Plan {
            aim,
            monitor,
            area,
            deadline,
        }) = self.plan(req, front)?
        else {
            return Ok(None);
        };
        let part = format!("{path}.part.png");
        let _ = std::fs::remove_file(&part);
        let ran = run::run(
            &program,
            &tools::shot_args(shooter, &aim, cursor, &part, area.as_deref()),
            None,
            deadline,
        );
        let head = std::fs::read(&part)
            .ok()
            .map(|b| b[..b.len().min(32)].to_vec());
        let Some((width, height)) = head.as_deref().and_then(tools::png_size) else {
            let _ = std::fs::remove_file(&part);
            // A picker closed with Esc writes nothing: a change of mind, not a failure.
            if aim == Aim::Pick && ran.is_some() {
                return Ok(None);
            }
            return Err(Fail::code("capture_failed"));
        };
        std::fs::rename(&part, path).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            Fail::new("write_failed", e)
        })?;
        Ok(Some(Shot {
            width,
            height,
            monitor,
        }))
    }

    pub(super) fn to_clipboard(&self, mime: &str, bytes: &[u8]) -> bool {
        let Some(tool) = self.kit.clipboard(self.desk) else {
            return false;
        };
        let args: Vec<String> = if self.desk == Desk::X11 {
            vec![
                "-selection".into(),
                "clipboard".into(),
                "-t".into(),
                mime.into(),
            ]
        } else {
            vec!["--type".into(), mime.into()]
        };
        run::run_quiet(tool, &args, Some(bytes), TOOL_DEADLINE)
    }

    pub(super) fn copy_image(&self, path: &str) -> bool {
        std::fs::read(path).is_ok_and(|bytes| self.to_clipboard("image/png", &bytes))
    }
}
