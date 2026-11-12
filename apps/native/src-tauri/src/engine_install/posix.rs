//! What macOS and Linux share.

use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Child, Command};

/// Packages do not all keep the executable bit on resources, so it is set here.
pub fn make_runtime_executable(root: &Path) -> io::Result<()> {
    let bin = root.join(super::RUNTIME_DIR).join("bin");
    if !bin.join("node").is_file() {
        return Err(io::Error::other("bin/node missing after the copy"));
    }
    for name in ["node", "npm", "npx"] {
        let path = bin.join(name);
        if path.is_file() {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(())
}

pub fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn write_mode_marker(root: &Path) -> io::Result<()> {
    let body = serde_json::json!({ "mode": "native", "engine": "carried", "at": crate::crash_log::now_utc() });
    std::fs::write(root.join("server/data/install-mode.json"), body.to_string())
}

pub fn spawn_test_engine(root: &Path, port: u16, mut node: Command) -> io::Result<Child> {
    node.arg(root.join("server/server.js"))
        .current_dir(root)
        .env("XENON_PORT", port.to_string())
        .spawn()
}
