// Linux: the process that reads the pictures of a recording made through the desktop's portal.

use std::sync::{Arc, mpsc, Mutex};
use super::{portal, portal_plan};

/// The portal recording's picture reader and its session: both end when the
/// recording does (ffmpeg has finished its file by then). When the desktop
/// closes the session first, the reader is stopped, its pictures end and
/// ffmpeg ends the file by itself.
pub(super) struct Reader {
    pub(super) child: Arc<Mutex<std::process::Child>>,
    _session: portal::Session,
}

impl Reader {
    pub(super) fn new(child: std::process::Child, session: portal::Session, closed: mpsc::Receiver<()>) -> Reader {
        let child = Arc::new(Mutex::new(child));
        let watched = child.clone();
        std::thread::spawn(move || {
            // Err: the session ended from this side, the reader is already stopped.
            if closed.recv().is_ok() {
                if let Ok(mut c) = watched.lock() {
                    let _ = c.kill();
                }
            }
        });
        Reader { child, _session: session }
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        // A reaped child is never signalled again (Child::kill), so the
        // watcher cannot hit a reused pid.
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// gst-launch with the portal's PipeWire connection as its descriptor
/// `PIPEWIRE_FD` (portal_plan.rs); every other descriptor stays closed.
pub(super) fn gst_command(launch: &str, args: &[String], fd: &std::os::fd::OwnedFd) -> std::process::Command {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    let raw = fd.as_raw_fd();
    let mut cmd = std::process::Command::new(launch);
    cmd.args(args);
    // SAFETY: between fork and exec only dup2 and fcntl run, both
    // async-signal-safe, on a descriptor this process owns.
    unsafe {
        cmd.pre_exec(move || {
            let target = portal_plan::PIPEWIRE_FD;
            let ok = if raw == target {
                // dup2 onto itself would keep close-on-exec.
                libc::fcntl(raw, libc::F_SETFD, 0) == 0
            } else {
                libc::dup2(raw, target) == target
            };
            if ok {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
    cmd
}
