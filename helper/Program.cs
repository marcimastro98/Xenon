using System.Text;
using System.Text.Json;

namespace XenonHelper;

// Entry point + the stdio protocols shared with the PowerShell processes the
// helper replaces.
//
// Modes (one per process):
//   media-serve            — SMTC media host (protocol of media.ps1 -Serve)
//   foreground-serve [ms]  — foreground/fullscreen probe (protocol of foreground.ps1)
//   windows <verb> [hwnd]  — one-shot app-switcher tool (protocol of windows.ps1)
//   screen-serve           — GDI capture host for the Second-screen tile (ScreenHost)
//   notifications-serve [ms] — Windows notification mirror (NotificationHost)
//   audio-serve [ms]       — per-app audio peak meters (AudioHost)
//
// media-serve protocol (one message per line, both directions):
//   stdin  : {"id":N,"action":"info","preferredSource":"..."}
//   stdout : "XEMED " + base64( UTF8( {"id":N,"ok":bool,"out":"<json>","err":"..."} ) )
// Base64-framing keeps any payload (newlines, braces) from breaking the line
// protocol. On stdin EOF the loop ends and the process exits cleanly — that
// clean exit is how the WinRT/SMTC broker handles must be released (never
// hard-kill the media host first). It may also push unsolicited frames with
// no "id":  {"event":"media-changed"}  when the OS reports a track/playback
// change — the server uses it to refresh instantly instead of waiting for the
// next poll tick. Pure bonus: a server that ignores them keeps working.
//
// foreground-serve emits the same bare JSON lines as foreground.ps1
// ({"fullscreen":bool,"process":"name","pid":N}), one per interval — plus an
// immediate extra line whenever the OS reports a foreground change, so game
// mode reacts instantly instead of on the next 2s tick.
internal static class Program
{
    private static readonly object OutLock = new();

    private static async Task<int> Main(string[] args)
    {
        var mode = args.Length > 0 ? args[0].ToLowerInvariant() : "";
        Console.OutputEncoding = new UTF8Encoding(false);
        switch (mode)
        {
            case "media-serve":
                return await MediaServeAsync();
            case "foreground-serve":
                var intervalMs = 2000;
                if (args.Length > 1 && int.TryParse(args[1], out var parsed) && parsed >= 250) intervalMs = parsed;
                return ForegroundHost.Run(intervalMs);
            case "windows":
                return WindowsTool.Run(args);
            case "screen-serve":
                return ScreenHost.Run();
            case "notifications-serve":
                var notifMs = 2000;
                if (args.Length > 1 && int.TryParse(args[1], out var notifParsed) && notifParsed >= 500) notifMs = notifParsed;
                return await NotificationHost.RunAsync(notifMs);
            case "audio-serve":
                var audioMs = 80;
                if (args.Length > 1 && int.TryParse(args[1], out var audioParsed) && audioParsed >= 40) audioMs = audioParsed;
                return AudioHost.Run(audioMs);
            default:
                Console.Error.WriteLine("usage: xenon-helper media-serve | foreground-serve [intervalMs] | windows list|focus|close [hwnd] | screen-serve | notifications-serve [intervalMs] | audio-serve [intervalMs]");
                return 2;
        }
    }

    // ── Media host ────────────────────────────────────────────────────────────

    private static async Task<int> MediaServeAsync()
    {
        var media = new MediaHost(() => WriteFrame(new Dictionary<string, object?> { ["event"] = "media-changed" }));

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
                var action = ReadString(root, "action");
                var preferredSource = ReadString(root, "preferredSource");
                // SMTC misbehaves when called from this (console main) thread:
                // with the manager already cached, a synchronous call from here
                // returns zero sessions. Threadpool threads work reliably, so
                // every request is pushed onto one.
                var result = await Task.Run(() => media.HandleRequestAsync(action, preferredSource));
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
                    ["err"] = ex.Message,
                });
            }
        }

        return 0; // stdin closed: parent gone, exit cleanly
    }

    private static void WriteFrame(Dictionary<string, object?> obj)
    {
        var json = JsonOut.Serialize(obj);
        var b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
        // Event frames arrive from WinRT callback threads while responses come
        // from the main loop: serialize writes so frames never interleave.
        lock (OutLock)
        {
            Console.Out.WriteLine("XEMED " + b64);
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
}
