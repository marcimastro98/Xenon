//! Running the system's tools: found on PATH once, started with an argv array,
//! never a shell, and never longer than a deadline.

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// What a finished tool said.
pub struct Output {
    pub ok: bool,
    pub stdout: String,
}

const POLL: Duration = Duration::from_millis(40);

/// `name` as an absolute path from PATH, when it is there and executable.
pub fn which(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|p| is_executable(p))
        .map(|p| p.to_string_lossy().into_owned())
}

fn is_executable(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

fn command(program: &str, args: &[String], input: bool) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(if input { Stdio::piped() } else { Stdio::null() })
        .stderr(Stdio::null())
        // Tools that print in the user's language (pactl) are read in English.
        .env("LC_ALL", "C.UTF-8");
    cmd
}

/// Runs `program args`, feeding `input` on stdin when given, for at most
/// `deadline`. None when it could not start or ran out of time (it is killed).
pub fn run(
    program: &str,
    args: &[String],
    input: Option<&[u8]>,
    deadline: Duration,
) -> Option<Output> {
    let mut child = command(program, args, input.is_some())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    feed(&mut child, input);
    // Read while waiting, so a tool with a lot to say never blocks on a full pipe.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let ok = wait(&mut child, deadline)?;
    Some(Output {
        ok,
        stdout: reader.join().unwrap_or_default(),
    })
}

/// Like `run`, for a tool that writes bytes (raw pixels): its stdout when it
/// ended well within `deadline`.
pub fn run_bytes(program: &str, args: &[String], deadline: Duration) -> Option<Vec<u8>> {
    let mut child = command(program, args, false)
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stdout.read_to_end(&mut b);
        b
    });
    let ok = wait(&mut child, deadline)?;
    let bytes = reader.join().ok()?;
    ok.then_some(bytes)
}

/// Like `run`, for a tool whose output is not read: the clipboard tools leave a
/// child behind that serves the clipboard and keeps any inherited pipe open.
pub fn run_quiet(program: &str, args: &[String], input: Option<&[u8]>, deadline: Duration) -> bool {
    let Ok(mut child) = command(program, args, input.is_some())
        .stdout(Stdio::null())
        .spawn()
    else {
        return false;
    };
    feed(&mut child, input);
    wait(&mut child, deadline).unwrap_or(false)
}

fn feed(child: &mut Child, input: Option<&[u8]>) {
    if let (Some(bytes), Some(mut stdin)) = (input, child.stdin.take()) {
        let _ = stdin.write_all(bytes);
    }
}

/// Waits for `child` until `deadline`; Some(success) when it ended, None when
/// it had to be killed.
pub fn wait(child: &mut Child, deadline: Duration) -> Option<bool> {
    let until = Instant::now() + deadline;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.success()),
            Ok(None) if Instant::now() < until => std::thread::sleep(POLL),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}
