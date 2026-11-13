// The Windows startup task of the engine: reading its state, starting it and switching it back on.

#[cfg(windows)]
use tauri::Manager;
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
#[cfg(windows)]
use crate::backend_answers_once;
#[cfg(windows)]
use crate::system32_exe;

/// Self-heal for a missing backend: the kiosk is only a shell for the local
/// dashboard, so if nothing answers on 127.0.0.1:3030 shortly after launch the
/// splash would spin forever (reported in the wild as "stuck on waiting for the
/// Xenon service"). Nudge the widget's per-logon scheduled task ("Xenon Edge
/// Widget", registered by the widget installer) once, best-effort — it covers a
/// backend that crashed or whose logon start never fired. The probe MUST come
/// first: the task's start-hidden.vbs kills whatever listens on 3030 before
/// starting node, so nudging while a healthy server runs would restart it.
/// If the task does not exist the backend was never installed, and that is a
/// different situation from a slow start: it is the one every fresh setup.exe
/// install is in. The task is therefore QUERIED before it is run, and its
/// absence is told to the splash, which offers its setup button immediately
/// instead of spinning in silence for twenty seconds first (SETUP_AFTER_MS in
/// splash/index.html). The wait is not wrong when something might still be
/// starting; it is wrong when nothing is going to.
/// The name of the widget's per-logon task, in one place: three call sites
/// query, enable and run it.
#[cfg(windows)]
pub(crate) const BACKEND_TASK: &str = "Xenon Edge Widget";

/// What the startup task is doing, as opposed to whether it exists.
#[cfg(windows)]
#[derive(PartialEq, Clone, Copy, Debug)]
pub(crate) enum TaskState {
    /// Never registered — the backend was never installed here.
    Missing,
    /// Registered and switched OFF, so nothing will ever start it. Windows
    /// offers this toggle in Task Manager's "Startup apps", and cleanup tools
    /// flip it too; a `schtasks /Query` succeeds either way, which is why this
    /// used to be invisible and read as "installed, just slow".
    Disabled,
    Enabled,
}

/// Reads the task's own XML rather than the human-readable listing, because
/// `/Query /V /FO LIST` is LOCALISED — "Status: Disabled" is "Stato:
/// Disabilitato" on an Italian PC — while XML element names never are.
#[cfg(windows)]
fn task_state_from_xml(xml: &str) -> TaskState {
    // Only the <Settings> block: a <Trigger> carries an <Enabled> of its own,
    // and matching that one would report a perfectly healthy task as off.
    let settings = xml
        .split_once("<Settings")
        .and_then(|(_, rest)| rest.split_once("</Settings>"))
        .map(|(block, _)| block)
        .unwrap_or("");
    if settings.contains("<Enabled>false</Enabled>") {
        TaskState::Disabled
    } else {
        TaskState::Enabled
    }
}

