// The file index: the loop that reads a request, and the table that sends it to its handler.

using System.IO.Enumeration;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

internal static partial class IndexHost
{
    public static int Run(string[] args)
    {
        if (args.Length < 2) { Console.Error.WriteLine("usage: xenon-helper index-serve <root> [root ...]"); return 2; }
        var roots = args.Skip(1).Select(a => NormalizeDir(a.Trim())).Where(r => r.TrimEnd('\\').Length > 0).ToArray();
        if (roots.Length == 0) { Console.Error.WriteLine("index-serve: no usable root"); return 2; }
        lock (Gate) RegisterRootsLocked(roots);

        // Build + watch in the background; the main thread is the request loop
        // so queries answer DURING the initial walk (partial results are honest:
        // stats says building=true and the server tells the user).
        new Thread(() =>
        {
            UseEfficiencyMode();
            // Watch before walking. A file created or removed during a
            // multi-million-entry initial build must not fall into the gap
            // between the snapshot and watcher startup. Duplicate create
            // events are harmless because AddEntryLocked is an upsert; an
            // overflow marks the root dirty for the repair loop below.
            for (var i = 0; i < Roots.Length; i++) if (!RootNested[i]) StartWatcher(Roots[i]);
            // A root the cap cut short is RECORDED, not just counted. The walk is
            // sequential, so hitting MaxEntries on an early root leaves every
            // later one essentially absent — and "2.000.000 files indexed" reads
            // as success while search quietly cannot see a whole drive. Naming
            // the roots is what turns that into something the user can act on.
            for (var i = 0; i < Roots.Length; i++)
            {
                if (Cancelled) break;
                if (RootNested[i]) continue;
                if (!WalkRoot(Roots[i])) lock (Gate) IncompleteRoots.Add(Roots[i]);
            }
            lock (Gate)
            {
                ByPath.Rebuild(Entries.Count - Tombstones);
                DirChildren.Rebuild(DirNodes.Count);
            }
            // Give the walk's garbage back to the OS — the resident number the
            // user sees in Task Manager is the honest cost from here on.
            System.Runtime.GCSettings.LargeObjectHeapCompactionMode = System.Runtime.GCLargeObjectHeapCompactionMode.CompactOnce;
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
            _trimMark = GC.GetTotalAllocatedBytes(precise: false);
            _trimAt = Environment.TickCount64;
            Ready = true;
            Emit(new Dictionary<string, object?> { ["event"] = "ready" });
            // Dirty-root repair loop: a watcher overflow re-walks that root,
            // debounced and rate-limited, and sweeps instead of emptying.
            while (!Cancelled)
            {
                WaitWhileHeld();
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
            // Only once built: during the walk the marks are unset and the
            // walk itself is allocating, so a stats poll every 1.8 s would
            // pay a full compacting GC every 5 s for the whole build.
            if (Ready) TrimHeapIfDue();
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
            case "hold": return OpHold(req);
            default: throw new Exception("unknown op");
        }
    }

    private static Dictionary<string, object?> OpHold(System.Text.Json.JsonElement req)
    {
        Held = req.TryGetProperty("on", out var on) && on.ValueKind == System.Text.Json.JsonValueKind.True;
        return new Dictionary<string, object?> { ["held"] = Held };
    }

    private static void WaitWhileHeld()
    {
        while (Held && !Cancelled) Thread.Sleep(HeldPollMs);
    }

    private static string? Str(System.Text.Json.JsonElement req, string name)
        => req.TryGetProperty(name, out var el) && el.ValueKind == System.Text.Json.JsonValueKind.String ? el.GetString() : null;
    private static long? Num(System.Text.Json.JsonElement req, string name)
        => req.TryGetProperty(name, out var el) && el.ValueKind == System.Text.Json.JsonValueKind.Number ? el.GetInt64() : null;

    private static Dictionary<string, object?> Item(in Entry e, Dictionary<int, string> dirCache)
        => new() { ["p"] = FilePathLocked(in e, dirCache), ["n"] = NameString(in e), ["s"] = e.Size, ["m"] = e.Mtime };
}
