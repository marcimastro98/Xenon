// Windows: a screenshot of a screen, a window or a region, from the request to the saved file.

use serde_json::{json, Value};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{MONITOR_DEFAULTTONEAREST, MonitorFromWindow};
use crate::proto::Fail;
use super::{Backend, clipboard, grab, HINT_MAX, monitors, pick_monitor, picker, png, window};

pub(super) struct Shot {
    pub(super) image: grab::Image,
    pub(super) hdr: bool,
    pub(super) monitor: Option<usize>,
    /// Put on the clipboard too (`copy`: the area picker does it while its
    /// window, the clipboard's owner, still exists).
    copied: bool,
}

/// Writes the PNG next to its final name first, so a half-written file never
/// carries the real name.
fn save(path: &str, image: &grab::Image) -> Result<(), Fail> {
    let part = format!("{path}.part");
    png::write(&part, image.width, image.height, &image.bgr)
        .map_err(|e| Fail::new("write_failed", e))?;
    std::fs::rename(&part, path).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        Fail::new("write_failed", e)
    })
}

impl Backend {
    /// `{ target: "screen" | "window" | "region", monitor?: index, path, cursor?, copy?, hint? }`;
    /// `copy` and `hint` are for "region".
    /// "screen" without a monitor is the one the foreground window is on;
    /// "region" lets the user pick an area on the frozen screens and answers
    /// `{ cancelled: true }` when they change their mind.
    pub fn screenshot(&mut self, req: &Value) -> Result<Value, Fail> {
        if !grab::supported() {
            return Err(Fail::code("unsupported"));
        }
        let path = req
            .get("path")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
            .ok_or(Fail::code("bad_request"))?;
        let cursor = req.get("cursor").and_then(Value::as_bool).unwrap_or(false);
        let copy = req.get("copy").and_then(Value::as_bool).unwrap_or(false);
        let exe = window::foreground()
            .map(window::exe_name)
            .unwrap_or_default();
        let Some(shot) = self.take(req, cursor, copy)? else {
            return Ok(json!({ "cancelled": true }));
        };
        save(path, &shot.image)?;
        // The area picker copies its own cut; a screen or a window is copied here.
        let copied = shot.copied
            || (copy
                && clipboard::copy_image(&crate::pixels::dib(
                    shot.image.width,
                    shot.image.height,
                    &shot.image.bgr,
                )));
        Ok(json!({
            "width": shot.image.width, "height": shot.image.height, "hdr": shot.hdr,
            "monitor": shot.monitor, "exe": exe, "copied": copied,
        }))
    }

    /// The picture a screenshot or a text read starts from; None when the user
    /// left the area picker.
    pub(super) fn take(&mut self, req: &Value, cursor: bool, copy: bool) -> Result<Option<Shot>, Fail> {
        let list = monitors::list();
        match req
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or("screen")
        {
            "window" => self.shot_window(&list, cursor).map(Some),
            "screen" => self
                .shot_screen(&list, req.get("monitor").and_then(Value::as_u64), cursor)
                .map(Some),
            "region" => {
                let hint: String = req
                    .get("hint")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .take(HINT_MAX)
                    .collect();
                self.shot_region(&list, &hint, copy)
            }
            _ => Err(Fail::code("bad_request")),
        }
    }

    fn shot_window(&mut self, list: &[monitors::Monitor], cursor: bool) -> Result<Shot, Fail> {
        let h: HWND = window::foreground().ok_or(Fail::code("no_window"))?;
        let hm = unsafe { MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) };
        let mon = list.iter().find(|m| m.handle == hm);
        let hdr_white = mon.filter(|m| m.hdr).map(|m| m.white);
        let opts = grab::Options {
            hdr_white,
            cursor,
            crop: None,
            wait: grab::FIRST_FRAME_TIMEOUT,
        };
        let image = self.grab_window(h, mon, opts)?;
        Ok(Shot {
            image,
            hdr: hdr_white.is_some(),
            monitor: mon.map(|m| m.index),
            copied: false,
        })
    }

    fn shot_screen(
        &mut self,
        list: &[monitors::Monitor],
        index: Option<u64>,
        cursor: bool,
    ) -> Result<Shot, Fail> {
        let m = pick_monitor(list, index)?;
        let hdr_white = m.hdr.then_some(m.white);
        let opts = grab::Options {
            hdr_white,
            cursor,
            crop: None,
            wait: grab::FIRST_FRAME_TIMEOUT,
        };
        let image = self.grab(&grab::Target::Monitor(m.handle), &opts)?;
        Ok(Shot {
            image,
            hdr: m.hdr,
            monitor: Some(m.index),
            copied: false,
        })
    }

    /// Freezes every monitor, then lets the user pick on the frozen images.
    /// The windows a click can pick are read at the same moment, so they
    /// match the picture even when they move meanwhile.
    fn shot_region(
        &mut self,
        list: &[monitors::Monitor],
        hint: &str,
        copy: bool,
    ) -> Result<Option<Shot>, Fail> {
        let frozen = self.freeze(list)?;
        let stack = window::stack();
        let Some(p) = picker::pick(&frozen, stack, hint, copy) else {
            return Ok(None);
        };
        let hdr = list.iter().any(|m| m.index == p.monitor && m.hdr);
        Ok(Some(Shot {
            image: p.image,
            hdr,
            monitor: Some(p.monitor),
            copied: p.copied,
        }))
    }
}