/// schtasks writes its XML as UTF-16LE with a BOM when redirected, and plain
/// bytes otherwise. Decode whichever arrived instead of assuming.
#[cfg(windows)]
pub(crate) fn decode_console_bytes(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[cfg(windows)]
pub(crate) fn backend_task_state() -> TaskState {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new(system32_exe("schtasks.exe"))
        .args(["/Query", "/TN", BACKEND_TASK, "/XML"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match out {
        Ok(o) if o.status.success() => task_state_from_xml(&decode_console_bytes(&o.stdout)),
        _ => TaskState::Missing,
    }
}

/// The splash's "Start Xenon" button, routed through `xenon-setup:start`: the
/// engine is installed and its task is on, it is just not running. Never fired
/// at an engine that answers, because start-hidden.vbs stops whatever listens
/// on the port before it starts node.
#[cfg(windows)]
pub(crate) fn start_backend_task(app: &tauri::AppHandle, port: u16) {
    let handle = app.clone();
    // Off the WebView UI thread: called from the navigation hook, which runs on
    // it, and the probe plus process creation block.
    std::thread::spawn(move || {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if backend_answers_once(port) {
            return;
        }
        let started = std::process::Command::new(system32_exe("schtasks.exe"))
            .args(["/Run", "/TN", BACKEND_TASK])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !started {
            if let Some(win) = handle.get_webview_window("main") {
                let _ = win.eval("try{window.__XENON_START_FAILED__=true;}catch(e){}");
            }
        }
    });
}

/// Switches the startup task back on and starts it — the splash's "Turn it back
/// on" button, routed through `xenon-setup:enable-task`.
///
/// Only ever reached from an explicit tap, and only after the shell has
/// established that the task IS registered and IS off (see the nudge above).
/// It also clears the two battery conditions, because every install before
/// v4.11.5 carries Task Scheduler's defaults for them: the dashboard would not
/// start on battery and was stopped on unplug. Repairing that here is what
/// reaches the laptops already out there — the installer fix only helps the
/// next install.
#[cfg(windows)]
pub(crate) fn repair_startup_task(app: &tauri::AppHandle) {
    let handle = app.clone();
    // Off the WebView UI thread: this is called from the navigation hook, which
    // runs on it, and process creation blocks.
    std::thread::spawn(move || {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let enabled = std::process::Command::new(system32_exe("schtasks.exe"))
            .args(["/Change", "/TN", BACKEND_TASK, "/ENABLE"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        // The battery conditions have no schtasks switch at all, so this one
        // goes through the cmdlets. A constant command with no interpolation —
        // there is no input here to build a string out of. Best-effort: failing
        // it still leaves a task that starts on mains power.
        let system_root =
            std::env::var("SystemRoot").unwrap_or_else(|_| String::from("C:\\Windows"));
        let powershell = std::path::Path::new(&system_root)
            .join("System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        let _ = std::process::Command::new(powershell)
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "$t = Get-ScheduledTask -TaskName 'Xenon Edge Widget' -ErrorAction Stop; \
                 $t.Settings.DisallowStartIfOnBatteries = $false; \
                 $t.Settings.StopIfGoingOnBatteries = $false; \
                 Set-ScheduledTask -InputObject $t | Out-Null",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        if enabled {
            let _ = std::process::Command::new(system32_exe("schtasks.exe"))
                .args(["/Run", "/TN", BACKEND_TASK])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        } else if let Some(win) = handle.get_webview_window("main") {
            // Enabling a task registered at the highest run level can need an
            // administrator, and nothing else here would ever say so — the page
            // would just keep spinning at a task still switched off.
            let _ = win.eval("try{window.__XENON_TASK_ENABLE_FAILED__=true;}catch(e){}");
        }
    });
}

// The only part of the startup-task check that can be tested without a PC in
// the broken state: the XML reading. It replaced a localised-text parse for
// exactly this reason.
#[cfg(all(test, windows))]
mod task_state_tests {
    use super::*;

    const ON: &str = r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2"><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><Enabled>true</Enabled></Settings></Task>"#;

    #[test]
    fn an_enabled_task_reads_as_enabled() {
        assert_eq!(task_state_from_xml(ON), TaskState::Enabled);
    }

    #[test]
    fn a_switched_off_task_reads_as_disabled() {
        let off = ON.replace("<Enabled>true</Enabled></Settings>", "<Enabled>false</Enabled></Settings>");
        assert_eq!(task_state_from_xml(&off), TaskState::Disabled);
    }

    // The bug this parser exists to avoid: a trigger carries an <Enabled> of its
    // own, so a whole-document search reports a healthy task as switched off.
    #[test]
    fn a_disabled_trigger_is_not_a_disabled_task() {
        let odd = ON.replace("<LogonTrigger><Enabled>true</Enabled>", "<LogonTrigger><Enabled>false</Enabled>");
        assert_eq!(task_state_from_xml(&odd), TaskState::Enabled);
    }

    // Unreadable output must never read as "switched off": that would offer the
    // repair button to someone whose task is fine.
    #[test]
    fn unparseable_output_is_not_disabled() {
        assert_eq!(task_state_from_xml(""), TaskState::Enabled);
        assert_eq!(task_state_from_xml("ERROR: access denied"), TaskState::Enabled);
    }

    #[test]
    fn utf16_output_with_a_bom_is_decoded() {
        let mut bytes = vec![0xFF, 0xFE];
        for u in "<Settings><Enabled>false</Enabled></Settings>".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(task_state_from_xml(&decode_console_bytes(&bytes)), TaskState::Disabled);
        // …and plain bytes still work, because schtasks only uses UTF-16 when
        // its output is redirected.
        assert_eq!(decode_console_bytes(b"<Settings/>"), "<Settings/>");
    }
}
