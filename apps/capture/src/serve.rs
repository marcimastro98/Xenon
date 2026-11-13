// Reads the requests the engine is sent, one a line, and answers each.

use std::io::{BufRead, Write};
use std::sync::{Arc, mpsc};
use serde_json::{json, Value};
use crate::{Backend, features, IDLE_EXIT, proto};
use crate::proto::{Fail, Notify};

fn handle(backend: &mut Backend, cmd: &str, req: &Value, notify: &Notify) -> Result<Value, Fail> {
    match cmd {
        "ping" => Ok(json!({ "version": env!("CARGO_PKG_VERSION"), "features": features(backend) })),
        "monitors" => Ok(backend.monitors()),
        "screenshot" => backend.screenshot(req),
        "record_start" => backend.record_start(req, notify.clone()),
        "record_stop" => backend.record_stop(),
        "replay_start" => backend.replay_start(req, notify.clone()),
        "replay_save" => backend.replay_save(req),
        "replay_keep" => backend.replay_keep(req),
        "replay_stop" => backend.replay_stop(),
        "pick_folder" => backend.pick_folder(req, notify.clone()),
        "thumb" => backend.thumb(req, notify.clone()),
        "trim" => backend.trim(req, notify.clone()),
        "export" => backend.export(req, notify.clone()),
        "export_cancel" => backend.export_cancel(),
        "cover" => backend.cover(req, notify.clone()),
        "speech" => backend.speech(req, notify.clone()),
        "copy_files" => backend.copy_files(req),
        "ocr" => backend.ocr(req),
        "inspect" => backend.inspect(req),
        "draw" => backend.draw(req, notify.clone()),
        "steps" => backend.steps(req, notify.clone()),
        _ => Err(Fail::code("unknown_cmd")),
    }
}

/// One line to the server; replies and events share stdout, a line at a time.
fn send(line: &str) -> bool {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{line}").and_then(|_| out.flush()).is_ok()
}

pub(crate) fn serve() {
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(l) = line else { break };
            if tx.send(l).is_err() {
                break;
            }
        }
    });
    let mut backend = Backend::new();
    let notify: Notify = Arc::new(|event: Value| {
        send(&event.to_string());
    });
    loop {
        let line = match rx.recv_timeout(IDLE_EXIT) {
            Ok(l) => l,
            Err(mpsc::RecvTimeoutError::Timeout) if backend.busy() => continue,
            Err(_) => {
                backend.shutdown(); // idle, or stdin closed
                return;
            }
        };
        let Some((id, cmd, req)) = proto::parse(&line) else {
            continue;
        };
        // One bad request must not take the engine down with it.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            handle(&mut backend, &cmd, &req, &notify)
        }))
        .unwrap_or_else(|_| Err(Fail::code("crashed")));
        if !send(&proto::reply(id, result)) {
            backend.shutdown();
            return;
        }
    }
}
