// The file index: the compact tables every file and folder is kept in.

using System.IO.Enumeration;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

internal static partial class IndexHost
{
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
}
