//! macOS: the footprint install.sh leaves. backend.json tells this app where the
//! engine is, and the login agent opens Xenon.app, which starts the engine as
//! its own child (so it inherits the app's Full Disk Access, see lib.rs).

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

const LABEL: &str = "com.marcimastro98.xenon.backend";

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|p| p.is_absolute())
}

fn support_dir() -> Option<PathBuf> {
    Some(home()?.join("Library/Application Support/Xenon"))
}

pub fn default_root() -> Option<PathBuf> {
    support_dir()
}

pub fn registered_root() -> Option<PathBuf> {
    let entry = crate::backend_entry(&home()?)?;
    entry.parent()?.parent().map(Path::to_path_buf)
}

pub fn after_copy(root: &Path) -> io::Result<()> {
    super::posix::make_runtime_executable(root)
}

/// `/Applications/Xenon.app` from `…/Xenon.app/Contents/MacOS/xenon-native`.
/// None while the app runs from the disk image: a login item pointing into
/// /Volumes would vanish with it.
fn app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let app = exe.parent()?.parent()?.parent()?.to_path_buf();
    let is_app = app.extension().map(|e| e == "app").unwrap_or(false);
    (is_app && !app.starts_with("/Volumes")).then_some(app)
}

fn plist(app: &Path, logs: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>{app}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>{logs}/backend.log</string>
  <key>StandardErrorPath</key>
  <string>{logs}/backend.err.log</string>
</dict>
</plist>
"#,
        app = super::posix::xml_escape(&app.to_string_lossy()),
        logs = super::posix::xml_escape(&logs.to_string_lossy()),
    )
}

fn write_backend_pointer(root: &Path) -> io::Result<()> {
    let dir = support_dir().ok_or_else(|| io::Error::other("HOME is not set"))?;
    std::fs::create_dir_all(&dir)?;
    let entry = root.join("server/server.js");
    let body = serde_json::json!({ "entry": entry, "root": root });
    std::fs::write(dir.join("backend.json"), serde_json::to_vec_pretty(&body)?)
}

fn agent_path(home: &Path) -> PathBuf {
    home.join("Library/LaunchAgents").join(format!("{LABEL}.plist"))
}

/// Writes the login agent for the app at its current place; None when there
/// is no stable place yet (still on the disk image).
fn write_login_agent(home: &Path) -> io::Result<Option<PathBuf>> {
    let Some(app) = app_bundle() else {
        super::log("running from the disk image: no login item until Xenon is in Applications");
        return Ok(None);
    };
    let logs = home.join("Library/Logs/Xenon");
    let path = agent_path(home);
    std::fs::create_dir_all(path.parent().unwrap_or(home))?;
    std::fs::create_dir_all(&logs)?;
    std::fs::write(&path, plist(&app, &logs))?;
    Ok(Some(path))
}

/// An install this app made while it ran from the disk image has no login
/// item. Once the app runs from a stable place, write it (it takes effect at
/// the next sign-in; this launch already started the engine). Installs made by
/// install.sh carry no runtime folder and are left exactly as they are.
pub fn ensure_login_item(root: &Path) {
    if !root.join(super::RUNTIME_DIR).is_dir() {
        return;
    }
    let Some(home) = home() else { return };
    if agent_path(&home).exists() {
        return;
    }
    if let Err(e) = write_login_agent(&home) {
        super::log(&format!("login item: {e}"));
    }
}

fn register_login_agent() -> io::Result<()> {
    let home = home().ok_or_else(|| io::Error::other("HOME is not set"))?;
    let Some(path) = write_login_agent(&home)? else { return Ok(()) };
    if let Some(uid) = crate::current_uid() {
        let domain = format!("gui/{uid}");
        let _ = Command::new("launchctl").args(["bootout", &format!("{domain}/{LABEL}")]).status();
        let _ = Command::new("launchctl").args(["bootstrap", &domain]).arg(&path).status();
    }
    Ok(())
}

pub fn register(root: &Path, _version: &str) -> io::Result<()> {
    write_backend_pointer(root)?;
    register_login_agent()?;
    super::posix::write_mode_marker(root)
}

pub fn start(root: &Path, _port: u16) -> io::Result<()> {
    if crate::start_backend_child(&root.join("server/server.js")) {
        Ok(())
    } else {
        Err(io::Error::other("the engine could not be started"))
    }
}

pub fn start_detached_for_test(root: &Path, port: u16) -> io::Result<Child> {
    super::posix::spawn_test_engine(root, port, Command::new(root.join(super::RUNTIME_DIR).join("bin/node")))
}

/// CI only (`--check-register`): the login agent this install writes, checked
/// by plutil in a scratch folder. Nothing is loaded into launchd.
pub fn check_register(root: &Path, scratch: &Path) -> Result<(), String> {
    let app = app_bundle().ok_or("not running from an .app outside a disk image")?;
    let path = scratch.join(format!("{LABEL}.plist"));
    std::fs::write(&path, plist(&app, scratch)).map_err(|e| e.to_string())?;
    let lint = Command::new("plutil").arg("-lint").arg(&path).output().map_err(|e| e.to_string())?;
    if !lint.status.success() {
        return Err(format!("plutil: {}", String::from_utf8_lossy(&lint.stdout).trim()));
    }
    let node = root.join(super::RUNTIME_DIR).join("bin/node");
    if node.is_file() { Ok(()) } else { Err(format!("{} is missing", node.display())) }
}
