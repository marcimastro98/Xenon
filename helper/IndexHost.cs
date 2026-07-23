using System.Text;

namespace XenonHelper;

// The Living Index — one in-memory index of every file under the configured
// roots, kept CURRENT by FileSystemWatchers. It is the single brain behind
// both the local search (instant name matches over everything, including what
// Windows Search never indexed) and the disk widget (treemap/top/dupes with no
// "scan" button — the numbers are always alive).
//
// Mode: index-serve <root> [root ...]
//
// Life cycle: initial walk streams progress and flips `ready`; watchers apply
// created/deleted/renamed/changed live; a watcher buffer overflow marks that
// root dirty and a background rescan rebuilds just that root — the index may
// briefly lag, it must never stay wrong. stdin EOF = clean exit.
//
// Protocol: stdin one JSON per line {id, op, ...}; stdout "XEIDX " + base64:
//   query {terms[],exts[],after,before,minBytes,maxBytes,max}
//         → {items:[{p,n,s,m}]}   name-tier + mtime ordering, all terms must hit
//   overview {path,...}            → one coherent disk snapshot (dirs/top/dupes/details)
//   sizes {path}                  → {total, dirs:[{p,s,n,m}]}   first-level children
//   dirs  {path,minBytes,max}     → {items:[{p,s,n,m}]}         every dir ≥ minBytes
//   list  {path,max}              → {items:[{p,n,s,m}]}         files under path
//   top   {path,max}              → {items:[{p,n,s,m}]}         biggest files
//   dupes {path,minBytes,max}     → {groups:[{s,paths:[]}]}     same-size candidates
//   stats {}                      → {ready,building,files,dirs,bytes,ramMB,roots}
// Unsolicited: {"event":"progress",...} while building, {"event":"ready"}.
//
// Memory: the lowercase matching form is stored ONLY when it differs from the
// display name (most files are already lowercase), the path lookup keys on a
// (dirId, lowerName) struct so no concatenated key strings exist, and the
        // build finishes with a compacting GC. Directories are interned once.
// Measured ~180–230 MB per million files; MaxEntries caps the worst case.
// Reparse points are never traversed (invariant).
internal static class IndexHost
{
    private const int MaxEntries = 2_000_000;
    private const long DefaultDirMinBytes = 10L * 1024 * 1024;

    private struct Entry
    {
        public string Name;        // display name
        public string? NameLower;  // ordinal-lowercase for matching; null = Name is already lowercase
        public int Dir;            // index into Dirs; -1 = tombstone
        public long Size;
        public long Mtime;
    }

    // The matching form: the stored lowercase when the name has uppercase,
    // the name itself otherwise (no duplicate string retained).
    private static string LowerOf(in Entry en) => en.NameLower ?? en.Name;

    // Path-lookup key without a concatenated string: on 2M entries the old
    // dirId+"|"+nameLower keys alone held ~150 MB.
    private readonly record struct PathKey(int Dir, string NameLower);

    private static readonly object Gate = new();
    private static readonly List<Entry> Entries = new();
    private static readonly List<string> Dirs = new();                   // full dir paths (display case)
    private static readonly Dictionary<string, int> DirIds = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<PathKey, int> ByPath = new();     // (dirId, nameLower) → entry idx
    private static int Tombstones;
    private static volatile bool Capped;
    private static long TotalBytes;
    private static volatile bool Ready;
    private static volatile bool Cancelled;
    private static string[] Roots = Array.Empty<string>();

    private static readonly object OutLock = new();
    private static readonly List<FileSystemWatcher> Watchers = new();
    private static readonly HashSet<string> DirtyRoots = new(StringComparer.OrdinalIgnoreCase);

