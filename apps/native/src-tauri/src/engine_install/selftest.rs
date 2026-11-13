// First-run install: the checks a packaged build runs on itself before it is released.

use std::path::{Path, PathBuf};
use super::{Bundle, fail};
#[cfg(target_os = "linux")]
use super::linux as platform;
#[cfg(target_os = "macos")]
use super::macos as platform;
#[cfg(windows)]
use super::windows as platform;
use super::place::{place_files, wait_for_engine};
use super::progress::Step;

/// `--install-engine-selftest <bundle-dir> <root> <port>`: the real copy and a
/// real engine start, into a throwaway folder and a spare port, without touching
/// login entries. CI runs it on the packaged app of every OS.
pub fn selftest(args: &[String]) -> i32 {
    let (args, check) = match args {
        [rest @ .., flag] if flag == CHECK_REGISTER_ARG => (rest, true),
        _ => (args, false),
    };
    let [bundle_dir, root, port] = args else {
        eprintln!("usage: --install-engine-selftest <bundle-dir> <root> <port> [{CHECK_REGISTER_ARG}]");
        return 2;
    };
    let Some(bundle) = Bundle::open(Path::new(bundle_dir)) else {
        eprintln!("selftest: no complete bundle in {bundle_dir}");
        return 3;
    };
    let Ok(port) = port.parse::<u16>() else { return 2 };
    let root = PathBuf::from(root);
    let result = place_files(&bundle, &root)
        .and_then(|_| platform::start_detached_for_test(&root, port).map_err(fail("start")))
        .and_then(|mut child| {
            let up = wait_for_engine(port, 90);
            let _ = child.kill();
            let _ = child.wait();
            if up { Ok(()) } else { Err(Step::Failed("no_answer")) }
        });
    match result {
        Ok(()) => {
            println!("selftest: engine {} answered on {port}", bundle.version);
            if check {
                return check_register(&root);
            }
            0
        }
        Err(step) => {
            eprintln!("selftest failed: {}", step.code());
            1
        }
    }
}

/// Last self-test argument: also check what this install would register to
/// start at sign-in (task, login agent, unit), with the OS's own tools.
const CHECK_REGISTER_ARG: &str = "--check-register";

fn check_register(root: &Path) -> i32 {
    let scratch = std::env::temp_dir().join(format!("xenon-register-check-{}", std::process::id()));
    let result = std::fs::create_dir_all(&scratch)
        .map_err(|e| e.to_string())
        .and_then(|_| platform::check_register(root, &scratch));
    let _ = std::fs::remove_dir_all(&scratch);
    match result {
        Ok(()) => {
            println!("selftest: the sign-in entry checks out");
            0
        }
        Err(e) => {
            eprintln!("selftest failed: sign-in entry: {e}");
            4
        }
    }
}
