import Foundation

// ─────────────────────────────────────────────────────────────────────────────
// `index-serve <root>...` — the Living Index.
//
// One in-memory index of every file under the configured roots, built once and
// then kept current by the filesystem itself. living-index.js owns the process;
// this answers its requests over the same XEIDX protocol IndexHost.cs speaks:
//
//   in : {"id":N,"op":"query"|"stats"|"sizes"|"dirs"|"list"|"top"|"dupes"
//                    |"browse"|"overview", …}
//   out: XEIDX <base64 of {"id":N,"ok":true,…}>
//   plus unsolicited {"event":"ready"} and {"event":"progress","files":N,…}
//
// THE INDEX IS A CACHE OF THE FILESYSTEM, NEVER AN AUTHORITY. That is the
// invariant every consumer is written against: search re-stats before opening,
// and the disk cleanup re-stats and re-guards before deleting. So a stale entry
// here degrades to a refusal upstream, never to a wrong action — which is what
// makes it acceptable for this to lag by a moment, and unacceptable for it to
// silently stay wrong. A watcher that drops events marks its root dirty and
// rescans rather than carrying on.
//
// Symlinks are never followed. A link into a parent directory would otherwise
// make the walk unbounded, and a link to another volume would silently count
// somebody else's disk into this one's total.
// ─────────────────────────────────────────────────────────────────────────────
final class FileIndex {
    struct Entry {
        let path: String
        let name: String
        let lowerName: String
        let size: Int64
        let mtime: Double      // epoch ms, the unit every consumer uses
        let isDir: Bool
    }

    // A hard ceiling, honestly surfaced through `stats.capped`. An unbounded
    // index on a multi-million-file volume is the difference between a helper
    // that costs a few hundred MB and one the user has to kill.
    static let maxEntries = 2_000_000

    private(set) var entries: [Entry] = []
    private(set) var building = true
    private(set) var capped = false
    private(set) var roots: [String] = []
    private let lock = NSLock()

    func snapshot() -> [Entry] {
        lock.lock(); defer { lock.unlock() }
        return entries
    }

    func setEntries(_ list: [Entry], capped: Bool) {
        lock.lock()
        self.entries = list
        self.capped = capped
        lock.unlock()
    }

    func finishBuilding() {
        lock.lock(); building = false; lock.unlock()
    }

    var isBuilding: Bool {
        lock.lock(); defer { lock.unlock() }
        return building
    }

    var isCapped: Bool {
        lock.lock(); defer { lock.unlock() }
        return capped
    }
}

enum IndexHost {
    static let index = FileIndex()
    static var watcherStream: FSEventStreamRef?
    static var rootList: [String] = []

    // ── Walking ─────────────────────────────────────────────────────────────

    static func walk(_ roots: [String], onProgress: (Int, String) -> Void) -> ([FileIndex.Entry], Bool) {
        var out: [FileIndex.Entry] = []
        out.reserveCapacity(200_000)
        var capped = false
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey, .nameKey]

        for root in roots {
            guard !capped else { break }
            // skipsPackageDescendants is deliberately NOT set: an .app bundle is
            // where a lot of a Mac's disk actually goes, and hiding it would
            // make the sizes disagree with Finder's own Get Info.
            // Hidden entries are INDEXED. `.skipsHiddenFiles` looks like a
            // sensible default and is the wrong one here: on POSIX almost
            // everything this index exists to find is dot-prefixed. It hid the
            // Trash (~/.Trash — so the recycleBin category could never appear),
            // the whole package-cache vocabulary (~/.npm, ~/.cargo, ~/.gradle,
            // ~/.m2, ~/.nuget, ~/.yarn, ~/.pnpm-store) and, on Linux, every
            // browser cache (~/.cache/*) — which is disk-categories.js's entire
            // POSIX list. The visible symptom was a cleanup plan of 0 B on a
            // machine with 721 MB sitting in the Trash, plus disk totals quietly
            // smaller than Finder's. The Windows walker skips ReparsePoint and
            // nothing else; this now matches it.
            guard let e = fm.enumerator(at: URL(fileURLWithPath: root),
                                        includingPropertiesForKeys: keys,
                                        options: [],
                                        errorHandler: { _, _ in true }) else { continue }
            var since = 0
            while let url = e.nextObject() as? URL {
                if out.count >= FileIndex.maxEntries { capped = true; break }
                guard let values = try? url.resourceValues(forKeys: Set(keys)) else { continue }
                // Never descend through a link: it would make the walk unbounded
                // and could count another volume into this root's total.
                if values.isSymbolicLink == true { e.skipDescendants(); continue }
                let isDir = values.isDirectory == true
                let size = Int64(values.fileSize ?? 0)
                let mtime = (values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000
                let name = values.name ?? url.lastPathComponent
                out.append(FileIndex.Entry(path: url.path, name: name, lowerName: name.lowercased(),
                                           size: isDir ? 0 : size, mtime: mtime, isDir: isDir))
                since += 1
                if since >= 20_000 { since = 0; onProgress(out.count, root) }
            }
            onProgress(out.count, root)
        }
        return (out, capped)
    }

