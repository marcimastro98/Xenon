use super::*;
use std::path::{Path, PathBuf};

/// A fresh folder under the system temp dir, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("xenon-ei-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[test]
fn versions_compare_by_number_not_by_text() {
    assert!(version_newer("5.1.0", "5.0.12"));
    assert!(version_newer("5.0.10", "5.0.9"));
    assert!(version_newer("v6.0.0", "5.9.9"));
    assert!(!version_newer("5.1.0", "5.1.0"));
    assert!(!version_newer("5.0.0", "5.1.0"));
    assert!(!version_newer("garbage", "0.0.1"));
}

#[test]
fn user_data_is_recognised_in_any_case() {
    assert!(copy::is_user_data(Path::new("server/data")));
    assert!(copy::is_user_data(Path::new("Server/Data/settings.json")));
    assert!(!copy::is_user_data(Path::new("server/database.js")));
    assert!(!copy::is_user_data(Path::new("data/server")));
}

#[test]
fn merge_keeps_user_data_and_unrelated_files() {
    let s = Scratch::new("merge");
    let (src, dst) = (s.0.join("src"), s.0.join("dst"));
    write(&src.join("server/server.js"), "new");
    write(&src.join("server/data/settings.json"), "from the bundle");
    write(&dst.join("server/server.js"), "old");
    write(&dst.join("server/data/settings.json"), "the user's");
    write(&dst.join("extra.txt"), "kept");
    let mut counter = copy::Counter::new(2, 0, 100);
    copy::merge_tree(&src, &dst, &mut counter).unwrap();
    assert_eq!(std::fs::read_to_string(dst.join("server/server.js")).unwrap(), "new");
    assert_eq!(std::fs::read_to_string(dst.join("server/data/settings.json")).unwrap(), "the user's");
    assert_eq!(std::fs::read_to_string(dst.join("extra.txt")).unwrap(), "kept");
    assert_eq!(counter.percent(), 50);
}

#[test]
fn replace_swaps_the_whole_tree() {
    let s = Scratch::new("replace");
    let (src, dst) = (s.0.join("src"), s.0.join("node-runtime"));
    write(&src.join("bin/node"), "v26");
    write(&dst.join("bin/node"), "v24");
    write(&dst.join("stale.txt"), "gone");
    copy::replace_tree(&src, &dst, &mut copy::Counter::new(1, 0, 100)).unwrap();
    assert_eq!(std::fs::read_to_string(dst.join("bin/node")).unwrap(), "v26");
    assert!(!dst.join("stale.txt").exists());
    assert!(!s.0.join("node-runtime.new").exists());
    assert!(!s.0.join("node-runtime.old").exists());
}

#[test]
fn manifest_uses_os_separators() {
    let s = Scratch::new("manifest");
    std::fs::create_dir_all(s.0.join("server/data")).unwrap();
    copy::write_manifest(&s.0, "5.1.0", &["server/js/app.js".to_string()]).unwrap();
    let text = std::fs::read_to_string(s.0.join("server/data/update-manifest.json")).unwrap();
    let body: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(body["version"], "5.1.0");
    let expected = ["server", "js", "app.js"].join(std::path::MAIN_SEPARATOR_STR);
    assert_eq!(body["files"][0], expected.as_str());
    assert!(body["at"].as_str().unwrap().starts_with("20"));
}

