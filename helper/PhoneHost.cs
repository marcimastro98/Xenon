using System.Text;
using System.Text.Json;
using Windows.ApplicationModel.Calls;
using Windows.Devices.Bluetooth.Rfcomm;
using Windows.Devices.Enumeration;
using Windows.Networking.Sockets;
using Windows.Storage.Streams;

namespace XenonHelper;

// ─────────────────────────────────────────────────────────────────────────────
// The paired phone, as far as Windows will let us reach it.
//
// Mode: phone-serve
//
// Two independent sources, deliberately kept apart because they fail
// independently and the dashboard has to be able to say which one is missing:
//
//   PBAP over RFCOMM (this file's transport + Obex.cs)
//     The phonebook and the call history. The phone is an OBEX server handing
//     out vCards, which is why the SAME code works against an iPhone and an
//     Android — it is what a car does. A session is opened per pull and closed
//     immediately: the channel is contended (Phone Link takes it too), so
//     holding it open would be taking something from the user's other software
//     for the 99% of the time we are not reading.
//
//   Windows' own telephony API (PhoneCallManager / PhoneLine)
//     Whether a call is ringing right now, and placing one. This exists because
//     the HFP channel that would otherwise carry both is owned by the system
//     driver: `RfcommDeviceService.FromIdAsync` returns null for 0x111F on a
//     paired phone (measured). Windows already speaks HFP to the phone, and
//     these two APIs are the parts of that it hands back.
//
// What is NOT here, and must not be quietly faked: ANSWERING a call, and
// hanging one up. Neither the RFCOMM channel nor the public API offers it on
// Windows. `status` reports `canAnswer:false` so the dashboard hides the button
// instead of offering one that does nothing.
//
// vCard PARSING is deliberately absent. The raw text goes to the server, which
// parses it in a pure module with fixture tests — the same split the platform
// collectors use, and the reason any of this is testable at all.
//
// Protocol: stdin one JSON per line {id, op, ...}; stdout "XEPHN " + base64 of
//   {id, ok, out, err}, plus unsolicited {"event":"callstate", ...}.
//     status   {}                  → {pbap, map, telephony, canDial, canAnswer, line, incoming, active}
//     contacts {max}               → {vcf, total}
//     calls    {book, max}         → {vcf, total}     book: cch|ich|och|mch
//     messages {folder, max}       → {xml, total}     folder: inbox|sent|outbox
//     message  {folder, handle}    → {bmsg}
//     send     {number, text}      → {ok}
//     dial     {number}            → {ok}
// ─────────────────────────────────────────────────────────────────────────────
internal static class PhoneHost
{
    private const string Frame = "XEPHN ";
    private static readonly object OutLock = new();

    // Phonebook Access Server, and the OBEX Target every PBAP session must
    // present or the phone refuses the CONNECT outright.
    private static readonly Guid PbapService = new("0000112F-0000-1000-8000-00805F9B34FB");
    private static readonly byte[] PbapTarget =
    {
        0x79, 0x61, 0x35, 0xF0, 0xF0, 0xC5, 0x11, 0xD8,
        0x09, 0x66, 0x08, 0x00, 0x20, 0x0C, 0x9A, 0x66,
    };

    // Message Access Server, and its own OBEX Target. Separate from the
    // phonebook in every way that matters: a different service, a different
    // session, and a different app-parameter numbering (MaxListCount is 0x04
    // for the phonebook and 0x01 here, which is the single easiest thing to get
    // wrong in this file).
    private static readonly Guid MapService = new("00001132-0000-1000-8000-00805F9B34FB");
    private static readonly byte[] MapTarget =
    {
        0xBB, 0x58, 0x2B, 0x40, 0x42, 0x0C, 0x11, 0xDB,
        0xB0, 0xDE, 0x08, 0x00, 0x20, 0x0C, 0x9A, 0x66,
    };

    private const string TypeMessageListing = "x-bt/MAP-msg-listing";
    private const string TypeMessage = "x-bt/message";
    private const byte MapMaxListCount = 0x01;
    private const byte MapStartOffset = 0x02;
    private const byte MapAttachment = 0x0A;
    private const byte MapTransparent = 0x0B;
    private const byte MapRetry = 0x0C;
    private const byte MapListingSize = 0x12;
    private const byte MapSubjectLength = 0x13;
    private const byte MapCharset = 0x14;

    // What a single-packet PUT can carry once the bMessage envelope is around
    // it. Longer than any SMS, short enough that the message never needs
    // splitting across OBEX continuations.
    private const int MaxMessageChars = 1000;

    private const string TypePhonebook = "x-bt/phonebook";
    private const byte TagMaxListCount = 0x04;
    private const byte TagListStartOffset = 0x05;
    private const byte TagFilter = 0x06;
    private const byte TagFormat = 0x07;
    private const byte TagPhonebookSize = 0x08;

    // The five objects a phone publishes. Direction is not a field on an entry:
    // it is which book the entry came out of, which is how "ricevuta /
    // effettuata / persa" is built without the phone ever saying so.
    private static readonly Dictionary<string, string> Books = new(StringComparer.OrdinalIgnoreCase)
    {
        ["pb"] = "telecom/pb.vcf",
        ["cch"] = "telecom/cch.vcf",
        ["ich"] = "telecom/ich.vcf",
        ["och"] = "telecom/och.vcf",
        ["mch"] = "telecom/mch.vcf",
    };

    private static bool _lastIncoming;
    private static bool _lastActive;

