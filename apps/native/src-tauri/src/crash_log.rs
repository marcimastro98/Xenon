//! Why the app disappeared: a tiny, dependency-free crash diary.
//!
//! The kiosk is a `windows_subsystem = "windows"` binary with `strip = true`,
//! so when it dies there is nowhere for it to say so: no console, no stderr, no
//! symbols, and Event Viewer only ever offers a generic fault code. Every report
//! of "it just closed at some point" therefore arrived with exactly zero
//! evidence, which is the actual bug being fixed here — the shell now writes
//! down what happened to it.
//!
//! The file lives next to `display.json` in the app config dir
//! (`%APPDATA%\com.marcimastro98.xenon\crash.log` on Windows,
//! `~/Library/Application Support/com.marcimastro98.xenon/` on macOS,
//! `~/.config/com.marcimastro98.xenon/` on Linux) and holds three kinds of line:
//!
//!   * `launched`  — written at startup, before anything else can fail;
//!   * `exited`    — written when the app stops on purpose: the run loop's Exit
//!                   event, and the three `restart()` paths that exec past it;
//!   * `PANIC`     — written by the panic hook, with thread, message and the
//!                   `file:line:col` of the panic site.
//!
//! That third state is what makes the log worth having even when it is empty of
//! panics: a `launched` with no `exited` and no `PANIC` after it means nothing
//! inside the app decided to stop — the process was killed from the outside,
//! which on Windows is almost always antivirus quarantining the executable
//! mid-session (see the README's Defender section) or the machine going down
//! hard. Telling those two worlds apart used to take a guess.
//!
//! Everything here is best-effort: a crash diary that can itself fail the app
//! would be worse than none. Every filesystem error is swallowed.

use std::io::Write;
use std::panic;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Must match `identifier` in `tauri.conf.json` — it is what Tauri derives the
/// app config dir from, and the point is to land in the same folder as the
/// prefs file so one screenshot of that folder carries both.
const IDENTIFIER: &str = "com.marcimastro98.xenon";

/// Rotate past this size so a log-every-launch file cannot grow forever on a PC
/// that is never restarted. One generation is kept: a crash loop overwrites its
/// own history otherwise, and the *first* failure is usually the interesting one.
const MAX_BYTES: u64 = 64 * 1024;

/// How many times a supervised background thread may be restarted after a panic
/// before it is left dead. A guard that panics once per tick would otherwise
/// spin forever, filling the log with the same line.
const MAX_RESTARTS: u32 = 3;

/// Pause before restarting a panicked background thread, so a failure that is
/// really "the display went away for a moment" gets a moment.
const RESTART_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

/// Guards against a panic *inside* the panic hook (a full disk, say) recursing
/// forever. Set for the duration of the hook, per process — the hook already
/// serialises through the file, and a second panicking thread has nothing new
/// to add anyway.
static IN_HOOK: AtomicBool = AtomicBool::new(false);

/// Directory Tauri would give as `app_config_dir()`, resolved without an
/// `AppHandle` — the hook has to be installed before the app exists.
fn config_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);

    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|h| h.join("Library").join("Application Support"));

    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));

    base.map(|b| b.join(IDENTIFIER))
}

/// Full path of the crash log, or `None` if the platform gave us no home to
/// write in (a service account with no profile, say).
pub fn path() -> Option<PathBuf> {
    Some(config_dir()?.join("crash.log"))
}

/// `YYYY-MM-DDTHH:MM:SSZ`, from the epoch seconds alone.
///
/// std has no date formatting and this crate has no date dependency; the civil
/// date is the days-since-epoch algorithm (Howard Hinnant's `civil_from_days`),
/// which is exact for every date this app will ever see. Local time is
/// deliberately not attempted: UTC is unambiguous in a log that gets pasted into
/// a bug report from another timezone.
fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    fmt_utc(secs)
}

/// The formatting half of `timestamp()`, split out so it can be tested against
/// known instants without waiting for the clock to reach them.
fn fmt_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (h, mi, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);

    // Shift the era so March is month 1 and the leap day lands at the end of the
    // cycle, which makes the 400-year pattern a straight division.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);

    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Append one line, rotating first if the file has grown past `MAX_BYTES`.
