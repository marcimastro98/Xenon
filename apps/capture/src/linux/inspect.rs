//! The colour picker and the ruler on Linux (as win/mod.rs `inspect`). The
//! colour: slurp's point and grim's pixel on wlroots; on X11 xdotool waits for
//! the click (it has no Esc: the picker's deadline is the way out) and import,
//! or ffmpeg's x11grab, reads that pixel. The ruler: an area picture taken with
//! the screenshot's own picker, measured and deleted. Nothing is saved.

use serde_json::{json, Value};

use super::inspect_plan as plan;
use super::run;
use super::tools::{Desk, Front};
use super::{Backend, PICK_DEADLINE, SHOT_DEADLINE, TOOL_DEADLINE};
use crate::inspect::{self, Format};
use crate::proto::Fail;

/// Where the user clicked, then that pixel read from a one-pixel picture.
enum Picked {
    Colour([u8; 3]),
    Cancelled,
}

fn temp(tag: &str) -> String {
    let file = format!("xenon-{tag}-{}.tmp", std::process::id());
    std::env::temp_dir().join(file).to_string_lossy().into_owned()
}

/// The first pixel of what `program args` wrote to `out`, then `out` deleted.
fn read_pixel(program: &str, args: &[String], out: &str) -> Option<[u8; 3]> {
    let ran = run::run(program, args, None, SHOT_DEADLINE).is_some_and(|o| o.ok);
    let bytes = std::fs::read(out).ok();
    let _ = std::fs::remove_file(out);
    bytes.filter(|_| ran).as_deref().and_then(plan::ppm_pixel)
}

impl Backend {
    fn pick_colour(&self) -> Result<Picked, Fail> {
        let out = format!("{}.ppm", temp("pixel"));
        let at = match self.desk {
            Desk::Wlroots => {
                let slurp = self.kit.slurp.as_deref().ok_or(Fail::code("unsupported"))?;
                run::run(slurp, &["-p".into()], None, PICK_DEADLINE)
                    .filter(|o| o.ok)
                    .and_then(|o| plan::parse_point(&o.stdout))
            }
            Desk::X11 => {
                let xdotool = self.kit.xdotool.as_deref().ok_or(Fail::code("unsupported"))?;
                run::run(xdotool, &["selectwindow".into()], None, PICK_DEADLINE)
                    .filter(|o| o.ok)
                    .and_then(|_| {
                        let args = ["getmouselocation".into(), "--shell".into()];
                        run::run(xdotool, &args, None, TOOL_DEADLINE)
                    })
                    .and_then(|o| plan::parse_mouse(&o.stdout))
            }
            _ => return Err(Fail::code("unsupported")),
        };
        let Some(at) = at else {
            return Ok(Picked::Cancelled);
        };
        let rgb = match (&self.kit.grim, &self.kit.import, &self.kit.ffmpeg) {
            (Some(grim), _, _) if self.desk == Desk::Wlroots => {
                read_pixel(grim, &plan::grim_args(at, &out), &out)
            }
            (_, Some(import), _) => read_pixel(import, &plan::import_args(at, &out), &out),
            (_, _, Some(ffmpeg)) => {
                read_pixel(ffmpeg, &plan::x11grab_args(&self.display, at, &out), &out)
            }
            _ => None,
        };
        rgb.map(Picked::Colour).ok_or(Fail::code("capture_failed"))
    }

    /// `{ mode: "colour" | "measure", format?: "hex" | "rgb" | "hsl" }`: the
    /// colour (in `format`) or the size goes on the clipboard and comes back in
    /// the answer; `{ cancelled: true }` when the user leaves.
    pub fn inspect(&mut self, req: &Value) -> Result<Value, Fail> {
        let measure = match req.get("mode").and_then(Value::as_str) {
            Some("colour") => false,
            Some("measure") => true,
            _ => return Err(Fail::code("bad_request")),
        };
        let format = match req.get("format").and_then(Value::as_str) {
            None => Format::Hex,
            Some(f) => Format::parse(f).ok_or(Fail::code("bad_request"))?,
        };
        let copy = |text: &str| self.to_clipboard("text/plain;charset=utf-8", text.as_bytes());
        if measure {
            let out = format!("{}.png", temp("ruler"));
            let shot = self.take(&json!({ "target": "region" }), &Front::default(), false, &out);
            let _ = std::fs::remove_file(&out);
            let Some(shot) = shot? else {
                return Ok(json!({ "cancelled": true }));
            };
            let (w, h) = (shot.width as i32, shot.height as i32);
            let text = inspect::size_text(w, h);
            return Ok(json!({
                "width": w, "height": h, "text": text, "copied": copy(&text), "monitor": null,
            }));
        }
        if !self.kit.picks_colour(self.desk) {
            return Err(Fail::code("unsupported"));
        }
        match self.pick_colour()? {
            Picked::Cancelled => Ok(json!({ "cancelled": true })),
            Picked::Colour(rgb) => {
                let text = inspect::text(rgb, format);
                Ok(json!({
                    "rgb": rgb, "hex": inspect::hex(rgb), "text": text,
                    "copied": copy(&text), "monitor": null,
                }))
            }
        }
    }
}
