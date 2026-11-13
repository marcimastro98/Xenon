// Open windows: a window's picture, and an app's icon or tile logo.

using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

internal static partial class WindowsTool
{
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
}
