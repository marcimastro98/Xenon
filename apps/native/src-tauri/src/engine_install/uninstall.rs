//! `xenon-native.exe --uninstall`, the one "Installed apps" entry of an engine
//! this app installed. One question in the Windows language (keep the user's
//! data or not), then: the login tasks go, whatever runs from Xenon's folders
//! stops, the engine's files go, and the app's own uninstaller finishes
//! silently. No console, no PowerShell, no administrator prompt: everything
//! here is the user's own, except an engine task "Install sensors" raised to
//! run as administrator, which asks once. An engine installed with INSTALL.bat keeps its
//! UNINSTALL.bat, which also undoes what that installer did as administrator.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::uninstall_words::{self as words, Words};
use super::win_api::{self as api, is_inside};
use super::windows::{local_app_data, quiet, UNINSTALL_KEY};
use crate::{system32_exe, BACKEND_TASK};

const APP_TASK: &str = "Xenon App";
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const APP_DATA_DIR: &str = "com.marcimastro98.xenon";

pub fn run() -> i32 {
    let words = words::for_language(api::ui_language());
    let root = super::target_root().ok();
    // A copy that never finished still carries this app's marker: it is ours to remove.
    let engine = root.as_deref().filter(|r| super::has_engine(r) || is_carried(r));
    if let Some(root) = engine.filter(|r| !is_carried(r)) {
        say(words, &words.not_ours.replace("{path}", &root.to_string_lossy()), api::MB_ICONINFORMATION);
        return 1;
    }
    let keep = match api::message(words.title, words.ask, api::MB_YESNOCANCEL | api::MB_ICONQUESTION) {
        api::IDYES => true,
        api::IDNO => false,
        _ => return 0,
    };
    let shell = std::env::current_exe().ok();
    unregister();
    if !remove_raised_task() {
        say(words, &words.task_left.replace("{task}", BACKEND_TASK), api::MB_ICONWARNING);
    }
    stop_processes(engine, shell.as_deref());
    remove_engine_files_beside_app();
    let left = engine.and_then(|root| remove_engine(root, keep));
    if !keep {
        remove_app_data();
    }
    match (left, engine) {
        (Some(dir), _) => say(words, &words.partial.replace("{path}", &dir.to_string_lossy()), api::MB_ICONWARNING),
        (None, Some(root)) if keep => {
            let data = root.join("server").join("data");
            say(words, &words.done_kept.replace("{path}", &data.to_string_lossy()), api::MB_ICONINFORMATION);
        }
        _ if keep => say(words, words.done, api::MB_ICONINFORMATION),
        _ => say(words, words.done_all, api::MB_ICONINFORMATION),
    }
    run_app_uninstaller(shell.as_deref());
    0
}

fn say(words: &Words, text: &str, icon: u32) {
    api::message(words.title, text, api::MB_OK | icon);
}

/// Only an engine this app put there (install-mode.json says "carried").
pub(super) fn is_carried(root: &Path) -> bool {
    let marker = root.join("server").join("data").join("install-mode.json");
    std::fs::read_to_string(marker)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .is_some_and(|v| v.get("engine").and_then(|e| e.as_str()) == Some("carried"))
}

/// Login tasks, the Run value and the engine's entry. Each may already be
/// gone, which is the wanted state.
fn unregister() {
    for task in [BACKEND_TASK, APP_TASK] {
        let _ = quiet("schtasks.exe").args(["/Delete", "/TN", task, "/F"]).status();
    }
    let _ = quiet("reg.exe").args(["delete", RUN_KEY, "/v", "Xenon", "/f"]).status();
    let _ = quiet("reg.exe").args(["delete", UNINSTALL_KEY, "/f"]).status();
}

