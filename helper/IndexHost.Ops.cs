// The file index: the other requests: overview, browse, lists, biggest files, duplicates, state.

using System.IO.Enumeration;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

internal static partial class IndexHost
{
    // One snapshot for the Disk widget, under one consistent lock. Sizes come
    // from the live directory totals, so this walks the folder tree (pruned at
    // dirMinBytes) and the large-file set, never every file: measured on a
    // 2.56M-file C:\ before the totals existed, the per-file pass cost
    // 330-675 ms and held the lock that search queries wait on.
    private static Dictionary<string, object?> OpOverview(System.Text.Json.JsonElement req)
    {
        var path = Str(req, "path") ?? "";
        long dirMinBytes = Num(req, "dirMinBytes") ?? DefaultDirMinBytes;
        int dirMax = (int)Math.Max(1, Math.Min(20000, Num(req, "dirMax") ?? 4000));
        int topMax = (int)Math.Max(1, Math.Min(500, Num(req, "topMax") ?? 200));
        long dupeMinBytes = Num(req, "dupeMinBytes") ?? DefaultDirMinBytes;
        int dupeMax = (int)Math.Max(1, Math.Min(500, Num(req, "dupeMax") ?? 40));
        int detailMax = (int)Math.Max(1, Math.Min(20000, Num(req, "detailMax") ?? 20000));
        // "Large and untouched": files of at least staleMinBytes last modified
        // before staleBefore (epoch ms). Absent = not asked.
        long staleMinBytes = Num(req, "staleMinBytes") ?? 0;
        long staleBefore = Num(req, "staleBefore") ?? 0;
        int staleMax = (int)Math.Max(1, Math.Min(500, Num(req, "staleMax") ?? 100));
        var detailPaths = new List<string>();
        if (req.TryGetProperty("detailRoots", out var detailEl) &&
            detailEl.ValueKind == System.Text.Json.JsonValueKind.Array)
        {
            foreach (var item in detailEl.EnumerateArray())
            {
                if (detailPaths.Count >= 8 || item.ValueKind != System.Text.Json.JsonValueKind.String) break;
                var detailPath = NormalizeDir(item.GetString() ?? "").TrimEnd('\\');
                if (detailPath.Length > 2) detailPaths.Add(detailPath);
            }
        }

        lock (Gate)
        {
            var sc = ScopeOfLocked(path);
            var dirCache = new Dictionary<int, string>();
            var (total, count, _) = ScopeTotalsLocked(in sc);
            var dirs = DirsAtLeastLocked(in sc, dirMinBytes, dirMax);
            var topFiles = TopFilesLocked(in sc, topMax).Select(i => Item(in Entries[i], dirCache)).ToList();
            var groups = DupeGroupsLocked(in sc, dupeMinBytes, dupeMax, dirCache);

            // Files inside the detail roots (Downloads, temp), straight from the
            // directory file lists of those subtrees. Each file is listed once,
            // under the first detail root that holds it.
            var detailFiles = new List<Dictionary<string, object?>>();
            var detailCapped = false;
            var seenDirs = new HashSet<int>();
            foreach (var dp in detailPaths)
            {
                var ds = ScopeOfLocked(dp);
                var listed = 0;
                ForEachDirLocked(in ds, d =>
                {
                    if (!seenDirs.Add(d)) return false;
                    if (listed >= detailMax) { if (DirNodes[d].Files > 0) detailCapped = true; return false; }
                    for (var i = DirNodes[d].FirstFile; i >= 0; i = NextInDir[i])
                    {
                        if (Entries[i].Dir < 0) continue;
                        if (listed >= detailMax) { detailCapped = true; break; }
                        detailFiles.Add(Item(in Entries[i], dirCache));
                        listed++;
                    }
                    return true;
                });
            }

            var result = new Dictionary<string, object?>
            {
                ["total"] = total,
                ["files"] = count,
                ["dirs"] = dirs,
                ["topFiles"] = topFiles,
                ["groups"] = groups,
                ["detailFiles"] = detailFiles,
                ["kinds"] = KindsLocked(in sc),
                ["version"] = Version,
                ["building"] = !Ready,
                ["capped"] = Capped,
                ["detailCapped"] = detailCapped,
            };
            if (staleMinBytes > 0 && staleBefore > 0)
            {
                var stale = FilesUnderLocked(in sc, staleMinBytes).Where(i => Entries[i].Mtime > 0 && Entries[i].Mtime < staleBefore).ToList();
                stale.Sort((a, b) => Entries[b].Size.CompareTo(Entries[a].Size));
                if (stale.Count > staleMax) stale.RemoveRange(staleMax, stale.Count - staleMax);
                result["staleFiles"] = stale.Select(i => Item(in Entries[i], dirCache)).ToList();
            }
            return result;
        }
    }

    // First-level children of `path`, largest first, from their live totals.
    // A path above the roots lists the roots under it.
    private static List<int> ChildrenLocked(in Scope sc)
    {
        var kids = new List<int>();
        if (sc.Self >= 0)
        {
            for (var c = DirNodes[sc.Self].FirstChild; c >= 0; c = DirNodes[c].NextSibling)
                if (DirNodes[c].Files > 0) kids.Add(c);
        }
        else
        {
            foreach (var a in sc.Anchors) if (a >= 0 && DirNodes[a].Files > 0) kids.Add(a);
        }
        kids.Sort((a, b) => DirNodes[b].Size.CompareTo(DirNodes[a].Size));
        return kids;
    }