    // ── Aggregates ──────────────────────────────────────────────────────────

    // Bytes per directory, computed once from the file entries by charging every
    // file to each of its ancestors. That is what makes a treemap possible from
    // a flat list, and it is why `dirs` can answer instantly.
    // The file COUNT travels with the bytes because `n` on a directory item is
    // that count (on a file item the same key is the name — an overloaded key,
    // but it is the protocol the Windows host defines and the disk widget reads
    // as `rootEntry.n` for "files in here").
    static func dirBytes(under root: String, entries: [FileIndex.Entry]) -> [String: (bytes: Int64, mtime: Double, files: Int)] {
        var totals: [String: (bytes: Int64, mtime: Double, files: Int)] = [:]
        let prefix = root.hasSuffix("/") ? root : root + "/"
        for e in entries where !e.isDir {
            guard e.path == root || e.path.hasPrefix(prefix) else { continue }
            var dir = (e.path as NSString).deletingLastPathComponent
            while dir.count >= root.count {
                let cur = totals[dir] ?? (0, 0, 0)
                totals[dir] = (cur.bytes + e.size, max(cur.mtime, e.mtime), cur.files + 1)
                if dir == root { break }
                let parent = (dir as NSString).deletingLastPathComponent
                if parent == dir { break }
                dir = parent
            }
        }
        return totals
    }

    static func under(_ root: String, _ entries: [FileIndex.Entry]) -> [FileIndex.Entry] {
        let prefix = root.hasSuffix("/") ? root : root + "/"
        return entries.filter { $0.path == root || $0.path.hasPrefix(prefix) }
    }

    // ── The wire items ──────────────────────────────────────────────────────
    // Short keys, matching helper/IndexHost.cs exactly. They are not decorative:
    // filesearch.js skips any item without a string `p`, and diskspace.js reads
    // `n`/`s`/`m` positionally by name, so a full-word spelling of any of them
    // is silently dropped data rather than a compile error on either side.
    static func dirItem(_ path: String, _ bytes: Int64, _ files: Int, _ mtime: Double) -> J {
        .obj([("p", .s(path)), ("n", .i(files)), ("s", .n(Double(bytes))), ("m", .n(mtime))])
    }

    static func fileItem(_ e: FileIndex.Entry) -> J {
        .obj([("p", .s(e.path)), ("n", .s(e.name)), ("s", .n(Double(e.size))), ("m", .n(e.mtime))])
    }

    static func item(_ path: String, _ bytes: Int64, _ mtime: Double) -> J {
        .obj([("p", .s(path)), ("s", .n(Double(bytes))), ("m", .n(mtime))])
    }

    // ── Request handling ────────────────────────────────────────────────────

    static func answer(_ id: Int, _ pairs: [(String, J)]) {
        var all: [(String, J)] = [("id", .i(id)), ("ok", .b(true))]
        all.append(contentsOf: pairs)
        let json = J.obj(all).text
        let b64 = Data(json.utf8).base64EncodedString()
        FileHandle.standardOutput.write(Data("XEIDX \(b64)\n".utf8))
    }

    static func push(_ pairs: [(String, J)]) {
        let json = J.obj(pairs).text
        let b64 = Data(json.utf8).base64EncodedString()
        FileHandle.standardOutput.write(Data("XEIDX \(b64)\n".utf8))
    }

