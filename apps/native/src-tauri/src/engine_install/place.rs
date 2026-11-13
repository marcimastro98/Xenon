// First-run install: copying the engine into place once, and waiting until it answers.

use std::path::Path;
use super::{Bundle, copy, fail, has_engine, installed_version, log, progress, RUNTIME_DIR, version_newer};
#[cfg(target_os = "linux")]
use super::linux as platform;
#[cfg(target_os = "macos")]
use super::macos as platform;
#[cfg(windows)]
use super::windows as platform;
use super::progress::Step;

/// Marks a runtime copied whole from this bundle, so a retry skips it: a
/// runtime the engine is running from cannot be overwritten on Windows.
pub(super) const RUNTIME_STAMP: &str = "xenon-bundle.txt";

pub(super) fn placed_version(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join("server").join("data").join("update-manifest.json")).ok()?;
    let info: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(info.get("version")?.as_str()?.to_string())
}

/// Copies the engine (never over a newer one, never again over the same one)
/// and the runtime, then the markers.
pub(super) fn place_files(bundle: &Bundle, root: &Path) -> Result<(), Step> {
    let newer_installed = installed_version(root)
        .map(|v| version_newer(&v, &bundle.version))
        .unwrap_or(false);
    // The manifest is written only after a complete copy, so it vouches for one,
    // but only beside the engine: an uninstall that kept server\data keeps it too.
    let app_placed = has_engine(root)
        && (newer_installed || placed_version(root).as_deref() == Some(bundle.version.as_str()));
    let runtime_dst = root.join(RUNTIME_DIR);
    let runtime_placed = std::fs::read_to_string(runtime_dst.join(RUNTIME_STAMP))
        .map(|v| v.trim() == bundle.version)
        .unwrap_or(false);
    let runtime_src = bundle.dir.join(RUNTIME_DIR);
    let app_src = bundle.dir.join("app");
    let total = if runtime_placed { 0 } else { copy::count_files(&runtime_src) }
        + if app_placed { 0 } else { copy::count_files(&app_src) };
    let mut counter = copy::Counter::new(total, 5, 84);
    if app_placed {
        log("this engine or a newer one is already here: its files are left as they are");
    } else {
        progress::set(Step::Copying, 5);
        copy::merge_tree(&app_src, root, &mut counter).map_err(fail("copy"))?;
        std::fs::create_dir_all(root.join("server").join("data")).map_err(fail("copy"))?;
        copy::write_manifest(root, &bundle.version, &bundle.files).map_err(fail("manifest"))?;
    }
    if !runtime_placed {
        progress::set(Step::Runtime, counter.percent());
        copy::replace_tree(&runtime_src, &runtime_dst, &mut counter).map_err(fail("runtime"))?;
        std::fs::write(runtime_dst.join(RUNTIME_STAMP), &bundle.version).map_err(fail("runtime"))?;
    }
    platform::after_copy(root).map_err(fail("runtime"))?;
    Ok(())
}

/// One real request, not just an open port: the engine's own `/ping`.
pub(super) fn engine_answers(port: u16, timeout: std::time::Duration) -> bool {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, timeout) else { return false };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let request = format!("GET /ping HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 12];
    stream.read_exact(&mut head).is_ok() && head.starts_with(b"HTTP/1.1 200")
}

pub(super) fn wait_for_engine(port: u16, seconds: u32) -> bool {
    use std::time::Duration;
    use std::time::Instant;
    let total = Duration::from_secs(u64::from(seconds.max(1)));
    let started = Instant::now();
    // A refused connection returns at once, so the wait is paced by the clock,
    // not by the number of tries.
    while started.elapsed() < total {
        if engine_answers(port, Duration::from_millis(900)) {
            return true;
        }
        let share = started.elapsed().as_millis() * 9 / total.as_millis();
        progress::set(Step::Starting, 90 + share.min(9) as u8);
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}
