using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

// App-switcher window tool — a faithful one-shot port of windows.ps1, same JSON
// contracts on stdout:
//   windows list          → {"windows":[{id,title,app,path,processId,active,minimized,
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

    // ── path / packaged-app icon fallbacks ─────────────────────────────────────

    // Robust exe path when Process.MainModule throws — it does for processes at a
    // different elevation/integrity level than this helper. Only the limited query
    // right is needed, which OpenProcess grants where module enumeration is denied.
    private static string PathFromPid(int pid)
    {
        if (pid <= 0) return "";
        var h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return "";
        try
        {
            var sb = new StringBuilder(1024);
            int size = sb.Capacity;
            return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : "";
        }
        finally { CloseHandle(h); }
    }

    // Tile logo for a packaged (UWP/Store) app whose window has no reachable exe
    // icon — WhatsApp and other apps hosted by ApplicationFrameHost. The window's
    // AUMID is read from its shell property store (set even on the frame host), then
    // the correctly-scaled logo comes straight from WinRT — raw PNG bytes, no GDI,
    // transparency preserved. Same mechanism the notification host uses for toasts.
    private static string? TileLogoForWindow(IntPtr hWnd)
    {
        // AppInfo.GetFromAppUserModelId needs Windows 10 2004 (19041); older builds
        // simply keep the letter fallback.
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041)) return null;
        var aumid = AumidForWindow(hWnd);
        if (string.IsNullOrEmpty(aumid)) return null;
        try
        {
            var info = Windows.ApplicationModel.AppInfo.GetFromAppUserModelId(aumid);
            var logoRef = info?.DisplayInfo?.GetLogo(new Windows.Foundation.Size(48, 48));
            if (logoRef == null) return null;
            using var stream = logoRef.OpenReadAsync().AsTask()
                .WaitAsync(TimeSpan.FromMilliseconds(1500)).GetAwaiter().GetResult();
            if (stream.Size == 0 || stream.Size > 512 * 1024) return null;
            using var input = stream.GetInputStreamAt(0);
            using var reader = new Windows.Storage.Streams.DataReader(input);
            reader.LoadAsync((uint)stream.Size).AsTask()
                .WaitAsync(TimeSpan.FromMilliseconds(1500)).GetAwaiter().GetResult();
            var bytes = new byte[(int)stream.Size];
            reader.ReadBytes(bytes);
            var ct = string.IsNullOrEmpty(stream.ContentType) ? "image/png" : stream.ContentType;
            return "data:" + ct + ";base64," + Convert.ToBase64String(bytes);
        }
        catch { return null; }
    }

    // Root the COM interface (and its members) so trimming can't strip it — the
    // IL2050 warning's failure mode is exactly a silently-empty AUMID at runtime.
    [System.Diagnostics.CodeAnalysis.DynamicDependency(System.Diagnostics.CodeAnalysis.DynamicallyAccessedMemberTypes.All, typeof(IPropertyStore))]
    private static string AumidForWindow(IntPtr hWnd)
    {
        IPropertyStore? store = null;
        try
        {
            var iid = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"); // IID_IPropertyStore
            if (SHGetPropertyStoreForWindow(hWnd, ref iid, out store) != 0 || store == null) return "";
            // PKEY_AppUserModel_ID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5 (VT_LPWSTR)
            var key = new PropertyKey { fmtid = new Guid("9f4c2855-9f79-4b39-a8d0-e1d42de1d5f3"), pid = 5 };
            if (store.GetValue(ref key, out var pv) != 0) return "";
            try
            {
                if (PropVariantToStringAlloc(ref pv, out var p) == 0 && p != IntPtr.Zero)
                {
                    var s = Marshal.PtrToStringUni(p) ?? "";
                    Marshal.FreeCoTaskMem(p);
                    return s;
                }
                return "";
            }
            finally { PropVariantClear(ref pv); }
        }
        catch { return ""; }
        finally { if (store != null) Marshal.ReleaseComObject(store); }
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

    // Path resolution + AUMID lookup for the icon fallbacks above.
    private const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr hProcess, int flags, StringBuilder exeName, ref int size);
    [DllImport("shell32.dll")] private static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ppv);
    [DllImport("propsys.dll")] private static extern int PropVariantToStringAlloc(ref PropVariant pv, out IntPtr ppszOut);
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant pv);

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey { public Guid fmtid; public uint pid; }

    // PROPVARIANT — only the header + the pointer-sized union slot matter here
    // (we read VT_LPWSTR via PropVariantToStringAlloc and clear via PropVariantClear).
    [StructLayout(LayoutKind.Sequential)]
    private struct PropVariant { public ushort vt; public ushort w1; public ushort w2; public ushort w3; public IntPtr p1; public IntPtr p2; }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        int GetCount(out uint cProps);
        int GetAt(uint iProp, out PropertyKey pkey);
        int GetValue(ref PropertyKey key, out PropVariant pv);
        int SetValue(ref PropertyKey key, ref PropVariant pv);
        int Commit();
    }
}
