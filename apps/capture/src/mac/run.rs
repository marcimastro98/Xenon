//! Running Apple's own tools: always an argv array, never a shell, and never
//! longer than a deadline (a tool waiting on a dialog nobody answers is killed).

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// What a finished tool said.
pub struct Output {
    pub ok: bool,
    pub stdout: String,
}

/// How often a running tool is looked at while waited for.
const POLL: Duration = Duration::from_millis(40);

/// Runs `program args`, feeding `input` on stdin when given, for at most
/// `deadline`. None when it could not start or ran out of time (it is killed).
pub fn run(
    program: &str,
    args: &[String],
    input: Option<&str>,
    deadline: Duration,
) -> Option<Output> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // pbcopy and osascript read and write text in the locale's encoding.
        .env("LC_ALL", "en_US.UTF-8");
    let mut child = cmd.spawn().ok()?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        let _ = stdin.write_all(text.as_bytes());
    }
    // Read while waiting, so a tool with a lot to say never blocks on a full pipe.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let status = wait(&mut child, deadline)?;
    let stdout = reader.join().unwrap_or_default();
    Some(Output { ok: status, stdout })
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

/// A JavaScript for Automation script (scripts.rs) with its arguments; its
/// `run(argv)` result is the output.
pub fn jxa(script: &str, args: &[String], deadline: Duration) -> Option<Output> {
    let mut argv = vec![
        "-l".to_owned(),
        "JavaScript".to_owned(),
        "-e".to_owned(),
        script.to_owned(),
    ];
    argv.extend(args.iter().cloned());
    run(OSASCRIPT, &argv, None, deadline)
}

pub const OSASCRIPT: &str = "/usr/bin/osascript";
pub const SCREENCAPTURE: &str = "/usr/sbin/screencapture";
pub const AVCONVERT: &str = "/usr/bin/avconvert";
pub const AFCONVERT: &str = "/usr/bin/afconvert";
pub const SIPS: &str = "/usr/bin/sips";
pub const QLMANAGE: &str = "/usr/bin/qlmanage";
pub const PBCOPY: &str = "/usr/bin/pbcopy";
pub const KILL: &str = "/bin/kill";
