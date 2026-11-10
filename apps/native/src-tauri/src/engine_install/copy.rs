//! File placement: plain std::fs, no archive format and no new crate. The
//! bundle arrives already unpacked by the OS installer (NSIS, the .app, the
//! AppImage or the .deb), so this is a copy with progress.

use std::io;
use std::path::Path;

/// Maps files copied so far onto a slice of the progress bar.
pub struct Counter {
    total: usize,
    done: usize,
    from: u8,
    to: u8,
}

impl Counter {
    pub fn new(total: usize, from: u8, to: u8) -> Counter {
        Counter { total: total.max(1), done: 0, from, to }
    }

    pub fn percent(&self) -> u8 {
        let span = (self.to - self.from) as usize;
        self.from + (span * self.done.min(self.total) / self.total) as u8
    }

    fn tick(&mut self) {
        self.done += 1;
        if self.done % 50 == 0 {
            super::progress::set(super::progress::current_step(), self.percent());
        }
    }
}

pub fn count_files(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => count_files(&e.path()),
            Ok(_) => 1,
            Err(_) => 0,
        })
        .sum()
}

/// `server/data` is the user's: never written by a copy, whatever the source holds.
pub(super) fn is_user_data(rel: &Path) -> bool {
    let mut parts = rel.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase());
    matches!((parts.next().as_deref(), parts.next().as_deref()), (Some("server"), Some("data")))
}

/// Copies src over dst, file by file, overwriting what exists and keeping
/// everything else (the same merge update-apply does).
pub fn merge_tree(src: &Path, dst: &Path, counter: &mut Counter) -> io::Result<()> {
    merge_inner(src, dst, Path::new(""), counter)
}

fn merge_inner(src: &Path, dst: &Path, rel: &Path, counter: &mut Counter) -> io::Result<()> {
    std::fs::create_dir_all(dst.join(rel))?;
    for entry in std::fs::read_dir(src.join(rel))? {
        let entry = entry?;
        let child = rel.join(entry.file_name());
        if is_user_data(&child) {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            merge_inner(src, dst, &child, counter)?;
        } else if kind.is_file() {
            copy_file(&entry.path(), &dst.join(&child))?;
            counter.tick();
        }
    }
    Ok(())
}

/// A read-only target (a file the updater marked, or a copy from read-only
/// media) would make `fs::copy` fail; clear the flag first.
fn copy_file(from: &Path, to: &Path) -> io::Result<()> {
    if let Ok(meta) = std::fs::metadata(to) {
        let mut perms = meta.permissions();
        if perms.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = std::fs::set_permissions(to, perms);
        }
    }
    std::fs::copy(from, to).map(|_| ())
}

/// Builds the new tree beside the old one and swaps it in, so a failed copy
/// never leaves a half runtime where a whole one was.
pub fn replace_tree(src: &Path, dst: &Path, counter: &mut Counter) -> io::Result<()> {
    let staging = dst.with_extension("new");
    let previous = dst.with_extension("old");
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_dir_all(&previous);
    merge_tree(src, &staging, counter)?;
    if dst.exists() {
        // A runtime in use (the engine is running from it) cannot be renamed on
        // Windows. Then the new files go over the old in place instead.
        if std::fs::rename(dst, &previous).is_err() {
            let result = merge_tree(&staging, dst, &mut Counter::new(1, 0, 0));
            let _ = std::fs::remove_dir_all(&staging);
            return result;
        }
    }
    if let Err(e) = std::fs::rename(&staging, dst) {
        // Put the old runtime back rather than leave none at all.
        let _ = std::fs::rename(&previous, dst);
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(&previous);
    Ok(())
}

/// The file list the engine's own updater reads to remove what a later
/// version stops shipping (Remove-StaleAppFiles). Same shape the bootstraps
/// wrote: OS separators, no user data, no dependencies.
pub fn write_manifest(root: &Path, version: &str, files: &[String]) -> io::Result<()> {
    let sep = std::path::MAIN_SEPARATOR.to_string();
    let files: Vec<String> = files.iter().map(|f| f.replace('/', &sep)).collect();
    let body = serde_json::json!({ "version": version, "at": now_iso(), "files": files });
    let path = root.join("server").join("data").join("update-manifest.json");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&body)?)?;
    std::fs::rename(&tmp, &path)
}

fn now_iso() -> String {
    crate::crash_log::now_utc()
}
