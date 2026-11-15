// Tests of placing the engine the app carries: once, again when cut short, never over a newer one.

use std::path::Path;
use super::{Scratch, write};
use super::super::*;

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
