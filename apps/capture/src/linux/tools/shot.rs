// Linux: the command line of a screenshot, and reading a picked region.

use super::kit::Shooter;

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

pub(super) fn wl_geometry((x, y, w, h): (i64, i64, i64, i64)) -> String {
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