/// "Install sensors" raises the engine task to run as administrator, and only
/// an administrator can delete a task raised that way. One visible prompt then,
/// never a silent leftover that runs a missing script at every sign-in.
/// False when the task is still there.
fn remove_raised_task() -> bool {
    if !task_exists(BACKEND_TASK) {
        return true;
    }
    api::run_elevated(&system32_exe("schtasks.exe"), &delete_task_parameters(BACKEND_TASK));
    !task_exists(BACKEND_TASK)
}

fn task_exists(task: &str) -> bool {
    quiet("schtasks.exe").args(["/Query", "/TN", task]).output().is_ok_and(|out| out.status.success())
}

/// schtasks' own command line: the name is a constant with spaces, quoted.
pub(super) fn delete_task_parameters(task: &str) -> String {
    format!("/Delete /TN \"{task}\" /F")
}

/// What the engine and its installer write beside the app (start-hidden.vbs
/// logs there): the app's own uninstaller removes only its own files, so a
/// folder holding these would outlive it. After the engine has stopped.
fn remove_engine_files_beside_app() {
    let Some(dir) = local_app_data().map(|d| d.join("Xenon")) else { return };
    for name in ["node-path.txt", "server.log", "server.log.1", "setup.log"] {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/// The engine (its Node, the helper, anything else run from its folder) and
/// every other window of this app, chosen by program path, never by port.
fn stop_processes(engine: Option<&Path>, shell: Option<&Path>) {
    let ended = api::end_processes(|program| {
        engine.is_some_and(|root| is_inside(program, root)) || shell.is_some_and(|exe| is_inside(program, exe))
    });
    if ended > 0 {
        // WebView2 and the engine's children let go of their files a moment later.
        std::thread::sleep(Duration::from_millis(1500));
    }
}

/// Removes the engine, or all of it but server\data when `keep`. Each entry on
/// its own, so one held folder does not stop the rest. Tries for about ten
/// seconds: the engine's PowerShell worker finishes the job it was on before it
/// notices the engine is gone, and holds server\ as its folder until then.
/// Returns the folder that still holds something it should not.
fn remove_engine(root: &Path, keep: bool) -> Option<PathBuf> {
    for attempt in 0..6 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(2));
        }
        if keep {
            remove_all_but(root, "server");
            remove_all_but(&root.join("server"), "data");
        } else {
            remove_all_but(root, "");
            let _ = std::fs::remove_dir(root);
        }
        if leftovers(root, keep).is_none() {
            return None;
        }
    }
    leftovers(root, keep)
}

pub(super) fn remove_all_but(dir: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().eq_ignore_ascii_case(keep) {
            let _ = remove_tree(&entry.path());
        }
    }
}

/// A file, a folder, or a link (server\shared is a junction): a link is
/// removed itself, never followed into what it points at.
pub(super) fn remove_tree(path: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return std::fs::remove_dir(path).or_else(|_| std::fs::remove_file(path));
    }
    if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

pub(super) fn leftovers(root: &Path, keep: bool) -> Option<PathBuf> {
    if !keep {
        return root.exists().then(|| root.to_path_buf());
    }
    let other = |dir: &Path, name: &str| {
        std::fs::read_dir(dir).ok()?.flatten().find(|e| !e.file_name().to_string_lossy().eq_ignore_ascii_case(name))
    };
    (other(root, "server").is_some() || other(&root.join("server"), "data").is_some()).then(|| root.to_path_buf())
}

/// The app's settings and WebView2 data, as UNINSTALL.bat removes them.
fn remove_app_data() {
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
    for base in [roaming, local_app_data()].into_iter().flatten().filter(|p| p.is_absolute()) {
        let _ = remove_tree(&base.join(APP_DATA_DIR));
    }
}

/// The installer's own uninstaller removes the app, its shortcuts and its
/// entry. It copies itself out first, so this process can end right away.
fn run_app_uninstaller(shell: Option<&Path>) {
    let Some(uninstaller) = shell.and_then(Path::parent).map(|d| d.join("uninstall.exe")) else { return };
    if uninstaller.is_file() {
        let _ = std::process::Command::new(uninstaller).arg("/S").spawn();
    }
}
