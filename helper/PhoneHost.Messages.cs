// Phone over Bluetooth: listing, reading and sending text messages.

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
    // ── MAP ─────────────────────────────────────────────────────────────────

    // A message session, opened per request and closed straight after, for the
    // same reason the phonebook one is: this channel is CONTENDED. On Windows,
    // Phone Link holds it whenever it is running and relaunches itself when the
    // phone does anything — so a busy channel is a normal state to report, not
    // a failure to work around, and Xenon never takes the connection from
    // software the user is also using.
    private static async Task<(StreamSocket Socket, ObexClient Obex)> OpenMapAsync()
    {
        var selector = RfcommDeviceService.GetDeviceSelector(RfcommServiceId.FromUuid(MapService));
        var devices = await DeviceInformation.FindAllAsync(selector);
        if (devices.Count == 0) throw new IOException("no_paired_messages");

        var svc = await RfcommDeviceService.FromIdAsync(devices[0].Id)
                  ?? throw new IOException("messages_channel_unavailable");

        var socket = new StreamSocket();
        try
        {
            await socket.ConnectAsync(
                svc.ConnectionHostName,
                svc.ConnectionServiceName,
                SocketProtectionLevel.BluetoothEncryptionAllowNullAuthentication);
        }
        catch { socket.Dispose(); throw; }

        var obex = new ObexClient(new SocketChannel(socket));
        var connect = await obex.ConnectAsync(MapTarget);
        if (!connect.IsSuccess) { socket.Dispose(); throw new IOException("messages_" + connect.CodeName()); }
        return (socket, obex);
    }

    // Walk down from the root, one level per SETPATH.
    private static async Task GoToFolderAsync(ObexClient obex, string path)
    {
        var root = await obex.SetPathAsync("");
        if (!root.IsSuccess) throw new IOException("messages_setpath_root_" + root.CodeName());
        foreach (var part in path.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            var r = await obex.SetPathAsync(part);
            if (!r.IsSuccess) throw new IOException("messages_setpath_" + r.CodeName());
        }
    }

    // The folder names MAP defines. An allowlist rather than passing the
    // caller's string through: a folder name becomes a SETPATH on the user's
    // phone, and there is no reason for it ever to be arbitrary.
    private static string FolderPath(string folder) => folder switch
    {
        "inbox" => "telecom/msg/inbox",
        "sent" => "telecom/msg/sent",
        "outbox" => "telecom/msg/outbox",
        _ => throw new ArgumentException("unknown_folder"),
    };

    private static async Task<(string Xml, int Total)> MessageListingAsync(string folder, int max)
    {
        if (max < 1) max = 1;
        if (max > 200) max = 200;
        var path = FolderPath(folder);

        var (socket, obex) = await OpenMapAsync();
        using (socket)
        using (obex)
        {
            await GoToFolderAsync(obex, path);
            var (last, body, appParams) = await obex.GetAllAsync(new[]
            {
                ObexClient.TextHeader(ObexHdr.Name, ""),          // the folder we are already in
                ObexClient.AsciiHeader(ObexHdr.Type, TypeMessageListing),
                ObexClient.BytesHeader(ObexHdr.AppParameters, ObexAppParams.Build(
                    (MapMaxListCount, ObexAppParams.U16(max)),
                    (MapStartOffset, ObexAppParams.U16(0)),
                    (MapSubjectLength, ObexAppParams.U8(255)))),
            });
            if (!last.IsSuccess) throw new IOException("messages_" + last.CodeName());

            var total = -1;
            foreach (var raw in appParams)
            {
                var parsed = ObexAppParams.Parse(raw);
                if (parsed.TryGetValue(MapListingSize, out var size)) total = ObexAppParams.AsU16(size);
            }
            try { await obex.DisconnectAsync(); } catch { /* closing is best effort */ }
            return (Encoding.UTF8.GetString(body), total);
        }
    }

    private static async Task<string> GetMessageAsync(string folder, string handle)
    {
        var path = FolderPath(folder.Length == 0 ? "inbox" : folder);
        var (socket, obex) = await OpenMapAsync();
        using (socket)
        using (obex)
        {
            await GoToFolderAsync(obex, path);
            var (last, body, _) = await obex.GetAllAsync(new[]
            {
                ObexClient.TextHeader(ObexHdr.Name, handle),
                ObexClient.AsciiHeader(ObexHdr.Type, TypeMessage),
                ObexClient.BytesHeader(ObexHdr.AppParameters, ObexAppParams.Build(
                    (MapAttachment, ObexAppParams.U8(0)),
                    (MapCharset, ObexAppParams.U8(1)))),      // 1 = UTF-8
            });
            if (!last.IsSuccess) throw new IOException("messages_" + last.CodeName());
            try { await obex.DisconnectAsync(); } catch { /* closing is best effort */ }
            return Encoding.UTF8.GetString(body);
        }
    }

    // Sending is a PUT of a bMessage into the outbox. CRLF throughout is not a
    // style choice: LENGTH counts the bytes of the MSG block, and a lone LF
    // makes the phone reject the whole push.
    private static string BuildBMessage(string number, string text)
    {
        var msgBlock = "BEGIN:MSG\r\n" + text + "\r\nEND:MSG\r\n";
        var length = Encoding.UTF8.GetByteCount(msgBlock);
        var sb = new StringBuilder();
        sb.Append("BEGIN:BMSG\r\nVERSION:1.0\r\nSTATUS:UNREAD\r\nTYPE:SMS_GSM\r\n");
        sb.Append("FOLDER:telecom/msg/outbox\r\n");
        sb.Append("BEGIN:BENV\r\n");
        sb.Append("BEGIN:VCARD\r\nVERSION:2.1\r\nN:\r\nTEL:").Append(number).Append("\r\nEND:VCARD\r\n");
        sb.Append("BEGIN:BBODY\r\nCHARSET:UTF-8\r\nLENGTH:").Append(length).Append("\r\n");
        sb.Append(msgBlock);
        sb.Append("END:BBODY\r\nEND:BENV\r\nEND:BMSG\r\n");
        return sb.ToString();
    }

    private static async Task SendMessageAsync(string number, string text)
    {
        var (socket, obex) = await OpenMapAsync();
        using (socket)
        using (obex)
        {
            await GoToFolderAsync(obex, FolderPath("outbox"));
            var resp = await obex.PutAsync(new[]
            {
                ObexClient.TextHeader(ObexHdr.Name, ""),
                ObexClient.AsciiHeader(ObexHdr.Type, TypeMessage),
                ObexClient.BytesHeader(ObexHdr.AppParameters, ObexAppParams.Build(
                    (MapCharset, ObexAppParams.U8(1)),
                    (MapTransparent, ObexAppParams.U8(0)),
                    (MapRetry, ObexAppParams.U8(1)))),
            }, Encoding.UTF8.GetBytes(BuildBMessage(number, text)));
            if (!resp.IsSuccess) throw new IOException("messages_" + resp.CodeName());
            try { await obex.DisconnectAsync(); } catch { /* closing is best effort */ }
        }
    }

    private static bool IsHex(string s)
    {
        foreach (var c in s) if (!Uri.IsHexDigit(c)) return false;
        return true;
    }
}
