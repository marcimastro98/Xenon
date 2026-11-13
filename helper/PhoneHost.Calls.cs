// Phone over Bluetooth: dialling, and telling the server when a call starts or ends.

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
    // ── Telephony ───────────────────────────────────────────────────────────

    private static async Task<PhoneLine?> DefaultLineAsync()
    {
        var store = await PhoneCallManager.RequestStoreAsync();
        var lineId = await store.GetDefaultLineAsync();
        return await PhoneLine.FromIdAsync(lineId);
    }

    private static async Task DialAsync(string number)
    {
        var line = await DefaultLineAsync() ?? throw new IOException("no_phone_line");
        if (!line.CanDial) throw new IOException("line_cannot_dial");
        line.Dial(number, number);
    }

    private static bool SafeIncoming()
    {
        try { return PhoneCallManager.IsCallIncoming; } catch { return false; }
    }

    private static bool SafeActive()
    {
        try { return PhoneCallManager.IsCallActive; } catch { return false; }
    }

    private static void PushCallStateIfChanged()
    {
        var incoming = SafeIncoming();
        var active = SafeActive();
        if (incoming == _lastIncoming && active == _lastActive) return;
        _lastIncoming = incoming;
        _lastActive = active;
        PushCallState();
    }

    private static void PushCallState()
    {
        WriteFrame(new Dictionary<string, object?>
        {
            ["event"] = "callstate",
            ["incoming"] = SafeIncoming(),
            ["active"] = SafeActive(),
        });
    }
}
