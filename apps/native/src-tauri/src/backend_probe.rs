// Asking whether the engine answers on its local port, and for how long to keep asking.

/// One connection attempt, ~2s. Enough to tell "installed and starting" from
/// "not there at all" when something else has already answered that question —
/// see the task query in the Windows nudge.
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
pub(crate) fn backend_answers_once(port: u16) -> bool {
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok()
}

/// Probe rounds before healing a backend that does not answer: ~8–16s, so a
/// normally-starting backend is never interfered with.
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
pub(crate) const PROBE_TRIES: u32 = 4;
/// The same when the app itself was launched at sign-in, where the logon task
/// is starting the engine alongside it and a cold boot is slow: ~25–50s.
#[cfg(windows)]
pub(crate) const LOGON_PROBE_TRIES: u32 = 12;

/// True once the local backend accepts a connection, polling for the usual
/// ~8–16s.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn backend_answers(port: u16) -> bool {
    backend_answers_within(port, PROBE_TRIES)
}

/// True once the local backend accepts a connection within `tries` probe rounds
/// (one connection attempt of up to 2s, then a 2s pause).
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
pub(crate) fn backend_answers_within(port: u16, tries: u32) -> bool {
    use std::time::Duration;
    for _ in 0..tries {
        if backend_answers_once(port) {
            return true;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    false
}
