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
internal static partial class PhoneHost
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
}
