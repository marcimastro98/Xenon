// OBEX: the request codes, the header ids, and one packet as it arrives.

using System.Text;

namespace XenonHelper;

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
