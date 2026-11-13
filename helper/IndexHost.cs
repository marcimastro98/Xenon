using System.IO.Enumeration;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
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
//   overview {path,...}            → one coherent disk snapshot (dirs/top/dupes/details,
//                                    kinds{other,video,...}, version, staleFiles when
//                                    staleMinBytes+staleBefore are given)
//   sizes {path}                  → {total, dirs:[{p,s,n,m}]}   first-level children
//   dirs  {path,minBytes,max}     → {items:[{p,s,n,m}]}         every dir ≥ minBytes
//   list  {path,max}              → {items:[{p,n,s,m}]}         files under path
//   top   {path,max}              → {items:[{p,n,s,m}]}         biggest files
//   dupes {path,minBytes,max}     → {groups:[{s,paths:[]}]}     same-size candidates
//   stats {}                      → {ready,building,files,dirs,bytes,version,ramMB,maxEntries,roots,...}
// Unsolicited: {"event":"progress",...} while building, {"event":"ready"}.
//
// Memory — the whole design of this file, because the index is resident for
// as long as Xenon runs and the user's RAM is the one thing it competes for.
// Measured on a real install before this layout: 1.98M files cost 814 MB of
// private memory, ~305 MB per million, three quarters of it in per-string
// overhead — every name a UTF-16 .NET string with a 22-byte header, a second
// lowercase copy for the ~40% of names that carry an uppercase letter, and
// a Dictionary entry of ~36 bytes per file just to find a path again.
//   • Names live in ONE UTF-8 arena (16 MB chunks, no per-name object, half
//     the bytes of UTF-16 for the Latin names that are nearly all of them).
//     An entry addresses its name by (offset, length): 32 bytes flat.
//   • Case-insensitive matching FOLDS ASCII on the fly instead of storing a
//     lowercase twin. A twin is kept only for the rare name whose lowercase
//     form differs outside ASCII (an accented capital), where folding cannot
//     reach.
//   • Directories are a TREE (parent id + own name), not 280k full-path
//     strings: "under this folder" is an integer walk, and a path is rebuilt
//     only for the few dirs an answer names.
//   • Path lookup is an open-addressing table of int slots (~6 bytes per
//     entry) keyed on (dir, folded name), hashed straight from the arena.
//   • Every directory holds the LIVE totals of its subtree (bytes, files,
//     newest mtime), links to its children and to its own files, updated on
//     each change by walking up the parents. 4 bytes per file and ~36 per
//     directory buy a disk map, a drill-down and a subtree delete that cost
//     the size of what they touch instead of a pass over every file.
// The entry cap is derived from the machine's RAM (2M on 8 GB, 6M on 32 GB)
// instead of one number for every PC, and `stats.ramMB` reports the
// process working set — the figure Task Manager shows — not the GC's own
// view of its heap, which understated the real cost by a third.
// Reparse points are never traversed (invariant).
internal static partial class IndexHost
{
    // ── entry cap: a RAM budget, not a constant ──────────────────────────────
    // One entry per 4 KB of physical RAM (≈2% of it at the measured cost),
    // never below the old fixed 2M and never above 6M — past that, a query's
    // linear scan is the limit, not memory.
    private const int MinEntries = 2_000_000;
    private const int MaxEntriesCeiling = 6_000_000;
    private static readonly int MaxEntries = ComputeMaxEntries();
    private const long DefaultDirMinBytes = 10L * 1024 * 1024;

    private static int ComputeMaxEntries()
    {
        long ram = 0;
        try { ram = GC.GetGCMemoryInfo().TotalAvailableMemoryBytes; } catch { /* unknown → floor */ }
        if (ram <= 0) return MinEntries;
        return (int)Math.Clamp(ram / 4096, MinEntries, MaxEntriesCeiling);
    }

    // The next file of the same directory, -1 = last, one slot per entry. A
    // parallel list rather than a field: inside Entry it made the struct 36
    // bytes, unaligned, and a query (a linear scan of Entries) measured 15-30 ms
    // slower on a 2.5M-file C:. Tombstones stay linked and are skipped.
    private static ChunkedList<int> NextInDir = new();

