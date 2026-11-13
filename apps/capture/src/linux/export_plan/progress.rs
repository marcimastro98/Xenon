// Linux export: reading ffmpeg's progress lines, and why it failed.

/// One line of `-progress` output: how far the copy is (0..1 of `total`
/// seconds) or how many bytes it has written.
#[derive(Debug, PartialEq)]
pub enum Tick {
    Done(f64),
    Bytes(u64),
}

pub fn progress(line: &str, total: f64) -> Option<Tick> {
    let (key, value) = line.trim().split_once('=')?;
    match key {
        // Microseconds under both names (ffmpeg's out_time_ms is misnamed).
        "out_time_us" | "out_time_ms" if total > 0.0 => {
            let us: f64 = value.parse().ok()?;
            Some(Tick::Done((us / 1e6 / total).clamp(0.0, 1.0)))
        }
        "total_size" => value.parse().ok().map(Tick::Bytes),
        _ => None,
    }
}

/// The error code for what a failed ffmpeg said.
pub fn failure(stderr: &str) -> &'static str {
    if stderr.contains("No space left on device") {
        "disk_full"
    } else {
        "export_failed"
    }
}
