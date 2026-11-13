// Open windows: listing the windows a person would call open.

using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

internal static partial class WindowsTool
{
    // ── list ──────────────────────────────────────────────────────────────────

    private sealed class WindowInfo
    {
        public long Hwnd;
        public string Title = "";
        public int ProcessId;
        public string ProcessName = "App";
        public string Path = "";
        public int X, Y, Width, Height;
        public bool Minimized;
        public bool Active;
    }

    private static Dictionary<string, object?> ListPayload()
    {
        var items = new List<object?>();
        var windows = ListWindows();
        windows.Sort((a, b) =>
        {
            if (a.Active != b.Active) return a.Active ? -1 : 1;
            var byName = string.Compare(a.ProcessName, b.ProcessName, StringComparison.OrdinalIgnoreCase);
            return byName != 0 ? byName : string.Compare(a.Title, b.Title, StringComparison.OrdinalIgnoreCase);
        });
        foreach (var w in windows.Take(24))
        {
            string? preview = null, icon = null;
            try { preview = Capture(w.Hwnd, 240, 135); } catch { }
            try { icon = IconForPath(w.Path, 48); } catch { }
            // No exe icon (packaged/UWP app, or an exe whose icon can't be read):
            // fall back to the app's tile logo, resolved from the window's AUMID.
            if (icon == null) { try { icon = TileLogoForWindow(new IntPtr(w.Hwnd)); } catch { } }
            items.Add(new Dictionary<string, object?>
            {
                ["id"] = w.Hwnd.ToString(),
                ["title"] = w.Title,
                ["app"] = w.ProcessName,
                // Executable path — lets a favorite for a CLOSED app be re-launched
                // (the server re-validates it through the allowlisted openApp runner).
                ["path"] = w.Path,
                ["processId"] = w.ProcessId,
                ["active"] = w.Active,
                ["minimized"] = w.Minimized,
                ["bounds"] = new Dictionary<string, object?> { ["x"] = w.X, ["y"] = w.Y, ["width"] = w.Width, ["height"] = w.Height },
                ["preview"] = preview,
                ["icon"] = icon,
            });
        }
        return new Dictionary<string, object?> { ["windows"] = items };
    }

    private static List<WindowInfo> ListWindows()
    {
        var result = new List<WindowInfo>();
        var seen = new HashSet<long>();
        var shell = GetShellWindow();
        var foreground = GetForegroundWindow();

        EnumWindows((hWnd, _) =>
        {
            try
            {
                if (hWnd == IntPtr.Zero || hWnd == shell) return true;
                if (!IsWindowVisible(hWnd)) return true;
                if (IsJunkClass(hWnd)) return true;
                if (IsCloaked(hWnd)) return true;
                if (IsToolWindow(hWnd)) return true;

                var len = GetWindowTextLength(hWnd);
                if (len <= 0) return true;
                var sb = new StringBuilder(len + 1);
                GetWindowText(hWnd, sb, sb.Capacity);
                var title = sb.ToString().Trim();
                if (string.IsNullOrWhiteSpace(title) || title == "Program Manager") return true;

                if (!TryWindowRect(hWnd, out var rect)) return true;
                var minimized = IsIconic(hWnd);
                var width = Math.Max(0, rect.Right - rect.Left);
                var height = Math.Max(0, rect.Bottom - rect.Top);
                if (!minimized && (width < 90 || height < 60)) return true;

                var hwndValue = hWnd.ToInt64();
                if (!seen.Add(hwndValue)) return true;

                GetWindowThreadProcessId(hWnd, out var pid);
                var (name, path) = ProcessInfo((int)pid);
                result.Add(new WindowInfo
                {
                    Hwnd = hwndValue, Title = title, ProcessId = (int)pid,
                    ProcessName = name, Path = path,
                    X = rect.Left, Y = rect.Top, Width = width, Height = height,
                    Minimized = minimized, Active = hWnd == foreground,
                });
            }
            catch { }
            return true;
        }, IntPtr.Zero);

        // Second pass (same as the PS script): processes whose main window the
        // enumeration missed — typically minimized UWP frames.
        foreach (var process in Process.GetProcesses())
        {
            try
            {
                var hWnd = process.MainWindowHandle;
                if (hWnd == IntPtr.Zero || hWnd == shell) continue;
                var hwndValue = hWnd.ToInt64();
                if (seen.Contains(hwndValue)) continue;

                var minimized = IsIconic(hWnd);
                if (!IsWindowVisible(hWnd) && !minimized) continue;
                if (IsJunkClass(hWnd)) continue;
                if (!minimized && IsCloaked(hWnd)) continue;
                if (IsToolWindow(hWnd)) continue;

                var title = (process.MainWindowTitle ?? "").Trim();
                if (string.IsNullOrWhiteSpace(title))
                {
                    var len = GetWindowTextLength(hWnd);
                    if (len <= 0) continue;
                    var sb = new StringBuilder(len + 1);
                    GetWindowText(hWnd, sb, sb.Capacity);
                    title = sb.ToString().Trim();
                }
                if (string.IsNullOrWhiteSpace(title) || title == "Program Manager") continue;

                if (!TryWindowRect(hWnd, out var rect)) continue;
                var width = Math.Max(0, rect.Right - rect.Left);
                var height = Math.Max(0, rect.Bottom - rect.Top);
                if (!minimized && (width < 90 || height < 60)) continue;

                var name = string.IsNullOrWhiteSpace(process.ProcessName) ? "App" : process.ProcessName;
                var path = "";
                try { path = process.MainModule?.FileName ?? ""; } catch { }
                if (string.IsNullOrEmpty(path)) path = PathFromPid(process.Id);

                seen.Add(hwndValue);
                result.Add(new WindowInfo
                {
                    Hwnd = hwndValue, Title = title, ProcessId = process.Id,
                    ProcessName = name, Path = path,
                    X = rect.Left, Y = rect.Top, Width = width, Height = height,
                    Minimized = minimized, Active = hWnd == foreground,
                });
            }
            catch { }
            finally { process.Dispose(); }
        }

        return result;
    }

    private static (string name, string path) ProcessInfo(int pid)
    {
        var name = "App";
        var path = "";
        try
        {
            using var p = Process.GetProcessById(pid);
            if (!string.IsNullOrWhiteSpace(p.ProcessName)) name = p.ProcessName;
            try { path = p.MainModule?.FileName ?? ""; } catch { }
        }
        catch { }
        // MainModule throws for processes at a different elevation/integrity level
        // (Discord mid-update, elevated apps) — QueryFullProcessImageName still
        // resolves the path with only the limited query right, so their icon shows.
        if (string.IsNullOrEmpty(path)) path = PathFromPid(pid);
        return (name, path);
    }

    private static bool IsJunkClass(IntPtr hWnd)
    {
        var sb = new StringBuilder(256);
        GetClassName(hWnd, sb, sb.Capacity);
        var cls = sb.ToString();
        return cls is "Progman" or "WorkerW" or "Shell_TrayWnd" or "Button";
    }

    private static bool IsCloaked(IntPtr hWnd)
        => DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out int cloaked, 4) == 0 && cloaked != 0;

    private static bool IsToolWindow(IntPtr hWnd)
    {
        var exStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
        return (exStyle & WS_EX_TOOLWINDOW) != 0 && (exStyle & WS_EX_APPWINDOW) == 0;
    }

    private static bool TryWindowRect(IntPtr hWnd, out Rect rect)
    {
        if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf<Rect>()) == 0) return true;
        return GetWindowRect(hWnd, out rect);
    }
}
