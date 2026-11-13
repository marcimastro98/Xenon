// Linux: reading the screens and the window in front from what the tools print.

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
pub(super) fn parse_geometry(g: &str) -> Option<(i64, i64, i64, i64)> {
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
