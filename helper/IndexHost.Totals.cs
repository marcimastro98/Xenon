// The file index: kinds of file, folder sizes, and the lists read from them.

using System.IO.Enumeration;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

internal static partial class IndexHost
{
    // ── file kinds ────────────────────────────────────────────────────────────
    // What the capacity bar is split into. By extension, except that anything
    // under a game library folder is a game whatever its extension: a 90 GB
    // game is .pak/.bin/.dat files that would otherwise read as "other".
    private const int KindCount = 8;
    private const int KindGame = 7;

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
}
