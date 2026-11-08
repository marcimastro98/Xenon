//! Starts the Windows app at sign-in without queueing behind other programs.
//!
//! Windows runs its Run list one program at a time and waits up to half a minute
//! for each, so Xenon's turn came a minute or more after sign-in, later on a PC
//! with many startup apps. A scheduled task starts on its own, right at sign-in.
//! The Run entry stays as the fallback for an account that may not
//! register tasks: when both fire, the second launch ends in the single-instance
//! hook, which ignores `--autostart`.

use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::Path;

const TASK_NAME: &str = "Xenon App";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Match the task to the login choice, off the calling thread: process creation blocks.
pub(crate) fn sync(want: bool) {
    std::thread::spawn(move || {
        if !want {
            // Fails when there is no task, which is already the wanted state.
            let _ = schtasks(&["/Delete", "/TN", TASK_NAME, "/F"]);
            return;
        }
        if let Err(reason) = register() {
            crate::crash_log::note("autostart", &format!("login task not registered: {reason}"));
        }
    });
}

fn register() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let name = std::env::var("USERNAME").map_err(|e| e.to_string())?;
    let user = match std::env::var("USERDOMAIN") {
        Ok(domain) if !domain.is_empty() => format!("{domain}\\{name}"),
        _ => name,
    };
    let file = std::env::temp_dir().join("xenon-login-task.xml");
    write_utf16(&file, &task_xml(&exe, &user)).map_err(|e| e.to_string())?;
    let path = file.to_string_lossy().into_owned();
    let done = schtasks(&["/Create", "/TN", TASK_NAME, "/XML", &path, "/F"]);
    let _ = std::fs::remove_file(&file);
    done
}

fn schtasks(args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new(crate::system32_exe("schtasks.exe"))
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("schtasks exited with {status}"))
    }
}

// Task Scheduler reads the file as UTF-16, the only way a user folder with
// non-ASCII letters in it arrives intact.
fn write_utf16(path: &Path, text: &str) -> std::io::Result<()> {
    let mut bytes = vec![0xFF, 0xFE];
    bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
    std::fs::File::create(path)?.write_all(&bytes)
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

// Priority 5: a task runs below normal priority unless told otherwise, and this
// one is the dashboard. No delay: if the taskbar is not there yet, the tray icon
// is added when it announces itself (TaskbarCreated, in the tray-icon crate).
fn task_xml(exe: &Path, user: &str) -> String {
    let exe = escape(&exe.to_string_lossy());
    let user = escape(user);
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>--autostart</Arguments>
    </Exec>
  </Actions>
</Task>
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_task_starts_the_app_as_a_login_launch() {
        let xml = task_xml(Path::new(r"C:\Users\Jo Smith\Xenon\xenon-native.exe"), r"PC\Jo");
        assert!(xml.contains(r"<Command>C:\Users\Jo Smith\Xenon\xenon-native.exe</Command>"));
        assert!(xml.contains("<Arguments>--autostart</Arguments>"));
        assert!(xml.contains(r"<UserId>PC\Jo</UserId>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
    }

    #[test]
    fn the_task_starts_at_sign_in_with_no_wait() {
        let xml = task_xml(Path::new(r"C:\Xenon\xenon-native.exe"), r"PC\Jo");
        assert!(xml.contains("<LogonTrigger>"));
        assert!(!xml.contains("<Delay>"));
    }

    #[test]
    fn a_path_cannot_break_out_of_the_xml() {
        let xml = task_xml(Path::new(r"C:\A&B<C>\x.exe"), "PC\\O'Neil");
        assert!(xml.contains(r"<Command>C:\A&amp;B&lt;C&gt;\x.exe</Command>"));
        assert!(xml.contains("O&apos;Neil"));
    }
}