/// A minimal bundle: one app file and a runtime with the node the platform checks.
fn fake_bundle(dir: &Path, version: &str) -> Bundle {
    write(&dir.join("bundle.json"), &format!(r#"{{"version":"{version}","files":["server/server.js"]}}"#));
    write(&dir.join("app/server/server.js"), version);
    write(&dir.join("app/package.json"), &format!(r#"{{"version":"{version}"}}"#));
    let node = if cfg!(windows) { "node.exe" } else { "bin/node" };
    write(&dir.join(RUNTIME_DIR).join(node), version);
    Bundle::open(dir).unwrap()
}

#[test]
fn a_second_run_never_copies_over_what_the_first_placed() {
    let s = Scratch::new("retry");
    let (bundle_dir, root) = (s.0.join("bundle"), s.0.join("root"));
    let bundle = fake_bundle(&bundle_dir, "5.1.0");
    place_files(&bundle, &root).unwrap();
    assert!(has_engine(&root));
    assert_eq!(placed_version(&root).as_deref(), Some("5.1.0"));
    // What a running engine holds open: a retry must not need to write it.
    let node = root.join(RUNTIME_DIR).join(if cfg!(windows) { "node.exe" } else { "bin/node" });
    write(&node, "in use");
    write(&root.join("server/server.js"), "running copy");
    place_files(&bundle, &root).unwrap();
    assert_eq!(std::fs::read_to_string(&node).unwrap(), "in use");
    assert_eq!(std::fs::read_to_string(root.join("server/server.js")).unwrap(), "running copy");
}

#[test]
fn an_unfinished_copy_is_done_again() {
    let s = Scratch::new("partial");
    let (bundle_dir, root) = (s.0.join("bundle"), s.0.join("root"));
    let bundle = fake_bundle(&bundle_dir, "5.1.0");
    // Files from an interrupted copy, with no manifest and no runtime stamp.
    write(&root.join("server/server.js"), "half");
    place_files(&bundle, &root).unwrap();
    assert_eq!(std::fs::read_to_string(root.join("server/server.js")).unwrap(), "5.1.0");
    assert_eq!(std::fs::read_to_string(root.join(RUNTIME_DIR).join(RUNTIME_STAMP)).unwrap(), "5.1.0");
}

#[test]
fn data_kept_by_an_uninstall_does_not_pass_for_an_engine() {
    let s = Scratch::new("kept-data");
    let (bundle_dir, root) = (s.0.join("bundle"), s.0.join("root"));
    let bundle = fake_bundle(&bundle_dir, "5.1.0");
    // What "keep my data" leaves: server\data only, its manifest still naming 5.1.0.
    write(&root.join("server/data/update-manifest.json"), r#"{"version":"5.1.0"}"#);
    write(&root.join("server/data/notes.json"), "mine");
    place_files(&bundle, &root).unwrap();
    assert!(has_engine(&root));
    assert_eq!(std::fs::read_to_string(root.join("server/data/notes.json")).unwrap(), "mine");
}

#[test]
fn a_newer_engine_keeps_its_files() {
    let s = Scratch::new("newer");
    let (bundle_dir, root) = (s.0.join("bundle"), s.0.join("root"));
    let bundle = fake_bundle(&bundle_dir, "5.1.0");
    write(&root.join("package.json"), r#"{"version":"5.2.0"}"#);
    write(&root.join("server/server.js"), "5.2.0");
    place_files(&bundle, &root).unwrap();
    assert_eq!(std::fs::read_to_string(root.join("server/server.js")).unwrap(), "5.2.0");
    assert_eq!(installed_version(&root).as_deref(), Some("5.2.0"));
}

#[test]
fn only_a_real_answer_counts_as_the_engine() {
    use std::io::{Read, Write};
    use std::time::Duration;
    let serve = |reply: &'static [u8]| {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut conn, _)) = listener.accept() {
                let mut buf = [0u8; 256];
                let _ = conn.read(&mut buf);
                let _ = conn.write_all(reply);
            }
        });
        port
    };
    let t = Duration::from_millis(900);
    assert!(engine_answers(serve(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"), t));
    assert!(!engine_answers(serve(b"HTTP/1.1 404 Not Found\r\n\r\n"), t));
    assert!(!engine_answers(serve(b""), t), "an open port that says nothing");
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    assert!(!engine_answers(closed, t));
}

#[test]
fn a_bundle_needs_app_runtime_and_a_file_list() {
    let s = Scratch::new("bundle");
    assert!(Bundle::open(&s.0).is_none());
    write(&s.0.join("bundle.json"), r#"{"version":"5.1.0","files":["package.json"]}"#);
    assert!(Bundle::open(&s.0).is_none(), "no app/ or runtime yet");
    std::fs::create_dir_all(s.0.join("app")).unwrap();
    std::fs::create_dir_all(s.0.join(RUNTIME_DIR)).unwrap();
    assert_eq!(Bundle::open(&s.0).unwrap().version, "5.1.0");
    write(&s.0.join("bundle.json"), r#"{"version":"5.1.0","files":[]}"#);
    assert!(Bundle::open(&s.0).is_none(), "an empty list is a broken bundle");
}

#[test]
fn the_splash_gets_codes_and_numbers_only() {
    progress::reset();
    progress::set(Step::Failed("copy"), 40);
    let js = progress::splash_js();
    assert!(js.contains("step:\"copy\""));
    assert!(js.contains("failed:true"));
    assert!(js.contains("percent:40"));
    assert!(js.contains("done:false"));
    progress::reset();
}

#[cfg(windows)]
#[test]
fn the_task_points_at_the_root_it_was_made_for() {
    let root = Path::new(r"C:\Users\Example User\AppData\Local\Programs\Xenon & Co");
    let xml = windows::task_xml(root, r"PC\Example");
    assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
    assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
    assert!(xml.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
    assert!(xml.contains("Xenon &amp; Co"));
    assert_eq!(windows::root_from_task_xml(&xml).as_deref(), Some(root));
}

#[cfg(target_os = "linux")]
#[test]
fn the_unit_quotes_paths_with_spaces() {
    let unit = linux::unit_text(Path::new("/home/example/My Apps/Xenon"));
    assert!(unit.contains("ExecStart=\"/home/example/My Apps/Xenon/node-runtime/bin/node\""));
    assert!(unit.contains("WorkingDirectory=/home/example/My Apps/Xenon\n"));
}

#[cfg(windows)]
mod uninstall_tests {
    use super::super::uninstall::{leftovers, remove_all_but, remove_tree};
    use super::super::uninstall_words::{for_language, ALL};
    use super::super::win_api::is_inside;
    use super::{write, Scratch};
    use std::path::Path;

    #[test]
    fn known_folders_come_from_windows_not_the_environment() {
        let pf = super::super::win_api::known_folder(&super::super::win_api::FOLDERID_PROGRAM_FILES).expect("Program Files");
        let pd = super::super::win_api::known_folder(&super::super::win_api::FOLDERID_PROGRAM_DATA).expect("ProgramData");
        assert!(pf.is_absolute() && pd.is_absolute());
        assert_ne!(pf, pd);
    }

    #[test]
    fn every_language_says_every_line_and_english_is_the_fallback() {
        for (id, w) in ALL {
            for line in [w.title, w.ask, w.done, w.done_kept, w.done_all, w.partial, w.not_ours, w.task_left] {
                assert!(!line.trim().is_empty(), "language {id:#x}");
                assert!(!line.contains('\u{2014}'), "no em dash in language {id:#x}");
            }
            for line in [w.done_kept, w.partial, w.not_ours] {
                assert!(line.contains("{path}"), "language {id:#x} names the folder");
            }
        }
        for (id, w) in ALL {
            assert!(w.task_left.contains("{task}"), "language {id:#x} names the task");
        }
        assert_eq!(for_language(0x10).title, "Disinstalla Xenon");
        assert_eq!(for_language(0x3e).title, "Uninstall Xenon");
    }

    #[test]
    fn inside_is_by_folder_not_by_text() {
        let root = Path::new(r"C:\Users\a\AppData\Local\Programs\Xenon");
        assert!(is_inside(Path::new(r"c:\users\A\appdata\local\programs\xenon\node-runtime\node.exe"), root));
        assert!(is_inside(Path::new(r"C:/Users/a/AppData/Local/Programs/Xenon/server/helper/x.exe"), root));
        assert!(is_inside(root, root));
        assert!(!is_inside(Path::new(r"C:\Users\a\AppData\Local\Programs\Xenon2\node.exe"), root));
        assert!(!is_inside(Path::new(r"C:\Windows\node.exe"), root));
        assert!(!is_inside(Path::new(r"C:\x.exe"), Path::new("")));
    }

    #[test]
    fn keeping_data_leaves_only_server_data() {
        let s = Scratch::new("uninstall-keep");
        let root = s.0.join("Xenon");
        write(&root.join("node-runtime").join("node.exe"), "x");
        write(&root.join("server").join("server.js"), "x");
        write(&root.join("server").join("data").join("settings.json"), "{}");
        write(&root.join("UNINSTALL.bat"), "x");
        assert!(leftovers(&root, true).is_some());
        remove_all_but(&root, "server");
        remove_all_but(&root.join("server"), "data");
        assert!(leftovers(&root, true).is_none());
        assert!(root.join("server").join("data").join("settings.json").is_file());
        remove_tree(&root).unwrap();
        assert!(leftovers(&root, false).is_none());
    }

    #[test]
    fn the_listed_folder_is_read_with_or_without_quotes() {
        use super::super::windows::reg_value;
        let out = |v: &str| format!("\r\nHKEY_CURRENT_USER\\Software\\X\r\n    InstallLocation    REG_SZ    {v}\r\n\r\n");
        assert_eq!(reg_value(&out(r"D:\My Xenon"), "InstallLocation").as_deref(), Some(r"D:\My Xenon"));
        assert_eq!(reg_value(&out(r#""D:\My Xenon""#), "InstallLocation").as_deref(), Some(r"D:\My Xenon"));
        assert_eq!(reg_value(&out(""), "InstallLocation"), None);
        let other = "    InstallLocationOld    REG_SZ    C:\\old\r\n";
        assert_eq!(reg_value(other, "InstallLocation"), None);
    }

    #[test]
    fn a_held_folder_does_not_stop_the_rest() {
        let s = Scratch::new("uninstall-held");
        let root = s.0.join("Xenon");
        write(&root.join("server").join("server.js"), "x");
        write(&root.join("tools").join("a.js"), "x");
        write(&root.join("UNINSTALL.bat"), "x");
        // As the engine's PowerShell worker does until its job ends: server\ is its folder.
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1"])
            .current_dir(root.join("server"))
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        remove_all_but(&root, "");
        let _ = child.kill();
        let _ = child.wait();
        assert!(!root.join("tools").exists() && !root.join("UNINSTALL.bat").exists());
    }

    #[test]
    fn a_junction_is_removed_never_followed() {
        let s = Scratch::new("uninstall-link");
        let target = s.0.join("elsewhere");
        write(&target.join("keep.txt"), "x");
        let link = s.0.join("Xenon").join("server").join("shared");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .output()
            .unwrap();
        assert!(made.status.success());
        remove_tree(&s.0.join("Xenon")).unwrap();
        assert!(target.join("keep.txt").is_file(), "the junction's target is untouched");
    }
}