    public static int Run(string[] args)
    {
        if (args.Length < 2) { Console.Error.WriteLine("usage: xenon-helper index-serve <root> [root ...]"); return 2; }
        Roots = args.Skip(1).Select(NormalizeDir).ToArray();

        // Build + watch in the background; the main thread is the request loop
        // so queries answer DURING the initial walk (partial results are honest:
        // stats says building=true and the server tells the user).
        new Thread(() =>
        {
            // Watch before walking. A file created or removed during a
            // multi-million-entry initial build must not fall into the gap
            // between the snapshot and watcher startup. Duplicate create
            // events are harmless because AddEntryLocked is an upsert; an
            // overflow marks the root dirty for the repair loop below.
            foreach (var r in Roots) StartWatcher(r);
            foreach (var r in Roots) { if (!Cancelled) WalkRoot(r); }
            lock (Gate)
            {
                Entries.TrimExcess();
                Dirs.TrimExcess();
                ByPath.TrimExcess();
                DirIds.TrimExcess();
            }
            // Give the walk's garbage back to the OS — the resident number the
            // user sees in Task Manager is the honest cost from here on.
            System.Runtime.GCSettings.LargeObjectHeapCompactionMode = System.Runtime.GCLargeObjectHeapCompactionMode.CompactOnce;
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
            Ready = true;
            Emit(new Dictionary<string, object?> { ["event"] = "ready" });
            // Dirty-root repair loop: a watcher overflow re-walks that root.
            while (!Cancelled)
            {
                string? dirty = null;
                lock (Gate) { foreach (var d in DirtyRoots) { dirty = d; break; } if (dirty != null) DirtyRoots.Remove(dirty); }
                if (dirty != null) { RemoveSubtree(dirty); WalkRoot(dirty); }
                else Thread.Sleep(1000);
            }
        })
        { IsBackground = true, Name = "index-build" }.Start();

        string? line;
        while ((line = Console.In.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            object? id = null;
            try
            {
                using var doc = System.Text.Json.JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (root.TryGetProperty("id", out var idEl))
                    id = idEl.ValueKind == System.Text.Json.JsonValueKind.Number ? idEl.GetInt64() : (object?)idEl.ToString();
                var op = root.TryGetProperty("op", out var opEl) ? (opEl.GetString() ?? "") : "";
                var result = Handle(op, root);
                result["id"] = id;
                result["ok"] = true;
                Emit(result);
            }
            catch (Exception ex)
            {
                Emit(new Dictionary<string, object?> { ["id"] = id, ["ok"] = false, ["err"] = ex.Message });
            }
        }
        Cancelled = true;
        foreach (var w in Watchers) { try { w.Dispose(); } catch { } }
        return 0;
    }

    // ── request handlers ──────────────────────────────────────────────────────

    private static Dictionary<string, object?> Handle(string op, System.Text.Json.JsonElement req)
    {
        switch (op)
        {
            case "query": return OpQuery(req);
            case "overview": return OpOverview(req);
            case "browse": return OpBrowse(req);
            case "sizes": return OpSizes(req);
            case "dirs": return OpDirs(req);
            case "list": return OpList(req);
            case "top": return OpTop(req);
            case "dupes": return OpDupes(req);
            case "stats": return OpStats();
            default: throw new Exception("unknown op");
        }
    }

    private static string? Str(System.Text.Json.JsonElement req, string name)
        => req.TryGetProperty(name, out var el) && el.ValueKind == System.Text.Json.JsonValueKind.String ? el.GetString() : null;
    private static long? Num(System.Text.Json.JsonElement req, string name)
        => req.TryGetProperty(name, out var el) && el.ValueKind == System.Text.Json.JsonValueKind.Number ? el.GetInt64() : null;

    private static Dictionary<string, object?> OpQuery(System.Text.Json.JsonElement req)
    {
        var terms = new List<string>();
        if (req.TryGetProperty("terms", out var tEl) && tEl.ValueKind == System.Text.Json.JsonValueKind.Array)
            foreach (var t in tEl.EnumerateArray()) { var s = t.GetString(); if (!string.IsNullOrEmpty(s)) terms.Add(s.ToLowerInvariant()); }
        HashSet<string>? exts = null;
        if (req.TryGetProperty("exts", out var eEl) && eEl.ValueKind == System.Text.Json.JsonValueKind.Array)
        {
            exts = new HashSet<string>(StringComparer.Ordinal);
            foreach (var x in eEl.EnumerateArray()) { var s = x.GetString(); if (!string.IsNullOrEmpty(s)) exts.Add("." + s.ToLowerInvariant()); }
        }
        long after = Num(req, "after") ?? long.MinValue;
        long before = Num(req, "before") ?? long.MaxValue;
        long minB = Num(req, "minBytes") ?? long.MinValue;
        long maxB = Num(req, "maxBytes") ?? long.MaxValue;
        int max = (int)Math.Max(1, Math.Min(200, Num(req, "max") ?? 60));

        // (tier, -mtime) min-wins ordering into a bounded worst-first heap.
        var best = new List<(int tier, long mtime, int idx)>(max + 1);
        lock (Gate)
        {
            for (int i = 0; i < Entries.Count; i++)
            {
                var en = Entries[i];
                if (en.Dir < 0) continue;
                if (en.Mtime < after || en.Mtime >= before) continue;
                if (en.Size < minB || en.Size > maxB) continue;
                var lower = LowerOf(en);
                if (exts != null)
                {
                    var dot = lower.LastIndexOf('.');
                    if (dot < 0 || !exts.Contains(lower.Substring(dot))) continue;
                }
                int tier = 0;
                foreach (var term in terms)
                {
                    var k = MatchTier(lower, term);
                    if (k < 0) { tier = -1; break; }
                    if (k > tier) tier = k;
                }
                if (tier < 0) continue;
                best.Add((tier, en.Mtime, i));
                if (best.Count > max * 4)
                {
                    best.Sort(CompareHits);
                    best.RemoveRange(max, best.Count - max);
                }
            }
            best.Sort(CompareHits);
            if (best.Count > max) best.RemoveRange(max, best.Count - max);
            var items = new List<Dictionary<string, object?>>(best.Count);
            foreach (var (_, _, idx) in best)
            {
                var en = Entries[idx];
                items.Add(new Dictionary<string, object?>
                { ["p"] = Dirs[en.Dir] + "\\" + en.Name, ["n"] = en.Name, ["s"] = en.Size, ["m"] = en.Mtime });
            }
            return new Dictionary<string, object?> { ["items"] = items, ["building"] = !Ready };
        }
    }

    private static int CompareHits((int tier, long mtime, int idx) a, (int tier, long mtime, int idx) b)
        => a.tier != b.tier ? a.tier.CompareTo(b.tier) : b.mtime.CompareTo(a.mtime);

    // 0 exact · 1 prefix · 2 word-boundary · 3 substring · -1 miss.
    private static int MatchTier(string nameLower, string term)
    {
        var idx = nameLower.IndexOf(term, StringComparison.Ordinal);
        if (idx < 0) return -1;
        if (idx == 0)
        {
            if (nameLower.Length == term.Length) return 0;
            var dot = nameLower.LastIndexOf('.');
            if (dot == term.Length) return 0;   // exact up to the extension
            return 1;
        }
        var prev = nameLower[idx - 1];
        return (prev == ' ' || prev == '-' || prev == '_' || prev == '.' || prev == '(') ? 2 : 3;
    }

    // One snapshot for the Disk widget. Asking for sizes, directories, top
    // files and duplicate candidates separately walked a large index four
    // times. The host handles requests serially on purpose, so the later
    // requests could time out while merely waiting. Compute all four views in
    // one pass under one consistent read lock.
    private static Dictionary<string, object?> OpOverview(System.Text.Json.JsonElement req)
    {
        var path = NormalizeDir(Str(req, "path") ?? "");
        var prefixLower = path.TrimEnd('\\').ToLowerInvariant();
        long dirMinBytes = Num(req, "dirMinBytes") ?? DefaultDirMinBytes;
        int dirMax = (int)Math.Max(1, Math.Min(20000, Num(req, "dirMax") ?? 4000));
        int topMax = (int)Math.Max(1, Math.Min(500, Num(req, "topMax") ?? 200));
        long dupeMinBytes = Num(req, "dupeMinBytes") ?? DefaultDirMinBytes;
        int dupeMax = (int)Math.Max(1, Math.Min(500, Num(req, "dupeMax") ?? 40));
        int detailMax = (int)Math.Max(1, Math.Min(20000, Num(req, "detailMax") ?? 20000));
        var detailRoots = new List<(string path, string lower)>();
        if (req.TryGetProperty("detailRoots", out var detailEl) &&
            detailEl.ValueKind == System.Text.Json.JsonValueKind.Array)
        {
            foreach (var item in detailEl.EnumerateArray())
            {
                if (detailRoots.Count >= 8 || item.ValueKind != System.Text.Json.JsonValueKind.String) break;
                var detailPath = NormalizeDir(item.GetString() ?? "").TrimEnd('\\');
                if (detailPath.Length > 2) detailRoots.Add((detailPath, detailPath.ToLowerInvariant()));
            }
        }

        var aggregate = new Dictionary<int, (long s, long n, long m)>();
        var chains = new Dictionary<int, int[]>();
        var under = new Dictionary<int, bool>();
        var top = new List<(long s, int idx)>(topMax * 2);
        var bySize = new Dictionary<long, List<int>>();
        var detailFiles = new List<Dictionary<string, object?>>();
        var detailCounts = new int[detailRoots.Count];
        var detailCapped = false;
        long total = 0;
        long count = 0;

        lock (Gate)
        {
            for (int i = 0; i < Entries.Count; i++)
            {
                var en = Entries[i];
                if (en.Dir < 0) continue;
                if (!under.TryGetValue(en.Dir, out var isUnder))
                {
                    var dl = Dirs[en.Dir].TrimEnd('\\').ToLowerInvariant();
                    isUnder = dl.StartsWith(prefixLower, StringComparison.Ordinal)
                           && (dl.Length == prefixLower.Length || dl[prefixLower.Length] == '\\');
                    under[en.Dir] = isUnder;
                }
                if (!isUnder) continue;

                total += en.Size;
                count++;

                if (!chains.TryGetValue(en.Dir, out var chain))
                {
                    chain = AncestorChain(en.Dir, prefixLower);
                    chains[en.Dir] = chain;
                }
                foreach (var d in chain)
                {
                    aggregate.TryGetValue(d, out var b);
                    aggregate[d] = (b.s + en.Size, b.n + 1, Math.Max(b.m, en.Mtime));
                }

                top.Add((en.Size, i));
                if (top.Count > topMax * 4)
                {
                    top.Sort((a, b) => b.s.CompareTo(a.s));
                    top.RemoveRange(topMax, top.Count - topMax);
                }

                if (en.Size >= dupeMinBytes)
                {
                    if (!bySize.TryGetValue(en.Size, out var sameSize))
                        bySize[en.Size] = sameSize = new List<int>();
                    if (sameSize.Count < 20) sameSize.Add(i);
                }

                if (detailRoots.Count > 0)
                {
                    var dirPath = Dirs[en.Dir].TrimEnd('\\');
                    var dirLower = dirPath.ToLowerInvariant();
                    for (int d = 0; d < detailRoots.Count; d++)
                    {
                        var pref = detailRoots[d].lower;
                        if (!dirLower.StartsWith(pref, StringComparison.Ordinal) ||
                            (dirLower.Length > pref.Length && dirLower[pref.Length] != '\\')) continue;
                        if (detailCounts[d] >= detailMax)
                        {
                            detailCapped = true;
                            break;
                        }
                        detailFiles.Add(new Dictionary<string, object?>
                        {
                            ["p"] = dirPath + "\\" + en.Name,
                            ["n"] = en.Name, ["s"] = en.Size, ["m"] = en.Mtime,
                        });
                        detailCounts[d]++;
                        break;
                    }
                }
            }

            top.Sort((a, b) => b.s.CompareTo(a.s));
            if (top.Count > topMax) top.RemoveRange(topMax, top.Count - topMax);

            var dirs = aggregate.Where(kv => kv.Value.s >= dirMinBytes)
                .OrderByDescending(kv => kv.Value.s).Take(dirMax)
                .Select(kv => new Dictionary<string, object?>
                {
                    ["p"] = Dirs[kv.Key], ["s"] = kv.Value.s,
                    ["n"] = kv.Value.n, ["m"] = kv.Value.m,
                }).ToList();
            var topFiles = top.Select(x =>
            {
                var en = Entries[x.idx];
                return new Dictionary<string, object?>
                {
                    ["p"] = Dirs[en.Dir] + "\\" + en.Name,
                    ["n"] = en.Name, ["s"] = en.Size, ["m"] = en.Mtime,
                };
            }).ToList();
            var groups = bySize.Where(kv => kv.Value.Count > 1)
                .OrderByDescending(kv => kv.Key).Take(dupeMax)
                .Select(kv => new Dictionary<string, object?>
                {
                    ["s"] = kv.Key,
                    ["paths"] = kv.Value.Select(i => Dirs[Entries[i].Dir] + "\\" + Entries[i].Name).ToList(),
                }).ToList();

            return new Dictionary<string, object?>
            {
                ["total"] = total,
                ["files"] = count,
                ["dirs"] = dirs,
                ["topFiles"] = topFiles,
                ["groups"] = groups,
                ["detailFiles"] = detailFiles,
                ["building"] = !Ready,
                ["capped"] = Capped,
                ["detailCapped"] = detailCapped,
            };
        }
    }

    private static Dictionary<string, object?> OpSizes(System.Text.Json.JsonElement req)
    {
        var path = NormalizeDir(Str(req, "path") ?? "");
        var prefixLower = path.TrimEnd('\\').ToLowerInvariant();
        var buckets = new Dictionary<string, (long s, long n, long m)>(StringComparer.OrdinalIgnoreCase);
        long total = 0, count = 0;
        lock (Gate)
        {
            // dirId → its first-level child under `path` (cached per unique dir).
            var childOf = new Dictionary<int, string?>();
            for (int i = 0; i < Entries.Count; i++)
            {
                var en = Entries[i];
                if (en.Dir < 0) continue;
                if (!childOf.TryGetValue(en.Dir, out var child))
                {
                    child = FirstChildUnder(Dirs[en.Dir], prefixLower);
                    childOf[en.Dir] = child;
                }
                if (child == null)
                {
                    // Not under path — but files DIRECTLY in path still count in total.
                    if (string.Equals(Dirs[en.Dir].TrimEnd('\\'), path.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                    { total += en.Size; count++; }
                    continue;
                }
                total += en.Size; count++;
                buckets.TryGetValue(child, out var b);
                buckets[child] = (b.s + en.Size, b.n + 1, Math.Max(b.m, en.Mtime));
            }
        }
        var dirs = buckets.OrderByDescending(kv => kv.Value.s).Take(64)
            .Select(kv => new Dictionary<string, object?> { ["p"] = kv.Key, ["s"] = kv.Value.s, ["n"] = kv.Value.n, ["m"] = kv.Value.m })
            .ToList();
        return new Dictionary<string, object?> { ["total"] = total, ["files"] = count, ["dirs"] = dirs, ["building"] = !Ready };
    }

    // One-level, on-demand map for a directory the Disk widget already exposed
    // by opaque id. Unlike the overview's thresholded global tree, this always
    // returns the selected folder's direct child folders AND its largest direct
    // files, so a 140 GB Desktop made of loose files never opens to an empty map.
    private static Dictionary<string, object?> OpBrowse(System.Text.Json.JsonElement req)
    {
        var path = NormalizeDir(Str(req, "path") ?? "");
        var prefixLower = path.TrimEnd('\\').ToLowerInvariant();
        int childMax = (int)Math.Max(1, Math.Min(128, Num(req, "childMax") ?? 64));
        int fileMax = (int)Math.Max(1, Math.Min(128, Num(req, "fileMax") ?? 64));
        var buckets = new Dictionary<string, (long s, long n, long m)>(StringComparer.OrdinalIgnoreCase);
        var childOf = new Dictionary<int, string?>();
        var direct = new List<(long s, int idx)>(fileMax * 2);
        long total = 0, count = 0, directBytes = 0;

        lock (Gate)
        {
            for (int i = 0; i < Entries.Count; i++)
            {
                var en = Entries[i];
                if (en.Dir < 0) continue;
                if (!childOf.TryGetValue(en.Dir, out var child))
                {
                    child = FirstChildUnder(Dirs[en.Dir], prefixLower);
                    childOf[en.Dir] = child;
                }
                if (child != null)
                {
                    total += en.Size; count++;
                    buckets.TryGetValue(child, out var b);
                    buckets[child] = (b.s + en.Size, b.n + 1, Math.Max(b.m, en.Mtime));
                    continue;
                }
                if (!string.Equals(Dirs[en.Dir].TrimEnd('\\'), path.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                    continue;
                total += en.Size; count++; directBytes += en.Size;
                direct.Add((en.Size, i));
                if (direct.Count > fileMax * 4)
                {
                    direct.Sort((a, b) => b.s.CompareTo(a.s));
                    direct.RemoveRange(fileMax, direct.Count - fileMax);
                }
            }

            var children = buckets.OrderByDescending(kv => kv.Value.s).Take(childMax)
                .Select(kv => new Dictionary<string, object?>
                {
                    ["p"] = kv.Key, ["s"] = kv.Value.s,
                    ["n"] = kv.Value.n, ["m"] = kv.Value.m,
                }).ToList();
            direct.Sort((a, b) => b.s.CompareTo(a.s));
            if (direct.Count > fileMax) direct.RemoveRange(fileMax, direct.Count - fileMax);
            var directFiles = direct.Select(x =>
            {
                var en = Entries[x.idx];
                return new Dictionary<string, object?>
                {
                    ["p"] = Dirs[en.Dir] + "\\" + en.Name,
                    ["n"] = en.Name, ["s"] = en.Size, ["m"] = en.Mtime,
                };
            }).ToList();
            return new Dictionary<string, object?>
            {
                ["path"] = path,
                ["total"] = total,
                ["files"] = count,
                ["directBytes"] = directBytes,
                ["children"] = children,
                ["directFiles"] = directFiles,
                ["building"] = !Ready,
            };
        }
    }

    // "C:\a\b\c" under "c:\a" → "C:\a\b"; not under → null.
    private static string? FirstChildUnder(string dir, string prefixLower)
    {
        var d = dir.TrimEnd('\\');
        var dl = d.ToLowerInvariant();
        if (!dl.StartsWith(prefixLower, StringComparison.Ordinal)) return null;
        if (dl.Length == prefixLower.Length) return null;          // the dir IS path (direct files)
        if (dl[prefixLower.Length] != '\\') return null;           // "C:\ab" vs "C:\a"
        var next = dl.IndexOf('\\', prefixLower.Length + 1);
        return next < 0 ? d : d.Substring(0, next);
    }

    private static Dictionary<string, object?> OpDirs(System.Text.Json.JsonElement req)
    {
        var path = NormalizeDir(Str(req, "path") ?? "");
        var prefixLower = path.TrimEnd('\\').ToLowerInvariant();
        long minBytes = Num(req, "minBytes") ?? DefaultDirMinBytes;
        int max = (int)Math.Max(1, Math.Min(20000, Num(req, "max") ?? 5000));
        // Aggregate EVERY dir (each entry counts toward all its ancestors under
        // path). One pass with a per-dir ancestor chain cache.
        var agg = new Dictionary<int, (long s, long n, long m)>();
        var chains = new Dictionary<int, int[]>();
        lock (Gate)
        {
            for (int i = 0; i < Entries.Count; i++)
            {
                var en = Entries[i];
                if (en.Dir < 0) continue;
                if (!chains.TryGetValue(en.Dir, out var chain))
                {
                    chain = AncestorChain(en.Dir, prefixLower);
                    chains[en.Dir] = chain;
                }
                foreach (var d in chain)
                {
                    agg.TryGetValue(d, out var b);
                    agg[d] = (b.s + en.Size, b.n + 1, Math.Max(b.m, en.Mtime));
                }
            }
            var items = agg.Where(kv => kv.Value.s >= minBytes)
                .OrderByDescending(kv => kv.Value.s).Take(max)
                .Select(kv => new Dictionary<string, object?> { ["p"] = Dirs[kv.Key], ["s"] = kv.Value.s, ["n"] = kv.Value.n, ["m"] = kv.Value.m })
                .ToList();
            return new Dictionary<string, object?> { ["items"] = items, ["building"] = !Ready };
        }
    }

    // Dir ids of `dirId` and every ancestor of it that sits under prefixLower.
    private static int[] AncestorChain(int dirId, string prefixLower)
    {
        var list = new List<int>();
        var d = Dirs[dirId].TrimEnd('\\');
        while (true)
        {
            var dl = d.ToLowerInvariant();
            if (!dl.StartsWith(prefixLower, StringComparison.Ordinal)) break;
            if (dl.Length > prefixLower.Length && dl[prefixLower.Length] != '\\') break;
            if (DirIds.TryGetValue(d, out var id)) list.Add(id);
            var cut = d.LastIndexOf('\\');
            if (cut <= 2) break; // stop at drive root
            d = d.Substring(0, cut);
        }
        return list.ToArray();
    }

    private static Dictionary<string, object?> OpList(System.Text.Json.JsonElement req)
    {
        var path = NormalizeDir(Str(req, "path") ?? "");
        var prefixLower = path.TrimEnd('\\').ToLowerInvariant();
        int max = (int)Math.Max(1, Math.Min(20000, Num(req, "max") ?? 5000));
        var items = new List<Dictionary<string, object?>>();
        lock (Gate)
        {
            var under = new Dictionary<int, bool>();
            for (int i = 0; i < Entries.Count && items.Count < max; i++)
            {
                var en = Entries[i];
                if (en.Dir < 0) continue;
                if (!under.TryGetValue(en.Dir, out var ok))
                {
                    var dl = Dirs[en.Dir].TrimEnd('\\').ToLowerInvariant();
                    ok = dl.StartsWith(prefixLower, StringComparison.Ordinal)
                         && (dl.Length == prefixLower.Length || dl[prefixLower.Length] == '\\');
                    under[en.Dir] = ok;
                }
                if (!ok) continue;
                items.Add(new Dictionary<string, object?>
                { ["p"] = Dirs[en.Dir] + "\\" + en.Name, ["n"] = en.Name, ["s"] = en.Size, ["m"] = en.Mtime });
            }
        }
        return new Dictionary<string, object?> { ["items"] = items, ["building"] = !Ready };
    }

    private static Dictionary<string, object?> OpTop(System.Text.Json.JsonElement req)
    {
        var path = NormalizeDir(Str(req, "path") ?? "");
        var prefixLower = path.TrimEnd('\\').ToLowerInvariant();
        int max = (int)Math.Max(1, Math.Min(500, Num(req, "max") ?? 100));
        var best = new List<(long s, int idx)>(max + 1);
        lock (Gate)
        {
            var under = new Dictionary<int, bool>();
            for (int i = 0; i < Entries.Count; i++)
            {
                var en = Entries[i];
                if (en.Dir < 0) continue;
                if (!under.TryGetValue(en.Dir, out var ok))
                {
                    var dl = Dirs[en.Dir].TrimEnd('\\').ToLowerInvariant();
                    ok = dl.StartsWith(prefixLower, StringComparison.Ordinal)
                         && (dl.Length == prefixLower.Length || dl[prefixLower.Length] == '\\');
                    under[en.Dir] = ok;
                }
                if (!ok) continue;
                best.Add((en.Size, i));
                if (best.Count > max * 4) { best.Sort((a, b) => b.s.CompareTo(a.s)); best.RemoveRange(max, best.Count - max); }
            }
            best.Sort((a, b) => b.s.CompareTo(a.s));
            if (best.Count > max) best.RemoveRange(max, best.Count - max);
            var items = best.Select(x =>
            {
                var en = Entries[x.idx];
                return new Dictionary<string, object?> { ["p"] = Dirs[en.Dir] + "\\" + en.Name, ["n"] = en.Name, ["s"] = en.Size, ["m"] = en.Mtime };
            }).ToList();
            return new Dictionary<string, object?> { ["items"] = items };
        }
    }

    private static Dictionary<string, object?> OpDupes(System.Text.Json.JsonElement req)
    {
        var path = NormalizeDir(Str(req, "path") ?? "");
        var prefixLower = path.TrimEnd('\\').ToLowerInvariant();
        long minBytes = Num(req, "minBytes") ?? DefaultDirMinBytes;
        int max = (int)Math.Max(1, Math.Min(500, Num(req, "max") ?? 200));
        var bySize = new Dictionary<long, List<int>>();
        lock (Gate)
        {
            var under = new Dictionary<int, bool>();
            for (int i = 0; i < Entries.Count; i++)
            {
                var en = Entries[i];
                if (en.Dir < 0 || en.Size < minBytes) continue;
                if (!under.TryGetValue(en.Dir, out var ok))
                {
                    var dl = Dirs[en.Dir].TrimEnd('\\').ToLowerInvariant();
                    ok = dl.StartsWith(prefixLower, StringComparison.Ordinal)
                         && (dl.Length == prefixLower.Length || dl[prefixLower.Length] == '\\');
                    under[en.Dir] = ok;
                }
                if (!ok) continue;
                if (!bySize.TryGetValue(en.Size, out var l)) bySize[en.Size] = l = new List<int>();
                if (l.Count < 20) l.Add(i);
            }
            var groups = bySize.Where(kv => kv.Value.Count > 1)
                .OrderByDescending(kv => kv.Key).Take(max)
                .Select(kv => new Dictionary<string, object?>
                {
                    ["s"] = kv.Key,
                    ["paths"] = kv.Value.Select(i => Dirs[Entries[i].Dir] + "\\" + Entries[i].Name).ToList(),
                }).ToList();
            return new Dictionary<string, object?> { ["groups"] = groups };
        }
    }

    private static Dictionary<string, object?> OpStats()
    {
        lock (Gate)
        {
            return new Dictionary<string, object?>
            {
                ["ready"] = Ready,
                ["building"] = !Ready,
                ["files"] = (long)(Entries.Count - Tombstones),
                ["dirs"] = (long)Dirs.Count,
                ["bytes"] = TotalBytes,
                ["ramMB"] = GC.GetTotalMemory(false) / (1024 * 1024),
                ["roots"] = Roots.ToList(),
                ["watchers"] = Watchers.Count,
                // True when MaxEntries stopped the walk: the index is still
                // useful but not complete — consumers can say so honestly.
                ["capped"] = Capped,
            };
        }
    }

    // ── build + live updates ──────────────────────────────────────────────────

    private static void WalkRoot(string root)
    {
        var opts = new EnumerationOptions
        {
            IgnoreInaccessible = true,
            RecurseSubdirectories = true,
            AttributesToSkip = FileAttributes.ReparsePoint,   // never through a junction
        };
        long emitted = 0;
        var lastProgress = Environment.TickCount64;
        IEnumerable<FileInfo> files;
        try { files = new DirectoryInfo(root).EnumerateFiles("*", opts); }
        catch { return; }
        foreach (var fi in files)
        {
            if (Cancelled) return;
            long len, mt;
            string? dir;
            try { len = fi.Length; mt = new DateTimeOffset(fi.LastWriteTimeUtc).ToUnixTimeMilliseconds(); dir = fi.DirectoryName; }
            catch { continue; }
            if (dir == null) continue;
            lock (Gate)
            {
                if (Entries.Count - Tombstones >= MaxEntries) { Capped = true; return; }
                AddEntryLocked(dir, fi.Name, len, mt);
            }
            emitted++;
            var now = Environment.TickCount64;
            if (now - lastProgress > 1000)
            {
                lastProgress = now;
                Emit(new Dictionary<string, object?> { ["event"] = "progress", ["files"] = emitted, ["root"] = root });
            }
        }
    }

    private static void AddEntryLocked(string dir, string name, long size, long mtime)
    {
        if (!DirIds.TryGetValue(dir, out var dirId))
        {
            dirId = Dirs.Count;
            Dirs.Add(dir);
            DirIds[dir] = dirId;
        }
        var lower = name.ToLowerInvariant();
        // Already-lowercase names keep ONE string: the key reuses the name
        // reference and the entry stores null (LowerOf falls back to Name).
        if (string.Equals(lower, name, StringComparison.Ordinal)) lower = name;
        var key = new PathKey(dirId, lower);
        if (ByPath.TryGetValue(key, out var existing))
        {
            var en = Entries[existing];
            TotalBytes += size - en.Size;
            en.Size = size; en.Mtime = mtime;
            Entries[existing] = en;
            return;
        }
        Entries.Add(new Entry { Name = name, NameLower = ReferenceEquals(lower, name) ? null : lower, Dir = dirId, Size = size, Mtime = mtime });
        ByPath[key] = Entries.Count - 1;
        TotalBytes += size;
    }

    private static void RemoveEntryLocked(string dir, string name)
    {
        if (!DirIds.TryGetValue(dir, out var dirId)) return;
        var key = new PathKey(dirId, name.ToLowerInvariant());
        if (!ByPath.TryGetValue(key, out var idx)) return;
        var en = Entries[idx];
        TotalBytes -= en.Size;
        en.Dir = -1; en.Name = ""; en.NameLower = null;
        Entries[idx] = en;
        ByPath.Remove(key);
        Tombstones++;
        if (Tombstones > 50000 && Tombstones > Entries.Count / 5) CompactLocked();
    }

    private static void RemoveSubtree(string root)
    {
        var prefixLower = root.TrimEnd('\\').ToLowerInvariant();
        lock (Gate)
        {
            var under = new Dictionary<int, bool>();
            for (int i = 0; i < Entries.Count; i++)
            {
                var en = Entries[i];
                if (en.Dir < 0) continue;
                if (!under.TryGetValue(en.Dir, out var ok))
                {
                    var dl = Dirs[en.Dir].TrimEnd('\\').ToLowerInvariant();
                    ok = dl.StartsWith(prefixLower, StringComparison.Ordinal)
                         && (dl.Length == prefixLower.Length || dl[prefixLower.Length] == '\\');
                    under[en.Dir] = ok;
                }
                if (!ok) continue;
                ByPath.Remove(new PathKey(en.Dir, LowerOf(en)));
                TotalBytes -= en.Size;
                en.Dir = -1; en.Name = ""; en.NameLower = null;
                Entries[i] = en;
                Tombstones++;
            }
            CompactLocked();
        }
    }

    private static void CompactLocked()
    {
        var alive = new List<Entry>(Entries.Count - Tombstones);
        foreach (var en in Entries) if (en.Dir >= 0) alive.Add(en);
        Entries.Clear();
        Entries.AddRange(alive);
        ByPath.Clear();
        for (int i = 0; i < Entries.Count; i++) ByPath[new PathKey(Entries[i].Dir, LowerOf(Entries[i]))] = i;
        Tombstones = 0;
    }

    private static void StartWatcher(string root)
    {
        try
        {
            var w = new FileSystemWatcher(root)
            {
                IncludeSubdirectories = true,
                InternalBufferSize = 64 * 1024,   // max Windows allows
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.Size | NotifyFilters.LastWrite,
            };
            w.Created += (_, e) => OnFsEvent(e.FullPath, created: true);
            w.Changed += (_, e) => OnFsEvent(e.FullPath, created: false);
            w.Deleted += (_, e) => OnFsDeleted(e.FullPath);
            w.Renamed += (_, e) => { OnFsDeleted(e.OldFullPath); OnFsEvent(e.FullPath, created: true); };
            w.Error += (_, _) => { lock (Gate) DirtyRoots.Add(root); };
            w.EnableRaisingEvents = true;
            Watchers.Add(w);
        }
        catch { /* an unwatchable root degrades to build-time snapshot */ }
    }

    private static void OnFsEvent(string fullPath, bool created)
    {
        try
        {
            var fi = new FileInfo(fullPath);
            if (fi.Exists)
            {
                if ((fi.Attributes & FileAttributes.ReparsePoint) != 0) return;
                lock (Gate)
                {
                    if (Entries.Count - Tombstones >= MaxEntries) { Capped = true; return; }
                    AddEntryLocked(fi.DirectoryName ?? "", fi.Name, fi.Length, new DateTimeOffset(fi.LastWriteTimeUtc).ToUnixTimeMilliseconds());
                }
                return;
            }
            if (created && Directory.Exists(fullPath))
            {
                // A moved-in directory arrives as ONE created event: walk it.
                new Thread(() => WalkRoot(fullPath)) { IsBackground = true }.Start();
            }
        }
        catch { /* transient fs races are the watcher's daily bread */ }
    }

    private static void OnFsDeleted(string fullPath)
    {
        try
        {
            var cut = fullPath.LastIndexOf('\\');
            if (cut <= 0) return;
            var dir = fullPath.Substring(0, cut);
            var name = fullPath.Substring(cut + 1);
            bool isDirectory;
            lock (Gate) isDirectory = DirIds.ContainsKey(fullPath);
            if (isDirectory) RemoveSubtree(fullPath);
            else lock (Gate) RemoveEntryLocked(dir, name);
        }
        catch { }
    }

    private static string NormalizeDir(string p)
    {
        var s = p.Replace('/', '\\');
        if (s.Length == 2 && s[1] == ':') s += "\\";
        return s;
    }

    private static void Emit(Dictionary<string, object?> obj)
    {
        var json = JsonOut.Serialize(obj);
        var b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
        lock (OutLock)
        {
            Console.Out.WriteLine("XEIDX " + b64);
            Console.Out.Flush();
        }
    }
}
