// The file index: answering a name search.

using System.IO.Enumeration;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

internal static partial class IndexHost
{
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
}
