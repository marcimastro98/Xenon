// Screen mirror: which monitors there are, picking one, and setting its resolution.

using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace XenonHelper;

internal static partial class ScreenHost
{
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
}
