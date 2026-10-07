using System.Runtime.CompilerServices;
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
internal static class IndexHost
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

    // ── storage ──────────────────────────────────────────────────────────────

    private struct Entry
    {
        public int NameOff;      // arena offset of the display name (UTF-8)
        public ushort NameLen;   // its byte length
        public ushort LowerLen;  // low 15 bits >0: a lowercase twin follows the name (see MatchOf); top bit = AccentFlag
        public int Dir;          // DirNodes index; -1 = tombstone
        public int Gen;          // walk that last confirmed this entry (see the repair rules)
        public long Size;
        public long Mtime;
    }
    // The next file of the same directory, -1 = last, one slot per entry. A
    // parallel list rather than a field: inside Entry it made the struct 36
    // bytes, unaligned, and a query (a linear scan of Entries) measured 15-30 ms
    // slower on a 2.5M-file C:. Tombstones stay linked and are skipped.
    private static ChunkedList<int> NextInDir = new();

    // A directory carries the live totals of everything below it, kept current
    // on every add, change and removal (RollLocked). That is what lets the disk
    // map, a drill-down and a subtree delete answer by walking the folder tree
    // (hundreds of thousands of nodes) instead of every file (millions).
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, Pack = 4)]
    private struct DirNode
    {
        public int Parent;       // DirNodes index; -1 = a root (name is the root path itself)
        public int NameOff;      // one path component (a root: the whole root path)
        public ushort NameLen;
        public ushort LowerLen;
        public int FirstChild;   // child directories, linked through NextSibling; -1 = none
        public int NextSibling;
        public int FirstFile;    // files directly inside, linked through NextInDir; -1 = none
        public int Files;        // live files at any depth below
        public long Size;        // their bytes
        public long MaxMtime;    // newest file mtime seen below (never lowered by a delete)
        public short RootSlot;   // index into Roots when this node IS a configured root, else -1
        public byte Flags;       // DirGameLibrary
    }

    private const byte DirGameLibrary = 1;

    // Names, in UTF-8, in fixed chunks: no per-name object header, no doubling
    // copy when it grows, and an int offset addresses 2 GB of them.
    private sealed class ByteArena
    {
        private const int ChunkBits = 24;
        private const int ChunkSize = 1 << ChunkBits;
        private readonly List<byte[]> _chunks = new();
        private int _pos = ChunkSize;
        public long Used { get; private set; }
        public long Dead;        // bytes owned by tombstoned entries (reclaimed by Compact)

        public int Add(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b)
        {
            var need = a.Length + b.Length;
            if (need > ChunkSize) throw new InvalidOperationException("name too long");
            if (_chunks.Count == 0 || _pos + need > ChunkSize) { _chunks.Add(new byte[ChunkSize]); _pos = 0; }
            var c = _chunks[_chunks.Count - 1];
            a.CopyTo(c.AsSpan(_pos));
            b.CopyTo(c.AsSpan(_pos + a.Length));
            var off = ((_chunks.Count - 1) << ChunkBits) | _pos;
            _pos += need;
            Used += need;
            return off;
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public ReadOnlySpan<byte> Get(int off, int len)
            => _chunks[off >> ChunkBits].AsSpan(off & (ChunkSize - 1), len);
    }

    // Struct storage in fixed chunks: growing never copies the whole array,
    // and no single 200 MB object sits on the large-object heap.
    private sealed class ChunkedList<T> where T : struct
    {
        private const int Bits = 16;
        private const int Size = 1 << Bits;
        private const int Mask = Size - 1;
        private readonly List<T[]> _chunks = new();
        private int _count;
        public int Count => _count;
        public ref T this[int i] { [MethodImpl(MethodImplOptions.AggressiveInlining)] get => ref _chunks[i >> Bits][i & Mask]; }
        public void Add(in T v)
        {
            if ((_count >> Bits) == _chunks.Count) _chunks.Add(new T[Size]);
            _chunks[_count >> Bits][_count & Mask] = v;
            _count++;
        }
    }

    // How a table reads the key of an id it stores: from the index itself, so
    // the table holds nothing but the ids.
    private interface IKeys
    {
        int HashOf(int id);
        bool Matches(int id, int parent, ReadOnlySpan<byte> lower);
    }

    // Open addressing, linear probing, int slots only (0 empty, -1 deleted,
    // else id+1). Keys are never copied in: hashing and equality go back to
    // the entry or dir node the id names, so a slot costs 4 bytes and the
    // table ~6 bytes per key at its load factor.
    private sealed class IdTable<TKeys> where TKeys : struct, IKeys
    {
        // Load factor 7/10: grow (or rehash out the deleted slots) past it.
        private const int LoadNum = 10, LoadDen = 7;
        private int[] _slots = new int[1 << 16];
        private int _count, _deleted;

        public int Find(int hash, int parent, ReadOnlySpan<byte> lower)
        {
            var mask = _slots.Length - 1;
            var i = hash & mask;
            TKeys k = default;
            while (true)
            {
                var s = _slots[i];
                if (s == 0) return -1;
                if (s > 0 && k.Matches(s - 1, parent, lower)) return s - 1;
                i = (i + 1) & mask;
            }
        }

        // Callers Find() first: Add never checks for a duplicate.
        public void Add(int hash, int id)
        {
            if ((_count + _deleted + 1) * LoadNum > (long)_slots.Length * LoadDen) Rehash(_slots.Length * (_count * LoadNum > (long)_slots.Length * 4 ? 2 : 1));
            var mask = _slots.Length - 1;
            var i = hash & mask;
            while (_slots[i] > 0) i = (i + 1) & mask;
            if (_slots[i] == -1) _deleted--;
            _slots[i] = id + 1;
            _count++;
        }

        public void Remove(int hash, int parent, ReadOnlySpan<byte> lower)
        {
            var mask = _slots.Length - 1;
            var i = hash & mask;
            TKeys k = default;
            while (true)
            {
                var s = _slots[i];
                if (s == 0) return;
                if (s > 0 && k.Matches(s - 1, parent, lower)) { _slots[i] = -1; _count--; _deleted++; return; }
                i = (i + 1) & mask;
            }
        }

        // Drop probe garbage and growth slack: exact size for what is stored.
        public void Rebuild(int expected) => Rehash(SizeFor(expected));

        public void Reset(int expected)
        {
            _slots = new int[SizeFor(expected)];
            _count = 0; _deleted = 0;
        }

        // Smallest power of two that keeps `expected` keys under the load factor.
        private static int SizeFor(int expected)
        {
            var size = 1 << 16;
            while (size * LoadDen < (long)expected * LoadNum) size <<= 1;
            return size;
        }

        private void Rehash(int newSize)
        {
            var old = _slots;
            _slots = new int[newSize];
            _count = 0; _deleted = 0;
            var mask = newSize - 1;
            TKeys k = default;
            foreach (var s in old)
            {
                if (s <= 0) continue;
                var i = k.HashOf(s - 1) & mask;
                while (_slots[i] != 0) i = (i + 1) & mask;
                _slots[i] = s;
                _count++;
            }
        }
    }

    private readonly struct EntryKeys : IKeys
    {
        public int HashOf(int id) { ref var e = ref Entries[id]; return HashKey(e.Dir, MatchOf(in e)); }
        public bool Matches(int id, int parent, ReadOnlySpan<byte> lower)
        { ref var e = ref Entries[id]; return e.Dir == parent && FoldEquals(MatchOf(in e), lower); }
    }

    private readonly struct DirKeys : IKeys
    {
        public int HashOf(int id) { ref var n = ref DirNodes[id]; return HashKey(n.Parent, DirMatchOf(in n)); }
        public bool Matches(int id, int parent, ReadOnlySpan<byte> lower)
        { ref var n = ref DirNodes[id]; return n.Parent == parent && FoldEquals(DirMatchOf(in n), lower); }
    }

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

    // ── heap trim ─────────────────────────────────────────────────────────────
    // An answer is garbage the moment it is written: an overview builds ~10k
    // dictionaries, a JSON string and its base64 twin, then drops them all.
    // The GC reclaims that on its next collection, but it hands the memory
    // back to Windows only gradually and only while collections keep
    // happening — and an idle host has none. Measured: a burst of five
    // overviews left the process 110 MB above its resident index for as long
    // as it sat idle. So after every ~32 MB of answers the host collects
    // aggressively, which decommits. It is cheap here: the index is a few
    // large arrays of structs and bytes with no references to trace.
    private const long TrimEveryBytes = 32L * 1024 * 1024;
    private const int TrimMinIntervalMs = 5_000;
    private static long _trimMark;
    private static long _trimAt;

    private static void TrimHeapIfDue()
    {
        var allocated = GC.GetTotalAllocatedBytes(precise: false);
        var now = Environment.TickCount64;
        if (allocated - _trimMark < TrimEveryBytes || now - _trimAt < TrimMinIntervalMs) return;
        _trimMark = allocated;
        _trimAt = now;
        GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
    }

    // ── names: UTF-8 arena, ASCII folded on the fly ───────────────────────────

    // The bytes a name is MATCHED on: its lowercase twin when it has one, its
    // own bytes otherwise. Either way the comparer folds A-Z, so the result
    // equals ToLowerInvariant(name) in UTF-8 without a second string per file.
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static ReadOnlySpan<byte> MatchOf(in Entry e)
        => TwinLen(in e) > 0 ? Arena.Get(e.NameOff + e.NameLen, TwinLen(in e)) : Arena.Get(e.NameOff, e.NameLen);

    // Set on an entry whose name holds a letter FoldAccents changes, decided
    // once when it enters the index. A query folds only those names: testing
    // every name for accents at match time measured 30-50 ms per query on a
    // 2.5M-file C:, a second pass over every name for the few that need it.
    // Stored in LowerLen's top bit (a name's UTF-8 is never 32 KB) so Entry
    // stays 32 bytes.
    private const ushort AccentFlag = 0x8000;
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static int TwinLen(in Entry e) => e.LowerLen & 0x7FFF;
    private static ReadOnlySpan<byte> NameOf(in Entry e) => Arena.Get(e.NameOff, e.NameLen);
    private static ReadOnlySpan<byte> DirMatchOf(in DirNode n)
        => n.LowerLen > 0 ? Arena.Get(n.NameOff + n.NameLen, n.LowerLen) : Arena.Get(n.NameOff, n.NameLen);
    private static string NameString(in Entry e) => Encoding.UTF8.GetString(NameOf(in e));

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static byte Fold(byte c) => c >= (byte)'A' && c <= (byte)'Z' ? (byte)(c | 0x20) : c;

    private static bool FoldEquals(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b)
    {
        if (a.Length != b.Length) return false;
        for (var i = 0; i < a.Length; i++) if (Fold(a[i]) != Fold(b[i])) return false;
        return true;
    }

    // FNV-1a over the folded bytes, seeded with the parent id, sign bit cleared.
    private static int HashKey(int parent, ReadOnlySpan<byte> m)
    {
        var h = 2166136261u ^ (uint)parent * 0x9E3779B1u;
        foreach (var c in m) h = (h ^ Fold(c)) * 16777619u;
        h ^= h >> 15; h *= 0x2C1B3C6Du; h ^= h >> 12;
        return (int)(h & 0x7FFFFFFF);
    }

    // `term` is lowercase; the haystack is folded as it is read. Returns the
    // byte index of the first match, like string.IndexOf on the old strings.
    private static int IndexOfFold(ReadOnlySpan<byte> hay, ReadOnlySpan<byte> term)
    {
        if (term.Length == 0) return 0;
        if (term.Length > hay.Length) return -1;
        var t0 = term[0];
        var t0u = t0 >= (byte)'a' && t0 <= (byte)'z' ? (byte)(t0 - 32) : t0;
        var last = hay.Length - term.Length;
        var i = 0;
        while (i <= last)
        {
            var k = hay.Slice(i, last - i + 1).IndexOfAny(t0, t0u);
            if (k < 0) return -1;
            i += k;
            var j = 1;
            for (; j < term.Length; j++) if (Fold(hay[i + j]) != term[j]) break;
            if (j == term.Length) return i;
            i++;
        }
        return -1;
    }

    // Does this name need a lowercase twin? Only when lowercasing changes a
    // character OUTSIDE ASCII (or a surrogate pair, which char-wise casing
    // cannot see) — the ASCII part is folded at compare time.
    private static bool NeedsLowerTwin(ReadOnlySpan<char> s)
    {
        foreach (var c in s)
        {
            if (c < 0x80) continue;
            if (char.IsSurrogate(c) || char.ToLowerInvariant(c) != c) return true;
        }
        return false;
    }

    // UTF-8 of the name plus, when needed, its lowercase twin, into `scratch`.
    // Returns the name length; `lowerLen` the twin's (0 = none).
    private static int EncodeName(ReadOnlySpan<char> s, ref byte[] scratch, out int lowerLen)
    {
        var need = Encoding.UTF8.GetMaxByteCount(s.Length) * 2 + 8;
        if (scratch.Length < need) scratch = new byte[Math.Max(need, scratch.Length * 2)];
        var n = Encoding.UTF8.GetBytes(s, scratch);
        lowerLen = 0;
        if (NeedsLowerTwin(s))
            lowerLen = Encoding.UTF8.GetBytes(new string(s).ToLowerInvariant(), scratch.AsSpan(n));
        return n;
    }

    // The bytes to LOOK a name up by: its lowercase twin's bytes when it would
    // have one, its raw bytes otherwise (the table folds both sides).
    private static ReadOnlySpan<byte> KeyOf(ReadOnlySpan<char> s, ref byte[] scratch)
    {
        var n = EncodeName(s, ref scratch, out var lowerLen);
        return lowerLen > 0 ? scratch.AsSpan(n, lowerLen) : scratch.AsSpan(0, n);
    }

    // ── directories: a tree, one component per node ──────────────────────────

    private static void RegisterRootsLocked(string[] roots)
    {
        Roots = roots;
        RootsTrimmed = roots.Select(r => r.TrimEnd('\\')).ToArray();
        RootNodeIds = new int[roots.Length];
        RootNested = new bool[roots.Length];
        RootRegistered = new bool[roots.Length];
        RootKinds = new long[roots.Length][];
        for (var k = 0; k < roots.Length; k++) RootKinds[k] = new long[KindCount];
        // Shortest first, so an inner root always finds its outer one already
        // registered and becomes a node of that tree instead of a second one.
        foreach (var i in Enumerable.Range(0, roots.Length).OrderBy(i => RootsTrimmed[i].Length))
        {
            var p = RootsTrimmed[i];
            var outer = RootIndexOf(p);
            if (outer >= 0)
            {
                RootNested[i] = true;
                RootNodeIds[i] = ResolveUnderLocked(RootNodeIds[outer], p, RootsTrimmed[outer].Length, create: true);
            }
            else
            {
                var existing = FindChildLocked(-1, p);
                RootNodeIds[i] = existing >= 0 ? existing : AddChildLocked(-1, p);
            }
            DirNodes[RootNodeIds[i]].RootSlot = (short)i;
            RootRegistered[i] = true;
        }
    }

    // The registered root `p` sits under (longest match, case-insensitive).
    private static int RootIndexOf(ReadOnlySpan<char> p)
    {
        var best = -1; var bestLen = -1;
        for (var i = 0; i < RootsTrimmed.Length; i++)
        {
            if (!RootRegistered[i]) continue;
            var r = RootsTrimmed[i];
            if (r.Length == 0 || r.Length > p.Length) continue;
            if (!p.StartsWith(r, StringComparison.OrdinalIgnoreCase)) continue;
            if (p.Length != r.Length && p[r.Length] != '\\') continue;
            if (r.Length > bestLen) { best = i; bestLen = r.Length; }
        }
        return best;
    }

    // Walk `p` from `pos` component by component below `node`, creating on the way.
    private static int ResolveUnderLocked(int node, ReadOnlySpan<char> p, int pos, bool create)
    {
        while (pos < p.Length)
        {
            if (p[pos] == '\\') { pos++; continue; }
            var next = p.Slice(pos).IndexOf('\\');
            next = next < 0 ? p.Length : pos + next;
            var comp = p.Slice(pos, next - pos);
            var child = FindChildLocked(node, comp);
            if (child < 0)
            {
                if (!create) return -1;
                child = AddChildLocked(node, comp);
            }
            node = child;
            pos = next;
        }
        return node;
    }

    // A directory path → its node (-1 when absent and !create). A path that
    // sits under no root is a tree of its own under parent -1: never expected
    // (watchers only cover roots), never wrong.
    private static int ResolveDirLocked(string path, bool create)
    {
        var p = path.AsSpan().TrimEnd('\\');
        if (p.Length == 0) return -1;
        var ri = RootIndexOf(p);
        if (ri >= 0) return ResolveUnderLocked(RootNodeIds[ri], p, RootsTrimmed[ri].Length, create);
        var top = FindChildLocked(-1, p);
        if (top >= 0 || !create) return top;
        return AddChildLocked(-1, p);
    }

    // The walk hands over the same directory string for every file in it, so
    // one string compare replaces the tree walk almost every time.
    private static int InternDirLocked(string dir)
    {
        if (_lastDirStr != null && string.Equals(dir, _lastDirStr, StringComparison.Ordinal)) return _lastDirId;
        var id = ResolveDirLocked(dir, create: true);
        _lastDirStr = dir; _lastDirId = id;
        return id;
    }

    private static int FindChildLocked(int parent, ReadOnlySpan<char> comp)
    {
        var key = KeyOf(comp, ref _dirScratch);
        return DirChildren.Find(HashKey(parent, key), parent, key);
    }

    private static int AddChildLocked(int parent, ReadOnlySpan<char> comp)
    {
        var n = EncodeName(comp, ref _dirScratch, out var lowerLen);
        var off = Arena.Add(_dirScratch.AsSpan(0, n), _dirScratch.AsSpan(n, lowerLen));
        var node = new DirNode
        {
            Parent = parent, NameOff = off, NameLen = (ushort)n, LowerLen = (ushort)lowerLen,
            FirstChild = -1, NextSibling = -1, FirstFile = -1, RootSlot = -1,
            Flags = parent >= 0 && IsGameLibraryName(comp) ? DirGameLibrary : (byte)0,
        };
        var id = DirNodes.Count;
        if (parent >= 0) { node.NextSibling = DirNodes[parent].FirstChild; }
        DirNodes.Add(in node);
        if (parent >= 0) DirNodes[parent].FirstChild = id;
        DirChildren.Add(HashKey(parent, DirMatchOf(in node)), id);
        return id;
    }

    // Rebuilt only for the dirs an answer names. A drive root comes back as
    // "C:\" so the joined paths read exactly as Windows writes them.
    private static string DirPathLocked(int id)
    {
        var chain = new List<int>(8);
        for (var d = id; d >= 0; d = DirNodes[d].Parent) chain.Add(d);
        var sb = new StringBuilder(96);
        for (var i = chain.Count - 1; i >= 0; i--)
        {
            if (i != chain.Count - 1) sb.Append('\\');
            ref var n = ref DirNodes[chain[i]];
            sb.Append(Encoding.UTF8.GetString(Arena.Get(n.NameOff, n.NameLen)));
        }
        if (sb.Length == 2 && sb[1] == ':') sb.Append('\\');
        return sb.ToString();
    }

    private static string JoinPath(string dir, string name) => dir.EndsWith('\\') ? dir + name : dir + "\\" + name;

    private static string FilePathLocked(in Entry e, Dictionary<int, string> dirCache)
    {
        if (!dirCache.TryGetValue(e.Dir, out var dp)) dirCache[e.Dir] = dp = DirPathLocked(e.Dir);
        return JoinPath(dp, NameString(in e));
    }

    // ── scope: what an op's `path` denotes ───────────────────────────────────
    // The node itself when it is in the tree; when the path sits ABOVE the
    // roots (asked about "E:\" with a root of E:\Games) every root beneath it;
    // the empty path means everything. Membership is an integer walk up the
    // tree, memoised per op in a flat array — one byte per dir.
    private readonly struct Scope
    {
        public readonly int[] Anchors;
        public readonly int Self;   // the node itself, -1 when the path is not one node
        public Scope(int[] anchors, int self) { Anchors = anchors; Self = self; }
        public bool Contains(int id) { foreach (var a in Anchors) if (a == id) return true; return false; }
    }

    private static Scope ScopeOfLocked(string path)
    {
        var p = NormalizeDir(path).TrimEnd('\\');
        if (p.Length == 0) return new Scope(TopRootIds(), -1);
        var id = ResolveDirLocked(p, create: false);
        if (id >= 0) return new Scope(new[] { id }, id);
        var under = new List<int>();
        for (var i = 0; i < RootsTrimmed.Length; i++)
        {
            var r = RootsTrimmed[i];
            if (r.Length <= p.Length || !r.StartsWith(p, StringComparison.OrdinalIgnoreCase) || r[p.Length] != '\\') continue;
            if (!RootNested[i]) under.Add(RootNodeIds[i]);
        }
        return new Scope(under.ToArray(), -1);
    }

    private static int[] TopRootIds()
    {
        var ids = new List<int>();
        for (var i = 0; i < RootNodeIds.Length; i++) if (!RootNested[i]) ids.Add(RootNodeIds[i]);
        return ids.ToArray();
    }

    // memo: 0 unknown · 1 under · 2 not. Every node on the walked path learns
    // the answer, so the second file of a directory costs one array read.
    private static bool IsUnder(int dir, in Scope sc, byte[] memo)
    {
        var cur = dir;
        var ans = false;
        while (cur >= 0)
        {
            var m = memo[cur];
            if (m != 0) { ans = m == 1; break; }
            if (sc.Contains(cur)) { ans = true; memo[cur] = 1; break; }
            cur = DirNodes[cur].Parent;
        }
        var v = (byte)(ans ? 1 : 2);
        for (var d = dir; d >= 0 && d != cur; d = DirNodes[d].Parent) memo[d] = v;
        return ans;
    }

    // ── file kinds ────────────────────────────────────────────────────────────
    // What the capacity bar is split into. By extension, except that anything
    // under a game library folder is a game whatever its extension: a 90 GB
    // game is .pak/.bin/.dat files that would otherwise read as "other".
    private const int KindCount = 8;
    private static readonly string[] KindNames = { "other", "video", "image", "audio", "document", "archive", "app", "game" };
    private const int KindGame = 7;
    private static readonly Dictionary<ulong, byte> ExtKind = BuildExtKinds();

    private static Dictionary<ulong, byte> BuildExtKinds()
    {
        var map = new Dictionary<ulong, byte>();
        // Keyed through a stand-in name: ExtKeyOf reads ".gitignore" as no
        // extension at all, so a bare ".mp4" would key as 0.
        void Add(byte kind, string list) { foreach (var e in list.Split(' ')) map[ExtKeyOf(Encoding.ASCII.GetBytes("x." + e))] = kind; }
        Add(1, "mp4 mkv mov avi wmv flv webm m4v mpg mpeg ts m2ts mts 3gp vob");
        Add(2, "jpg jpeg png gif bmp tif tiff webp heic heif raw cr2 cr3 nef arw dng orf rw2 psd ico avif jxl");
        Add(3, "mp3 wav flac aac ogg m4a wma opus aiff aif alac mid midi");
        Add(4, "pdf doc docx xls xlsx ppt pptx odt ods odp rtf txt md csv epub pages numbers key");
        Add(5, "zip rar 7z tar gz tgz bz2 xz zst iso img dmg cab lz4 wim vhd vhdx");
        Add(6, "exe dll msi sys appx msix msixbundle so dylib pkg deb rpm drv ocx mui cat nls efi jar");
        return map;
    }

    // The extension (".mp4" … up to 8 ASCII letters/digits) folded and packed
    // into one integer, read straight from the name bytes: no string per file.
    private static ulong ExtKeyOf(ReadOnlySpan<byte> name)
    {
        var dot = name.LastIndexOf((byte)'.');
        if (dot < 0 || dot == 0 || name.Length - dot - 1 is < 1 or > 8) return 0;
        ulong k = 0;
        for (var i = dot + 1; i < name.Length; i++)
        {
            var c = Fold(name[i]);
            if (!((c >= (byte)'a' && c <= (byte)'z') || (c >= (byte)'0' && c <= (byte)'9'))) return 0;
            k = (k << 8) | c;
        }
        return k;
    }

    private static readonly string[] GameLibraryNames =
        { "steamapps", "Epic Games", "XboxGames", "GOG Games", "Riot Games", "EA Games", "Rockstar Games" };

    private static bool IsGameLibraryName(ReadOnlySpan<char> comp)
    {
        foreach (var g in GameLibraryNames) if (comp.Equals(g, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static int KindOfLocked(int dir, ReadOnlySpan<byte> name)
    {
        for (var d = dir; d >= 0; d = DirNodes[d].Parent)
            if ((DirNodes[d].Flags & DirGameLibrary) != 0) return KindGame;
        return ExtKind.TryGetValue(ExtKeyOf(name), out var k) ? k : 0;
    }

    // ── live totals ───────────────────────────────────────────────────────────
    // A change to one file is applied to its directory and every ancestor: a few
    // integer hops. Every configured root met on the way counts it by kind too
    // (a root nested in another counts it in both, as its own total does).
    private static void RollLocked(int dir, long dSize, int dFiles, long mtime, int kind)
    {
        for (var d = dir; d >= 0; d = DirNodes[d].Parent)
        {
            ref var n = ref DirNodes[d];
            n.Size += dSize;
            n.Files += dFiles;
            if (mtime > n.MaxMtime) n.MaxMtime = mtime;
            if (n.RootSlot >= 0 && n.RootSlot < RootKinds.Length) RootKinds[n.RootSlot][kind] += dSize;
        }
    }

    // Zero every total and replay every live entry. Only after a compaction,
    // which renumbers everything; the live path never needs it.
    private static void RebuildTotalsLocked()
    {
        for (var d = 0; d < DirNodes.Count; d++)
        {
            ref var n = ref DirNodes[d];
            n.Size = 0; n.Files = 0; n.MaxMtime = 0;
        }
        foreach (var k in RootKinds) Array.Clear(k);
        Large = new HashSet<int>();
        for (var i = 0; i < Entries.Count; i++)
        {
            ref var en = ref Entries[i];
            if (en.Dir < 0) continue;
            RollLocked(en.Dir, en.Size, 1, en.Mtime, KindOfLocked(en.Dir, NameOf(in en)));
            if (en.Size >= LargeMinBytes) Large.Add(i);
        }
    }

    // ── tree walks ────────────────────────────────────────────────────────────

    // Every directory at or below the anchors, depth first. `prune` skips a
    // subtree (its totals already say nothing below can qualify).
    private static void ForEachDirLocked(in Scope sc, Func<int, bool> visit)
    {
        var stack = new Stack<int>();
        foreach (var a in sc.Anchors) if (a >= 0) stack.Push(a);
        while (stack.Count > 0)
        {
            var d = stack.Pop();
            if (!visit(d)) continue;
            for (var c = DirNodes[d].FirstChild; c >= 0; c = DirNodes[c].NextSibling) stack.Push(c);
        }
    }

    // Every live file directly inside `dir`.
    private static void ForEachFileInLocked(int dir, Action<int> visit)
    {
        for (var i = DirNodes[dir].FirstFile; i >= 0; i = NextInDir[i])
            if (Entries[i].Dir >= 0) visit(i);
    }

    private static (long size, long files, long mtime) ScopeTotalsLocked(in Scope sc)
    {
        long s = 0, f = 0, m = 0;
        foreach (var a in sc.Anchors)
        {
            if (a < 0) continue;
            ref var n = ref DirNodes[a];
            s += n.Size; f += n.Files; if (n.MaxMtime > m) m = n.MaxMtime;
        }
        return (s, f, m);
    }

    private static Dictionary<string, object?> DirItemLocked(int d)
    {
        ref var n = ref DirNodes[d];
        return new() { ["p"] = DirPathLocked(d), ["s"] = n.Size, ["n"] = (long)n.Files, ["m"] = n.MaxMtime };
    }

    // Dirs at or above minBytes under the scope (the anchors included), largest
    // first, at most max. A directory is never larger than its parent, so a
    // subtree below the threshold is skipped whole.
    private static List<Dictionary<string, object?>> DirsAtLeastLocked(in Scope sc, long minBytes, int max)
    {
        var ids = new List<int>();
        ForEachDirLocked(in sc, d =>
        {
            ref var n = ref DirNodes[d];
            if (n.Files <= 0 || n.Size < minBytes) return false;
            ids.Add(d);
            return true;
        });
        ids.Sort((a, b) => DirNodes[b].Size.CompareTo(DirNodes[a].Size));
        if (ids.Count > max) ids.RemoveRange(max, ids.Count - max);
        return ids.Select(DirItemLocked).ToList();
    }

    // Live files under the scope, from the large set when it can answer
    // (every candidate is >= LargeMinBytes), from the tree otherwise.
    private static List<int> FilesUnderLocked(in Scope sc, long minBytes)
    {
        var outIds = new List<int>();
        if (minBytes >= LargeMinBytes)
        {
            var memo = new byte[DirNodes.Count];
            foreach (var i in Large)
            {
                ref var en = ref Entries[i];
                if (en.Dir < 0 || en.Size < minBytes) continue;
                if (IsUnder(en.Dir, in sc, memo)) outIds.Add(i);
            }
            return outIds;
        }
        var acc = outIds;
        ForEachDirLocked(in sc, d =>
        {
            ForEachFileInLocked(d, i => { if (Entries[i].Size >= minBytes) acc.Add(i); });
            return true;
        });
        return outIds;
    }

    // The `max` largest files under the scope. The large set answers whenever
    // it holds at least `max` of them; a scope with fewer large files than that
    // is a small one, and the tree walk over it is cheap.
    private static List<int> TopFilesLocked(in Scope sc, int max)
    {
        var ids = FilesUnderLocked(in sc, LargeMinBytes);
        if (ids.Count < max) ids = FilesUnderLocked(in sc, 0);
        ids.Sort((a, b) => Entries[b].Size.CompareTo(Entries[a].Size));
        if (ids.Count > max) ids.RemoveRange(max, ids.Count - max);
        return ids;
    }

    // Same-size groups, ordered by what they could waste (size × extra copies),
    // which is the order a cut at `max` should keep — the old size-only order
    // dropped a 20-copy group of 50 MB behind forty pairs of 1 GB.
    private static List<Dictionary<string, object?>> DupeGroupsLocked(in Scope sc, long minBytes, int max, Dictionary<int, string> dirCache)
    {
        var bySize = new Dictionary<long, List<int>>();
        foreach (var i in FilesUnderLocked(in sc, Math.Max(1, minBytes)))
        {
            var s = Entries[i].Size;
            if (!bySize.TryGetValue(s, out var l)) bySize[s] = l = new List<int>();
            if (l.Count < 20) l.Add(i);
        }
        return bySize.Where(kv => kv.Value.Count > 1)
            .OrderByDescending(kv => kv.Key * (kv.Value.Count - 1)).Take(max)
            .Select(kv => new Dictionary<string, object?>
            {
                ["s"] = kv.Key,
                ["paths"] = kv.Value.Select(i => (object?)FilePathLocked(in Entries[i], dirCache)).ToList(),
            }).ToList();
    }

    // Bytes per kind for a scope that is one or more whole configured roots;
    // null for a folder inside a root, which the per-root counters cannot split.
    private static Dictionary<string, object?>? KindsLocked(in Scope sc)
    {
        if (sc.Anchors.Length == 0) return null;
        var sum = new long[KindCount];
        foreach (var a in sc.Anchors)
        {
            if (a < 0) return null;
            var slot = DirNodes[a].RootSlot;
            if (slot < 0 || slot >= RootKinds.Length) return null;
            for (var k = 0; k < KindCount; k++) sum[k] += RootKinds[slot][k];
        }
        var outMap = new Dictionary<string, object?>();
        for (var k = 0; k < KindCount; k++) outMap[KindNames[k]] = sum[k];
        return outMap;
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

    private static Dictionary<string, object?> Item(in Entry e, Dictionary<int, string> dirCache)
        => new() { ["p"] = FilePathLocked(in e, dirCache), ["n"] = NameString(in e), ["s"] = e.Size, ["m"] = e.Mtime };

    // ── query ────────────────────────────────────────────────────────────────
    // A name query is a scan, and three things keep it cheap while someone types:
    //   • Refinement. Typing "fatt" → "fattu" → "fattura" only ever narrows, so
    //     when every term of the new query CONTAINS the same-position term of the
    //     last one (same filters, same term count), only the last query's matches
    //     are re-checked, plus the entries appended since. Entries are never
    //     renamed in place and tombstones are skipped, so that set is complete;
    //     a compaction renumbers everything and ends the memo.
    //   • A full scan runs on several cores (half of them, the index is a
    //     background guest) under the same index lock, which writers respect.
    //   • Words of the PATH count: "download fattura" finds Download\fattura.pdf
    //     when at least one word is in the name and the others are in a folder
    //     above it. Per term, "some ancestor holds it" is memoised per folder.
    private sealed class QueryMemo
    {
        public string FilterKey = "";
        public byte[][] Terms = Array.Empty<byte[]>();
        public int[] Hits = Array.Empty<int>();
        public int ScannedCount;
        public int CompactGen;
    }
    private static QueryMemo? _queryMemo;
    private static int CompactGen;
    private const int MemoMaxHits = 300_000;
    private const int ParallelMinEntries = 250_000;
    private const int PathTier = 4;   // a term found only in a folder above the file

    private sealed class QueryCtx
    {
        public byte[][] Terms = Array.Empty<byte[]>();
        public List<byte[]>? Exts;
        public long After, Before, MinB, MaxB;
        public bool PathTerms;
        public byte[][] AncMemo = Array.Empty<byte[]>();   // per term: 0 unknown · 1 an ancestor holds it · 2 none
    }

    // Does `dir` or a folder above it (a configured root's own path excluded)
    // hold the term? Memoised along the walked chain; parallel workers may write
    // the same byte twice, never a different one.
    private static bool AncestorHas(QueryCtx c, int t, int dir)
    {
        var memo = c.AncMemo[t];
        var cur = dir;
        var ans = false;
        while (cur >= 0)
        {
            var m = memo[cur];
            if (m != 0) { ans = m == 1; break; }
            ref var n = ref DirNodes[cur];
            if (n.Parent >= 0 && MatchTierFolded(DirMatchOf(in n), c.Terms[t]) >= 0) { ans = true; memo[cur] = 1; break; }
            cur = n.Parent;
        }
        var v = (byte)(ans ? 1 : 2);
        for (var d = dir; d >= 0 && d != cur; d = DirNodes[d].Parent) memo[d] = v;
        return ans;
    }

    // The entry's tier (worst term) or -1, and how many terms only the path held.
    private static int EntryTier(QueryCtx c, int i, out int pathOnly)
    {
        pathOnly = 0;
        ref var en = ref Entries[i];
        if (en.Dir < 0) return -1;
        if (en.Mtime < c.After || en.Mtime >= c.Before) return -1;
        if (en.Size < c.MinB || en.Size > c.MaxB) return -1;
        var lower = MatchOf(in en);
        if (c.Exts != null)
        {
            var dot = lower.LastIndexOf((byte)'.');
            if (dot < 0) return -1;
            var suffix = lower.Slice(dot);
            var hit = false;
            foreach (var x in c.Exts) if (FoldEquals(suffix, x)) { hit = true; break; }
            if (!hit) return -1;
        }
        int tier = 0;
        var accented = (en.LowerLen & AccentFlag) != 0;
        for (var t = 0; t < c.Terms.Length; t++)
        {
            var k = accented ? MatchTierFolded(lower, c.Terms[t]) : MatchTier(lower, c.Terms[t]);
            if (k < 0)
            {
                if (!c.PathTerms || !AncestorHas(c, t, en.Dir)) return -1;
                pathOnly++;
                k = PathTier;
            }
            if (k > tier) tier = k;
        }
        // At least one word must be in the NAME: "download" alone is every file
        // in Downloads, which is a folder result, not a file result.
        if (pathOnly > 0 && pathOnly >= c.Terms.Length) return -1;
        return tier;
    }

    private static int CompareHits((int tier, long mtime, int idx) a, (int tier, long mtime, int idx) b)
        => a.tier != b.tier ? a.tier.CompareTo(b.tier)
         : a.mtime != b.mtime ? b.mtime.CompareTo(a.mtime)
         : a.idx.CompareTo(b.idx);

    private static void TrimBest(List<(int tier, long mtime, int idx)> best, int max)
    {
        best.Sort(CompareHits);
        if (best.Count > max) best.RemoveRange(max, best.Count - max);
    }

    private static Dictionary<string, object?> OpQuery(System.Text.Json.JsonElement req)
    {
        var termList = new List<byte[]>();
        if (req.TryGetProperty("terms", out var tEl) && tEl.ValueKind == System.Text.Json.JsonValueKind.Array)
            foreach (var t in tEl.EnumerateArray()) { var s = t.GetString(); if (!string.IsNullOrEmpty(s)) termList.Add(FoldAccents(Encoding.UTF8.GetBytes(s.ToLowerInvariant())).ToArray()); }
        var c = new QueryCtx { Terms = termList.ToArray() };
        if (req.TryGetProperty("exts", out var eEl) && eEl.ValueKind == System.Text.Json.JsonValueKind.Array)
        {
            c.Exts = new List<byte[]>();
            foreach (var x in eEl.EnumerateArray()) { var s = x.GetString(); if (!string.IsNullOrEmpty(s)) c.Exts.Add(Encoding.UTF8.GetBytes("." + s.ToLowerInvariant())); }
        }
        c.After = Num(req, "after") ?? long.MinValue;
        c.Before = Num(req, "before") ?? long.MaxValue;
        c.MinB = Num(req, "minBytes") ?? long.MinValue;
        c.MaxB = Num(req, "maxBytes") ?? long.MaxValue;
        int max = (int)Math.Max(1, Math.Min(200, Num(req, "max") ?? 60));
        int dirMax = (int)Math.Max(0, Math.Min(50, Num(req, "dirs") ?? 0));
        c.PathTerms = c.Terms.Length >= 2 && req.TryGetProperty("pathTerms", out var ptEl) && ptEl.ValueKind == System.Text.Json.JsonValueKind.True;
        var filterKey = string.Join("|", c.Exts == null ? "" : string.Join(",", c.Exts.Select(Convert.ToBase64String)),
            c.After, c.Before, c.MinB, c.MaxB, c.PathTerms);

        lock (Gate)
        {
            if (c.PathTerms)
            {
                c.AncMemo = new byte[c.Terms.Length][];
                for (var t = 0; t < c.Terms.Length; t++) c.AncMemo[t] = new byte[DirNodes.Count];
            }

            // Which entries to look at: the last query's matches plus what was
            // appended since, or everything.
            var memo = _queryMemo;
            var refine = memo != null && memo.CompactGen == CompactGen && memo.FilterKey == filterKey
                && c.Terms.Length > 0 && memo.Terms.Length == c.Terms.Length
                && Enumerable.Range(0, c.Terms.Length).All(t => c.Terms[t].AsSpan().IndexOf(memo.Terms[t]) >= 0);
            int[]? source = refine ? memo!.Hits : null;
            int tailFrom = refine ? Math.Min(memo!.ScannedCount, Entries.Count) : 0;
            int count = (source?.Length ?? 0) + (Entries.Count - tailFrom);
            int At(int k) => source != null && k < source.Length ? source[k] : tailFrom + (k - (source?.Length ?? 0));

            var best = new List<(int tier, long mtime, int idx)>(max * 4 + 1);
            var hits = new List<int>();
            var overflow = false;
            if (count >= ParallelMinEntries)
            {
                var parts = Math.Max(1, Math.Min(16, Environment.ProcessorCount / 2));
                var chunk = (count + parts - 1) / parts;
                var localBest = new List<(int, long, int)>[parts];
                var localHits = new List<int>[parts];
                var localOverflow = new bool[parts];
                Parallel.For(0, parts, new ParallelOptions { MaxDegreeOfParallelism = parts }, p =>
                {
                    var lb = new List<(int tier, long mtime, int idx)>(max * 4 + 1);
                    var lh = new List<int>();
                    var from = p * chunk;
                    var to = Math.Min(count, from + chunk);
                    for (var k = from; k < to; k++)
                    {
                        var i = At(k);
                        var tier = EntryTier(c, i, out _);
                        if (tier < 0) continue;
                        if (lh.Count < MemoMaxHits) lh.Add(i); else localOverflow[p] = true;
                        lb.Add((tier, Entries[i].Mtime, i));
                        if (lb.Count > max * 4) TrimBest(lb, max);
                    }
                    localBest[p] = lb;
                    localHits[p] = lh;
                });
                for (var p = 0; p < parts; p++)
                {
                    best.AddRange(localBest[p]);
                    if (hits.Count + localHits[p].Count <= MemoMaxHits) hits.AddRange(localHits[p]); else overflow = true;
                    overflow |= localOverflow[p];
                }
            }
            else
            {
                for (var k = 0; k < count; k++)
                {
                    var i = At(k);
                    var tier = EntryTier(c, i, out _);
                    if (tier < 0) continue;
                    if (hits.Count < MemoMaxHits) hits.Add(i); else overflow = true;
                    best.Add((tier, Entries[i].Mtime, i));
                    if (best.Count > max * 4) TrimBest(best, max);
                }
            }
            TrimBest(best, max);
            _queryMemo = overflow || c.Terms.Length == 0 ? null : new QueryMemo
            {
                FilterKey = filterKey, Terms = c.Terms, Hits = hits.ToArray(),
                ScannedCount = Entries.Count, CompactGen = CompactGen,
            };

            var dirCache = new Dictionary<int, string>();
            var items = new List<Dictionary<string, object?>>(best.Count);
            foreach (var (_, _, idx) in best)
            {
                var item = Item(in Entries[idx], dirCache);
                EntryTier(c, idx, out var pathOnly);
                if (pathOnly > 0) item["pt"] = (long)pathOnly;
                items.Add(item);
            }

            // Folders whose own name holds every term, when asked and only for a
            // plain name query (a type, date or size filter is about files).
            var dirItems = new List<Dictionary<string, object?>>();
            if (dirMax > 0 && c.Terms.Length > 0 && c.Exts == null && c.After == long.MinValue && c.Before == long.MaxValue
                && c.MinB == long.MinValue && c.MaxB == long.MaxValue)
            {
                var bestDirs = new List<(int tier, long mtime, int idx)>();
                for (var d = 0; d < DirNodes.Count; d++)
                {
                    ref var n = ref DirNodes[d];
                    if (n.Parent < 0 || n.Files <= 0) continue;
                    var name = DirMatchOf(in n);
                    int tier = 0;
                    foreach (var term in c.Terms)
                    {
                        var k = MatchTierFolded(name, term);
                        if (k < 0) { tier = -1; break; }
                        if (k > tier) tier = k;
                    }
                    if (tier < 0) continue;
                    bestDirs.Add((tier, n.MaxMtime, d));
                    if (bestDirs.Count > dirMax * 4) TrimBest(bestDirs, dirMax);
                }
                TrimBest(bestDirs, dirMax);
                foreach (var (_, _, d) in bestDirs)
                {
                    ref var n = ref DirNodes[d];
                    dirItems.Add(new Dictionary<string, object?>
                    {
                        ["p"] = DirPathLocked(d), ["n"] = Encoding.UTF8.GetString(Arena.Get(n.NameOff, n.NameLen)),
                        ["s"] = n.Size, ["m"] = n.MaxMtime, ["f"] = (long)n.Files,
                    });
                }
            }
            return new Dictionary<string, object?> { ["items"] = items, ["dirs"] = dirItems, ["refined"] = refine, ["building"] = !Ready };
        }
    }

    // ── accent folding ────────────────────────────────────────────────────────
    // The server strips accents from every typed term ("città" → "citta"), so a
    // name is matched twice: as stored, then — only when it holds non-ASCII
    // bytes and the first pass missed — accent-folded. Names with accents are a
    // minority, so the second pass costs little on the scan.

    // U+00C0..U+017F → lowercase ASCII base letter, '.' = none (æ, ß, œ, þ…).
    // A literal table, not string.Normalize: the helper is built with
    // InvariantGlobalization, where normalization support is not something to
    // bet the search on.
    private const string LatinBaseTable =
        "aaaaaa.ceeeeiiiidnooooo.ouuuuy.." +   // U+00C0..U+00DF
        "aaaaaa.ceeeeiiiidnooooo.ouuuuy.y" +   // U+00E0..U+00FF
        "aaaaaaccccccccddddeeeeeeeeeegggggggghhhhiiiiiiiiii..jjkk." +   // U+0100..U+0138
        "llllllllllnnnnnnn..oooooo..rrrrrrssssssssttttttuuuuuuuuuuuuwwyyyzzzzzzs"; // U+0139..U+017F
    private static readonly byte[] LatinBase = BuildLatinBase();

    private static byte[] BuildLatinBase()
    {
        if (LatinBaseTable.Length != 0x180 - 0xC0) throw new InvalidOperationException("LatinBaseTable size");
        var t = new byte[LatinBaseTable.Length];
        for (var i = 0; i < t.Length; i++) t[i] = LatinBaseTable[i] == '.' ? (byte)0 : (byte)LatinBaseTable[i];
        return t;
    }

    [ThreadStatic] private static byte[]? _foldBuf;

    // UTF-8 → the same bytes with Latin accents removed and combining marks
    // (U+0300..U+036F, what an NFD name stores) dropped. Output is never longer
    // than input. ASCII is left as is: the comparer folds A-Z itself.
    private static ReadOnlySpan<byte> FoldAccents(ReadOnlySpan<byte> s)
    {
        var buf = _foldBuf;
        if (buf == null || buf.Length < s.Length) _foldBuf = buf = new byte[Math.Max(256, s.Length)];
        var n = 0;
        for (var i = 0; i < s.Length; i++)
        {
            var b = s[i];
            if (b >= 0xC3 && b <= 0xCD && i + 1 < s.Length && (s[i + 1] & 0xC0) == 0x80)
            {
                var cp = ((b & 0x1F) << 6) | (s[i + 1] & 0x3F);
                if (cp >= 0x300 && cp <= 0x36F) { i++; continue; }
                if (cp >= 0xC0 && cp < 0x180 && LatinBase[cp - 0xC0] != 0) { buf[n++] = LatinBase[cp - 0xC0]; i++; continue; }
            }
            buf[n++] = b;
        }
        return new ReadOnlySpan<byte>(buf, 0, n);
    }

    // UTF-8 lead bytes of everything FoldAccents changes: Latin-1 and Latin
    // Extended-A letters (0xC3-0xC5) and combining marks (0xCC-0xCD). A name
    // in Cyrillic or CJK has none of them, so it is not folded for nothing.
    private static readonly System.Buffers.SearchValues<byte> FoldLeads =
        System.Buffers.SearchValues.Create(new byte[] { 0xC3, 0xC4, 0xC5, 0xCC, 0xCD });

    // Tier against the name as stored, then against its accent-folded form.
    private static int MatchTierFolded(ReadOnlySpan<byte> nameLower, ReadOnlySpan<byte> term)
    {
        var k = MatchTier(nameLower, term);
        return k >= 0 ? k : MatchTier(FoldAccents(nameLower), term);
    }

    // 0 exact · 1 prefix · 2 word-boundary · 3 substring · -1 miss.
    // Byte offsets throughout: both sides are UTF-8, and every character this
    // looks at ('.', ' ', '-', '_', '(') is ASCII, which a continuation byte
    // can never equal.
    private static int MatchTier(ReadOnlySpan<byte> nameLower, ReadOnlySpan<byte> term)
    {
        var idx = IndexOfFold(nameLower, term);
        if (idx < 0) return -1;
        if (idx == 0)
        {
            if (nameLower.Length == term.Length) return 0;
            var dot = nameLower.LastIndexOf((byte)'.');
            if (dot == term.Length) return 0;   // exact up to the extension
            return 1;
        }
        var prev = nameLower[idx - 1];
        return (prev == ' ' || prev == '-' || prev == '_' || prev == '.' || prev == '(') ? 2 : 3;
    }

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
        var dirId = InternDirLocked(dir);
        if (dirId < 0) return;
        var n = EncodeName(name, ref _nameScratch, out var lowerLen);
        if (n > ushort.MaxValue || lowerLen > 0x7FFF) return;   // not a Windows file name
        var key = lowerLen > 0 ? _nameScratch.AsSpan(n, lowerLen) : _nameScratch.AsSpan(0, n);
        var hash = HashKey(dirId, key);
        var existing = ByPath.Find(hash, dirId, key);
        if (existing >= 0)
        {
            ref var en = ref Entries[existing];
            en.Gen = gen;
            // A repair walk re-confirms millions of unchanged entries: only a
            // real change moves the totals and the version.
            if (en.Size == size && en.Mtime == mtime) return;
            var delta = size - en.Size;
            TotalBytes += delta;
            RollLocked(dirId, delta, 0, mtime, KindOfLocked(dirId, _nameScratch.AsSpan(0, n)));
            en.Size = size; en.Mtime = mtime;
            if (size >= LargeMinBytes) Large.Add(existing); else Large.Remove(existing);
            Version++;
            return;
        }
        var off = Arena.Add(_nameScratch.AsSpan(0, n), _nameScratch.AsSpan(n, lowerLen));
        var idx = Entries.Count;
        var entry = new Entry
        {
            NameOff = off, NameLen = (ushort)n, Dir = dirId, Gen = gen, Size = size, Mtime = mtime,
            LowerLen = (ushort)(lowerLen | (_nameScratch.AsSpan(0, n).IndexOfAny(FoldLeads) >= 0 ? AccentFlag : 0)),
        };
        Entries.Add(in entry);
        NextInDir.Add(DirNodes[dirId].FirstFile);
        DirNodes[dirId].FirstFile = idx;
        ByPath.Add(hash, idx);
        TotalBytes += size;
        RollLocked(dirId, size, 1, mtime, KindOfLocked(dirId, _nameScratch.AsSpan(0, n)));
        if (size >= LargeMinBytes) Large.Add(idx);
        Version++;
    }

    // The entry stays linked in its directory's file list (readers skip
    // Dir < 0); a compaction drops it for good.
    private static void TombstoneLocked(int idx)
    {
        ref var en = ref Entries[idx];
        ByPath.Remove(HashKey(en.Dir, MatchOf(in en)), en.Dir, MatchOf(in en));
        TotalBytes -= en.Size;
        RollLocked(en.Dir, -en.Size, -1, 0, KindOfLocked(en.Dir, NameOf(in en)));
        Large.Remove(idx);
        Arena.Dead += en.NameLen + TwinLen(in en);
        en.Dir = -1;
        Tombstones++;
        Version++;
    }

    // Every live entry at or below the scope, through the tree's file lists:
    // O(that subtree), where it used to be a pass over the whole index for
    // every deleted folder (a build tool deletes them by the hundred).
    private static List<int> EntriesUnderLocked(in Scope sc)
    {
        var ids = new List<int>();
        ForEachDirLocked(in sc, d =>
        {
            for (var i = DirNodes[d].FirstFile; i >= 0; i = NextInDir[i])
                if (Entries[i].Dir >= 0) ids.Add(i);
            return true;
        });
        return ids;
    }

    private static void RemoveEntryLocked(string dir, string name)
    {
        var dirId = ResolveDirLocked(dir, create: false);
        if (dirId < 0) return;
        var key = KeyOf(name, ref _nameScratch);
        var idx = ByPath.Find(HashKey(dirId, key), dirId, key);
        if (idx < 0) return;
        TombstoneLocked(idx);
        MaybeCompactLocked();
    }

    // Same threshold everywhere. Compacting unconditionally rebuilt the whole
    // path table (millions of entries) on EVERY deleted directory — and a
    // build tool deletes directories by the hundred. The arena's dead bytes
    // are a second trigger: a name is not freed until the index is rebuilt.
    private static void MaybeCompactLocked()
    {
        if (Tombstones > 50000 && Tombstones > Entries.Count / 5) { CompactLocked(); return; }
        if (Arena.Dead > 32L * 1024 * 1024 && Arena.Dead * 4 > Arena.Used) CompactLocked();
    }

    private static void RemoveSubtree(string root)
    {
        lock (Gate)
        {
            var sc = ScopeOfLocked(root);
            if (sc.Anchors.Length == 0) return;
            foreach (var i in EntriesUnderLocked(in sc)) TombstoneLocked(i);
            MaybeCompactLocked();
        }
    }

    // The other half of a repair: whatever the walk did not confirm under this
    // root is gone. Entries the drain thread added while the walk ran carry the
    // walk's own generation, so they are never swept.
    private static void SweepStaleUnder(string root, int gen)
    {
        lock (Gate)
        {
            var sc = ScopeOfLocked(root);
            if (sc.Anchors.Length == 0) return;
            foreach (var i in EntriesUnderLocked(in sc))
                if (Entries[i].Gen != gen) TombstoneLocked(i);
            MaybeCompactLocked();
        }
    }

    // Rebuild everything live into fresh storage: tombstoned entries, the
    // names they owned, and every directory node no live entry sits under
    // (a build tool's temp trees would otherwise accumulate forever). Parents
    // are always created before their children, so ids only ever move down
    // and a parent's new id is known when its child is copied.
    private static void CompactLocked()
    {
        var keep = new bool[DirNodes.Count];
        for (int i = 0; i < Entries.Count; i++)
        {
            ref var en = ref Entries[i];
            for (var d = en.Dir; d >= 0 && !keep[d]; d = DirNodes[d].Parent) keep[d] = true;
        }
        foreach (var r in RootNodeIds) for (var d = r; d >= 0 && !keep[d]; d = DirNodes[d].Parent) keep[d] = true;

        var arena = new ByteArena();
        var dirs = new ChunkedList<DirNode>();
        var remap = new int[DirNodes.Count];
        for (int i = 0; i < DirNodes.Count; i++)
        {
            if (!keep[i]) { remap[i] = -1; continue; }
            ref var n = ref DirNodes[i];
            var node = new DirNode
            {
                Parent = n.Parent < 0 ? -1 : remap[n.Parent],
                NameOff = arena.Add(Arena.Get(n.NameOff, n.NameLen + n.LowerLen), default),
                NameLen = n.NameLen, LowerLen = n.LowerLen,
                FirstChild = -1, NextSibling = -1, FirstFile = -1,
                RootSlot = n.RootSlot, Flags = n.Flags,
            };
            var id = dirs.Count;
            remap[i] = id;
            // Parents are copied before their children, so the parent's new
            // node already exists to be linked into.
            if (node.Parent >= 0) node.NextSibling = dirs[node.Parent].FirstChild;
            dirs.Add(in node);
            if (node.Parent >= 0) dirs[node.Parent].FirstChild = id;
        }
        var entries = new ChunkedList<Entry>();
        var next = new ChunkedList<int>();
        for (int i = 0; i < Entries.Count; i++)
        {
            ref var en = ref Entries[i];
            if (en.Dir < 0) continue;
            var e = en;
            e.NameOff = arena.Add(Arena.Get(en.NameOff, en.NameLen + TwinLen(in en)), default);
            e.Dir = remap[en.Dir];
            next.Add(dirs[e.Dir].FirstFile);
            dirs[e.Dir].FirstFile = entries.Count;
            entries.Add(in e);
        }
        for (int i = 0; i < RootNodeIds.Length; i++) RootNodeIds[i] = remap[RootNodeIds[i]];

        Arena = arena; DirNodes = dirs; Entries = entries; NextInDir = next;
        CompactGen++;   // ends any query memo: every entry index just moved
        RebuildTotalsLocked();
        Version++;
        Tombstones = 0;
        _lastDirStr = null; _lastDirId = -1;
        DirChildren.Reset(DirNodes.Count);
        for (int i = 0; i < DirNodes.Count; i++) DirChildren.Add(HashKey(DirNodes[i].Parent, DirMatchOf(in DirNodes[i])), i);
        ByPath.Reset(Entries.Count);
        for (int i = 0; i < Entries.Count; i++) ByPath.Add(HashKey(Entries[i].Dir, MatchOf(in Entries[i])), i);
    }

    private static void StartWatcher(string root)
    {
        try
        {
            var w = new FileSystemWatcher(root)
            {
                IncludeSubdirectories = true,
                InternalBufferSize = WatcherBufferBytes,
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
            // This thread is what gives memory back once nobody is asking —
            // see TrimHeapIfDue: a burst that ended inside the trim interval
            // would otherwise sit in the process until the next request. It
            // runs every pass, not only on an empty one: a system drive is
            // never quiet for 300 ms in a row (measured: a 2M-file C:\ kept
            // 521 MB for as long as the trim waited for an idle pass), and
            // the call is already rate-limited by bytes and by time.
            if (Ready) TrimHeapIfDue();
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
                    // Gone. A directory the tree knows (even one that only ever
                    // held subfolders) takes its whole subtree with it.
                    bool isDirectory;
                    lock (Gate) isDirectory = ResolveDirLocked(full, create: false) >= 0;
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
        var i = RootIndexOf(path.AsSpan().TrimEnd('\\'));
        return i < 0 ? null : Roots[i];
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