    public static async Task<int> RunAsync()
    {
        // Call state is pushed, never polled: the OS raises the event and the
        // booleans are read from it. A change-detected push keeps a card that is
        // already correct from being re-rendered on every unrelated state churn.
        EventHandler<object>? onCallState = null;
        try
        {
            _lastIncoming = PhoneCallManager.IsCallIncoming;
            _lastActive = PhoneCallManager.IsCallActive;
            onCallState = (_, _) => PushCallStateIfChanged();
            PhoneCallManager.CallStateChanged += onCallState;
        }
        catch
        {
            // No telephony on this machine. Everything else still works, and
            // `status` will report it rather than pretending.
            onCallState = null;
        }

        PushCallState();

        string? line;
        while ((line = Console.In.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;

            object? id = null;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                id = ReadId(root);
                var op = ReadString(root, "op");
                var result = await HandleAsync(op, root);
                WriteFrame(new Dictionary<string, object?>
                {
                    ["id"] = id,
                    ["ok"] = true,
                    ["out"] = JsonOut.Serialize(result),
                    ["err"] = "",
                });
            }
            catch (Exception ex)
            {
                WriteFrame(new Dictionary<string, object?>
                {
                    ["id"] = id,
                    ["ok"] = false,
                    ["out"] = "",
                    ["err"] = Describe(ex),
                });
            }
        }

        if (onCallState != null)
        {
            try { PhoneCallManager.CallStateChanged -= onCallState; } catch { }
        }
        return 0; // stdin closed: the parent is gone, exit cleanly
    }

    private static async Task<Dictionary<string, object?>> HandleAsync(string op, JsonElement root)
    {
        switch (op)
        {
            case "status":
                return await StatusAsync();

            case "contacts":
            {
                var (vcf, total) = await PullAsync("pb", ReadInt(root, "max", 1000));
                return new Dictionary<string, object?> { ["vcf"] = vcf, ["total"] = total };
            }

            case "calls":
            {
                var book = ReadString(root, "book");
                if (book.Length == 0) book = "cch";
                var (vcf, total) = await PullAsync(book, ReadInt(root, "max", 60));
                return new Dictionary<string, object?> { ["vcf"] = vcf, ["total"] = total, ["book"] = book };
            }

            case "messages":
            {
                var folder = ReadString(root, "folder");
                if (folder.Length == 0) folder = "inbox";
                var (xml, total) = await MessageListingAsync(folder, ReadInt(root, "max", 40));
                return new Dictionary<string, object?> { ["xml"] = xml, ["total"] = total, ["folder"] = folder };
            }

            case "message":
            {
                var handle = ReadString(root, "handle");
                // The handle came from a listing THIS host produced; re-assert
                // its shape anyway, because it is the one value from the wire
                // that becomes part of a request to the phone.
                if (handle.Length == 0 || handle.Length > 32 || !IsHex(handle)) throw new ArgumentException("bad_handle");
                var body = await GetMessageAsync(ReadString(root, "folder"), handle);
                return new Dictionary<string, object?> { ["bmsg"] = body };
            }

            case "send":
            {
                var number = ReadString(root, "number");
                var text = ReadString(root, "text");
                if (number.Length == 0) throw new ArgumentException("number_required");
                if (text.Length == 0) throw new ArgumentException("text_required");
                if (text.Length > MaxMessageChars) throw new ArgumentException("message_too_long");
                await SendMessageAsync(number, text);
                return new Dictionary<string, object?> { ["ok"] = true };
            }

            case "dial":
            {
                var number = ReadString(root, "number");
                if (number.Length == 0) throw new ArgumentException("number_required");
                await DialAsync(number);
                return new Dictionary<string, object?> { ["ok"] = true };
            }

            default:
                throw new ArgumentException("unknown_op");
        }
    }

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

    // ── Plumbing ────────────────────────────────────────────────────────────

    // The channel OBEX rides on. WinRT resolves the RFCOMM channel number out of
    // the peer's SDP record, which is the tedious part of talking to an
    // arbitrary Bluetooth service by hand.
    private sealed class SocketChannel : IByteChannel
    {
        private readonly StreamSocket _socket;
        private readonly DataReader _reader;
        private readonly DataWriter _writer;

        public SocketChannel(StreamSocket socket)
        {
            _socket = socket;
            _reader = new DataReader(socket.InputStream)
            {
                // Partial: hand back whatever has arrived. The default waits for
                // the FULL requested count, which deadlocks a reader that asks
                // for more than the next packet happens to carry.
                InputStreamOptions = InputStreamOptions.Partial,
            };
            _writer = new DataWriter(socket.OutputStream);
        }

        public async Task WriteAsync(byte[] data, CancellationToken ct = default)
        {
            _writer.WriteBytes(data);
            await _writer.StoreAsync().AsTask(ct);
            await _writer.FlushAsync().AsTask(ct);
        }

        public async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct = default)
        {
            if (_reader.UnconsumedBufferLength == 0)
            {
                var loaded = await _reader.LoadAsync((uint)count).AsTask(ct);
                if (loaded == 0) return 0;
            }
            var take = (int)Math.Min(_reader.UnconsumedBufferLength, (uint)count);
            var tmp = new byte[take];
            _reader.ReadBytes(tmp);
            Array.Copy(tmp, 0, buffer, offset, take);
            return take;
        }

        public void Dispose()
        {
            try { _reader.Dispose(); } catch { }
            try { _writer.Dispose(); } catch { }
            // The socket is owned by the caller's `using`, not by this wrapper.
        }
    }

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
