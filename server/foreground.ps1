# ─────────────────────────────────────────────────────────────────────────
# Foreground full-screen probe — the reliable "is a game running" signal.
#
# A real game owns the foreground window and covers its entire monitor
# (exclusive or borderless full-screen) WITHOUT a title bar. We compare the
# foreground window rect to the FULL monitor rect (rcMonitor, not the work
# area) and require the window to have no WS_CAPTION. This cleanly separates:
#   - full-screen games  -> cover the whole monitor, no caption  -> match
#   - maximized apps      -> cover only the work area (taskbar excluded) and
#                            keep their title bar                 -> no match
# This needs no admin rights and never false-positives on perpetual presenters
# (iCUE, the dashboard's own browser, animated wallpapers) the way PresentMon
# frame-rate detection does. PresentMon is now used only for the FPS readout.
#
# Runs as a long-lived loop, printing one compact JSON line per interval to
# stdout; the Node side (gamedetect.js) reads the latest line.
# ─────────────────────────────────────────────────────────────────────────
param([int]$IntervalMs = 2000)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$source = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class XenonForeground {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MonitorInfo { public int cbSize; public Rect rcMonitor; public Rect rcWork; public uint dwFlags; }

  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder s, int max);
  [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hWnd, int flags);
  [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MonitorInfo info);

  private const int GWL_STYLE = -16;
  private const int WS_CAPTION = 0x00C00000;
  private const int MONITOR_DEFAULTTONEAREST = 2;

  private static string Json(bool fullscreen, string name, uint pid) {
    string safe = (name ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
    return "{\"fullscreen\":" + (fullscreen ? "true" : "false")
         + ",\"process\":\"" + safe + "\",\"pid\":" + pid + "}";
  }

  public static string Probe() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return Json(false, "", 0);

    var cls = new StringBuilder(256);
    GetClassName(h, cls, cls.Capacity);
    string c = cls.ToString();
    if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Button")
      return Json(false, "", 0);

    Rect w;
    if (!GetWindowRect(h, out w)) return Json(false, "", 0);

    IntPtr mon = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
    MonitorInfo mi = new MonitorInfo();
    mi.cbSize = Marshal.SizeOf(typeof(MonitorInfo));
    if (!GetMonitorInfo(mon, ref mi)) return Json(false, "", 0);

    const int tol = 2; // borderless games match the monitor exactly; allow a hair
    bool coversMonitor =
      w.Left   <= mi.rcMonitor.Left   + tol &&
      w.Top    <= mi.rcMonitor.Top    + tol &&
      w.Right  >= mi.rcMonitor.Right  - tol &&
      w.Bottom >= mi.rcMonitor.Bottom - tol;

    int style = GetWindowLong(h, GWL_STYLE);
    bool hasCaption = (style & WS_CAPTION) == WS_CAPTION;

    bool fullscreen = coversMonitor && !hasCaption;

    uint pid;
    GetWindowThreadProcessId(h, out pid);
    string name = "";
    try { using (var p = Process.GetProcessById((int)pid)) { name = p.ProcessName; } } catch { }

    return Json(fullscreen, name, pid);
  }
}
"@

Add-Type -TypeDefinition $source

while ($true) {
  try { [Console]::Out.WriteLine([XenonForeground]::Probe()) }
  catch { [Console]::Out.WriteLine('{"fullscreen":false,"process":"","pid":0}') }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $IntervalMs
}
