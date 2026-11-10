//! Windows: the same footprint install.ps1 leaves, written without PowerShell.
//! The "Xenon Edge Widget" logon task (the marker every other part keys on),
//! node-path.txt for start-hidden.vbs, and the "Installed apps" entry.

use std::io;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use crate::{system32_exe, BACKEND_TASK};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
pub(super) const UNINSTALL_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\XenonEdge";
/// The entry the app's installer (NSIS, per user) writes under its product name.
const SHELL_UNINSTALL_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Xenon";

pub(super) fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).filter(|p| p.is_absolute())
}

pub fn default_root() -> Option<PathBuf> {
    Some(local_app_data()?.join("Programs").join("Xenon"))
}

pub(super) fn quiet(exe: &str) -> Command {
    let mut cmd = Command::new(system32_exe(exe));
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// The engine root the registered task points at, from its own XML (never
/// the localised listing): `<Arguments>"…\server\start-hidden.vbs"</Arguments>`.
pub fn registered_root() -> Option<PathBuf> {
    let out = quiet("schtasks.exe").args(["/Query", "/TN", BACKEND_TASK, "/XML"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    root_from_task_xml(&crate::decode_console_bytes(&out.stdout))
}

/// The engine folder its "Installed apps" entry names (install.ps1 and this
/// app both write InstallLocation): finds an engine kept in a folder of the
/// user's choosing after its task went missing.
pub fn listed_root() -> Option<PathBuf> {
    let out = quiet("reg.exe").args(["query", UNINSTALL_KEY, "/v", "InstallLocation"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    reg_value(&crate::decode_console_bytes(&out.stdout), "InstallLocation").map(PathBuf::from)
}

/// One REG_SZ value from `reg query` output (`    Name    REG_SZ    value`).
/// Older install.ps1 versions stored the path with literal quotes.
pub fn reg_value(text: &str, name: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let rest = line.trim_start().strip_prefix(name)?;
        let value = rest.trim_start().strip_prefix("REG_SZ")?.trim().trim_matches('"');
        (!value.is_empty()).then(|| value.to_string())
    })
}

pub fn root_from_task_xml(xml: &str) -> Option<PathBuf> {
    let args = xml.split_once("<Arguments>")?.1.split_once("</Arguments>")?.0;
    let script = unescape(args.trim().trim_matches('"'));
    let script = PathBuf::from(script);
    script.parent()?.parent().map(Path::to_path_buf)
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn unescape(text: &str) -> String {
    text.replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

/// DOMAIN\user, as Get-CurrentTaskUserId builds it.
fn task_user() -> String {
    match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
        (Ok(domain), Ok(user)) if !domain.is_empty() => format!("{domain}\\{user}"),
        (_, Ok(user)) => user,
        _ => String::new(),
    }
}

/// The task install.ps1 registers unelevated: at logon, in the user's own
/// interactive session, limited rights, never stopped on battery, restarted
/// three times a minute apart, no time limit.
pub fn task_xml(root: &Path, user: &str) -> String {
    let server = root.join("server");
    let script = server.join("start-hidden.vbs");
    let wscript = system32_exe("wscript.exe");
    let user = escape(user);
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><URI>\{task}</URI><Description>Starts the Xenon dashboard engine when you sign in.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>{wscript}</Command><Arguments>"{script}"</Arguments><WorkingDirectory>{server}</WorkingDirectory></Exec></Actions>
</Task>
"#,
        task = escape(BACKEND_TASK),
        wscript = escape(&wscript.to_string_lossy()),
        script = escape(&script.to_string_lossy()),
        server = escape(&server.to_string_lossy()),
    )
}

/// schtasks reads /XML as UTF-16LE with a byte-order mark.
fn utf16_with_bom(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

fn run(cmd: &mut Command, what: &str) -> io::Result<()> {
    let status = cmd.status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("{what} exited with {status}")))
    }
}

fn register_task(root: &Path) -> io::Result<()> {
    let xml_path = std::env::temp_dir().join(format!("xenon-task-{}.xml", std::process::id()));
    std::fs::write(&xml_path, utf16_with_bom(&task_xml(root, &task_user())))?;
    let result = run(
        quiet("schtasks.exe").args(["/Create", "/TN", BACKEND_TASK, "/F", "/XML"]).arg(&xml_path),
        "schtasks /Create",
    );
    let _ = std::fs::remove_file(&xml_path);
    result
}

fn reg_add(key: &str, name: &str, kind: &str, value: &str) -> io::Result<()> {
    run(quiet("reg.exe").args(["add", key, "/v", name, "/t", kind, "/d", value, "/f"]), "reg add")
}

/// The one "Installed apps" entry: this app with `--uninstall` removes the
/// engine with no console and no administrator prompt, then runs the app's own
/// uninstaller, so the app's entry is hidden. Best-effort, as Register-UninstallEntry
/// is: a missing entry is no reason to fail the install.
fn register_uninstall_entry(root: &Path, version: &str) {
    let Ok(exe) = std::env::current_exe() else { return };
    let exe = exe.to_string_lossy().into_owned();
    let values = [
        ("DisplayName", "REG_SZ", "Xenon".to_string()),
        ("DisplayVersion", "REG_SZ", version.to_string()),
        ("Publisher", "REG_SZ", "marcimastro98".to_string()),
        ("InstallLocation", "REG_SZ", root.to_string_lossy().into_owned()),
        ("UninstallString", "REG_SZ", format!("\"{exe}\" {}", crate::UNINSTALL_ARG)),
        ("DisplayIcon", "REG_SZ", exe.clone()),
        ("NoModify", "REG_DWORD", "1".to_string()),
        ("NoRepair", "REG_DWORD", "1".to_string()),
    ];
    for (name, kind, value) in values {
        if let Err(e) = reg_add(UNINSTALL_KEY, name, kind, &value) {
            super::log(&format!("uninstall entry {name}: {e}"));
        }
    }
    hide_shell_entry();
}

/// Hides the installer's own "Xenon" entry when the engine was installed by
/// this app, whose entry removes both. Only an entry that exists is touched (a
/// `reg add` on a missing key would create a stub). Repeated at every start, as
/// an app update writes the entry again.
pub fn hide_shell_entry() {
    let exists = quiet("reg.exe").args(["query", SHELL_UNINSTALL_KEY, "/v", "UninstallString"]).status();
    if exists.is_ok_and(|s| s.success()) {
        let _ = reg_add(SHELL_UNINSTALL_KEY, "SystemComponent", "REG_DWORD", "1");
    }
}

pub(super) fn runtime_node(root: &Path) -> PathBuf {
    root.join(super::RUNTIME_DIR).join("node.exe")
}

pub fn after_copy(root: &Path) -> io::Result<()> {
    if runtime_node(root).is_file() {
        Ok(())
    } else {
        Err(io::Error::other("node.exe missing after the copy"))
    }
}

/// start-hidden.vbs reads this first (UTF-16LE): the node it must run. Written
/// at registration, not after the copy, so the self-test never repoints it.
fn write_node_path(root: &Path) -> io::Result<()> {
    let dir = local_app_data().ok_or_else(|| io::Error::other("LOCALAPPDATA is not set"))?.join("Xenon");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("node-path.txt"), utf16_with_bom(&runtime_node(root).to_string_lossy()))
}

