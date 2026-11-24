//! An install a package manager owns. The Nix package sets `XENON_MANAGED_BY=nix`
//! in the wrapper that starts the app. Such an install never replaces its own
//! program (the manager does), links the engine's runtime instead of copying it
//! (a copy keeps pointing at libraries the manager deletes after an upgrade), and
//! starts at login by name, not by a path the next upgrade removes.
//! Only Linux has such a package today; the module builds everywhere so its tests run on any PC.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

const VAR: &str = "XENON_MANAGED_BY";

/// The program a package puts on PATH: the login entry starts it by this name.
pub(crate) const PROGRAM: &str = "xenon-native";

/// The manager's name, when the variable holds one short plain word.
pub(crate) fn manager() -> Option<String> {
    parse(std::env::var(VAR).ok().as_deref())
}

pub(crate) fn is_managed() -> bool {
    manager().is_some()
}

fn parse(raw: Option<&str>) -> Option<String> {
    let value = raw?.trim();
    let plain = value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    (!value.is_empty() && value.len() <= 32 && plain).then(|| value.to_string())
}

/// The login entry's text with its `Exec=` line starting `command` instead.
pub(crate) fn exec_line_replaced(text: &str, command: &str) -> String {
    let mut out: Vec<String> = text
        .lines()
        .map(|line| if line.starts_with("Exec=") { format!("Exec={command}") } else { line.to_string() })
        .collect();
    if text.ends_with('\n') {
        out.push(String::new());
    }
    out.join("\n")
}

/// Points the login entry at the program by name, through PATH. True when the
/// file changed; an entry already naming it is left as it is.
pub(crate) fn name_login_entry(file: &std::path::Path) -> std::io::Result<bool> {
    let text = std::fs::read_to_string(file)?;
    let named = exec_line_replaced(&text, &format!("{PROGRAM} --autostart"));
    if named == text {
        return Ok(false);
    }
    std::fs::write(file, named)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_word_names_the_manager() {
        assert_eq!(parse(Some("nix")).as_deref(), Some("nix"));
        assert_eq!(parse(Some(" nix \n")).as_deref(), Some("nix"));
        assert_eq!(parse(Some("guix-2")).as_deref(), Some("guix-2"));
    }

    #[test]
    fn anything_else_is_not_a_manager() {
        for raw in [None, Some(""), Some("  "), Some("Nix"), Some("nix pkgs"), Some("../nix"), Some(&"n".repeat(33))] {
            assert_eq!(parse(raw), None, "{raw:?}");
        }
    }

    #[test]
    fn only_the_exec_line_changes() {
        let entry = "[Desktop Entry]\nType=Application\nExec=/nix/store/abc-xenon/bin/.xenon-native-wrapped --autostart\nTerminal=false";
        let out = exec_line_replaced(entry, "xenon-native --autostart");
        assert_eq!(out, "[Desktop Entry]\nType=Application\nExec=xenon-native --autostart\nTerminal=false");
        assert_eq!(exec_line_replaced(&format!("{entry}\n"), "x"), format!("{}\n", exec_line_replaced(entry, "x")));
    }

    #[test]
    fn the_login_entry_is_named_once_and_a_missing_one_is_an_error() {
        let dir = std::env::temp_dir().join(format!("xenon-managed-entry-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Xenon.desktop");
        std::fs::write(&file, "[Desktop Entry]\nExec=/nix/store/abc-xenon/bin/.xenon-native-wrapped --autostart\n").unwrap();
        assert!(name_login_entry(&file).unwrap());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "[Desktop Entry]\nExec=xenon-native --autostart\n");
        assert!(!name_login_entry(&file).unwrap(), "a named entry is not rewritten");
        assert!(name_login_entry(&dir.join("missing.desktop")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
