// Linux replay: the recording processes that fill the buffer, started, watched and ended.

use std::io::Write;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};
use crate::proto::Fail;
use super::{Plan, POLL, Source, START_GRACE, STOP_GRACE};
use super::super::{replay_plan as plan, run};

/// The recorders of a running replay.
pub(super) struct Recorders {
    /// The ffmpeg that writes the ring (and prints its list).
    cutter: Child,
    /// wf-recorder, feeding the cutter, and the `kill` that stops it.
    feeder: Option<(Child, String)>,
}

impl Recorders {
    pub(super) fn spawn(plan: &Plan, dir: &str) -> Result<(Recorders, ChildStdout), Fail> {
        let fail = |e: std::io::Error| Fail::new("replay_failed", e);
        let (mut cutter, feeder) = match &plan.source {
            Source::Ffmpeg { program, args } => {
                let args = plan::ring_from_record(args.clone(), dir).ok_or(Fail::code("replay_failed"))?;
                let child = Command::new(program)
                    .args(&args)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(fail)?;
                (child, None)
            }
            Source::Wf {
                program,
                args,
                kill,
            } => {
                let mut wf = Command::new(program)
                    .args(args)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(fail)?;
                let Some(stream) = wf.stdout.take() else {
                    let _ = wf.kill();
                    let _ = wf.wait();
                    return Err(Fail::code("replay_failed"));
                };
                let cutter = Command::new(&plan.ffmpeg)
                    .args(plan::ring_from_stream(dir))
                    .stdin(Stdio::from(stream))
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn();
                match cutter {
                    Ok(c) => (c, Some((wf, kill.clone()))),
                    Err(e) => {
                        let _ = wf.kill();
                        let _ = wf.wait();
                        return Err(fail(e));
                    }
                }
            }
        };
        let list = cutter.stdout.take();
        let mut rec = Recorders { cutter, feeder };
        std::thread::sleep(START_GRACE);
        match list {
            Some(list) if rec.alive() => Ok((rec, list)),
            _ => {
                rec.end();
                Err(Fail::new("replay_failed", "recorder ended at once"))
            }
        }
    }

    fn alive(&mut self) -> bool {
        let up = |c: &mut Child| matches!(c.try_wait(), Ok(None));
        up(&mut self.cutter) && self.feeder.as_mut().is_none_or(|(f, _)| up(f))
    }

    /// Asks them to finish (wf-recorder first: the cutter then sees the end of
    /// its input), and kills what is still running after the grace.
    pub(super) fn end(&mut self) {
        match self.feeder.as_mut() {
            Some((wf, kill)) => {
                let pid = wf.id().to_string();
                let _ = run::run(kill, &["-INT".into(), pid], None, Duration::from_secs(4));
            }
            None => {
                if let Some(mut input) = self.cutter.stdin.take() {
                    let _ = input.write_all(b"q");
                }
            }
        }
        let deadline = Instant::now() + STOP_GRACE;
        let mut children: Vec<&mut Child> = vec![&mut self.cutter];
        if let Some((wf, _)) = self.feeder.as_mut() {
            children.push(wf);
        }
        for c in children {
            while matches!(c.try_wait(), Ok(None)) && Instant::now() < deadline {
                std::thread::sleep(POLL);
            }
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}
