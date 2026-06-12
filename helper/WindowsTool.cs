using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

// App-switcher window tool — a faithful one-shot port of windows.ps1, same JSON
// contracts on stdout:
//   windows list          → {"windows":[{id,title,app,processId,active,minimized,
//                                        bounds:{x,y,width,height},preview,icon}]}
//   windows focus <hwnd>  → {"ok":bool}
//   windows close <hwnd>  → {"ok":bool,"app":...,"path":...} | {"ok":false,"error":...}
//
// Unlike the media/foreground hosts this is NOT a resident process: the Apps
// panel is opened on demand, so a one-shot run keeps idle cost at zero while
// still skipping what made the PowerShell path slow — a full engine start plus
// an Add-Type C# compile on every single invocation (~1s before any work).
internal static class WindowsTool
{
    public static int Run(string[] args)
    {
        var action = args.Length > 1 ? args[1].ToLowerInvariant() : "list";
        switch (action)
        {
            case "list":
                Emit(ListPayload());
                return 0;
            case "focus":
            case "close":
                if (args.Length < 3 || !long.TryParse(args[2], out var hwnd) || hwnd <= 0)
                {
                    Emit(new Dictionary<string, object?> { ["ok"] = false, ["error"] = "Invalid window id" });
                    return 0;
                }
                Emit(action == "focus" ? FocusPayload(hwnd) : ClosePayload(hwnd));
                return 0;
            default:
                Console.Error.WriteLine("usage: xenon-helper windows list | focus <hwnd> | close <hwnd>");
                return 2;
        }
    }

    private static void Emit(Dictionary<string, object?> payload)
    {
        Console.Out.WriteLine(JsonOut.Serialize(payload));
        Console.Out.Flush();
    }

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
            items.Add(new Dictionary<string, object?>
            {
                ["id"] = w.Hwnd.ToString(),
                ["title"] = w.Title,
                ["app"] = w.ProcessName,
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

    // ── focus ─────────────────────────────────────────────────────────────────

    private static Dictionary<string, object?> FocusPayload(long hwndValue)
    {
        var hWnd = new IntPtr(hwndValue);
        ShowWindowAsync(hWnd, IsIconic(hWnd) ? SW_RESTORE : SW_SHOW);
        BringWindowToTop(hWnd);
        // The Alt tap releases the foreground lock so SetForegroundWindow is
        // honoured from a background process (same trick as the PS script).
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        SwitchToThisWindow(hWnd, true);
        var ok = SetForegroundWindow(hWnd);
        return new Dictionary<string, object?> { ["ok"] = ok };
    }

    // ── close ─────────────────────────────────────────────────────────────────

    // OS-critical processes that must never be closed, even on explicit request.
    private static readonly HashSet<string> ProtectedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "explorer", "csrss", "winlogon", "wininit", "services", "lsass", "smss",
        "dwm", "system", "registry", "fontdrvhost", "sihost", "ctfmon",
        "searchhost", "shellexperiencehost", "startmenuexperiencehost",
        "textinputhost", "runtimebroker", "applicationframehost",
    };

    private static Dictionary<string, object?> ClosePayload(long hwndValue)
    {
        var hWnd = new IntPtr(hwndValue);
        GetWindowThreadProcessId(hWnd, out var pid);
        if (pid == 0) return new Dictionary<string, object?> { ["ok"] = false, ["error"] = "not_found" };
        try
        {
            using var process = Process.GetProcessById((int)pid);
            var name = string.IsNullOrWhiteSpace(process.ProcessName) ? "" : process.ProcessName;
            var path = "";
            try { path = process.MainModule?.FileName ?? ""; } catch { }
            if (ProtectedNames.Contains(name))
                return new Dictionary<string, object?> { ["ok"] = false, ["error"] = "protected", ["app"] = name };
            // Graceful WM_CLOSE — the app may still prompt to save; never Kill.
            var closed = process.CloseMainWindow();
            return new Dictionary<string, object?> { ["ok"] = closed, ["app"] = name, ["path"] = path };
        }
        catch
        {
            return new Dictionary<string, object?> { ["ok"] = false, ["error"] = "not_found" };
        }
    }

    // ── capture / icons (GDI+ via System.Drawing) ─────────────────────────────

    private static string? Capture(long hwndValue, int maxWidth, int maxHeight)
    {
        var hWnd = new IntPtr(hwndValue);
        if (hWnd == IntPtr.Zero || IsIconic(hWnd)) return null;
        if (!TryWindowRect(hWnd, out var rect)) return null;

        var width = Math.Max(1, rect.Right - rect.Left);
        var height = Math.Max(1, rect.Bottom - rect.Top);
        if (width > 4096 || height > 4096) return null;

        using var source = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(source))
        {
            var hdc = graphics.GetHdc();
            bool ok;
            try { ok = PrintWindow(hWnd, hdc, 2); }
            finally { graphics.ReleaseHdc(hdc); }
            if (!ok) return null;
        }
        using var thumb = FitBitmap(source, maxWidth, maxHeight);
        return ToPngDataUrl(thumb);
    }

    private static string? IconForPath(string path, int size)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return null;
            using var icon = Icon.ExtractAssociatedIcon(path);
            if (icon == null) return null;
            using var bmp = icon.ToBitmap();
            using var resized = new Bitmap(size, size);
            using (var g = Graphics.FromImage(resized))
            {
                g.Clear(Color.Transparent);
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.DrawImage(bmp, 0, 0, size, size);
            }
            return ToPngDataUrl(resized);
        }
        catch { return null; }
    }

    private static Bitmap FitBitmap(Bitmap source, int maxWidth, int maxHeight)
    {
        var target = new Bitmap(maxWidth, maxHeight, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(target);
        g.Clear(Color.FromArgb(255, 10, 14, 14));
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.SmoothingMode = SmoothingMode.HighQuality;
        var scale = Math.Min((double)maxWidth / source.Width, (double)maxHeight / source.Height);
        var w = Math.Max(1, (int)Math.Round(source.Width * scale));
        var h = Math.Max(1, (int)Math.Round(source.Height * scale));
        g.DrawImage(source, (maxWidth - w) / 2, (maxHeight - h) / 2, w, h);
        return target;
    }

    private static string ToPngDataUrl(Bitmap bmp)
    {
        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        return "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
    }

    // ── Win32 ─────────────────────────────────────────────────────────────────

    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int WS_EX_APPWINDOW = 0x00040000;
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private const int DWMWA_CLOAKED = 14;
    private const int SW_SHOW = 5;
    private const int SW_RESTORE = 9;
    private const byte VK_MENU = 0x12;
    private const int KEYEVENTF_KEYUP = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
    [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("user32.dll")] private static extern void keybd_event(byte bVk, byte bScan, int dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, int nFlags);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int attrValue, int attrSize);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out Rect rect, int attrSize);
}
