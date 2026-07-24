import Foundation

// ─────────────────────────────────────────────────────────────────────────────
// `shell-delete` — the only path in the product that removes a user's files.
//
// Reads ONE JSON object on stdin and answers ONE on stdout, which is
// ShellDelete.cs's contract and what diskspace.js's runShellDelete expects:
//   {"paths":["/abs/one","/abs/two"]}  → move each to the Trash
//   {"emptyRecycleBin":true}           → empty the Trash
//   answer: {"ok":bool, "rc":int, "aborted":bool}
//
// THE TRASH IS THE UNDO, and that is the invariant this file exists to keep.
// FileManager.trashItem is the macOS equivalent of FOF_ALLOWUNDO: the file
// moves, it is not destroyed, and the user can put it back with the Finder they
// already know. There is deliberately no permanent-delete path for `paths`; the
// one labelled exception is emptying the Trash itself.
//
// Every guard that decides WHAT may be deleted lives in disk-guard.js, above
// this. This process only refuses what it can see is wrong from here: a
// relative path (which would resolve against a working directory nobody chose)
// and a symlink (which would trash the target rather than the link).
// ─────────────────────────────────────────────────────────────────────────────
enum ShellDelete {
    static func run() {
        guard let line = readLine(strippingNewline: true),
              let data = line.data(using: .utf8),
              let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            emit(.obj([("ok", .b(false)), ("rc", .i(-1))]))
            return
        }

        if payload["emptyRecycleBin"] as? Bool == true {
            emptyTrash()
            return
        }

        guard let paths = payload["paths"] as? [String], !paths.isEmpty else {
            emit(.obj([("ok", .b(false)), ("rc", .i(-1))]))
            return
        }

        let fm = FileManager.default
        var failures = 0
        var inUse = false
        for path in paths {
            // Absolute only. A relative path here would be resolved against
            // whatever directory this process happens to be in, which is not a
            // decision anybody made.
            guard path.hasPrefix("/") else { failures += 1; continue }
            let url = URL(fileURLWithPath: path)
            // A symlink is trashed as itself by trashItem, but re-stating the
            // rule here is cheap and matches what the guard above promises.
            let attrs = try? fm.attributesOfItem(atPath: path)
            if (attrs?[.type] as? FileAttributeType) == .typeSymbolicLink { failures += 1; continue }
            if !fm.fileExists(atPath: path) { failures += 1; continue }
            do {
                try fm.trashItem(at: url, resultingItemURL: nil)
            } catch let error as NSError {
                failures += 1
                // Busy or locked: diskspace.js reacts to this by descending into
                // the directory and moving the children individually, so telling
                // it apart from a refusal matters.
                if error.code == NSFileWriteNoPermissionError || error.code == NSFileLockingError {
                    inUse = true
                }
            }
        }
        emit(.obj([
            ("ok", .b(failures == 0)),
            // 32 is the code diskspace.js already treats as "in use" (it is
            // ERROR_SHARING_VIOLATION on Windows), so reusing it means the
            // descend-and-retry logic needs no per-platform branch.
            ("rc", .i(failures == 0 ? 0 : (inUse ? 32 : 5))),
            ("aborted", .b(false)),
        ]))
    }

    // Emptying is the ONE place a permanent delete is correct, and it is the one
    // place the user is told so in plain words before it runs.
    static func emptyTrash() {
        let fm = FileManager.default
        var failures = 0
        var removed = 0
        // Every mounted volume has its own .Trashes, plus the home one. Emptying
        // per-volume rather than all-at-once is what keeps one refusing volume
        // from failing the whole operation — the same lesson the Windows side
        // learned about SHEmptyRecycleBin.
        var roots: [URL] = []
        if let home = fm.urls(for: .trashDirectory, in: .userDomainMask).first { roots.append(home) }
        for volume in fm.mountedVolumeURLs(includingResourceValuesForKeys: nil, options: [.skipHiddenVolumes]) ?? [] {
            let vt = volume.appendingPathComponent(".Trashes/\(getuid())")
            if fm.fileExists(atPath: vt.path) { roots.append(vt) }
        }
        for root in roots {
            guard let items = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { continue }
            for item in items {
                do { try fm.removeItem(at: item); removed += 1 } catch { failures += 1 }
            }
        }
        // Success is "something went", not "nothing refused": a Trash holding one
        // file the system will not release should still report the rest as gone.
        emit(.obj([
            ("ok", .b(failures == 0 || removed > 0)),
            ("rc", .i(failures == 0 ? 0 : 5)),
            ("aborted", .b(false)),
        ]))
    }
}
