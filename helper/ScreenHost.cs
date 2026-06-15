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
internal static class ScreenHost
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

    // Commit a display mode (resolution) on the target monitor — normally the VDD.
    // A freshly created virtual monitor advertises its configured modes but Windows
    // often leaves the *active* mode at a stale 800x600 default until a mode is
    // explicitly committed; this is what makes the chosen resolution actually stick
    // (no reboot, no elevation — a per-user display setting). We pick an advertised
    // mode matching width×height (preferring the requested refresh) and apply it.
    private static Dictionary<string, object?> SetMode(string target, int width, int height, int refresh)
    {
        if (width <= 0 || height <= 0)
            return new Dictionary<string, object?> { ["ok"] = false, ["code"] = "bad_args" };

        var mon = ResolveMonitor(target);
        if (mon == null)
            return new Dictionary<string, object?> { ["ok"] = false, ["code"] = "monitor_not_found" };

        DEVMODE best = default;
        var found = false;
        var dm = new DEVMODE { dmSize = (short)Marshal.SizeOf<DEVMODE>() };
        for (var i = 0; EnumDisplaySettings(mon.Device, i, ref dm) != 0; i++)
        {
            if (dm.dmPelsWidth == width && dm.dmPelsHeight == height)
            {
                best = dm; found = true;
                if (refresh <= 0 || dm.dmDisplayFrequency == refresh) break;
            }
            dm.dmSize = (short)Marshal.SizeOf<DEVMODE>();
        }
        if (!found)
            return new Dictionary<string, object?>
            {
                ["ok"] = false, ["code"] = "mode_not_available", ["width"] = width, ["height"] = height,
            };

        best.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY | DM_BITSPERPEL;
        var ret = ChangeDisplaySettingsEx(mon.Device, ref best, IntPtr.Zero, CDS_UPDATEREGISTRY, IntPtr.Zero);
        var ok = ret == DISP_CHANGE_SUCCESSFUL || ret == DISP_CHANGE_RESTART;
        return new Dictionary<string, object?>
        {
            ["ok"] = ok,
            ["code"] = ok ? "mode_applied" : "change_failed",
            ["ret"] = ret,
            ["device"] = mon.Device,
            ["width"] = best.dmPelsWidth,
            ["height"] = best.dmPelsHeight,
        };
    }

    // ── Monitor selection ──────────────────────────────────────────────────────

    private sealed class MonitorInfo
    {
        public string Device = "";   // GDI name, e.g. \\.\DISPLAY10
        public string Adapter = "";  // GPU/adapter description
        public string Monitor = "";  // monitor model description
        public int X, Y, Width, Height;
        public bool Primary;
        public bool IsVirtual;
    }

    private static Dictionary<string, object?> MonitorSummary(MonitorInfo m) => new()
    {
        ["device"] = m.Device,
        ["adapter"] = m.Adapter,
        ["monitor"] = m.Monitor,
        ["x"] = m.X,
        ["y"] = m.Y,
        ["width"] = m.Width,
        ["height"] = m.Height,
        ["primary"] = m.Primary,
        ["virtual"] = m.IsVirtual,
    };

    // "virtual" → first VDD-backed monitor; an explicit \\.\DISPLAYn → that exact
    // device; "primary"/empty → the primary monitor (diagnostic fallback).
    private static MonitorInfo? ResolveMonitor(string target)
    {
        var monitors = EnumerateMonitors();
        if (monitors.Count == 0) return null;

        if (string.IsNullOrWhiteSpace(target) || target.Equals("primary", StringComparison.OrdinalIgnoreCase))
            return monitors.FirstOrDefault(m => m.Primary) ?? monitors[0];

        if (target.Equals("virtual", StringComparison.OrdinalIgnoreCase))
            return monitors.FirstOrDefault(m => m.IsVirtual);

        return monitors.FirstOrDefault(m => m.Device.Equals(target, StringComparison.OrdinalIgnoreCase));
    }

    private static List<MonitorInfo> EnumerateMonitors()
    {
        // adapter (GPU) description per GDI device name, so we can flag VDD-backed
        // displays without correlating PnP ids.
        var adapters = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var dd = new DISPLAY_DEVICE { cb = Marshal.SizeOf<DISPLAY_DEVICE>() };
        for (uint i = 0; EnumDisplayDevices(null, i, ref dd, 0); i++)
        {
            adapters[dd.DeviceName] = dd.DeviceString;
            dd.cb = Marshal.SizeOf<DISPLAY_DEVICE>();
        }

        var list = new List<MonitorInfo>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr hMon, IntPtr _, ref RECT __, IntPtr ___) =>
        {
            var mi = new MONITORINFOEX { cbSize = Marshal.SizeOf<MONITORINFOEX>() };
            if (GetMonitorInfo(hMon, ref mi))
            {
                var device = mi.szDevice ?? "";
                adapters.TryGetValue(device, out var adapter);
                adapter ??= "";

                // Monitor model (child of the adapter) — extra signal for the VDD.
                var monitorName = "";
                var md = new DISPLAY_DEVICE { cb = Marshal.SizeOf<DISPLAY_DEVICE>() };
                if (EnumDisplayDevices(device, 0, ref md, 0)) monitorName = md.DeviceString ?? "";

                var isVirtual =
                    adapter.Contains("virtual", StringComparison.OrdinalIgnoreCase) && adapter.Contains("display", StringComparison.OrdinalIgnoreCase) ||
                    adapter.Contains("MttVDD", StringComparison.OrdinalIgnoreCase) ||
                    adapter.Contains("IddSample", StringComparison.OrdinalIgnoreCase) ||
                    monitorName.Contains("virtual", StringComparison.OrdinalIgnoreCase) && monitorName.Contains("display", StringComparison.OrdinalIgnoreCase);

                list.Add(new MonitorInfo
                {
                    Device = device,
                    Adapter = adapter,
                    Monitor = monitorName,
                    X = mi.rcMonitor.left,
                    Y = mi.rcMonitor.top,
                    Width = mi.rcMonitor.right - mi.rcMonitor.left,
                    Height = mi.rcMonitor.bottom - mi.rcMonitor.top,
                    Primary = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0,
                    IsVirtual = isVirtual,
                });
            }
            return true;
        }, IntPtr.Zero);

        return list;
    }

    // ── Capture loop ────────────────────────────────────────────────────────────

    private sealed class CaptureLoop
    {
        private readonly MonitorInfo _mon;
        private readonly int _fps;
        private readonly int _maxW, _maxH, _quality;
        private readonly CancellationTokenSource _cts = new();
        private Thread? _thread;
        private long _seq;
        private ulong _lastHash;
        private long _lastEmitTicks;

        private static readonly ImageCodecInfo JpegCodec =
            ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);

        public CaptureLoop(MonitorInfo mon, int fps, int maxW, int maxH, int quality)
        {
            _mon = mon; _fps = fps; _maxW = maxW; _maxH = maxH; _quality = quality;
        }

        // The captured monitor's geometry — used to map tile-relative input
        // coordinates back onto the virtual desktop for SendInput.
        public MonitorInfo Target => _mon;

        public void Start()
        {
            _thread = new Thread(Loop) { IsBackground = true, Name = "screen-capture" };
            _thread.Start();
        }

        public void Stop()
        {
            try { _cts.Cancel(); } catch { }
            try { _thread?.Join(1000); } catch { }
            _cts.Dispose();
        }

        private void Loop()
        {
            var frameMs = Math.Max(1, 1000 / _fps);
            const int keepaliveMs = 1000; // re-send a static frame at most ~1/s
            using var encParams = new EncoderParameters(1);
            encParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)_quality);

            while (!_cts.IsCancellationRequested)
            {
                var started = Environment.TickCount64;
                try
                {
                    using var shot = Capture();
                    // Hash the captured pixels BEFORE scaling/encoding so a static
                    // screen costs almost nothing (the encode is the expensive part).
                    var hash = FastHash(shot);
                    var now = Environment.TickCount64;
                    var changed = hash != _lastHash;
                    if (changed || now - _lastEmitTicks >= keepaliveMs)
                    {
                        using var outBmp = Scale(shot, _maxW, _maxH);
                        EmitFrame(outBmp, encParams);
                        _lastHash = hash;
                        _lastEmitTicks = now;
                    }
                }
                catch { /* transient capture failure: skip this frame */ }

                var elapsed = (int)(Environment.TickCount64 - started);
                var wait = frameMs - elapsed;
                if (wait > 0 && _cts.Token.WaitHandle.WaitOne(wait)) break;
            }
        }

        private Bitmap Capture()
        {
            var bmp = new Bitmap(_mon.Width, _mon.Height, PixelFormat.Format32bppArgb);
            try
            {
                using var g = Graphics.FromImage(bmp);
                g.CopyFromScreen(_mon.X, _mon.Y, 0, 0, new Size(_mon.Width, _mon.Height), CopyPixelOperation.SourceCopy);
                DrawCursor(g);
            }
            catch { bmp.Dispose(); throw; }
            return bmp;
        }

        // BitBlt never captures the mouse pointer, and a virtual display draws its
        // cursor as a hardware overlay (outside the framebuffer), so the captured
        // frame has no cursor at all — the user can't see where they're pointing.
        // Composite it ourselves: read the live cursor, offset it into this monitor's
        // space (the same process-DPI space CopyFromScreen and SendInput use, so it
        // lands exactly where input goes) and draw it onto the frame.
        private void DrawCursor(Graphics g)
        {
            var ci = new CURSORINFO { cbSize = Marshal.SizeOf<CURSORINFO>() };
            // Draw whenever a cursor exists — CURSOR_SHOWING (0x1) OR CURSOR_SUPPRESSED
            // (0x2). On a touchscreen Windows *suppresses* the cursor visual after touch
            // input, but the logical pointer still moves and clicks land; the remote view
            // must show it anyway so the user can see where they're pointing. Skip only
            // when genuinely hidden (flags 0) or there's no cursor handle.
            if (!GetCursorInfo(ref ci) || ci.hCursor == IntPtr.Zero || ci.flags == 0) return;
            // Skip all the per-frame GDI icon work when the pointer isn't over this
            // monitor (the common case while the user isn't pointing here): no bitmap
            // churn, and a static screen keeps hashing identical so it isn't re-encoded.
            if (ci.ptScreenPos.x < _mon.X || ci.ptScreenPos.x >= _mon.X + _mon.Width ||
                ci.ptScreenPos.y < _mon.Y || ci.ptScreenPos.y >= _mon.Y + _mon.Height) return;
            if (!GetIconInfo(ci.hCursor, out var ii)) return;
            try
            {
                var x = ci.ptScreenPos.x - _mon.X - ii.xHotspot;
                var y = ci.ptScreenPos.y - _mon.Y - ii.yHotspot;
                var hdc = g.GetHdc();
                try { DrawIconEx(hdc, x, y, ci.hCursor, 0, 0, 0, IntPtr.Zero, DI_NORMAL); }
                finally { g.ReleaseHdc(hdc); }
            }
            finally
            {
                if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
                if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
            }
        }

        private static Bitmap Scale(Bitmap src, int maxW, int maxH)
        {
            if (src.Width <= maxW && src.Height <= maxH) return (Bitmap)src.Clone();
            var ratio = Math.Min((double)maxW / src.Width, (double)maxH / src.Height);
            var w = Math.Max(1, (int)Math.Round(src.Width * ratio));
            var h = Math.Max(1, (int)Math.Round(src.Height * ratio));
            var dst = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            try
            {
                using var g = Graphics.FromImage(dst);
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
                g.DrawImage(src, 0, 0, w, h);
            }
            catch { dst.Dispose(); throw; }
            return dst;
        }

        private void EmitFrame(Bitmap bmp, EncoderParameters encParams)
        {
            using var ms = new MemoryStream();
            bmp.Save(ms, JpegCodec, encParams);
            var b64 = Convert.ToBase64String(ms.GetBuffer(), 0, (int)ms.Length);
            var seq = ++_seq;
            WriteFrame(bmp.Width, bmp.Height, seq, b64);
        }

        // FNV-1a over a strided sample of the 32bpp pixel buffer — cheap change
        // detection that avoids re-encoding a static screen every tick.
        private static ulong FastHash(Bitmap bmp)
        {
            var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
            var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                ulong hash = 14695981039346656037UL;
                var total = data.Stride * data.Height;
                const int step = 257 * 4; // prime-ish stride, stays 4-byte aligned
                unsafe
                {
                    var p = (byte*)data.Scan0;
                    for (var i = 0; i < total; i += step)
                    {
                        hash ^= p[i];
                        hash *= 1099511628211UL;
                    }
                }
                // Mix in dimensions so a resize never collides with a static frame.
                hash ^= (ulong)((bmp.Width << 16) ^ bmp.Height);
                return hash;
            }
            finally { bmp.UnlockBits(data); }
        }
    }

    private static int Clamp(int v, int lo, int hi) => v < lo ? lo : v > hi ? hi : v;

    // ── Input injection (SendInput onto the virtual desktop) ────────────────────
    //
    // The tile sends fractional coordinates (0..1 across the displayed frame); we
    // map them onto the captured monitor's pixel rect, then normalize to the whole
    // virtual desktop (0..65535) for MOUSEEVENTF_ABSOLUTE|VIRTUALDESK. Everything
    // stays in the same (process-DPI) coordinate space the capture uses, so clicks
    // land where they appear. Never throws — a bad event is dropped silently.
    private static void HandleInput(JsonElement root)
    {
        try
        {
            var kind = ReadString(root, "kind");
            if (kind == "key")
            {
                var subtype = ReadString(root, "subtype");
                if (subtype == "char")
                {
                    var cp = ReadInt(root, "cp", 0);
                    if (cp > 0 && cp <= 0xFFFF) { SendUnicode((ushort)cp, false); SendUnicode((ushort)cp, true); }
                    return;
                }
                var vk = ReadInt(root, "vk", 0);
                if (vk > 0) SendKey((ushort)vk, subtype == "up");
                return;
            }

            MonitorInfo? mon;
            lock (CaptureLock) { mon = _active?.Target; }
            if (mon == null) return;

            var fx = ReadDouble(root, "fx", 0);
            var fy = ReadDouble(root, "fy", 0);
            var (nx, ny) = ToVirtualDesktopNormalized(mon, fx, fy);

            if (kind == "wheel")
            {
                var delta = ReadInt(root, "delta", 0);
                SendMouse(MOUSEEVENTF_WHEEL | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE, nx, ny, unchecked((uint)delta));
                return;
            }
            if (kind == "mouse")
            {
                var subtype = ReadString(root, "subtype");
                var button = ReadString(root, "button");
                uint flags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE;
                if (subtype == "down") flags |= button == "right" ? MOUSEEVENTF_RIGHTDOWN : button == "middle" ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
                else if (subtype == "up") flags |= button == "right" ? MOUSEEVENTF_RIGHTUP : button == "middle" ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
                SendMouse(flags, nx, ny, 0);
            }
        }
        catch { /* drop the event */ }
    }

    private static (int nx, int ny) ToVirtualDesktopNormalized(MonitorInfo mon, double fx, double fy)
    {
        fx = fx < 0 ? 0 : fx > 1 ? 1 : fx;
        fy = fy < 0 ? 0 : fy > 1 ? 1 : fy;
        var mx = mon.X + fx * mon.Width;
        var my = mon.Y + fy * mon.Height;
        int vsX = GetSystemMetrics(SM_XVIRTUALSCREEN), vsY = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vsW = GetSystemMetrics(SM_CXVIRTUALSCREEN), vsH = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        int nx = (int)Math.Round((mx - vsX) * 65535.0 / Math.Max(1, vsW - 1));
        int ny = (int)Math.Round((my - vsY) * 65535.0 / Math.Max(1, vsH - 1));
        return (Clamp(nx, 0, 65535), Clamp(ny, 0, 65535));
    }

    private static void SendMouse(uint flags, int nx, int ny, uint mouseData)
    {
        var inp = new INPUT { type = INPUT_MOUSE };
        inp.U.mi = new MOUSEINPUT { dx = nx, dy = ny, mouseData = mouseData, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
        SendInput(1, new[] { inp }, Marshal.SizeOf<INPUT>());
    }

    private static void SendKey(ushort vk, bool up)
    {
        var inp = new INPUT { type = INPUT_KEYBOARD };
        inp.U.ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = up ? KEYEVENTF_KEYUP : 0, time = 0, dwExtraInfo = IntPtr.Zero };
        SendInput(1, new[] { inp }, Marshal.SizeOf<INPUT>());
    }

    private static void SendUnicode(ushort codepoint, bool up)
    {
        var inp = new INPUT { type = INPUT_KEYBOARD };
        inp.U.ki = new KEYBDINPUT { wVk = 0, wScan = codepoint, dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0u), time = 0, dwExtraInfo = IntPtr.Zero };
        SendInput(1, new[] { inp }, Marshal.SizeOf<INPUT>());
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

    // ── Win32 ─────────────────────────────────────────────────────────────────

    private const uint MONITORINFOF_PRIMARY = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int left, top, right, bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DISPLAY_DEVICE
    {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
        public int StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }

    private delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplayDevices(string? device, uint devNum, ref DISPLAY_DEVICE dd, uint flags);

    // SendInput plumbing for the second-screen control path.
    private const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
    private const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004,
        MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010, MOUSEEVENTF_MIDDLEDOWN = 0x0020,
        MOUSEEVENTF_MIDDLEUP = 0x0040, MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public InputUnion U; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    // Per-Monitor-V2 DPI awareness so all coordinates are physical pixels (see Run()).
    private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = (IntPtr)(-4);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    // Cursor compositing (the captured frame never contains the pointer).
    private const int CURSOR_SHOWING = 0x00000001;
    private const int DI_NORMAL = 0x0003;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x, y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }

    [DllImport("user32.dll")]
    private static extern bool GetCursorInfo(ref CURSORINFO pci);

    [DllImport("user32.dll")]
    private static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);

    [DllImport("user32.dll")]
    private static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int cx, int cy, int istepIfAniCur, IntPtr hbrFlickerFreeDraw, int diFlags);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);

    // Display-mode commit (second-screen resolution). dmFields bits + change flags.
    private const int DM_BITSPERPEL = 0x40000, DM_PELSWIDTH = 0x80000, DM_PELSHEIGHT = 0x100000, DM_DISPLAYFREQUENCY = 0x400000;
    private const uint CDS_UPDATEREGISTRY = 0x01;
    private const int DISP_CHANGE_SUCCESSFUL = 0, DISP_CHANGE_RESTART = 1;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
        public int dmFields;
        public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int ChangeDisplaySettingsEx(string deviceName, ref DEVMODE devMode, IntPtr hwnd, uint flags, IntPtr lParam);
}
