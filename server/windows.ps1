param(
  [ValidateSet('list', 'focus', 'close')]
  [string]$Action = 'list',
  [string]$Hwnd = ''
)

$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

Add-Type -AssemblyName System.Drawing

$source = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class XenonWindows {
  public class WindowInfo {
    public long Hwnd;
    public string Title;
    public int ProcessId;
    public string ProcessName;
    public string Path;
    public int X;
    public int Y;
    public int Width;
    public int Height;
    public bool Minimized;
    public bool Active;
    public bool Closed;
    public bool Protected;
  }

  public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

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

  private const int GWL_EXSTYLE = -20;
  private const int WS_EX_TOOLWINDOW = 0x00000080;
  private const int WS_EX_APPWINDOW = 0x00040000;
  private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  private const int DWMWA_CLOAKED = 14;
  private const int SW_SHOWNORMAL = 1;
  private const int SW_SHOW = 5;
  private const int SW_RESTORE = 9;
  private const byte VK_MENU = 0x12;
  private const int KEYEVENTF_KEYUP = 0x0002;

  public static List<WindowInfo> ListWindows() {
    var result = new List<WindowInfo>();
    var seen = new HashSet<long>();
    IntPtr shell = GetShellWindow();
    IntPtr foreground = GetForegroundWindow();

    EnumWindows((hWnd, lParam) => {
      try {
        if (hWnd == IntPtr.Zero || hWnd == shell) return true;
        if (!IsWindowVisible(hWnd)) return true;

        var className = new StringBuilder(256);
        GetClassName(hWnd, className, className.Capacity);
        string cls = className.ToString();
        if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Button") return true;

        int cloaked = 0;
        if (DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;

        int exStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
        if ((exStyle & WS_EX_TOOLWINDOW) != 0 && (exStyle & WS_EX_APPWINDOW) == 0) return true;

        int len = GetWindowTextLength(hWnd);
        if (len <= 0) return true;
        var titleBuilder = new StringBuilder(len + 1);
        GetWindowText(hWnd, titleBuilder, titleBuilder.Capacity);
        string title = (titleBuilder.ToString() ?? "").Trim();
        if (String.IsNullOrWhiteSpace(title) || title == "Program Manager") return true;

        Rect rect;
        if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(Rect))) != 0) {
          if (!GetWindowRect(hWnd, out rect)) return true;
        }
        bool minimized = IsIconic(hWnd);
        int width = Math.Max(0, rect.Right - rect.Left);
        int height = Math.Max(0, rect.Bottom - rect.Top);
        if (!minimized && (width < 90 || height < 60)) return true;

        long hwndValue = hWnd.ToInt64();
        if (seen.Contains(hwndValue)) return true;
        seen.Add(hwndValue);

        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        string processName = "App";
        string path = "";
        try {
          using (var process = Process.GetProcessById((int)pid)) {
            processName = String.IsNullOrWhiteSpace(process.ProcessName) ? processName : process.ProcessName;
            try { path = process.MainModule.FileName; } catch { path = ""; }
          }
        } catch { }

        result.Add(new WindowInfo {
          Hwnd = hwndValue,
          Title = title,
          ProcessId = (int)pid,
          ProcessName = processName,
          Path = path,
          X = rect.Left,
          Y = rect.Top,
          Width = width,
          Height = height,
          Minimized = minimized,
          Active = hWnd == foreground
        });
      } catch { }
      return true;
    }, IntPtr.Zero);

    foreach (var process in Process.GetProcesses()) {
      try {
        IntPtr hWnd = process.MainWindowHandle;
        if (hWnd == IntPtr.Zero || hWnd == shell) continue;

        long hwndValue = hWnd.ToInt64();
        if (seen.Contains(hwndValue)) continue;

        bool minimized = IsIconic(hWnd);
        if (!IsWindowVisible(hWnd) && !minimized) continue;

        var className = new StringBuilder(256);
        GetClassName(hWnd, className, className.Capacity);
        string cls = className.ToString();
        if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Button") continue;

        int cloaked = 0;
        if (!minimized && DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) continue;

        int exStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
        if ((exStyle & WS_EX_TOOLWINDOW) != 0 && (exStyle & WS_EX_APPWINDOW) == 0) continue;

        string title = (process.MainWindowTitle ?? "").Trim();
        if (String.IsNullOrWhiteSpace(title)) {
          int len = GetWindowTextLength(hWnd);
          if (len <= 0) continue;
          var titleBuilder = new StringBuilder(len + 1);
          GetWindowText(hWnd, titleBuilder, titleBuilder.Capacity);
          title = (titleBuilder.ToString() ?? "").Trim();
        }
        if (String.IsNullOrWhiteSpace(title) || title == "Program Manager") continue;

        Rect rect;
        if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(Rect))) != 0) {
          if (!GetWindowRect(hWnd, out rect)) continue;
        }
        int width = Math.Max(0, rect.Right - rect.Left);
        int height = Math.Max(0, rect.Bottom - rect.Top);
        if (!minimized && (width < 90 || height < 60)) continue;

        string processName = String.IsNullOrWhiteSpace(process.ProcessName) ? "App" : process.ProcessName;
        string path = "";
        try { path = process.MainModule.FileName; } catch { path = ""; }

        seen.Add(hwndValue);
        result.Add(new WindowInfo {
          Hwnd = hwndValue,
          Title = title,
          ProcessId = process.Id,
          ProcessName = processName,
          Path = path,
          X = rect.Left,
          Y = rect.Top,
          Width = width,
          Height = height,
          Minimized = minimized,
          Active = hWnd == foreground
        });
      } catch { }
    }

    return result;
  }

  public static bool Focus(long hwndValue) {
    IntPtr hWnd = new IntPtr(hwndValue);
    if (hWnd == IntPtr.Zero) return false;

    if (IsIconic(hWnd)) ShowWindowAsync(hWnd, SW_RESTORE);
    else ShowWindowAsync(hWnd, SW_SHOW);

    BringWindowToTop(hWnd);
    keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
    keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    SwitchToThisWindow(hWnd, true);
    return SetForegroundWindow(hWnd);
  }

  // OS-critical processes that must never be closed, even on explicit request —
  // closing them would destabilise the desktop session.
  private static readonly HashSet<string> ProtectedNames = new HashSet<string>(
    StringComparer.OrdinalIgnoreCase) {
    "explorer", "csrss", "winlogon", "wininit", "services", "lsass", "smss",
    "dwm", "system", "registry", "fontdrvhost", "sihost", "ctfmon",
    "searchhost", "shellexperiencehost", "startmenuexperiencehost",
    "textinputhost", "runtimebroker", "applicationframehost"
  };

  // Gracefully close a window by HWND (sends WM_CLOSE via CloseMainWindow — the
  // app can still prompt to save; we never Kill). Captures the executable path
  // first so the caller can offer to reopen it later. Refuses protected OS
  // processes. Returns null if the window/process can't be resolved.
  public static WindowInfo CloseWindow(long hwndValue) {
    IntPtr hWnd = new IntPtr(hwndValue);
    if (hWnd == IntPtr.Zero) return null;
    uint pid;
    GetWindowThreadProcessId(hWnd, out pid);
    if (pid == 0) return null;
    var info = new WindowInfo { Hwnd = hwndValue, ProcessId = (int)pid, Closed = false, Protected = false };
    try {
      using (var process = Process.GetProcessById((int)pid)) {
        info.ProcessName = String.IsNullOrWhiteSpace(process.ProcessName) ? "" : process.ProcessName;
        try { info.Path = process.MainModule.FileName; } catch { info.Path = ""; }
        if (ProtectedNames.Contains(info.ProcessName)) { info.Protected = true; return info; }
        info.Closed = process.CloseMainWindow();
      }
    } catch { return null; }
    return info;
  }

  public static string Capture(long hwndValue, int maxWidth, int maxHeight) {
    IntPtr hWnd = new IntPtr(hwndValue);
    if (hWnd == IntPtr.Zero || IsIconic(hWnd)) return null;

    Rect rect;
    if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(Rect))) != 0) {
      if (!GetWindowRect(hWnd, out rect)) return null;
    }

    int width = Math.Max(1, rect.Right - rect.Left);
    int height = Math.Max(1, rect.Bottom - rect.Top);
    if (width > 4096 || height > 4096) return null;

    using (var source = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
      using (var graphics = Graphics.FromImage(source)) {
        IntPtr hdc = graphics.GetHdc();
        bool ok = false;
        try { ok = PrintWindow(hWnd, hdc, 2); }
        finally { graphics.ReleaseHdc(hdc); }
        if (!ok) return null;
      }

      using (var thumb = FitBitmap(source, maxWidth, maxHeight)) {
        using (var ms = new MemoryStream()) {
          thumb.Save(ms, ImageFormat.Png);
          return "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
        }
      }
    }
  }

  public static string IconForPath(string path, int size) {
    try {
      if (String.IsNullOrWhiteSpace(path) || !File.Exists(path)) return null;
      using (var icon = Icon.ExtractAssociatedIcon(path)) {
        if (icon == null) return null;
        using (var bmp = icon.ToBitmap())
        using (var resized = new Bitmap(size, size)) {
          using (var g = Graphics.FromImage(resized)) {
            g.Clear(Color.Transparent);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.DrawImage(bmp, 0, 0, size, size);
          }
          using (var ms = new MemoryStream()) {
            resized.Save(ms, ImageFormat.Png);
            return "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
          }
        }
      }
    } catch { return null; }
  }

  private static Bitmap FitBitmap(Bitmap source, int maxWidth, int maxHeight) {
    var target = new Bitmap(maxWidth, maxHeight, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(target)) {
      g.Clear(Color.FromArgb(255, 10, 14, 14));
      g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      g.SmoothingMode = SmoothingMode.HighQuality;
      double scale = Math.Min((double)maxWidth / source.Width, (double)maxHeight / source.Height);
      int w = Math.Max(1, (int)Math.Round(source.Width * scale));
      int h = Math.Max(1, (int)Math.Round(source.Height * scale));
      int x = (maxWidth - w) / 2;
      int y = (maxHeight - h) / 2;
      g.DrawImage(source, x, y, w, h);
    }
    return target;
  }
}
"@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing

