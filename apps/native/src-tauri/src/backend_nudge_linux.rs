// Linux: waking an engine that does not answer, or offering to set it up in a terminal window.

#[cfg(target_os = "linux")]
use crate::engine_install;
#[cfg(target_os = "linux")]
use crate::backend_probe::backend_answers;

/// Linux twin. Same two signals, written by `server/install.sh`: the
/// `systemd --user` unit, or the XDG autostart entry it falls back to where
/// there is no user manager.
///
/// Neither package can install the backend for us. An AppImage has no install
/// hook at all, and a .deb's post-install script runs as ROOT — while the login
/// service, the install root and the data directory all belong to ONE user's
/// session (the same rule that keeps the Windows backend out of a session-0
/// service). First launch is the only moment that knows whose Xenon this is.
#[cfg(target_os = "linux")]
pub(crate) fn spawn_backend_nudge(app: &tauri::AppHandle, port: u16) {
    use tauri::path::BaseDirectory;
    use tauri::Manager;
    let script = app
        .path()
        .resolve("posix/xenon-bootstrap.sh", BaseDirectory::Resource)
        .ok();
    let config = app.path().config_dir().ok();
    let handle = app.clone();
    std::thread::spawn(move || {
        if backend_answers(port) {
            return;
        }
        if port != 3030 {
            return;
        }
        let unit = config
            .as_ref()
            .map(|c| c.join("systemd/user/xenon-backend.service"));
        let autostart = config
            .as_ref()
            .map(|c| c.join("autostart/xenon-backend.desktop"));
        // The unit exists but nothing answers: it crashed, or its login start
        // never fired. `--user restart` is the only correct verb here; a system
        // `systemctl` would address a unit that does not exist.
        if unit.map(|p| p.exists()).unwrap_or(false) {
            let _ = std::process::Command::new("systemctl")
                .args(["--user", "restart", "xenon-backend.service"])
                .status();
            return;
        }
        // Installed, but through the autostart fallback: there is no manager to
        // ask, and that entry only fires at login. Starting a second copy from
        // here would just fight for the port, so this waits for the next login
        // exactly as install.sh said it would.
        if autostart.map(|p| p.exists()).unwrap_or(false) {
            return;
        }
        // Nothing installed. A build that carries the engine sets it up itself,
        // with progress on the splash; an older one offers the bootstrap in a
        // terminal the user can read and interrupt.
        if engine_install::packaged(&handle).is_some() {
            engine_install::spawn(&handle, port);
            return;
        }
        let Some(script) = script else { return };
        if !script.exists() {
            return;
        }
        let _ = run_in_terminal(&script);
    });
}

/// Open `script` in whatever terminal emulator this desktop has, running it
/// through `bash` so neither the executable bit (Tauri copies resources without
/// it) nor the shebang has to be right.
///
/// The list is ordered by how likely the emulator is to be the session's own,
/// and every entry takes the command as SEPARATE argv elements — never a single
/// string to be re-parsed, which would break the moment a home directory has a
/// space in it. Returning false is a real outcome: a desktop with no terminal at
/// all cannot be shown an installer, and the README's manual command is then the
/// only honest answer.
///
/// Two details are what make this actually reach the user from inside an
/// AppImage:
///
///  * the terminal is a HOST binary and must not be handed the AppImage's
///    environment (see host_env_command). Spawned with it, gnome-terminal on
///    Fedora 43 dies instantly with "undefined symbol: g_once_init_enter_pointer"
///    — the host's libvte against the AppImage's older bundled glib;
///  * `spawn()` succeeding does not mean the terminal opened. That is exactly the
///    failure above: the process starts and exits 127 before drawing anything,
///    while this reported success and moved on, leaving the splash spinning at a
///    user who was never shown a thing. So a candidate that DIES quickly is a
///    candidate that failed, and the next one is tried. Still running, or gone
///    with status 0, both count as opened: gnome-terminal is a client that hands
///    the window to gnome-terminal-server and returns 0 immediately.
#[cfg(target_os = "linux")]
fn run_in_terminal(script: &std::path::Path) -> bool {
    const TERMINALS: &[(&str, &[&str])] = &[
        ("x-terminal-emulator", &["-e"]), // Debian/Ubuntu alternatives symlink
        ("gnome-terminal", &["--"]),
        ("ptyxis", &["--"]), // Fedora 40+ / GNOME 47+ default
        ("kgx", &["-e"]),    // GNOME Console
        ("konsole", &["-e"]),
        ("xfce4-terminal", &["-x"]),
        ("mate-terminal", &["--"]),
        ("tilix", &["-e"]),
        ("alacritty", &["-e"]),
        ("kitty", &[]),
        ("foot", &[]),
        ("wezterm", &["start", "--"]),
        ("xterm", &["-e"]),
    ];
    for (bin, prefix) in TERMINALS {
        let Some(exe) = find_in_path(bin) else { continue };
        let mut command = host_env_command(&exe);
        let Ok(mut child) = command.args(*prefix).arg("bash").arg(script).spawn() else {
            continue;
        };
        let failed = terminal_failed(|| match child.try_wait() {
            Ok(None) => None,
            Ok(Some(status)) => Some(status.success()),
            Err(_) => Some(true),
        });
        if !failed {
            return true;
        }
        // It exited non-zero. Nothing was shown, so the next one is tried.
    }
    false
}

