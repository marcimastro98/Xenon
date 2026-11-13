// The file index: reading a drive into the index, and removing or compacting entries.

using System.IO.Enumeration;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

internal static partial class IndexHost
{
    // ── build + live updates ──────────────────────────────────────────────────

    private static bool WalkRoot(string root) => WalkRoot(root, CurrentGen);

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
        IEnumerable<(string dir, string name, long size, long mtime)> files;
        // The enumeration never started, so this walk is evidence of nothing.
        // Reporting it as complete would let a repair sweep every entry under a
        // momentarily unreadable root out of the index.
        try { files = WalkEntries(root, opts); }
        catch { return false; }
        foreach (var file in files)
        {
            WaitWhileHeld();
            if (Cancelled) return false;
            batch.Add(file);
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

    // Every file under `root`, read straight from the directory listing the
    // kernel returns. FileInfo cost a full path, a name and a folder string per
    // file plus the object itself; here a file costs its name, and its folder
    // is one string shared by every file in it (the listing hands them over
    // folder by folder, which is also what InternDirLocked counts on).
    private static FileSystemEnumerable<(string dir, string name, long size, long mtime)> WalkEntries(string root, EnumerationOptions opts)
    {
        string? lastDir = null;
        return new FileSystemEnumerable<(string dir, string name, long size, long mtime)>(root,
            (ref FileSystemEntry e) =>
            {
                var dir = e.Directory;
                if (lastDir == null || !dir.SequenceEqual(lastDir)) lastDir = dir.ToString();
                return (lastDir, e.FileName.ToString(), e.Length, e.LastWriteTimeUtc.ToUnixTimeMilliseconds());
            }, opts)
        {
            ShouldIncludePredicate = (ref FileSystemEntry e) => !e.IsDirectory,
        };
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
}
