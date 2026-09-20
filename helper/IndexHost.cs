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
//   overview {path,...}            → one coherent disk snapshot (dirs/top/dupes/details)
//   sizes {path}                  → {total, dirs:[{p,s,n,m}]}   first-level children
//   dirs  {path,minBytes,max}     → {items:[{p,s,n,m}]}         every dir ≥ minBytes
//   list  {path,max}              → {items:[{p,n,s,m}]}         files under path
//   top   {path,max}              → {items:[{p,n,s,m}]}         biggest files
//   dupes {path,minBytes,max}     → {groups:[{s,paths:[]}]}     same-size candidates
//   stats {}                      → {ready,building,files,dirs,bytes,ramMB,maxEntries,roots,...}
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
        public ushort LowerLen;  // >0: a lowercase twin follows the name in the arena (see MatchOf)
        public int Dir;          // DirNodes index; -1 = tombstone
        public int Gen;          // walk that last confirmed this entry (see the repair rules)
        public long Size;
        public long Mtime;
    }

    private struct DirNode
    {
        public int Parent;       // DirNodes index; -1 = a root (name is the root path itself)
        public int NameOff;      // one path component (a root: the whole root path)
        public ushort NameLen;
        public ushort LowerLen;
    }

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
        => e.LowerLen > 0 ? Arena.Get(e.NameOff + e.NameLen, e.LowerLen) : Arena.Get(e.NameOff, e.NameLen);
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
        var node = new DirNode { Parent = parent, NameOff = off, NameLen = (ushort)n, LowerLen = (ushort)lowerLen };
        var id = DirNodes.Count;
        DirNodes.Add(in node);
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

    // The first-level child of the queried path that `dir` sits in: -1 when
    // dir IS that path (its direct files), -2 when it is not under it at all.
    // When the path is ABOVE the roots (asked about "E:\\" with a root of
    // E:\\Games) the root itself is the child, as the old string-prefix
    // version answered — which is what `Scope.Self` distinguishes.
    private const int ChildUnknown = -3;
    private static int ChildUnder(int dir, in Scope sc, int[] memo)
    {
        var cur = dir;
        var prev = -1;
        int result;
        while (true)
        {
            if (cur < 0) { result = -2; break; }
            var m = memo[cur];
            if (m != ChildUnknown) { result = m == -1 ? (prev < 0 ? -1 : prev) : m; break; }
            if (sc.Contains(cur))
            {
                var own = cur == sc.Self ? -1 : cur;
                memo[cur] = own;
                result = own == -1 ? (prev < 0 ? -1 : prev) : own;
                break;
            }
            prev = cur;
            cur = DirNodes[cur].Parent;
        }
        for (var d = dir; d >= 0 && d != cur; d = DirNodes[d].Parent) memo[d] = result;
        return result;
    }

    private static int[] NewChildMemo() { var m = new int[DirNodes.Count]; Array.Fill(m, ChildUnknown); return m; }

    // Per-directory totals, one flat slot per dir id: an entry counts toward
    // its own directory and every ancestor up to the scope. A walk up the
    // tree is a few integer hops, so this replaces the per-directory ancestor
    // arrays (280k of them per overview) the string-path version needed.
    private sealed class DirTotals
    {
        public readonly long[] Size, Count, Mtime;
        public DirTotals(int dirs) { Size = new long[dirs]; Count = new long[dirs]; Mtime = new long[dirs]; }
        public void Add(int dir, in Scope sc, long size, long mtime)
        {
            for (var d = dir; d >= 0; d = DirNodes[d].Parent)
            {
                Size[d] += size; Count[d]++; if (mtime > Mtime[d]) Mtime[d] = mtime;
                if (sc.Contains(d)) return;
            }
        }
        // Dirs at or above minBytes, largest first, at most max.
        public List<Dictionary<string, object?>> Report(long minBytes, int max)
        {
            var ids = new List<int>();
            for (var d = 0; d < Size.Length; d++) if (Count[d] > 0 && Size[d] >= minBytes) ids.Add(d);
            ids.Sort((a, b) => Size[b].CompareTo(Size[a]));
            if (ids.Count > max) ids.RemoveRange(max, ids.Count - max);
            return ids.Select(d => new Dictionary<string, object?>
            { ["p"] = DirPathLocked(d), ["s"] = Size[d], ["n"] = Count[d], ["m"] = Mtime[d] }).ToList();
        }
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

    private static Dictionary<string, object?> OpQuery(System.Text.Json.JsonElement req)
    {
        var terms = new List<byte[]>();
        if (req.TryGetProperty("terms", out var tEl) && tEl.ValueKind == System.Text.Json.JsonValueKind.Array)
            foreach (var t in tEl.EnumerateArray()) { var s = t.GetString(); if (!string.IsNullOrEmpty(s)) terms.Add(Encoding.UTF8.GetBytes(s.ToLowerInvariant())); }
        List<byte[]>? exts = null;
        if (req.TryGetProperty("exts", out var eEl) && eEl.ValueKind == System.Text.Json.JsonValueKind.Array)
        {
            exts = new List<byte[]>();
            foreach (var x in eEl.EnumerateArray()) { var s = x.GetString(); if (!string.IsNullOrEmpty(s)) exts.Add(Encoding.UTF8.GetBytes("." + s.ToLowerInvariant())); }
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
                ref var en = ref Entries[i];
                if (en.Dir < 0) continue;
                if (en.Mtime < after || en.Mtime >= before) continue;
                if (en.Size < minB || en.Size > maxB) continue;
                var lower = MatchOf(in en);
                if (exts != null)
                {
                    var dot = lower.LastIndexOf((byte)'.');
                    if (dot < 0) continue;
                    var suffix = lower.Slice(dot);
                    var hit = false;
                    foreach (var x in exts) if (FoldEquals(suffix, x)) { hit = true; break; }
                    if (!hit) continue;
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
            var dirCache = new Dictionary<int, string>();
            var items = new List<Dictionary<string, object?>>(best.Count);
            foreach (var (_, _, idx) in best) items.Add(Item(in Entries[idx], dirCache));
            return new Dictionary<string, object?> { ["items"] = items, ["building"] = !Ready };
        }
    }

    private static int CompareHits((int tier, long mtime, int idx) a, (int tier, long mtime, int idx) b)
        => a.tier != b.tier ? a.tier.CompareTo(b.tier) : b.mtime.CompareTo(a.mtime);

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

    // One snapshot for the Disk widget. Asking for sizes, directories, top
    // files and duplicate candidates separately walked a large index four
    // times. The host handles requests serially on purpose, so the later
    // requests could time out while merely waiting. Compute all four views in
    // one pass under one consistent read lock.
    private static Dictionary<string, object?> OpOverview(System.Text.Json.JsonElement req)
    {
        var path = Str(req, "path") ?? "";
        long dirMinBytes = Num(req, "dirMinBytes") ?? DefaultDirMinBytes;
        int dirMax = (int)Math.Max(1, Math.Min(20000, Num(req, "dirMax") ?? 4000));
        int topMax = (int)Math.Max(1, Math.Min(500, Num(req, "topMax") ?? 200));
        long dupeMinBytes = Num(req, "dupeMinBytes") ?? DefaultDirMinBytes;
        int dupeMax = (int)Math.Max(1, Math.Min(500, Num(req, "dupeMax") ?? 40));
        int detailMax = (int)Math.Max(1, Math.Min(20000, Num(req, "detailMax") ?? 20000));
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

        var top = new List<(long s, int idx)>(topMax * 2);
        var bySize = new Dictionary<long, List<int>>();
        var detailFiles = new List<Dictionary<string, object?>>();
        var detailCounts = new int[detailPaths.Count];
        var detailCapped = false;
        long total = 0;
        long count = 0;

        lock (Gate)
        {
            var sc = ScopeOfLocked(path);
            var under = new byte[DirNodes.Count];
            var aggregate = new DirTotals(DirNodes.Count);
            var detailScopes = new Scope[detailPaths.Count];
            var detailMemos = new byte[detailPaths.Count][];
            for (var d = 0; d < detailPaths.Count; d++) { detailScopes[d] = ScopeOfLocked(detailPaths[d]); detailMemos[d] = new byte[DirNodes.Count]; }
            var dirCache = new Dictionary<int, string>();

            for (int i = 0; i < Entries.Count; i++)
            {
                ref var en = ref Entries[i];
                if (en.Dir < 0) continue;
                if (!IsUnder(en.Dir, in sc, under)) continue;

                total += en.Size;
                count++;
                aggregate.Add(en.Dir, in sc, en.Size, en.Mtime);

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

                for (int d = 0; d < detailScopes.Length; d++)
                {
                    if (!IsUnder(en.Dir, in detailScopes[d], detailMemos[d])) continue;
                    if (detailCounts[d] >= detailMax)
                    {
                        detailCapped = true;
                        break;
                    }
                    detailFiles.Add(Item(in en, dirCache));
                    detailCounts[d]++;
                    break;
                }
            }

            top.Sort((a, b) => b.s.CompareTo(a.s));
            if (top.Count > topMax) top.RemoveRange(topMax, top.Count - topMax);

            var dirs = aggregate.Report(dirMinBytes, dirMax);
            var topFiles = top.Select(x => Item(in Entries[x.idx], dirCache)).ToList();
            var groups = bySize.Where(kv => kv.Value.Count > 1)
                .OrderByDescending(kv => kv.Key).Take(dupeMax)
                .Select(kv => new Dictionary<string, object?>
                {
                    ["s"] = kv.Key,
                    ["paths"] = kv.Value.Select(i => (object?)FilePathLocked(in Entries[i], dirCache)).ToList(),
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
        var path = Str(req, "path") ?? "";
        var buckets = new Dictionary<int, (long s, long n, long m)>();
        long total = 0, count = 0;
        lock (Gate)
        {
            var sc = ScopeOfLocked(path);
            var childOf = NewChildMemo();
            for (int i = 0; i < Entries.Count; i++)
            {
                ref var en = ref Entries[i];
                if (en.Dir < 0) continue;
                var child = ChildUnder(en.Dir, in sc, childOf);
                if (child == -2) continue;
                // Files DIRECTLY in path count in the total, in no bucket.
                total += en.Size; count++;
                if (child < 0) continue;
                buckets.TryGetValue(child, out var b);
                buckets[child] = (b.s + en.Size, b.n + 1, Math.Max(b.m, en.Mtime));
            }
            var dirs = buckets.OrderByDescending(kv => kv.Value.s).Take(64)
                .Select(kv => new Dictionary<string, object?> { ["p"] = DirPathLocked(kv.Key), ["s"] = kv.Value.s, ["n"] = kv.Value.n, ["m"] = kv.Value.m })
                .ToList();
            return new Dictionary<string, object?> { ["total"] = total, ["files"] = count, ["dirs"] = dirs, ["building"] = !Ready };
        }
    }

    // One-level, on-demand map for a directory the Disk widget already exposed
    // by opaque id. Unlike the overview's thresholded global tree, this always
    // returns the selected folder's direct child folders AND its largest direct
    // files, so a 140 GB Desktop made of loose files never opens to an empty map.
    private static Dictionary<string, object?> OpBrowse(System.Text.Json.JsonElement req)
    {
        var path = NormalizeDir(Str(req, "path") ?? "");
        int childMax = (int)Math.Max(1, Math.Min(128, Num(req, "childMax") ?? 64));
        int fileMax = (int)Math.Max(1, Math.Min(128, Num(req, "fileMax") ?? 64));
        var buckets = new Dictionary<int, (long s, long n, long m)>();
        var direct = new List<(long s, int idx)>(fileMax * 2);
        long total = 0, count = 0, directBytes = 0;

        lock (Gate)
        {
            var sc = ScopeOfLocked(path);
            var childOf = NewChildMemo();
            for (int i = 0; i < Entries.Count; i++)
            {
                ref var en = ref Entries[i];
                if (en.Dir < 0) continue;
                var child = ChildUnder(en.Dir, in sc, childOf);
                if (child == -2) continue;
                total += en.Size; count++;
                if (child >= 0)
                {
                    buckets.TryGetValue(child, out var b);
                    buckets[child] = (b.s + en.Size, b.n + 1, Math.Max(b.m, en.Mtime));
                    continue;
                }
                directBytes += en.Size;
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
                    ["p"] = DirPathLocked(kv.Key), ["s"] = kv.Value.s,
                    ["n"] = kv.Value.n, ["m"] = kv.Value.m,
                }).ToList();
            direct.Sort((a, b) => b.s.CompareTo(a.s));
            if (direct.Count > fileMax) direct.RemoveRange(fileMax, direct.Count - fileMax);
            var dirCache = new Dictionary<int, string>();
            var directFiles = direct.Select(x => Item(in Entries[x.idx], dirCache)).ToList();
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

    private static Dictionary<string, object?> OpDirs(System.Text.Json.JsonElement req)
    {
        var path = Str(req, "path") ?? "";
        long minBytes = Num(req, "minBytes") ?? DefaultDirMinBytes;
        int max = (int)Math.Max(1, Math.Min(20000, Num(req, "max") ?? 5000));
        // Aggregate EVERY dir (each entry counts toward all its ancestors under
        // path). One pass, integer hops up the tree.
        lock (Gate)
        {
            var sc = ScopeOfLocked(path);
            var under = new byte[DirNodes.Count];
            var agg = new DirTotals(DirNodes.Count);
            for (int i = 0; i < Entries.Count; i++)
            {
                ref var en = ref Entries[i];
                if (en.Dir < 0 || !IsUnder(en.Dir, in sc, under)) continue;
                agg.Add(en.Dir, in sc, en.Size, en.Mtime);
            }
            var items = agg.Report(minBytes, max);
            return new Dictionary<string, object?> { ["items"] = items, ["building"] = !Ready };
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
            var under = new byte[DirNodes.Count];
            var dirCache = new Dictionary<int, string>();
            for (int i = 0; i < Entries.Count && items.Count < max; i++)
            {
                ref var en = ref Entries[i];
                if (en.Dir < 0 || !IsUnder(en.Dir, in sc, under)) continue;
                items.Add(Item(in en, dirCache));
            }
        }
        return new Dictionary<string, object?> { ["items"] = items, ["building"] = !Ready };
    }

    private static Dictionary<string, object?> OpTop(System.Text.Json.JsonElement req)
    {
        var path = Str(req, "path") ?? "";
        int max = (int)Math.Max(1, Math.Min(500, Num(req, "max") ?? 100));
        var best = new List<(long s, int idx)>(max + 1);
        lock (Gate)
        {
            var sc = ScopeOfLocked(path);
            var under = new byte[DirNodes.Count];
            for (int i = 0; i < Entries.Count; i++)
            {
                ref var en = ref Entries[i];
                if (en.Dir < 0 || !IsUnder(en.Dir, in sc, under)) continue;
                best.Add((en.Size, i));
                if (best.Count > max * 4) { best.Sort((a, b) => b.s.CompareTo(a.s)); best.RemoveRange(max, best.Count - max); }
            }
            best.Sort((a, b) => b.s.CompareTo(a.s));
            if (best.Count > max) best.RemoveRange(max, best.Count - max);
            var dirCache = new Dictionary<int, string>();
            var items = best.Select(x => Item(in Entries[x.idx], dirCache)).ToList();
            return new Dictionary<string, object?> { ["items"] = items };
        }
    }

    private static Dictionary<string, object?> OpDupes(System.Text.Json.JsonElement req)
    {
        var path = Str(req, "path") ?? "";
        long minBytes = Num(req, "minBytes") ?? DefaultDirMinBytes;
        int max = (int)Math.Max(1, Math.Min(500, Num(req, "max") ?? 200));
        var bySize = new Dictionary<long, List<int>>();
        lock (Gate)
        {
            var sc = ScopeOfLocked(path);
            var under = new byte[DirNodes.Count];
            for (int i = 0; i < Entries.Count; i++)
            {
                ref var en = ref Entries[i];
                if (en.Dir < 0 || en.Size < minBytes) continue;
                if (!IsUnder(en.Dir, in sc, under)) continue;
                if (!bySize.TryGetValue(en.Size, out var l)) bySize[en.Size] = l = new List<int>();
                if (l.Count < 20) l.Add(i);
            }
            var dirCache = new Dictionary<int, string>();
            var groups = bySize.Where(kv => kv.Value.Count > 1)
                .OrderByDescending(kv => kv.Key).Take(max)
                .Select(kv => new Dictionary<string, object?>
                {
                    ["s"] = kv.Key,
                    ["paths"] = kv.Value.Select(i => (object?)FilePathLocked(in Entries[i], dirCache)).ToList(),
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
                ["dirs"] = (long)DirNodes.Count,
                ["bytes"] = TotalBytes,
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
        if (n > ushort.MaxValue || lowerLen > ushort.MaxValue) return;   // not a Windows file name
        var key = lowerLen > 0 ? _nameScratch.AsSpan(n, lowerLen) : _nameScratch.AsSpan(0, n);
        var hash = HashKey(dirId, key);
        var existing = ByPath.Find(hash, dirId, key);
        if (existing >= 0)
        {
            ref var en = ref Entries[existing];
            TotalBytes += size - en.Size;
            en.Size = size; en.Mtime = mtime; en.Gen = gen;
            return;
        }
        var off = Arena.Add(_nameScratch.AsSpan(0, n), _nameScratch.AsSpan(n, lowerLen));
        var entry = new Entry { NameOff = off, NameLen = (ushort)n, LowerLen = (ushort)lowerLen, Dir = dirId, Gen = gen, Size = size, Mtime = mtime };
        Entries.Add(in entry);
        ByPath.Add(hash, Entries.Count - 1);
        TotalBytes += size;
    }

    private static void TombstoneLocked(int idx)
    {
        ref var en = ref Entries[idx];
        ByPath.Remove(HashKey(en.Dir, MatchOf(in en)), en.Dir, MatchOf(in en));
        TotalBytes -= en.Size;
        Arena.Dead += en.NameLen + en.LowerLen;
        en.Dir = -1;
        Tombstones++;
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
            var under = new byte[DirNodes.Count];
            for (int i = 0; i < Entries.Count; i++)
            {
                ref var en = ref Entries[i];
                if (en.Dir < 0 || !IsUnder(en.Dir, in sc, under)) continue;
                TombstoneLocked(i);
            }
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
            var under = new byte[DirNodes.Count];
            for (int i = 0; i < Entries.Count; i++)
            {
                ref var en = ref Entries[i];
                if (en.Dir < 0 || en.Gen == gen) continue;
                if (!IsUnder(en.Dir, in sc, under)) continue;
                TombstoneLocked(i);
            }
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
            };
            remap[i] = dirs.Count;
            dirs.Add(in node);
        }
        var entries = new ChunkedList<Entry>();
        for (int i = 0; i < Entries.Count; i++)
        {
            ref var en = ref Entries[i];
            if (en.Dir < 0) continue;
            var e = en;
            e.NameOff = arena.Add(Arena.Get(en.NameOff, en.NameLen + en.LowerLen), default);
            e.Dir = remap[en.Dir];
            entries.Add(in e);
        }
        for (int i = 0; i < RootNodeIds.Length; i++) RootNodeIds[i] = remap[RootNodeIds[i]];

        Arena = arena; DirNodes = dirs; Entries = entries;
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
