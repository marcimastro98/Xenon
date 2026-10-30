//! The gallery's exports on Linux (export_plan.rs builds them): ffmpeg makes
//! the copy into a file next to the final name, reporting how far it is on its
//! stdout, and the file is renamed when it is whole. One export at a time (the
//! server's rule); `export_cancel` kills it and leaves nothing behind.

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Value};

use super::edit::{spawn, text, Ffmpeg, Jobs};
use super::export_plan::{self as plan, Kind, Picture, Probe, Tick};
use super::run;
use crate::bubble::Corner;
use crate::proto::{Fail, Notify};
use crate::reframe::{self, Focus};

/// Asked to stop: the running export is killed at its next progress line.
static CANCEL: AtomicBool = AtomicBool::new(false);
/// A GIF past this many bytes stops: no chat or page takes one that big.
const GIF_MAX_BYTES: u64 = 256 * 1_000_000;
/// Tries at a copy that must fit, each with less bitrate than the last.
const FIT_TRIES: u32 = 3;
/// Progress events at most every this much of the clip.
const PROGRESS_STEP: f64 = 0.03;
/// The sizes a copy may be asked to fit in, in megabytes.
const FIT_MB_MAX: u64 = 4000;
const PROBE_DEADLINE: Duration = Duration::from_secs(30);
/// What is kept of ffmpeg's error output, to tell a full disk.
const STDERR_KEEP: usize = 8 * 1024;

type Out<T> = Result<T, &'static str>;

fn probe(ff: &Ffmpeg, src: &str) -> Out<Probe> {
    run::run(&ff.ffprobe, &plan::probe_args(src), None, PROBE_DEADLINE)
        .filter(|o| o.ok)
        .and_then(|o| plan::parse_probe(&o.stdout))
        .ok_or("export_failed")
}

/// The end of a child's error output, read while it runs.
fn tail(child: &mut Child) -> std::thread::JoinHandle<String> {
    let stderr = child.stderr.take();
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        if let Some(mut e) = stderr {
            let mut buf = [0u8; 4096];
            while let Ok(n) = e.read(&mut buf) {
                if n == 0 {
                    break;
                }
                kept.extend_from_slice(&buf[..n]);
                if kept.len() > STDERR_KEEP {
                    kept.drain(..kept.len() - STDERR_KEEP);
                }
            }
        }
        String::from_utf8_lossy(&kept).into_owned()
    })
}

/// Runs one ffmpeg pass; `limit` stops it when the file grows past that.
fn encode(
    ff: &Ffmpeg,
    args: &[String],
    seconds: f64,
    limit: Option<u64>,
    progress: &mut dyn FnMut(f64),
) -> Out<()> {
    let mut child = Command::new(&ff.ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "export_failed")?;
    let errors = tail(&mut child);
    let mut stop = None;
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            if CANCEL.load(Ordering::SeqCst) {
                stop = Some("cancelled");
                break;
            }
            match plan::progress(&line, seconds) {
                Some(Tick::Done(f)) => progress(f),
                Some(Tick::Bytes(b)) if limit.is_some_and(|l| b > l) => {
                    stop = Some("too_big");
                    break;
                }
                _ => {}
            }
        }
    }
    if let Some(code) = stop {
        let _ = child.kill();
        let _ = child.wait();
        let _ = errors.join();
        return Err(code);
    }
    let ok = child.wait().is_ok_and(|s| s.success());
    let said = errors.join().unwrap_or_default();
    if CANCEL.load(Ordering::SeqCst) {
        return Err("cancelled");
    }
    if ok {
        Ok(())
    } else {
        Err(plan::failure(&said))
    }
}

