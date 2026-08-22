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
// root dirty and a background REPAIR re-walks just that root — the index may
// briefly lag, it must never stay wrong. stdin EOF = clean exit.
//
// Three rules make that repair safe, and all three were learned from one bug
// (measured on a live install: the index rebuilding C:\ end to end every ~20s,
// for hours, at 98% of a core, its file count swinging 1.8M → 418k → 1.3M).
//   1. The watcher callbacks NEVER take the index lock and never touch the
//      disk. They record the path and return. The old handlers did a stat plus
//      a lock per event, so while a re-walk held that lock a couple of million
//      times the callbacks were starved, the watcher's 64 KB kernel buffer
//      overflowed, that overflow marked the root dirty, and the repair it
//      triggered starved the callbacks again. The recovery WAS the cause.
//   2. A repair upserts under a fresh generation stamp and then sweeps only
//      what it did not touch. It never empties the root first: search and the
//      disk widget read this index continuously, and a "kept current" index
//      that periodically drops three quarters of its content is not lagging,
//      it is wrong.
//   3. A repair is debounced (the storm must pass) and rate-limited per root,
//      so no amount of filesystem noise can turn into a permanent re-walk.
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
        public int Gen;            // walk that last confirmed this entry (see the repair rules)
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

    // ── repair scheduling ─────────────────────────────────────────────────────
    // A dirty root carries WHEN it was first marked and when it was last marked:
    // the repair waits for the storm to stop (quiet) but never waits forever
    // (max), and never repairs the same root more often than the interval.
    private readonly record struct Dirt(long First, long Last);
    private static readonly Dictionary<string, Dirt> DirtyRoots = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, long> LastRepair = new(StringComparer.OrdinalIgnoreCase);
    private const int RepairQuietMs = 30_000;        // no new overflow for this long
    private const int RepairMaxWaitMs = 300_000;     // ...but repair anyway after this
    private const int RepairMinIntervalMs = 600_000; // at most one re-walk per root per 10 min
    private static volatile bool Repairing;
    private static int Repairs;

    // ── coalesced watcher events ──────────────────────────────────────────────
    // Path → "a create event was seen for it". Statting happens on the drain
    // thread, so the same file written a thousand times a second costs one stat
    // per drain instead of a thousand stats under the index lock.
    private static readonly object PendingGate = new();
    private static readonly Dictionary<string, bool> Pending = new(StringComparer.OrdinalIgnoreCase);
    private const int PendingMax = 200_000;          // beyond this the root is repaired instead
    private const int DrainIntervalMs = 300;

    // Entries are written under the newest generation issued. An entry the
    // drain thread adds while a repair walk is running therefore carries that
    // walk's generation and survives its sweep.
    private static int WalkGen;
    private static int CurrentGen => Volatile.Read(ref WalkGen);

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
            // A root the cap cut short is RECORDED, not just counted. The walk is
            // sequential, so hitting MaxEntries on an early root leaves every
            // later one essentially absent — and "2.000.000 files indexed" reads
            // as success while search quietly cannot see a whole drive. Naming
            // the roots is what turns that into something the user can act on.
            foreach (var r in Roots)
            {
                if (Cancelled) break;
                if (!WalkRoot(r)) lock (Gate) IncompleteRoots.Add(r);
            }
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
            // Dirty-root repair loop: a watcher overflow re-walks that root,
            // debounced and rate-limited, and sweeps instead of emptying.
            while (!Cancelled)
            {
                var due = TakeDueRoot();
                if (due != null) RepairRoot(due);
                else Thread.Sleep(1000);
            }
        })
        { IsBackground = true, Name = "index-build" }.Start();

        // Watcher events are applied here, off the watcher callbacks.
        new Thread(DrainLoop) { IsBackground = true, Name = "index-drain" }.Start();

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
        // Read the queue BEFORE the index lock: this is the only place that
        // would want both, and taking them in one fixed order is cheaper to
        // keep true than a rule about which nests inside which.
        var pending = PendingCount();
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
                // What the host is doing beyond the initial build. Without
                // these three, a host re-walking a root forever is
                // indistinguishable from an idle one that merely uses a core.
                ["repairing"] = Repairing,
                ["repairs"] = Repairs,
                ["pending"] = pending,
                // True when MaxEntries stopped the walk: the index is still
                // useful but not complete — consumers can say so honestly.
                ["capped"] = Capped,
                // ...and WHICH roots were left incomplete, so the UI can name
                // the drive that search cannot see instead of only saying that
                // some limit was reached.
                ["cappedRoots"] = IncompleteRoots.ToList(),
            };
        }
    }

    private static int PendingCount() { lock (PendingGate) return Pending.Count; }

    // ── build + live updates ──────────────────────────────────────────────────

    private static bool WalkRoot(string root) => WalkRoot(root, CurrentGen);

    // Roots whose initial walk did not see the whole root (display case, as the
    // user typed them). Guarded by Gate like every other index field.
    private static readonly List<string> IncompleteRoots = new();

    // Entries are added in batches under ONE lock acquisition instead of one
    // per file. On a 2M-entry root the per-file version held the index lock
    // roughly two million times in a row, which starved the watcher callbacks
    // for the whole walk — see rule 1 in the header.
    private const int LockBatch = 512;

    // false = this walk did NOT see the whole root: the entry cap truncated it,
    // the enumeration could not start, or it was cancelled. Callers use it to
    // decide whether "this walk did not touch it" is evidence a file is gone.
    private static bool WalkRoot(string root, int gen)
    {
        var opts = new EnumerationOptions
        {
            IgnoreInaccessible = true,
            RecurseSubdirectories = true,
            AttributesToSkip = FileAttributes.ReparsePoint,   // never through a junction
        };
        long emitted = 0;
        var lastProgress = Environment.TickCount64;
        var batch = new List<(string dir, string name, long size, long mtime)>(LockBatch);
        IEnumerable<FileInfo> files;
        // The enumeration never started, so this walk is evidence of nothing.
        // Reporting it as complete would let a repair sweep every entry under a
        // momentarily unreadable root out of the index.
        try { files = new DirectoryInfo(root).EnumerateFiles("*", opts); }
        catch { return false; }
        foreach (var fi in files)
        {
            if (Cancelled) return false;
            long len, mt;
            string? dir;
            try { len = fi.Length; mt = new DateTimeOffset(fi.LastWriteTimeUtc).ToUnixTimeMilliseconds(); dir = fi.DirectoryName; }
            catch { continue; }
            if (dir == null) continue;
            batch.Add((dir, fi.Name, len, mt));
            if (batch.Count >= LockBatch && !FlushWalkBatch(batch, gen)) return false;
            emitted++;
            var now = Environment.TickCount64;
            // Progress is a BUILD signal only: emitting it during a repair
            // overwrites the server's build progress with a rescan's count, and
            // "1.5M files, root C:\" sitting next to "ready" is exactly the
            // reading that made this bug hard to see from outside.
            if (!Ready && now - lastProgress > 1000)
            {
                lastProgress = now;
                Emit(new Dictionary<string, object?> { ["event"] = "progress", ["files"] = emitted, ["root"] = root });
            }
        }
        return FlushWalkBatch(batch, gen);
    }

    // false = the entry cap stopped the walk.
    private static bool FlushWalkBatch(List<(string dir, string name, long size, long mtime)> batch, int gen)
    {
        if (batch.Count == 0) return true;
        var ok = true;
        lock (Gate)
        {
            foreach (var b in batch)
            {
                if (Entries.Count - Tombstones >= MaxEntries) { Capped = true; ok = false; break; }
                AddEntryLocked(b.dir, b.name, b.size, b.mtime, gen);
            }
        }
        batch.Clear();
        return ok;
    }

    private static void AddEntryLocked(string dir, string name, long size, long mtime)
        => AddEntryLocked(dir, name, size, mtime, CurrentGen);

    private static void AddEntryLocked(string dir, string name, long size, long mtime, int gen)
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
            en.Size = size; en.Mtime = mtime; en.Gen = gen;
            Entries[existing] = en;
            return;
        }
        Entries.Add(new Entry { Name = name, NameLower = ReferenceEquals(lower, name) ? null : lower, Dir = dirId, Gen = gen, Size = size, Mtime = mtime });
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
            // Same threshold as RemoveEntryLocked. Compacting unconditionally
            // rebuilt the whole ByPath dictionary (millions of entries) on
            // EVERY deleted directory — and a build tool deletes directories by
            // the hundred.
            if (Tombstones > 50000 && Tombstones > Entries.Count / 5) CompactLocked();
        }
    }

    // The other half of a repair: whatever the walk did not confirm under this
    // root is gone. Entries the drain thread added while the walk ran carry the
    // walk's own generation, so they are never swept.
    private static void SweepStaleUnder(string root, int gen)
    {
        var prefixLower = root.TrimEnd('\\').ToLowerInvariant();
        lock (Gate)
        {
            var under = new Dictionary<int, bool>();
            for (int i = 0; i < Entries.Count; i++)
            {
                var en = Entries[i];
                if (en.Dir < 0 || en.Gen == gen) continue;
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
            if (Tombstones > 50000 && Tombstones > Entries.Count / 5) CompactLocked();
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
            // These four callbacks run on the watcher's own threads and must
            // return immediately: no disk, no index lock. Everything they do is
            // record the path (see rule 1 in the header).
            w.Created += (_, e) => OnFsTouch(e.FullPath, created: true);
            w.Changed += (_, e) => OnFsTouch(e.FullPath, created: false);
            w.Deleted += (_, e) => OnFsTouch(e.FullPath, created: false);
            w.Renamed += (_, e) => { OnFsTouch(e.OldFullPath, created: false); OnFsTouch(e.FullPath, created: true); };
            w.Error += (_, _) =>
            {
                MarkDirty(root);
                // A buffer overflow leaves the watcher alive, but other errors
                // leave it permanently deaf with no way to tell from here.
                // Re-arming costs nothing and a silently dead watcher is the one
                // failure this host cannot otherwise detect.
                try { w.EnableRaisingEvents = false; w.EnableRaisingEvents = true; } catch { }
            };
            w.EnableRaisingEvents = true;
            Watchers.Add(w);
        }
        catch { /* an unwatchable root degrades to build-time snapshot */ }
    }

    private static void OnFsTouch(string fullPath, bool created)
    {
        if (string.IsNullOrEmpty(fullPath)) return;
        var overflow = false;
        lock (PendingGate)
        {
            if (Pending.Count >= PendingMax) overflow = true;
            else if (created) Pending[fullPath] = true;
            else if (!Pending.ContainsKey(fullPath)) Pending[fullPath] = false;
        }
        // The queue is as bounded as the kernel's own buffer, and it answers an
        // overflow the same way: repair the root rather than grow without limit.
        if (overflow) MarkDirty(fullPath);
    }

    // Applies coalesced watcher events: one stat per touched path per pass,
    // whatever happened to it in between, and one index lock per pass.
    private static void DrainLoop()
    {
        var touched = new List<KeyValuePair<string, bool>>(4096);
        var adds = new List<(string dir, string name, long size, long mtime)>(4096);
        var fileDeletes = new List<(string dir, string name)>();
        var subtreeDeletes = new List<string>();
        var dirWalks = new List<string>();

        while (!Cancelled)
        {
            touched.Clear(); adds.Clear(); fileDeletes.Clear(); subtreeDeletes.Clear(); dirWalks.Clear();
            lock (PendingGate)
            {
                if (Pending.Count > 0) { touched.AddRange(Pending); Pending.Clear(); }
            }
            if (touched.Count == 0) { Thread.Sleep(DrainIntervalMs); continue; }

            foreach (var kv in touched)
            {
                if (Cancelled) return;
                var full = kv.Key;
                try
                {
                    // Statting NOW is what makes coalescing correct: created,
                    // written and deleted between two passes reads as deleted,
                    // which is the truth.
                    var fi = new FileInfo(full);
                    if (fi.Exists)
                    {
                        if ((fi.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                        var dir = fi.DirectoryName;
                        if (dir == null) continue;
                        adds.Add((dir, fi.Name, fi.Length, new DateTimeOffset(fi.LastWriteTimeUtc).ToUnixTimeMilliseconds()));
                        continue;
                    }
                    if (Directory.Exists(full))
                    {
                        // A directory moved in arrives as ONE created event, so
                        // its contents are only ever seen by walking it.
                        if (kv.Value) dirWalks.Add(full);
                        continue;
                    }
                    bool isDirectory;
                    lock (Gate) isDirectory = DirIds.ContainsKey(full);
                    if (isDirectory) { subtreeDeletes.Add(full); continue; }
                    var cut = full.LastIndexOf('\\');
                    if (cut > 0) fileDeletes.Add((full.Substring(0, cut), full.Substring(cut + 1)));
                }
                catch { /* transient fs races are the watcher's daily bread */ }
            }

            if (adds.Count > 0 || fileDeletes.Count > 0)
            {
                lock (Gate)
                {
                    foreach (var a in adds)
                    {
                        if (Entries.Count - Tombstones >= MaxEntries) { Capped = true; break; }
                        AddEntryLocked(a.dir, a.name, a.size, a.mtime);
                    }
                    foreach (var d in fileDeletes) RemoveEntryLocked(d.dir, d.name);
                }
            }
            foreach (var p in subtreeDeletes) { if (Cancelled) return; RemoveSubtree(p); }
            foreach (var d in dirWalks) { if (Cancelled) return; WalkRoot(d); }
            Thread.Sleep(DrainIntervalMs);
        }
    }

    // ── repair scheduling ─────────────────────────────────────────────────────

    private static void MarkDirty(string pathOrRoot)
    {
        var root = RootOf(pathOrRoot);
        if (root == null) return;
        var now = Environment.TickCount64;
        lock (Gate)
        {
            DirtyRoots[root] = DirtyRoots.TryGetValue(root, out var d) ? new Dirt(d.First, now) : new Dirt(now, now);
        }
    }

    private static string? RootOf(string path)
    {
        var pl = path.ToLowerInvariant();
        string? best = null;
        var bestLen = -1;
        foreach (var r in Roots)
        {
            var rl = r.TrimEnd('\\').ToLowerInvariant();
            if (rl.Length == 0) continue;
            if (!pl.StartsWith(rl, StringComparison.Ordinal)) continue;
            if (pl.Length != rl.Length && pl[rl.Length] != '\\') continue;
            if (rl.Length > bestLen) { best = r; bestLen = rl.Length; }
        }
        return best;
    }

    // A root is due once the storm has stopped (or has gone on long enough to
    // stop waiting for it), and never more often than the interval. Without
    // both, one busy filesystem turns into a permanent re-walk.
    private static string? TakeDueRoot()
    {
        var now = Environment.TickCount64;
        string? due = null;
        lock (Gate)
        {
            foreach (var kv in DirtyRoots)
            {
                var quiet = now - kv.Value.Last >= RepairQuietMs;
                var waitedLongEnough = now - kv.Value.First >= RepairMaxWaitMs;
                if (!quiet && !waitedLongEnough) continue;
                if (LastRepair.TryGetValue(kv.Key, out var last) && now - last < RepairMinIntervalMs) continue;
                due = kv.Key;
                break;
            }
            if (due != null) { DirtyRoots.Remove(due); LastRepair[due] = now; }
        }
        return due;
    }

    private static void RepairRoot(string root)
    {
        var gen = Interlocked.Increment(ref WalkGen);
        Repairing = true;
        try
        {
            // A walk that stopped early saw only part of the root, so "not
            // touched" is not evidence that anything is gone. That question is
            // about THIS walk: `Capped` is a sticky whole-index report flag, so
            // gating the sweep on it disabled stale removal permanently, for
            // every root, the first time any root touched the cap — leaving
            // deleted files in the index forever, in exactly the state where the
            // index is already least accurate. The index may lag; it must never
            // stay wrong.
            var complete = WalkRoot(root, gen);
            if (!Cancelled && complete) SweepStaleUnder(root, gen);
        }
        finally
        {
            Repairing = false;
            Interlocked.Increment(ref Repairs);
        }
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
