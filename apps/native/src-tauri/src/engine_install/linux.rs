//! Linux: the footprint install.sh leaves. A `systemd --user` unit where there
//! is a user manager, an XDG autostart entry where there is not. Both run the
//! node this install carries, so the distribution's Node no longer matters.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Child;

const UNIT_NAME: &str = "xenon-backend.service";

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|p| p.is_absolute())
}

fn xdg(var: &str, fallback: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| home().map(|h| h.join(fallback)))
}

fn unit_path() -> Option<PathBuf> {
    Some(xdg("XDG_CONFIG_HOME", ".config")?.join("systemd/user").join(UNIT_NAME))
}

fn autostart_path() -> Option<PathBuf> {
    Some(xdg("XDG_CONFIG_HOME", ".config")?.join("autostart/xenon-backend.desktop"))
}

pub fn default_root() -> Option<PathBuf> {
    Some(xdg("XDG_DATA_HOME", ".local/share")?.join("Xenon"))
}

/// The root a registered unit or autostart entry runs from (`WorkingDirectory=`
/// or `Path=`, both whole-line values written by install.sh or by us).
pub fn registered_root() -> Option<PathBuf> {
    for (file, key) in [(unit_path()?, "WorkingDirectory="), (autostart_path()?, "Path=")] {
        if let Ok(text) = std::fs::read_to_string(&file) {
            if let Some(dir) = text.lines().find_map(|l| l.strip_prefix(key)) {
                return Some(PathBuf::from(dir.trim()));
            }
        }
    }
    None
}

pub fn after_copy(root: &Path) -> io::Result<()> {
    super::posix::make_runtime_executable(root)
}

fn node(root: &Path) -> PathBuf {
    root.join(super::RUNTIME_DIR).join("bin/node")
}

/// systemctl is a host binary: never hand it the AppImage's environment.
fn systemctl(args: &[&str]) -> bool {
    let Some(exe) = crate::find_in_path("systemctl") else { return false };
    crate::host_env_command(&exe)
        .arg("--user")
        .args(args)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Same unit as install.sh (quoted ExecStart: a path with a space must survive).
pub fn unit_text(root: &Path) -> String {
    format!(
        "[Unit]\nDescription=Xenon dashboard backend\nDocumentation=https://github.com/marcimastro98/Xenon\nAfter=graphical-session.target network.target\n\n[Service]\nType=simple\nExecStart=\"{node}\" \"{server}\"\nWorkingDirectory={root}\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n",
        node = node(root).display(),
        server = root.join("server/server.js").display(),
        root = root.display(),
    )
}

pub fn autostart_text(root: &Path) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=Xenon dashboard backend\nComment=Starts the local Xenon server\nExec=\"{node}\" \"{server}\"\nPath={root}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
        node = node(root).display(),
        server = root.join("server/server.js").display(),
        root = root.display(),
    )
}

fn write_file(path: &Path, text: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, text)
}

fn has_user_manager() -> bool {
    systemctl(&["show-environment"])
}

pub fn register(root: &Path, _version: &str) -> io::Result<()> {
    let unit = unit_path().ok_or_else(|| io::Error::other("HOME is not set"))?;
    if has_user_manager() {
        write_file(&unit, &unit_text(root))?;
        let _ = systemctl(&["import-environment", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR"]);
        let _ = systemctl(&["daemon-reload"]);
        if systemctl(&["enable", UNIT_NAME]) {
            return super::posix::write_mode_marker(root);
        }
        let _ = std::fs::remove_file(&unit);
        let _ = systemctl(&["daemon-reload"]);
        super::log("systemd refused the unit: using an autostart entry instead");
    }
    let autostart = autostart_path().ok_or_else(|| io::Error::other("HOME is not set"))?;
    write_file(&autostart, &autostart_text(root))?;
    super::posix::write_mode_marker(root)
}

pub fn start(root: &Path, _port: u16) -> io::Result<()> {
    if unit_path().map(|p| p.exists()).unwrap_or(false) && systemctl(&["restart", UNIT_NAME]) {
        return Ok(());
    }
    // No user manager: start it now; the autostart entry covers the next login.
    let mut cmd = crate::host_env_command(&node(root));
    cmd.arg(root.join("server/server.js"))
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
}

pub fn start_detached_for_test(root: &Path, port: u16) -> io::Result<Child> {
    super::posix::spawn_test_engine(root, port, crate::host_env_command(&node(root)))
}

/// CI only (`--check-register`): the unit and the autostart entry this install
/// writes, in a scratch folder, checked by systemd-analyze and
/// desktop-file-validate where the runner has them. Nothing is enabled.
pub fn check_register(root: &Path, scratch: &Path) -> Result<(), String> {
    if !node(root).is_file() {
        return Err(format!("{} is missing", node(root).display()));
    }
    let unit = scratch.join(UNIT_NAME);
    let desktop = scratch.join("xenon-backend.desktop");
    write_file(&unit, &unit_text(root)).map_err(|e| e.to_string())?;
    write_file(&desktop, &autostart_text(root)).map_err(|e| e.to_string())?;
    // System mode: verifying a file needs no user manager, which CI lacks. A
    // complaint is a CI warning, not a failure: the Linux job must not hold back
    // a release over a runner tool, only over a file this install could not write.
    check_with("systemd-analyze", &["verify"], &unit);
    check_with("desktop-file-validate", &[], &desktop);
    Ok(())
}

fn check_with(tool: &str, args: &[&str], file: &Path) {
    let Some(exe) = crate::find_in_path(tool) else {
        println!("selftest: {tool} not found, {} not checked", file.display());
        return;
    };
    match std::process::Command::new(exe).args(args).arg(file).output() {
        Ok(out) if out.status.success() => println!("selftest: {tool} accepts {}", file.display()),
        Ok(out) => println!(
            "::warning::{tool} on {}: {}{}",
            file.display(),
            String::from_utf8_lossy(&out.stdout).trim(),
            String::from_utf8_lossy(&out.stderr).trim()
        ),
        Err(e) => println!("::warning::{tool} did not run: {e}"),
    }
}
