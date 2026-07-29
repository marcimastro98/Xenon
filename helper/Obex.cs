using System.Text;

namespace XenonHelper;

// ─────────────────────────────────────────────────────────────────────────────
// OBEX — the transfer protocol the phone's Phonebook Access server speaks.
//
// PURE byte work over a two-way channel: nothing here knows what Bluetooth is.
// That is deliberate. The same request/response shapes are what BlueZ hands to
// a Linux client and what IOBluetooth hands to a macOS one, so when the phone
// widget grows those two platforms, THIS file is the part that does not get
// rewritten — only the channel underneath it changes.
//
// Header encoding is decided by the TOP TWO BITS of the header id, and it is
// the one detail that silently produces a packet the phone answers with "Bad
// Request" rather than an error you can read:
//   00xxxxxx  null-terminated UTF-16 BIG-endian text, 2-byte length prefix
//   01xxxxxx  raw bytes, 2-byte length prefix
//   10xxxxxx  one byte of value
//   11xxxxxx  four bytes, big endian
// The length prefix counts ITSELF and the id, so an empty text header is 3.
//
// Only what the phonebook needs is implemented: CONNECT, GET with its
// continuation loop, DISCONNECT. There is no PUT here because nothing in this
// feature writes to the phone.
// ─────────────────────────────────────────────────────────────────────────────

internal interface IByteChannel : IDisposable
{
    Task WriteAsync(byte[] data, CancellationToken ct = default);
    // 0 means the peer closed the channel; anything else is bytes delivered.
    Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct = default);
}

internal static class ObexOp
{
    public const byte Connect = 0x80;
    public const byte Disconnect = 0x81;
    public const byte PutFinal = 0x82;
    public const byte GetFinal = 0x83;
    public const byte SetPath = 0x85;
}

internal static class ObexHdr
{
    public const byte Name = 0x01;
    public const byte Type = 0x42;
    public const byte Length = 0xC3;
    public const byte Body = 0x48;
    public const byte EndOfBody = 0x49;
    public const byte Target = 0x46;
    public const byte ConnectionId = 0xCB;
    public const byte AppParameters = 0x4C;
}

internal sealed class ObexPacket
{
    public byte Code;
    public byte[] Payload = Array.Empty<byte>();
    public List<(byte Id, byte[] Data)> Headers = new();

    public bool IsSuccess => Code == 0xA0;
    public bool IsContinue => Code == 0x90;

    public byte[]? Header(byte id)
    {
        foreach (var (hid, data) in Headers) if (hid == id) return data;
        return null;
    }

    public IEnumerable<byte[]> BodyChunks()
    {
        foreach (var (id, data) in Headers)
            if (id == ObexHdr.Body || id == ObexHdr.EndOfBody) yield return data;
    }

    // The refusals worth telling a human apart: Forbidden is what a phone
    // answers when the user has not granted this pairing access to contacts,
    // which is a thing they can fix, unlike a protocol error.
    public string CodeName() => Code switch
    {
        0x90 => "continue",
        0xA0 => "success",
        0xC0 => "bad_request",
        0xC1 => "unauthorized",
        0xC3 => "forbidden",
        0xC4 => "not_found",
        0xC6 => "not_acceptable",
        0xD0 => "server_error",
        0xD1 => "not_implemented",
        _ => "0x" + Code.ToString("X2"),
    };
}

internal sealed class ObexClient : IDisposable
{
    private readonly IByteChannel _ch;
    private uint? _connectionId;
    // The peer's own limit, learned from the CONNECT reply. 255 is the floor
    // the spec guarantees, and staying there until told otherwise is what keeps
    // a PUT from overflowing a peer that never said it could take more.
    private int _peerMaxPacket = 255;

    public ObexClient(IByteChannel channel) { _ch = channel; }

    // ── Header building ─────────────────────────────────────────────────────

    public static byte[] TextHeader(byte id, string value)
    {
        if (value.Length == 0) return new byte[] { id, 0x00, 0x03 };
        var body = new byte[(value.Length + 1) * 2];
        for (var i = 0; i < value.Length; i++)
        {
            body[i * 2] = (byte)(value[i] >> 8);
            body[i * 2 + 1] = (byte)(value[i] & 0xFF);
        }
        return Wrap(id, body);
    }