if ($Action -eq 'focus') {
  if ([string]::IsNullOrWhiteSpace($Hwnd) -or $Hwnd -notmatch '^\d+$') {
    @{ ok = $false; error = 'Invalid window id' } | ConvertTo-Json -Compress
    exit 0
  }

  $ok = [XenonWindows]::Focus([int64]$Hwnd)
  @{ ok = [bool]$ok } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'close') {
  if ([string]::IsNullOrWhiteSpace($Hwnd) -or $Hwnd -notmatch '^\d+$') {
    @{ ok = $false; error = 'Invalid window id' } | ConvertTo-Json -Compress
    exit 0
  }

  $info = [XenonWindows]::CloseWindow([int64]$Hwnd)
  if ($null -eq $info) {
    @{ ok = $false; error = 'not_found' } | ConvertTo-Json -Compress
  } elseif ($info.Protected) {
    @{ ok = $false; error = 'protected'; app = [string]$info.ProcessName } | ConvertTo-Json -Compress
  } else {
    @{ ok = [bool]$info.Closed; app = [string]$info.ProcessName; path = [string]$info.Path } | ConvertTo-Json -Compress
  }
  exit 0
}

$items = @()
$windows = [XenonWindows]::ListWindows() |
  Sort-Object @{ Expression = 'Active'; Descending = $true }, @{ Expression = 'ProcessName'; Ascending = $true }, @{ Expression = 'Title'; Ascending = $true } |
  Select-Object -First 24

foreach ($window in $windows) {
  $preview = $null
  try { $preview = [XenonWindows]::Capture($window.Hwnd, 240, 135) } catch { }
  $icon = $null
  try { $icon = [XenonWindows]::IconForPath($window.Path, 48) } catch { }

  $items += [pscustomobject]@{
    id = [string]$window.Hwnd
    title = [string]$window.Title
    app = [string]$window.ProcessName
    processId = [int]$window.ProcessId
    active = [bool]$window.Active
    minimized = [bool]$window.Minimized
    bounds = [pscustomobject]@{
      x = [int]$window.X
      y = [int]$window.Y
      width = [int]$window.Width
      height = [int]$window.Height
    }
    preview = $preview
    icon = $icon
  }
}

@{ windows = $items } | ConvertTo-Json -Depth 6 -Compress