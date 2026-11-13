// OBEX: building and reading the small tagged values a request carries.

using System.Text;

namespace XenonHelper;

// Both PBAP and MAP carry their options inside ONE OBEX header as a
// tag/length/value list. The tag numbers are NOT shared between the two
// profiles (MaxListCount is 0x04 in PBAP and 0x01 in MAP), so a profile always
// names its own constants rather than importing another's.
internal static class ObexAppParams
{
    public static byte[] Build(params (byte Tag, byte[] Value)[] items)
    {
        var buf = new List<byte>();
        foreach (var (tag, value) in items)
        {
            buf.Add(tag);
            buf.Add((byte)value.Length);
            buf.AddRange(value);
        }
        return buf.ToArray();
    }

    public static Dictionary<byte, byte[]> Parse(byte[] buf)
    {
        var map = new Dictionary<byte, byte[]>();
        var i = 0;
        while (i + 2 <= buf.Length)
        {
            var tag = buf[i];
            var len = buf[i + 1];
            if (i + 2 + len > buf.Length) break;
            var value = new byte[len];
            Array.Copy(buf, i + 2, value, 0, len);
            map[tag] = value;
            i += 2 + len;
        }
        return map;
    }

    public static byte[] U16(int v) => new[] { (byte)(v >> 8), (byte)(v & 0xFF) };
    public static byte[] U8(int v) => new[] { (byte)v };
    public static byte[] U64(ulong v)
    {
        var b = new byte[8];
        for (var i = 0; i < 8; i++) b[i] = (byte)(v >> (56 - i * 8));
        return b;
    }

    public static int AsU16(byte[]? v) => v is { Length: 2 } ? (v[0] << 8) | v[1] : -1;
}