    private static readonly object Gate = new();
    private static ByteArena Arena = new();
    private static ChunkedList<Entry> Entries = new();
    private static ChunkedList<DirNode> DirNodes = new();
    private static readonly IdTable<EntryKeys> ByPath = new();      // (dirId, folded name) → entry idx
    private static readonly IdTable<DirKeys> DirChildren = new();   // (parentId, folded name) → dir id
    private static int Tombstones;
    private static volatile bool Capped;
    private static long TotalBytes;
    // Bumped on every change a reader could see (a file added, removed, or its
    // size/mtime changed). The server keys its disk snapshot cache on it, so an
    // unchanged index never costs a rebuild and a changed one never serves stale.
    private static long Version;
    // Every live file at or above LargeMinBytes, kept current like the totals.
    // The biggest files, duplicate candidates and "large and untouched" all come
    // from here: a few tens of thousands of ids instead of a pass over millions.
    private const long LargeMinBytes = 4L * 1024 * 1024;
    private static HashSet<int> Large = new();
    // Bytes per file kind (Kinds) for each configured root, for the capacity bar.
    private static long[][] RootKinds = Array.Empty<long[]>();
    private static volatile bool Ready;
    private static volatile bool Cancelled;
    // While a game runs the walk, the watcher drain and the repairs stand still:
    // they are the only work here that can take a core. Requests keep being
    // answered from what the index holds, and the watchers keep recording into
    // their bounded queue, whose overflow already means a repair later.
    private static volatile bool Held;
    private const int HeldPollMs = 500;

    // Roots as given (normalized, a drive keeps its trailing '\'), the same
    // without the trailing separator (what paths are matched against), and
    // each one's node. A root inside another root is a normal node of the
    // outer tree, so "under C:\" still covers a C:\Users root listed as well.
    private static string[] Roots = Array.Empty<string>();
    private static string[] RootsTrimmed = Array.Empty<string>();
    private static int[] RootNodeIds = Array.Empty<int>();
    private static bool[] RootNested = Array.Empty<bool>();         // walked and watched by an outer root
    private static bool[] RootRegistered = Array.Empty<bool>();     // has a node (false only mid-registration)

    // Scratch for key encoding — one for directory components, one for the
    // file name, because interning a path and keying a name happen in the
    // same call. Both only ever touched under Gate.
    private static byte[] _dirScratch = new byte[4096];
    private static byte[] _nameScratch = new byte[4096];
    private static string? _lastDirStr;
    private static int _lastDirId = -1;

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

    // The kernel buffer behind ReadDirectoryChangesW. 64 KB is the ceiling for
    // a NETWORK share only; a local volume takes more, and every overflow here
    // costs a re-walk of the whole root (minutes at a core on a 2M-file drive),
    // so 2 MB of non-paged pool per root — ~20k events of headroom for a build
    // tool's burst — is the cheapest memory in this file.
    private const int WatcherBufferBytes = 2 * 1024 * 1024;

    // Entries are written under the newest generation issued. An entry the
    // drain thread adds while a repair walk is running therefore carries that
    // walk's generation and survives its sweep.
    private static int WalkGen;
    private static int CurrentGen => Volatile.Read(ref WalkGen);

    private static readonly string[] KindNames = { "other", "video", "image", "audio", "document", "archive", "app", "game" };
    private static readonly Dictionary<ulong, byte> ExtKind = BuildExtKinds();

    private static readonly string[] GameLibraryNames =
        { "steamapps", "Epic Games", "XboxGames", "GOG Games", "Riot Games", "EA Games", "Rockstar Games" };

    private static readonly byte[] LatinBase = BuildLatinBase();

    // UTF-8 lead bytes of everything FoldAccents changes: Latin-1 and Latin
    // Extended-A letters (0xC3-0xC5) and combining marks (0xCC-0xCD). A name
    // in Cyrillic or CJK has none of them, so it is not folded for nothing.
    private static readonly System.Buffers.SearchValues<byte> FoldLeads =
        System.Buffers.SearchValues.Create(new byte[] { 0xC3, 0xC4, 0xC5, 0xCC, 0xCD });

    // Roots whose initial walk did not see the whole root (display case, as the
    // user typed them). Guarded by Gate like every other index field.
    private static readonly List<string> IncompleteRoots = new();

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