fn write_mode_marker(root: &Path) -> io::Result<()> {
    let body = serde_json::json!({ "mode": "native", "engine": "carried", "at": crate::crash_log::now_utc() });
    std::fs::write(root.join("server").join("data").join("install-mode.json"), body.to_string())
}

pub fn register(root: &Path, version: &str) -> io::Result<()> {
    write_node_path(root)?;
    register_task(root)?;
    register_uninstall_entry(root, version);
    write_mode_marker(root)
}

/// Through the task, exactly as a sign-in would: start-hidden.vbs owns the
/// launch (port, logs, the one-engine rule).
pub fn start(_root: &Path, _port: u16) -> io::Result<()> {
    run(quiet("schtasks.exe").args(["/Run", "/TN", BACKEND_TASK]), "schtasks /Run")
}

pub fn start_detached_for_test(root: &Path, port: u16) -> io::Result<Child> {
    Command::new(runtime_node(root))
        .arg(root.join("server").join("server.js"))
        .current_dir(root)
        .env("XENON_PORT", port.to_string())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
}

/// CI only (`--check-register`): the task this install registers, created for
/// real under a throwaway name, read back and deleted. Proves schtasks takes
/// the XML and that the root reads back unchanged, on a runner, not a user's PC.
pub fn check_register(root: &Path, scratch: &Path) -> Result<(), String> {
    let name = format!("Xenon Selftest {}", std::process::id());
    let xml = scratch.join("task.xml");
    std::fs::write(&xml, utf16_with_bom(&task_xml(root, &task_user()))).map_err(|e| e.to_string())?;
    let created = quiet("schtasks.exe").args(["/Create", "/TN", &name, "/F", "/XML"]).arg(&xml).output();
    match created {
        Ok(out) if out.status.success() => {}
        Ok(out) => return Err(format!("schtasks /Create exited with {}", out.status)),
        Err(e) => return Err(e.to_string()),
    }
    let back = quiet("schtasks.exe").args(["/Query", "/TN", &name, "/XML"]).output();
    let _ = quiet("schtasks.exe").args(["/Delete", "/TN", &name, "/F"]).output();
    let back = back.map_err(|e| e.to_string())?;
    match root_from_task_xml(&crate::decode_console_bytes(&back.stdout)) {
        Some(read) if read == root => Ok(()),
        other => Err(format!("the task reads back {other:?}, not {}", root.display())),
    }
}