fn make(
    ff: &Ffmpeg,
    encoder: &str,
    src: &str,
    part: &str,
    kind: Kind,
    seconds: f64,
    progress: &mut dyn FnMut(f64),
) -> Out<(u32, u32)> {
    let p = probe(ff, src)?;
    let length = if p.seconds > 0.0 { p.seconds } else { seconds };
    let pass = |pic: &Picture, limit, progress: &mut dyn FnMut(f64)| {
        encode(ff, &plan::ffmpeg_args(src, part, pic, kind, encoder), length, limit, progress)
    };
    match kind {
        Kind::Vertical(focus, webcam) => {
            let pic = plan::vertical(&p, focus, webcam);
            pass(&pic, None, progress)?;
            Ok(pic.size)
        }
        Kind::Gif => {
            let pic = plan::gif(&p);
            pass(&pic, Some(GIF_MAX_BYTES), progress)?;
            Ok(pic.size)
        }
        Kind::Fit(target) => {
            let mut pic = plan::fit(&p, target, seconds).ok_or("too_long")?;
            for _ in 0..FIT_TRIES {
                pass(&pic, None, progress)?;
                let written = std::fs::metadata(part).map_err(|_| "export_failed")?.len();
                if written <= target {
                    return Ok(pic.size);
                }
                let less = reframe::retry_bitrate(pic.bps, target, written);
                if less >= pic.bps {
                    break;
                }
                pic.bps = less;
            }
            Err("too_long")
        }
    }
}

fn finish(made: Out<(u32, u32)>, part: &str, out: &str) -> Value {
    let settled = made.and_then(|size| {
        std::fs::rename(part, out).map_err(|_| "write_failed")?;
        Ok(size)
    });
    match settled {
        Ok((w, h)) => {
            let bytes = std::fs::metadata(out).map_or(0, |m| m.len());
            json!({ "width": w, "height": h, "bytes": bytes })
        }
        Err(code) => {
            let _ = std::fs::remove_file(part);
            json!({ "error": code })
        }
    }
}

fn kind(req: &Value) -> Result<Kind, Fail> {
    match req.get("kind").and_then(Value::as_str) {
        Some("vertical") => Ok(Kind::Vertical(
            Focus::parse(req.get("focus").and_then(Value::as_str)),
            Corner::parse(req.get("webcam").and_then(Value::as_str)),
        )),
        Some("fit") => req
            .get("mb")
            .and_then(Value::as_u64)
            .filter(|m| (1..=FIT_MB_MAX).contains(m))
            .map(|mb| Kind::Fit(mb * 1_000_000))
            .ok_or_else(|| Fail::code("bad_request")),
        Some("gif") => Ok(Kind::Gif),
        _ => Err(Fail::code("bad_request")),
    }
}

/// The same request and events as win/export.rs `start_export`.
pub fn start(
    req: &Value,
    notify: Notify,
    jobs: &Jobs,
    ff: &Ffmpeg,
    encoder: &'static str,
) -> Result<Value, Fail> {
    let src = text(req, "src")?;
    let out = text(req, "out")?;
    let kind = kind(req)?;
    let seconds = req
        .get("seconds")
        .and_then(Value::as_f64)
        .filter(|s| s.is_finite() && *s > 0.0)
        .unwrap_or(0.0);
    let token = req.get("token").cloned().unwrap_or(Value::Null);
    CANCEL.store(false, Ordering::SeqCst);
    let (tell, tag) = (notify.clone(), token.clone());
    let mut last = -1.0f64;
    let mut progress = move |f: f64| {
        let f = f.clamp(0.0, 1.0);
        if f - last >= PROGRESS_STEP {
            last = f;
            tell(json!({ "event": "export_progress", "token": tag, "pct": (f * 100.0).round() }));
        }
    };
    let ff = ff.clone();
    spawn(jobs, notify, "export_done", token, move || {
        let part = format!("{out}.part");
        let made = make(&ff, encoder, &src, &part, kind, seconds, &mut progress);
        finish(made, &part, &out)
    })
}

/// Stops the running export; nothing running is fine.
pub fn cancel() -> Value {
    CANCEL.store(true, Ordering::SeqCst);
    json!({ "cancelled": true })
}
