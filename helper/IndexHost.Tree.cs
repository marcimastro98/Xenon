// The file index: the roots, the folder tree, and the path of a file or folder.

using System.IO.Enumeration;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

internal static partial class IndexHost
{
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
}