    public static byte[] AsciiHeader(byte id, string value)
    {
        var raw = Encoding.ASCII.GetBytes(value);
        var body = new byte[raw.Length + 1];
        Array.Copy(raw, body, raw.Length);
        return Wrap(id, body);
    }

    public static byte[] BytesHeader(byte id, byte[] value) => Wrap(id, value);

    private static byte[] UIntHeader(byte id, uint value) =>
        new[] { id, (byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value };

    private static byte[] Wrap(byte id, byte[] body)
    {
        var len = body.Length + 3;
        var packet = new byte[len];
        packet[0] = id;
        packet[1] = (byte)(len >> 8);
        packet[2] = (byte)(len & 0xFF);
        Array.Copy(body, 0, packet, 3, body.Length);
        return packet;
    }

    // ── Requests ────────────────────────────────────────────────────────────

    public async Task<ObexPacket> ConnectAsync(byte[] target, CancellationToken ct = default)
    {
        // version 1.0, flags 0, our max packet size (8 KB)
        var body = new List<byte> { 0x10, 0x00, 0x20, 0x00 };
        body.AddRange(BytesHeader(ObexHdr.Target, target));

        var resp = await SendAsync(ObexOp.Connect, Array.Empty<byte>(), body.ToArray(), skipConnectionId: true, ct);
        if (resp.IsSuccess)
        {
            // The CONNECT reply repeats the 4-byte preamble before its headers:
            // version, flags, then the peer's max packet size.
            if (resp.Payload.Length >= 4)
                _peerMaxPacket = Math.Max(255, (resp.Payload[2] << 8) | resp.Payload[3]);
            var cid = resp.Header(ObexHdr.ConnectionId);
            if (cid is { Length: 4 })
                _connectionId = (uint)((cid[0] << 24) | (cid[1] << 16) | (cid[2] << 8) | cid[3]);
        }
        return resp;
    }

    public Task<ObexPacket> DisconnectAsync(CancellationToken ct = default)
        => SendAsync(ObexOp.Disconnect, Array.Empty<byte>(), Array.Empty<byte>(), skipConnectionId: false, ct);

    // SETPATH — one level at a time. Handing it "telecom/msg/inbox" in a single
    // Name header is refused by every stack; the folder walk is the caller's job.
    //
    // The two fixed bytes belong to the PACKET, not to the header list, so they
    // precede the connection id. Emitting them after it produces a packet that
    // looks well formed and that iOS answers with Bad Request and nothing else.
    public Task<ObexPacket> SetPathAsync(string? name, CancellationToken ct = default)
    {
        var headers = TextHeader(ObexHdr.Name, name ?? "");
        return SendAsync(ObexOp.SetPath, new byte[] { 0x02, 0x00 }, headers, skipConnectionId: false, ct);
    }

    // A single-packet PUT. Everything this sends is one short message, and the
    // caller bounds the text before it gets here — but "it fits" is checked
    // rather than assumed, because a body that overflows the peer's declared
    // packet size is silently truncated by the transport rather than refused.
    public Task<ObexPacket> PutAsync(IEnumerable<byte[]> headers, byte[] content, CancellationToken ct = default)
    {
        var all = new List<byte>();
        foreach (var h in headers) all.AddRange(h);
        all.AddRange(UIntHeader(ObexHdr.Length, (uint)content.Length));
        all.AddRange(BytesHeader(ObexHdr.EndOfBody, content));
        if (all.Count + 8 > _peerMaxPacket) throw new IOException("message_too_long");
        return SendAsync(ObexOp.PutFinal, Array.Empty<byte>(), all.ToArray(), skipConnectionId: false, ct);
    }

    // A GET that follows every Continue until the peer says Success, gluing the
    // body chunks together.
    //
    // The continuation packets carry ONLY the connection id. Repeating Name and
    // Type on them makes some stacks restart the transfer from the beginning,
    // which presents as a transfer that never ends rather than as an error.
    public async Task<(ObexPacket Last, byte[] Body, List<byte[]> AppParams)> GetAllAsync(
        IEnumerable<byte[]> headers, CancellationToken ct = default)
    {
        var body = new List<byte>();
        var appParams = new List<byte[]>();
        var first = new List<byte>();
        foreach (var h in headers) first.AddRange(h);

        var resp = await SendAsync(ObexOp.GetFinal, Array.Empty<byte>(), first.ToArray(), skipConnectionId: false, ct);
        var guard = 0;
        while (true)
        {
            foreach (var chunk in resp.BodyChunks()) body.AddRange(chunk);
            var ap = resp.Header(ObexHdr.AppParameters);
            if (ap != null) appParams.Add(ap);
            if (!resp.IsContinue) break;
            if (++guard > 4096) break;   // a rude peer must not spin us forever
            resp = await SendAsync(ObexOp.GetFinal, Array.Empty<byte>(), Array.Empty<byte>(), skipConnectionId: false, ct);
        }
        return (resp, body.ToArray(), appParams);
    }

    // ── Wire ────────────────────────────────────────────────────────────────

    // `preamble` is the fixed-field part a request carries between the packet
    // header and its first OBEX header (CONNECT's version/flags/max-packet). It
    // goes out BEFORE the connection id, because it belongs to the packet and
    // not to the header list.
    private async Task<ObexPacket> SendAsync(byte opcode, byte[] preamble, byte[] payload, bool skipConnectionId, CancellationToken ct)
    {
        var body = new List<byte>();
        body.AddRange(preamble);
        if (!skipConnectionId && _connectionId.HasValue)
            body.AddRange(UIntHeader(ObexHdr.ConnectionId, _connectionId.Value));
        body.AddRange(payload);

        var len = body.Count + 3;
        var packet = new byte[len];
        packet[0] = opcode;
        packet[1] = (byte)(len >> 8);
        packet[2] = (byte)(len & 0xFF);
        body.CopyTo(packet, 3);

        await _ch.WriteAsync(packet, ct);
        return await ReadPacketAsync(ct);
    }

    private async Task<ObexPacket> ReadPacketAsync(CancellationToken ct)
    {
        var head = await ReadExactAsync(3, ct);
        var len = (head[1] << 8) | head[2];
        if (len < 3) throw new IOException($"OBEX packet claims length {len}");
        var payload = len > 3 ? await ReadExactAsync(len - 3, ct) : Array.Empty<byte>();

        var packet = new ObexPacket { Code = head[0], Payload = payload };
        // A CONNECT reply puts a 4-byte preamble before its headers and starts
        // with the version byte; every other reply starts its headers at once.
        var offset = payload.Length >= 4 && payload[0] == 0x10 ? 4 : 0;
        packet.Headers = ParseHeaders(payload, offset);
        return packet;
    }

    private static List<(byte, byte[])> ParseHeaders(byte[] buf, int offset)
    {
        var list = new List<(byte, byte[])>();
        var i = offset;
        while (i < buf.Length)
        {
            var id = buf[i];
            switch (id >> 6)
            {
                case 0:
                case 1:
                {
                    if (i + 3 > buf.Length) return list;
                    var len = (buf[i + 1] << 8) | buf[i + 2];
                    if (len < 3 || i + len > buf.Length) return list;
                    var data = new byte[len - 3];
                    Array.Copy(buf, i + 3, data, 0, data.Length);
                    list.Add((id, data));
                    i += len;
                    break;
                }
                case 2:
                {
                    if (i + 2 > buf.Length) return list;
                    list.Add((id, new[] { buf[i + 1] }));
                    i += 2;
                    break;
                }
                default:
                {
                    if (i + 5 > buf.Length) return list;
                    list.Add((id, new[] { buf[i + 1], buf[i + 2], buf[i + 3], buf[i + 4] }));
                    i += 5;
                    break;
                }
            }
        }
        return list;
    }

    private async Task<byte[]> ReadExactAsync(int count, CancellationToken ct)
    {
        var buf = new byte[count];
        var got = 0;
        while (got < count)
        {
            var n = await _ch.ReadAsync(buf, got, count - got, ct);
            if (n <= 0) throw new IOException("channel closed mid-packet");
            got += n;
        }
        return buf;
    }

    public void Dispose() => _ch.Dispose();
}

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
