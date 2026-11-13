// macOS: a screenshot of a screen, a window or a region, from the target to the saved file.

use serde_json::{json, Value};
use crate::proto::Fail;
use super::{kit_shot, PICK_DEADLINE, run, sck, SCRIPT_DEADLINE, scripts, Shot, SHOT_DEADLINE, tools};
use super::tools::{Aim, Monitor};

/// The encoded size and bitrate for something `points` big at `scale`
/// pixels per point, as the request's height and quality ask.
pub(super) fn tuned(req: &Value, points: (i64, i64), scale: f64, fps: u32) -> (u32, u32, u32) {
    let source = (
        (points.0 as f64 * scale).round().max(2.0) as u32,
        (points.1 as f64 * scale).round().max(2.0) as u32,
    );
    let cap = crate::video::height_cap(req.get("height").and_then(Value::as_u64));
    let (width, height) = crate::video::encode_size(source.0, source.1, cap);
    let quality = crate::video::Quality::parse(req.get("quality").and_then(Value::as_str));
    (width, height, crate::video::bitrate(width, height, fps, quality))
}

/// What a ScreenCaptureKit recording aims at.
pub(super) struct Aimed<'a> {
    pub(super) target: sck::Target,
    /// The monitor it is on.
    pub(super) monitor: Option<&'a Monitor>,
    /// Its size in points.
    pub(super) points: (i64, i64),
}

pub(super) fn kit_target<'a>(req: &Value, list: &'a [Monitor], front: &tools::Front) -> Result<Aimed<'a>, Fail> {
    match req.get("target").and_then(Value::as_str).unwrap_or("screen") {
        "window" => {
            let id = u32::try_from(front.id).ok().filter(|&i| i != 0);
            let id = id.ok_or(Fail::code("no_window"))?;
            let frame = sck::window_frame(id).ok_or(Fail::code("no_window"))?;
            let size = (frame.size.width.round() as i64, frame.size.height.round() as i64);
            Ok(Aimed {
                target: sck::Target::Window(id),
                monitor: tools::monitor_at(list, front.centre),
                points: size,
            })
        }
        "screen" => {
            let m = pick_monitor(list, req, front)?;
            if m.display == 0 {
                return Err(Fail::code("no_monitor"));
            }
            Ok(Aimed {
                target: sck::Target::Display(m.display),
                monitor: Some(m),
                points: (m.width, m.height),
            })
        }
        _ => Err(Fail::code("bad_request")),
    }
}

pub(super) fn monitors() -> Vec<Monitor> {
    run::jxa(scripts::MONITORS, &[], SCRIPT_DEADLINE)
        .filter(|o| o.ok)
        .map(|o| tools::parse_monitors(&o.stdout))
        .unwrap_or_default()
}

pub(super) fn front() -> tools::Front {
    run::jxa(scripts::FRONT_WINDOW, &[], SCRIPT_DEADLINE)
        .filter(|o| o.ok)
        .map(|o| tools::parse_front(&o.stdout))
        .unwrap_or_default()
}

/// The monitor asked for, or the one the window in front is on.
pub(super) fn pick_monitor<'a>(
    list: &'a [Monitor],
    req: &Value,
    front: &tools::Front,
) -> Result<&'a Monitor, Fail> {
    match req.get("monitor").and_then(Value::as_u64) {
        Some(i) => list.iter().find(|m| m.index as u64 == i),
        None => tools::monitor_at(list, front.centre),
    }
    .ok_or(Fail::code("no_monitor"))
}

/// One picture to `path` (through `path.part`); None when the user left the
/// area picker without picking.
pub(super) fn take(req: &Value, front: &tools::Front, cursor: bool, path: &str) -> Result<Option<Shot>, Fail> {
    let mut kit_display = None;
    let (aim, monitor, deadline) = match req
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or("screen")
    {
        "window" if front.id != 0 => {
            let list = monitors();
            let m = tools::monitor_at(&list, front.centre).map(|m| m.index);
            (Aim::Window(front.id), m, SHOT_DEADLINE)
        }
        "window" => return Err(Fail::code("no_window")),
        "screen" => {
            let list = monitors();
            let m = pick_monitor(&list, req, front)?;
            kit_display = Some(m.display).filter(|&d| d != 0);
            (Aim::Display(m.index), Some(m.index), SHOT_DEADLINE)
        }
        "region" => (Aim::Pick, None, PICK_DEADLINE),
        _ => return Err(Fail::code("bad_request")),
    };
    let part = format!("{path}.part");
    let _ = std::fs::remove_file(&part);
    let ran = if shot_by_kit(kit_display, cursor, &part) {
        None
    } else {
        run::run(run::SCREENCAPTURE, &tools::screenshot_args(&aim, cursor, &part), None, deadline)
    };
    let head = std::fs::read(&part)
        .ok()
        .map(|b| b[..b.len().min(32)].to_vec());
    let Some((width, height)) = head.as_deref().and_then(tools::png_size) else {
        let _ = std::fs::remove_file(&part);
        // The picker closed with Esc writes nothing: a change of mind, not a failure.
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

/// A whole display through ScreenCaptureKit where it can, so the widgets kept
/// out of captures stay out of the picture too (kit_shot.rs); false sends it
/// to screencapture.
fn shot_by_kit(display: Option<u32>, cursor: bool, part: &str) -> bool {
    match display.filter(|_| kit_shot::available()) {
        Some(d) => kit_shot::display(d, cursor, std::path::Path::new(part)).is_ok(),
        None => false,
    }
}

/// The ruler: an area picked with the screenshot's own picker (the space bar
/// picks a window), measured in pixels and deleted. Nothing is saved.
pub(super) fn measure() -> Result<Value, Fail> {
    let tmp = std::env::temp_dir().join(format!("xenon-ruler-{}.png", std::process::id()));
    let tmp = tmp.to_string_lossy().into_owned();
    let shot = take(&json!({ "target": "region" }), &tools::Front::default(), false, &tmp);
    let _ = std::fs::remove_file(&tmp);
    let Some(shot) = shot? else {
        return Ok(json!({ "cancelled": true }));
    };
    let (w, h) = (shot.width as i32, shot.height as i32);
    let text = crate::inspect::size_text(w, h);
    Ok(json!({ "width": w, "height": h, "text": text, "copied": copy_text(&text), "monitor": null }))
}

pub(super) fn copy_image(path: &str) -> bool {
    run::jxa(scripts::COPY_IMAGE, &[path.to_owned()], SCRIPT_DEADLINE)
        .is_some_and(|o| o.ok && o.stdout.trim() == "ok")
}

pub(super) fn copy_text(text: &str) -> bool {
    run::run(run::PBCOPY, &[], Some(text), SCRIPT_DEADLINE).is_some_and(|o| o.ok)
}
