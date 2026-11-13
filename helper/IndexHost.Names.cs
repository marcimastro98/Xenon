// The file index: how a name is stored, compared and matched, accents included.

using System.IO.Enumeration;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

internal static partial class IndexHost
{
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
}
