using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace XenonHelper;

// GDI screen-capture host for the Second-screen feature. Captures one monitor —
// normally the virtual display created by the VDD — and streams JPEG frames on
// stdout for the server to relay to the dashboard tile over loopback.
//
// Why GDI (System.Drawing) and not Windows.Graphics.Capture for v1: GDI
// CopyFromScreen needs zero D3D/Media-Foundation interop, reuses the
// System.Drawing.Common reference already in this project, and is trivially
// trim-safe. It composites ordinary DWM windows fine (the second-screen use case
// is dragging normal apps onto the extra desktop); hardware-overlay/DRM surfaces
// can come back black — the documented v1 limitation. A WGC upgrade (already
// de-risked by the spike) can replace just the Capture() call later without
// touching this stdio protocol.
//
// Protocol (one message per line):
//   stdin : {"id":N,"action":"start","monitor":"virtual","fps":15,"maxWidth":1280,"maxHeight":720,"quality":55}
//           {"id":N,"action":"stop"}
//           {"id":N,"action":"list"}
//   stdout: control/ack -> "XSCTL " + base64( UTF8( {"id":N,"ok":bool,"out":"<json>","err":"..."} ) )
//           video frame  -> "XSFRM <w> <h> <seq> " + base64(jpeg)
// On stdin EOF the loop ends and the process exits cleanly (parent gone), exactly
// like the media/foreground hosts.
internal static partial class ScreenHost
{
    private static readonly object OutLock = new();
    private static TextWriter _out = Console.Out;

    // Active capture state (only ever one capture at a time).
    private static readonly object CaptureLock = new();
    private static CaptureLoop? _active;

    public static int Run()
    {
        // Become Per-Monitor-V2 DPI aware before any monitor/capture/input call. The
        // whole feature works in physical pixels then: EnumDisplayMonitors rects,
        // GetCursorInfo, the captured bitmap, and the SendInput ABSOLUTE|VIRTUALDESK
        // 0..65535 mapping all agree. Without this, on a mixed-DPI multi-monitor setup
        // the scaled metrics don't match the physical virtual desktop SendInput targets,
        // so clicks land on the wrong monitor and the composited cursor is misplaced.
        try { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); } catch { /* pre-1703 OS: best effort */ }

        // Own stdout writer so high-rate frame lines and rare control acks share
        // one handle under OutLock and can never interleave.
        var stream = Console.OpenStandardOutput();
        _out = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = false };

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
                // Input is fire-and-forget and high-rate (mouse moves): handle it
                // without an ack so stdout isn't flooded with useless control frames.
                if (action == "input") { HandleInput(root); continue; }
                var result = Handle(action, root);
                WriteControl(new Dictionary<string, object?>
                {
                    ["id"] = id,
                    ["ok"] = true,
                    ["out"] = JsonOut.Serialize(result),
                    ["err"] = "",
                });
            }
            catch (Exception ex)
            {
                WriteControl(new Dictionary<string, object?>
                {
                    ["id"] = id,
                    ["ok"] = false,
                    ["out"] = "",
                    ["err"] = ex.Message,
                });
            }
        }

        StopActive();
        return 0; // stdin closed: parent gone, exit cleanly
    }

    private static Dictionary<string, object?> Handle(string action, JsonElement root)
    {
        switch (action)
        {
            case "list":
                return new Dictionary<string, object?>
                {
                    ["monitors"] = EnumerateMonitors().Select(MonitorSummary).Cast<object?>().ToList(),
                };

            case "start":
            {
                var target = ReadString(root, "monitor");
                var fps = Clamp(ReadInt(root, "fps", 15), 1, 60);
                var maxW = Clamp(ReadInt(root, "maxWidth", 1280), 160, 3840);
                var maxH = Clamp(ReadInt(root, "maxHeight", 720), 120, 2160);
                var quality = Clamp(ReadInt(root, "quality", 55), 10, 95);

                var mon = ResolveMonitor(target);
                if (mon == null)
                    return new Dictionary<string, object?> { ["started"] = false, ["reason"] = "monitor_not_found" };

                StopActive();
                var loop = new CaptureLoop(mon, fps, maxW, maxH, quality);
                lock (CaptureLock) { _active = loop; }
                loop.Start();
                return new Dictionary<string, object?>
                {
                    ["started"] = true,
                    ["device"] = mon.Device,
                    ["width"] = mon.Width,
                    ["height"] = mon.Height,
                };
            }

            case "stop":
                StopActive();
                return new Dictionary<string, object?> { ["stopped"] = true };

            case "setmode":
            {
                var target = ReadString(root, "monitor");
                var w = ReadInt(root, "width", 0);
                var h = ReadInt(root, "height", 0);
                var refresh = ReadInt(root, "refresh", 0);
                return SetMode(string.IsNullOrWhiteSpace(target) ? "virtual" : target, w, h, refresh);
            }

            default:
                return new Dictionary<string, object?> { ["error"] = "unknown_action" };
        }
    }

    private static void StopActive()
    {
        CaptureLoop? loop;
        lock (CaptureLock) { loop = _active; _active = null; }
        loop?.Stop();
    }

    // ── stdout framing ──────────────────────────────────────────────────────────

    private static void WriteControl(Dictionary<string, object?> obj)
    {
        var json = JsonOut.Serialize(obj);
        var b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
        lock (OutLock)
        {
            _out.Write("XSCTL ");
            _out.Write(b64);
            _out.Write('\n');
            _out.Flush();
        }
    }

    private static void WriteFrame(int w, int h, long seq, string b64Jpeg)
    {
        lock (OutLock)
        {
            _out.Write("XSFRM ");
            _out.Write(w);
            _out.Write(' ');
            _out.Write(h);
            _out.Write(' ');
            _out.Write(seq);
            _out.Write(' ');
            _out.Write(b64Jpeg);
            _out.Write('\n');
            _out.Flush();
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
        if (root.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var n))
            return n;
        return fallback;
    }

    private static double ReadDouble(JsonElement root, string name, double fallback)
    {
        if (root.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.Number && el.TryGetDouble(out var n))
            return n;
        return fallback;
    }

    // Per-Monitor-V2 DPI awareness so all coordinates are physical pixels (see Run()).
    private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = (IntPtr)(-4);
}