    static func handle(_ req: [String: Any]) {
        let id = (req["id"] as? Int) ?? 0
        let op = (req["op"] as? String) ?? ""
        let path = (req["path"] as? String) ?? (rootList.first ?? "/")
        let all = index.snapshot()

        switch op {
        case "stats":
            let files = all.filter { !$0.isDir }
            let bytes = files.reduce(Int64(0)) { $0 + $1.size }
            // Roughly what the entries cost: the strings dominate, and an
            // honest estimate is what lets the widget show the price.
            let ramMB = Double(all.count) * 180.0 / 1_048_576.0
            answer(id, [
                ("ready", .b(!index.isBuilding)),
                ("building", .b(index.isBuilding)),
                ("files", .i(files.count)),
                ("dirs", .i(all.count - files.count)),
                ("bytes", .n(Double(bytes))),
                ("ramMB", .n(ramMB.rounded())),
                ("capped", .b(index.isCapped)),
            ])

        case "query":
            let terms = ((req["terms"] as? [String]) ?? []).map { $0.lowercased() }.filter { !$0.isEmpty }
            let exts = (req["exts"] as? [String])?.map { $0.lowercased() }
            let max = (req["max"] as? Int) ?? 60
            let minBytes = Int64((req["minBytes"] as? Int) ?? 0)
            let maxBytes = Int64((req["maxBytes"] as? Int) ?? 0)
            let after = (req["after"] as? Double) ?? 0
            let before = (req["before"] as? Double) ?? 0
            var hits: [FileIndex.Entry] = []
            for e in all where !e.isDir {
                if !terms.isEmpty && !terms.allSatisfy({ e.lowerName.contains($0) }) { continue }
                if let exts, !exts.isEmpty {
                    let ext = (e.name as NSString).pathExtension.lowercased()
                    if !exts.contains(ext) { continue }
                }
                if minBytes > 0 && e.size < minBytes { continue }
                if maxBytes > 0 && e.size > maxBytes { continue }
                if after > 0 && e.mtime < after { continue }
                if before > 0 && e.mtime > before { continue }
                hits.append(e)
                // Ranking is server-side (search-rank.js), so this only has to
                // hand back a bounded, generous candidate set.
                if hits.count >= max * 4 { break }
            }
            hits.sort { $0.mtime > $1.mtime }
            let items: [J] = hits.prefix(max).map { e in
                // The SHORT keys the Windows host emits and filesearch.js reads
                // (`p`/`n`/`s`/`m`). This one branch spelled them out in full,
                // which is not a cosmetic difference: the merge skips any item
                // without a string `p`, so every hit was dropped and search
                // returned nothing at all — with a fully built index sitting
                // right there reporting `ready`. `dir` is not sent because the
                // server derives it; the Windows host does not send it either.
                .obj([
                    ("p", .s(e.path)),
                    ("n", .s(e.name)),
                    ("s", .n(Double(e.size))),
                    ("m", .n(e.mtime)),
                ])
            }
            answer(id, [("items", .arr(items)), ("building", .b(index.isBuilding))])

        case "sizes":
            let scoped = under(path, all)
            let files = scoped.filter { !$0.isDir }
            answer(id, [
                ("total", .n(Double(files.reduce(Int64(0)) { $0 + $1.size }))),
                ("files", .i(files.count)),
                ("dirs", .i(scoped.count - files.count)),
            ])

        case "dirs":
            let minBytes = Int64((req["minBytes"] as? Int) ?? 0)
            let max = (req["max"] as? Int) ?? 4000
            let totals = dirBytes(under: path, entries: all)
            let items: [J] = totals
                .filter { $0.value.bytes >= minBytes }
                .sorted { $0.value.bytes > $1.value.bytes }
                .prefix(max)
                .map { dirItem($0.key, $0.value.bytes, $0.value.files, $0.value.mtime) }
            answer(id, [("items", .arr(items))])

        case "list":
            let max = (req["max"] as? Int) ?? 5000
            let items: [J] = under(path, all).filter { !$0.isDir }
                .sorted { $0.size > $1.size }
                .prefix(max)
                .map { fileItem($0) }
            answer(id, [("items", .arr(items))])

        case "top":
            let max = (req["max"] as? Int) ?? 100
            let items: [J] = under(path, all).filter { !$0.isDir }
                .sorted { $0.size > $1.size }
                .prefix(max)
                .map { fileItem($0) }
            answer(id, [("items", .arr(items))])

        case "dupes":
            let minBytes = Int64((req["minBytes"] as? Int) ?? (10 * 1024 * 1024))
            let max = (req["max"] as? Int) ?? 50
            // Same size AND same name. The index holds no content hash, and
            // claiming two files are identical without reading them would be a
            // lie the user might act on — the server verifies byte-for-byte
            // before ever offering a deletion.
            var groups: [String: [FileIndex.Entry]] = [:]
            for e in under(path, all) where !e.isDir && e.size >= minBytes {
                groups["\(e.size)|\(e.lowerName)", default: []].append(e)
            }
            let out: [J] = groups.values
                .filter { $0.count > 1 }
                .sorted { ($0[0].size * Int64($0.count)) > ($1[0].size * Int64($1.count)) }
                .prefix(max)
                // {s, paths} — the shape verifyDupeCandidates() reads. It skips
                // any group without a `paths` ARRAY of at least two entries, so
                // the {s,n,items} spelling this used to send was discarded whole
                // and no duplicate was ever offered.
                .map { g in
                    .obj([
                        ("s", .n(Double(g[0].size))),
                        ("paths", .arr(g.map { .s($0.path) })),
                    ])
                }
            answer(id, [("groups", .arr(out))])

        case "browse":
            let childMax = (req["childMax"] as? Int) ?? 64
            let fileMax = (req["fileMax"] as? Int) ?? 64
            let totals = dirBytes(under: path, entries: all)
            let prefix = path.hasSuffix("/") ? path : path + "/"
            // Direct children only: one level, which is what a drill-down needs.
            let children: [J] = totals.filter { key, _ in
                key != path && key.hasPrefix(prefix) &&
                !key.dropFirst(prefix.count).contains("/")
            }
            .sorted { $0.value.bytes > $1.value.bytes }
            .prefix(childMax)
            .map { dirItem($0.key, $0.value.bytes, $0.value.files, $0.value.mtime) }
            let files: [J] = all.filter {
                !$0.isDir && (($0.path as NSString).deletingLastPathComponent == path)
            }
            .sorted { $0.size > $1.size }
            .prefix(fileMax)
            .map { fileItem($0) }
            // `children`/`directFiles`, plus the totals the drill-down header
            // shows — the Windows host's names. Answering `dirs`/`files` here
            // left diskspace.js with an undefined children list on every
            // drill-down, and no size at all on the folder it had just opened.
            let scopedAll = under(path, all)
            let scopedFiles = scopedAll.filter { !$0.isDir }
            let directBytes = all
                .filter { !$0.isDir && ($0.path as NSString).deletingLastPathComponent == path }
                .reduce(Int64(0)) { $0 + $1.size }
            answer(id, [
                ("path", .s(path)),
                ("total", .n(Double(scopedFiles.reduce(Int64(0)) { $0 + $1.size }))),
                ("files", .i(scopedFiles.count)),
                ("directBytes", .n(Double(directBytes))),
                ("children", .arr(children)),
                ("directFiles", .arr(files)),
            ])

        case "overview":
            // The combined call, so a drill-down is one round trip instead of
            // four. Composed from the same aggregates rather than a second
            // implementation of them.
            // The answer keys are the Windows host's, exactly: `dirs` is the
            // thresholded ARRAY, not a count. Sending the count under that name
            // and the array as `bigDirs` made diskspace.js spread a NUMBER —
            // "(list || []) is not iterable" — so the whole disk widget failed
            // to open. `groups` and `detailFiles` were absent entirely, which
            // costs the duplicate finder and every cleanup category, since the
            // categories are built from the detail files.
            let dirMin = Int64((req["dirMinBytes"] as? Int) ?? (10 * 1024 * 1024))
            let dirMax = (req["dirMax"] as? Int) ?? 4000
            let topMax = (req["topMax"] as? Int) ?? 100
            let dupeMin = Int64((req["dupeMinBytes"] as? Int) ?? (10 * 1024 * 1024))
            let dupeMax = (req["dupeMax"] as? Int) ?? 50
            let detailMax = (req["detailMax"] as? Int) ?? 20000
            let detailRoots = ((req["detailRoots"] as? [String]) ?? []).prefix(8).map {
                $0.hasSuffix("/") && $0.count > 1 ? String($0.dropLast()) : $0
            }
            let scoped = under(path, all)
            let files = scoped.filter { !$0.isDir }
            let totals = dirBytes(under: path, entries: all)
            let bigDirs: [J] = totals.filter { $0.value.bytes >= dirMin }
                .sorted { $0.value.bytes > $1.value.bytes }
                .prefix(dirMax)
                .map { dirItem($0.key, $0.value.bytes, $0.value.files, $0.value.mtime) }
            let topFiles: [J] = files.sorted { $0.size > $1.size }
                .prefix(topMax)
                .map { fileItem($0) }

            // Same-size-and-name candidates. The server hashes them before it
            // calls anything a duplicate; this only proposes.
            var dupeBuckets: [String: [FileIndex.Entry]] = [:]
            for e in files where e.size >= dupeMin {
                dupeBuckets["\(e.size)|\(e.lowerName)", default: []].append(e)
            }
            let groups: [J] = dupeBuckets.values
                .filter { $0.count > 1 }
                .sorted { ($0[0].size * Int64($0.count)) > ($1[0].size * Int64($1.count)) }
                .prefix(dupeMax)
                .map { g in .obj([("s", .n(Double(g[0].size))), ("paths", .arr(g.map { .s($0.path) }))]) }

            // Per-file rows for the places the cleanup categories are built
            // from (the temp dirs and Downloads). Everything else is summarised
            // by directory — this is the one part that has to be per file,
            // because a category classifies each entry on its own name and age.
            var detailFiles: [J] = []
            var detailCapped = false
            if !detailRoots.isEmpty {
                outer: for root in detailRoots {
                    let prefix = root.hasSuffix("/") ? root : root + "/"
                    for e in files where e.path.hasPrefix(prefix) {
                        if detailFiles.count >= detailMax { detailCapped = true; break outer }
                        detailFiles.append(fileItem(e))
                    }
                }
            }

            answer(id, [
                ("total", .n(Double(files.reduce(Int64(0)) { $0 + $1.size }))),
                ("files", .i(files.count)),
                ("dirs", .arr(bigDirs)),
                ("topFiles", .arr(topFiles)),
                ("groups", .arr(groups)),
                ("detailFiles", .arr(detailFiles)),
                ("building", .b(index.isBuilding)),
                ("capped", .b(index.isCapped)),
                ("detailCapped", .b(detailCapped)),
            ])

        default:
            let json = J.obj([("id", .i(id)), ("ok", .b(false)), ("err", .s("unknown_op"))]).text
            FileHandle.standardOutput.write(Data("XEIDX \(Data(json.utf8).base64EncodedString())\n".utf8))
        }
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    static func run(_ args: [String]) {
        rootList = args.filter { $0.hasPrefix("/") }
        guard !rootList.isEmpty else { emitError("no_roots"); exit(2) }

        // The walk runs off the main thread so requests are answered while it
        // is still going — `building` tells the caller the answers are partial,
        // which is better than a search box that does nothing for a minute.
        DispatchQueue.global(qos: .utility).async {
            let (list, capped) = walk(rootList) { count, root in
                push([("event", .s("progress")), ("files", .i(count)), ("root", .s(root))])
            }
            index.setEntries(list, capped: capped)
            index.finishBuilding()
            push([("event", .s("ready"))])
            startWatchers()
        }

        // Requests arrive as one JSON object per line on stdin.
        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8),
                  let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
            handle(req)
        }
    }

    // FSEvents rather than one watcher per directory: a Mac with a million
    // files would exhaust the descriptor limit long before the index finished.
    // A dropped-event flag from the kernel means the stream lost track, and the
    // only correct response is to rebuild rather than carry on with an index
    // that is quietly wrong.
    static func startWatchers() {
        let paths = rootList as CFArray
        var context = FSEventStreamContext(version: 0, info: nil, retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, _, count, _, flags, _ in
            var mustRebuild = false
            for i in 0..<count {
                let f = flags[i]
                if f & UInt32(kFSEventStreamEventFlagMustScanSubDirs) != 0 { mustRebuild = true }
                if f & UInt32(kFSEventStreamEventFlagUserDropped) != 0 { mustRebuild = true }
                if f & UInt32(kFSEventStreamEventFlagKernelDropped) != 0 { mustRebuild = true }
            }
            IndexHost.scheduleRefresh(full: mustRebuild)
        }
        guard let stream = FSEventStreamCreate(
            kCFAllocatorDefault, callback, &context, paths,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            1.0,   // coalesce a second of churn: a build directory is thousands
                   // of events and one rescan answers all of them
            UInt32(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer)
        ) else { return }
        watcherStream = stream
        FSEventStreamSetDispatchQueue(stream, DispatchQueue.global(qos: .utility))
        FSEventStreamStart(stream)
    }

    static var refreshPending = false
    static let refreshLock = NSLock()

    // Coalesced: a rebuild is expensive and a burst of events must cost one.
    static func scheduleRefresh(full: Bool) {
        refreshLock.lock()
        if refreshPending { refreshLock.unlock(); return }
        refreshPending = true
        refreshLock.unlock()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 3) {
            let (list, capped) = walk(rootList) { _, _ in }
            index.setEntries(list, capped: capped)
            refreshLock.lock(); refreshPending = false; refreshLock.unlock()
        }
    }
}