/// Whether a terminal died with an error in its first ~1.5s: long enough for a
/// loader error to land, short enough that the splash's own setup button is still
/// responsive behind it. `poll` is `None` while it runs, `Some(clean)` once gone.
#[cfg(target_os = "linux")]
fn terminal_failed(mut poll: impl FnMut() -> Option<bool>) -> bool {
    for _ in 0..15 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Some(clean) = poll() {
            return !clean;
        }
    }
    false
}

#[cfg(all(test, target_os = "linux"))]
mod terminal_tests {
    use super::terminal_failed;

    #[test]
    fn a_terminal_that_dies_after_the_first_look_has_failed() {
        let mut looks = 0;
        assert!(terminal_failed(|| {
            looks += 1;
            (looks == 5).then_some(false)
        }));
        assert_eq!(looks, 5);
    }

    #[test]
    fn a_clean_exit_or_a_running_terminal_counts_as_opened() {
        assert!(!terminal_failed(|| Some(true)));
        assert!(!terminal_failed(|| None));
    }
}

/// A `Command` for a HOST binary, with the AppImage's environment stripped back
/// out of it.
///
/// An AppImage's AppRun exports LD_LIBRARY_PATH, GTK_PATH, GIO_EXTRA_MODULES,
/// PYTHONHOME and a dozen more, all pointing into the read-only mount, and every
/// child inherits them. That is right for our own bundled binaries and wrong for
/// anything from /usr/bin: the host binary gets loaded against the AppImage's
/// (older, Ubuntu-built) libraries and dies on a missing symbol. So drop every
/// variable whose value points into $APPDIR, and for the two that are LISTS
/// (PATH, XDG_DATA_DIRS) drop only the AppDir entries — emptying those outright
/// would break the child in a different way.
///
/// Outside an AppImage $APPDIR is unset and this is a plain `Command::new`.
#[cfg(target_os = "linux")]
pub(crate) fn host_env_command(exe: &std::path::Path) -> std::process::Command {
    let mut command = std::process::Command::new(exe);
    let Some(appdir) = std::env::var_os("APPDIR") else {
        return command;
    };
    let appdir = appdir.to_string_lossy().to_string();
    if appdir.is_empty() {
        return command;
    }
    for (key, value) in std::env::vars_os() {
        let value = value.to_string_lossy().to_string();
        if !value.contains(&appdir) {
            continue;
        }
        let key_str = key.to_string_lossy().to_string();
        if key_str == "PATH" || key_str == "XDG_DATA_DIRS" {
            let kept: Vec<&str> = value
                .split(':')
                .filter(|entry| !entry.is_empty() && !entry.contains(&appdir))
                .collect();
            command.env(&key, kept.join(":"));
        } else {
            command.env_remove(&key);
        }
    }
    command
}

/// Locate a binary on PATH. A dependency-free stand-in for `which`.
#[cfg(target_os = "linux")]
pub(crate) fn find_in_path(bin: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|p| p.is_file())
}