///
/// Opened and closed per write rather than held open: the app is expected to die
/// at an arbitrary moment, and a handle that is never dropped is a handle whose
/// buffer is never flushed. Each record is small enough to reach the disk in one
/// write.
fn append(kind: &str, detail: &str) {
    let Some(path) = path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_BYTES {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let _ = writeln!(
        f,
        "[{}] v{} {} {}",
        timestamp(),
        env!("CARGO_PKG_VERSION"),
        kind,
        detail
    );
    let _ = f.flush();
}

/// Install the panic hook. Call this first thing in `run()`, before any thread
/// exists that could beat it to a panic.
///
/// The previous hook is kept and still runs, so `tauri dev` keeps printing the
/// usual panic message to the console.
pub fn install() {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        if !IN_HOOK.swap(true, Ordering::SeqCst) {
            let thread = std::thread::current();
            let name = thread.name().unwrap_or("unnamed").to_string();
            // The payload is `&str` for `panic!("literal")` and `String` for a
            // formatted one; anything else (`panic_any`) has no text to show.
            let msg = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "(no message)".to_string());
            let at = info
                .location()
                .map(|l| format!(" at {}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_default();
            append("PANIC", &format!("in thread `{name}`: {msg}{at}"));
            IN_HOOK.store(false, Ordering::SeqCst);
        }
        previous(info);
    }));
}

/// Note that this process started. Written after `install()` so a panic during
/// startup still lands in a file that says which launch it belongs to.
pub fn session_start() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let line = format!("{} {}", std::env::consts::OS, args.join(" "));
    append("launched", line.trim_end());
}

/// Note that this process is stopping on purpose. Anything that ends a session
/// without this line — and without a `PANIC` — was not the app's own decision.
pub fn session_end(reason: &str) {
    append("exited", reason);
}

/// Run a background loop under the crash diary, restarting it if it panics.
///
/// The watchdogs are `loop { sleep; poll the OS }` threads that must outlive
/// every transient failure of the thing they poll. Since the release profile
/// unwinds (see `Cargo.toml`), a panic in one of them no longer takes the
/// process with it — but silently losing the thread would still leave the kiosk
/// unpinned or the cursor unguarded for the rest of the session, with nothing
/// said. Restart it a few times, then leave it dead rather than spin.
///
/// The body is `AssertUnwindSafe`: these closures own their state and are
/// restarted from scratch, so there is no half-mutated value to observe.
pub fn spawn_supervised<F>(name: &'static str, mut body: F)
where
    F: FnMut() + Send + 'static,
{
    let spawned = std::thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            for attempt in 0..=MAX_RESTARTS {
                if panic::catch_unwind(panic::AssertUnwindSafe(&mut body)).is_ok() {
                    return; // finished on its own terms (window gone) — done
                }
                if attempt == MAX_RESTARTS {
                    append("thread", &format!("`{name}` panicked too often — not restarting"));
                    return;
                }
                append("thread", &format!("`{name}` panicked — restarting"));
                std::thread::sleep(RESTART_DELAY);
            }
        });
    if spawned.is_err() {
        append("thread", &format!("`{name}` could not be started"));
    }
}

#[cfg(test)]
mod tests {
    use super::fmt_utc;

    #[test]
    fn formats_known_instants() {
        assert_eq!(fmt_utc(0), "1970-01-01T00:00:00Z");
        // A leap day, and the last second before the next one.
        assert_eq!(fmt_utc(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(fmt_utc(1_709_251_199), "2024-02-29T23:59:59Z");
        // 2000 is a leap year (divisible by 400) and 1900 was not; a wrong era
        // shift shows up here first.
        assert_eq!(fmt_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(fmt_utc(1_755_592_800), "2025-08-19T08:40:00Z");
    }

    #[test]
    fn survives_a_clock_before_the_epoch() {
        // A PC whose CMOS battery died reports a pre-1970 time; the log line
        // must still be written rather than panicking on an overflow.
        assert_eq!(fmt_utc(-1), "1969-12-31T23:59:59Z");
    }
}
