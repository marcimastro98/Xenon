// Phone over Bluetooth: writing an answer to the server and reading the fields of a request.

using System.Text;
using System.Text.Json;
using Windows.ApplicationModel.Calls;
using Windows.Devices.Bluetooth.Rfcomm;
using Windows.Devices.Enumeration;
using Windows.Networking.Sockets;
using Windows.Storage.Streams;

namespace XenonHelper;

internal static partial class PhoneHost
{
    // A machine-readable reason, never a localised .NET sentence: the server
    // turns these into the one line the widget shows, in the user's language.
    private static string Describe(Exception ex) => ex switch
    {
        ArgumentException a => a.Message,
        IOException io => io.Message,
        _ when (uint)ex.HResult == 0x80072740 => "channel_busy",   // WSAEADDRINUSE
        _ => "phone_error",
    };

    private static void WriteFrame(Dictionary<string, object?> obj)
    {
        var json = JsonOut.Serialize(obj);
        var b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
        // Event frames arrive on WinRT callback threads while responses come
        // from the read loop: serialize writes so frames never interleave.
        lock (OutLock)
        {
            Console.Out.WriteLine(Frame + b64);
            Console.Out.Flush();
        }
    }

    private static object? ReadId(JsonElement root)
    {
        if (!root.TryGetProperty("id", out var el)) return null;
        return el.ValueKind switch
        {
            JsonValueKind.Number => el.TryGetInt64(out var n) ? n : el.GetDouble(),
            JsonValueKind.String => el.GetString(),
            _ => null,
        };
    }

    private static string ReadString(JsonElement root, string name)
    {
        if (root.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String)
            return el.GetString() ?? "";
        return "";
    }

    private static int ReadInt(JsonElement root, string name, int fallback)
    {
        if (root.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.Number &&
            el.TryGetInt32(out var value)) return value;
        return fallback;
    }
}
