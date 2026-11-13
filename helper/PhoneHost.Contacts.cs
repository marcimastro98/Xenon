// Phone over Bluetooth: which phone is paired and what it offers, and reading its contacts and call log.

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
    // ── Status ──────────────────────────────────────────────────────────────

    private static async Task<Dictionary<string, object?>> StatusAsync()
    {
        var pbap = false;
        var deviceName = "";
        try
        {
            var services = await FindPbapAsync();
            pbap = services.Count > 0;
            // DeviceInformation.Name here is the SERVICE's name ("Phonebook"),
            // not the phone's. The device behind it is what the user recognises.
            if (pbap)
            {
                deviceName = services[0].Name;
                try
                {
                    var svc = await RfcommDeviceService.FromIdAsync(services[0].Id);
                    var friendly = svc?.Device?.Name;
                    if (!string.IsNullOrWhiteSpace(friendly)) deviceName = friendly;
                }
                catch { /* the service name is a usable fallback */ }
            }
        }
        catch { pbap = false; }

        // Whether the phone PUBLISHES a message server, which is a different
        // question from whether we can reach it right now: the channel is
        // contended and may be busy. Presence is what the UI needs to decide
        // between "your phone does not do this" and "try again in a moment".
        var map = false;
        try
        {
            var selector = RfcommDeviceService.GetDeviceSelector(RfcommServiceId.FromUuid(MapService));
            map = (await DeviceInformation.FindAllAsync(selector)).Count > 0;
        }
        catch { map = false; }

        var telephony = false;
        var canDial = false;
        var lineName = "";
        var transport = "";
        try
        {
            var line = await DefaultLineAsync();
            if (line != null)
            {
                telephony = true;
                canDial = line.CanDial;
                lineName = line.DisplayName ?? "";
                transport = line.Transport.ToString();
            }
        }
        catch { telephony = false; }

        return new Dictionary<string, object?>
        {
            ["pbap"] = pbap,
            ["map"] = map,
            ["device"] = deviceName,
            ["telephony"] = telephony,
            ["canDial"] = canDial,
            // Stated rather than omitted. The dashboard renders the buttons a
            // capability says are real, so "we cannot answer on this platform"
            // has to be a value it can read, not something it infers.
            ["canAnswer"] = false,
            ["canHangUp"] = false,
            ["line"] = lineName,
            ["transport"] = transport,
            ["incoming"] = SafeIncoming(),
            ["active"] = SafeActive(),
        };
    }

    // ── PBAP ────────────────────────────────────────────────────────────────

    private static async Task<List<DeviceInformation>> FindPbapAsync()
    {
        var selector = RfcommDeviceService.GetDeviceSelector(RfcommServiceId.FromUuid(PbapService));
        var found = await DeviceInformation.FindAllAsync(selector);
        return found.ToList();
    }

    private static async Task<(string Vcf, int Total)> PullAsync(string book, int max)
    {
        if (!Books.TryGetValue(book, out var path)) throw new ArgumentException("unknown_book");
        if (max < 1) max = 1;
        if (max > 5000) max = 5000;

        var devices = await FindPbapAsync();
        if (devices.Count == 0) throw new IOException("no_paired_phonebook");

        var svc = await RfcommDeviceService.FromIdAsync(devices[0].Id)
                  ?? throw new IOException("phonebook_channel_unavailable");

        using var socket = new StreamSocket();
        await socket.ConnectAsync(
            svc.ConnectionHostName,
            svc.ConnectionServiceName,
            // The pairing already encrypts the link; demanding authentication
            // here re-prompts on some stacks for nothing.
            SocketProtectionLevel.BluetoothEncryptionAllowNullAuthentication);

        using var obex = new ObexClient(new SocketChannel(socket));
        var connect = await obex.ConnectAsync(PbapTarget);
        if (!connect.IsSuccess) throw new IOException("phonebook_" + connect.CodeName());

        // Count first. MaxListCount = 0 means "do not send entries, just say how
        // many there are", which is also the cheapest proof the user granted
        // this pairing access at all.
        var total = -1;
        try
        {
            var (countResp, _, countParams) = await obex.GetAllAsync(new[]
            {
                ObexClient.TextHeader(ObexHdr.Name, path),
                ObexClient.AsciiHeader(ObexHdr.Type, TypePhonebook),
                ObexClient.BytesHeader(ObexHdr.AppParameters, ObexAppParams.Build(
                    (TagMaxListCount, ObexAppParams.U16(0)))),
            });
            if (countResp.IsSuccess)
            {
                foreach (var raw in countParams)
                {
                    var parsed = ObexAppParams.Parse(raw);
                    if (parsed.TryGetValue(TagPhonebookSize, out var size)) total = ObexAppParams.AsU16(size);
                }
            }
        }
        catch { /* the size is a nicety; the entries are the point */ }

        var (last, body, _) = await obex.GetAllAsync(new[]
        {
            ObexClient.TextHeader(ObexHdr.Name, path),
            ObexClient.AsciiHeader(ObexHdr.Type, TypePhonebook),
            ObexClient.BytesHeader(ObexHdr.AppParameters, ObexAppParams.Build(
                // Filter 0 = the phone's own default property set. Asking for
                // every property makes some phones refuse the whole request.
                (TagFilter, ObexAppParams.U64(0)),
                (TagFormat, ObexAppParams.U8(0)),          // vCard 2.1: the universally supported one
                (TagMaxListCount, ObexAppParams.U16(max)),
                (TagListStartOffset, ObexAppParams.U16(0)))),
        });
        if (!last.IsSuccess) throw new IOException("phonebook_" + last.CodeName());

        try { await obex.DisconnectAsync(); } catch { /* closing is best effort */ }
        return (Encoding.UTF8.GetString(body), total);
    }
}