    private static Dictionary<string, object?> OpSizes(System.Text.Json.JsonElement req)
    {
        var path = Str(req, "path") ?? "";
        lock (Gate)
        {
            var sc = ScopeOfLocked(path);
            var (total, count, _) = ScopeTotalsLocked(in sc);
            var dirs = ChildrenLocked(in sc).Take(64).Select(DirItemLocked).ToList();
            return new Dictionary<string, object?> { ["total"] = total, ["files"] = count, ["dirs"] = dirs, ["building"] = !Ready };
        }
    }

    // One-level, on-demand map for a directory the Disk widget already exposed
    // by opaque id: its direct child folders AND its largest direct files, so a
    // 140 GB Desktop made of loose files never opens to an empty map. Answered
    // from the node's own totals and file list: O(children + its own files).
    private static Dictionary<string, object?> OpBrowse(System.Text.Json.JsonElement req)
    {
        var path = NormalizeDir(Str(req, "path") ?? "");
        int childMax = (int)Math.Max(1, Math.Min(128, Num(req, "childMax") ?? 64));
        int fileMax = (int)Math.Max(1, Math.Min(128, Num(req, "fileMax") ?? 64));

        lock (Gate)
        {
            var sc = ScopeOfLocked(path);
            var (total, count, _) = ScopeTotalsLocked(in sc);
            var kids = ChildrenLocked(in sc);
            long childBytes = 0;
            foreach (var k in kids) childBytes += DirNodes[k].Size;
            var direct = new List<int>();
            if (sc.Self >= 0) ForEachFileInLocked(sc.Self, i => direct.Add(i));
            direct.Sort((a, b) => Entries[b].Size.CompareTo(Entries[a].Size));
            if (direct.Count > fileMax) direct.RemoveRange(fileMax, direct.Count - fileMax);
            var dirCache = new Dictionary<int, string>();
            return new Dictionary<string, object?>
            {
                ["path"] = path,
                ["total"] = total,
                ["files"] = count,
                ["directBytes"] = Math.Max(0, total - childBytes),
                ["children"] = kids.Take(childMax).Select(DirItemLocked).ToList(),
                ["directFiles"] = direct.Select(i => Item(in Entries[i], dirCache)).ToList(),
                ["version"] = Version,
                ["building"] = !Ready,
            };
        }
    }

    private static Dictionary<string, object?> OpDirs(System.Text.Json.JsonElement req)
    {
        var path = Str(req, "path") ?? "";
        long minBytes = Num(req, "minBytes") ?? DefaultDirMinBytes;
        int max = (int)Math.Max(1, Math.Min(20000, Num(req, "max") ?? 5000));
        lock (Gate)
        {
            var sc = ScopeOfLocked(path);
            return new Dictionary<string, object?> { ["items"] = DirsAtLeastLocked(in sc, minBytes, max), ["building"] = !Ready };
        }
    }

    private static Dictionary<string, object?> OpList(System.Text.Json.JsonElement req)
    {
        var path = Str(req, "path") ?? "";
        int max = (int)Math.Max(1, Math.Min(20000, Num(req, "max") ?? 5000));
        var items = new List<Dictionary<string, object?>>();
        lock (Gate)
        {
            var sc = ScopeOfLocked(path);
            var dirCache = new Dictionary<int, string>();
            ForEachDirLocked(in sc, d =>
            {
                if (items.Count >= max) return false;
                for (var i = DirNodes[d].FirstFile; i >= 0 && items.Count < max; i = NextInDir[i])
                    if (Entries[i].Dir >= 0) items.Add(Item(in Entries[i], dirCache));
                return true;
            });
        }
        return new Dictionary<string, object?> { ["items"] = items, ["building"] = !Ready };
    }

    private static Dictionary<string, object?> OpTop(System.Text.Json.JsonElement req)
    {
        var path = Str(req, "path") ?? "";
        int max = (int)Math.Max(1, Math.Min(500, Num(req, "max") ?? 100));
        lock (Gate)
        {
            var sc = ScopeOfLocked(path);
            var dirCache = new Dictionary<int, string>();
            var items = TopFilesLocked(in sc, max).Select(i => Item(in Entries[i], dirCache)).ToList();
            return new Dictionary<string, object?> { ["items"] = items };
        }
    }

    private static Dictionary<string, object?> OpDupes(System.Text.Json.JsonElement req)
    {
        var path = Str(req, "path") ?? "";
        long minBytes = Num(req, "minBytes") ?? DefaultDirMinBytes;
        int max = (int)Math.Max(1, Math.Min(500, Num(req, "max") ?? 200));
        lock (Gate)
        {
            var sc = ScopeOfLocked(path);
            return new Dictionary<string, object?> { ["groups"] = DupeGroupsLocked(in sc, minBytes, max, new Dictionary<int, string>()) };
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
                ["held"] = Held,
                ["files"] = (long)(Entries.Count - Tombstones),
                ["dirs"] = (long)DirNodes.Count,
                ["bytes"] = TotalBytes,
                ["version"] = Version,
                // The process's private bytes: what it has committed and
                // nobody else shares, the figure the 814 MB was measured as.
                // Not the working set, which Windows trims under pressure —
                // exactly when the user looks — and which counts shared DLL
                // pages. GC.GetTotalMemory reported the managed heap alone and
                // read 603 against that 814: the one number the UI promises
                // to be honest about was not.
                ["ramMB"] = PrivateBytes() / (1024 * 1024),
                ["maxEntries"] = (long)MaxEntries,
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

    private static long PrivateBytes()
    {
        try { using var p = System.Diagnostics.Process.GetCurrentProcess(); return p.PrivateMemorySize64; }
        catch { return Environment.WorkingSet; }
    }
}
