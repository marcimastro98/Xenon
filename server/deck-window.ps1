# ─────────────────────────────────────────────────────────────────────────
# Window mover — acts on the FOREGROUND window (the app the user was last in;
# tapping the touchscreen gives focus to the dashboard, so the target is the
# window beneath it in the Z-order — same model as deck-hotkey.ps1).
#
# Verbs (a fixed allowlist; the Node registry only ever passes one of these as a
# single argv element — never a shell string):
#   next-monitor / prev-monitor  move to the adjacent display (re-maximises if the
#                                 window was maximised)
#   left / right                 snap to the left/right half of the current monitor
#   maximize / minimize          window state
#   center                       centre on the current monitor, keeping its size
#
# Prints ONE compact JSON line: {"ok":true} or {"ok":false,"error":"..."}.
# ─────────────────────────────────────────────────────────────────────────
param([string]$verb)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$source = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class XenonWindow {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MonitorInfo { public int cbSize; public Rect rcMonitor; public Rect rcWork; public uint dwFlags; }

  public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref Rect lprc, IntPtr data);

  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
  [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hWnd, int flags);
  [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MonitorInfo info);
  [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  // Z-order walk to find the app behind the dashboard (see FindTarget).
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);

  private const int MONITOR_DEFAULTTONEAREST = 2;
  private const int SW_MAXIMIZE = 3;
  private const int SW_MINIMIZE = 6;
  private const int SW_RESTORE  = 9;
  private const uint SWP_NOZORDER = 0x0004;
  private const uint SWP_NOACTIVATE = 0x0010;
  private const uint GW_HWNDNEXT = 2;
  private const int GWL_EXSTYLE = -20;
  private const int WS_EX_TOOLWINDOW = 0x00000080;
  private const int DWMWA_CLOAKED = 14;

  // The app the user was last using = the first real, visible, on-screen top-level
  // window BELOW the foreground (the dashboard, which the touch just focused).
  // Same Z-order walk deck-hotkey.ps1 uses — so a moved window is the one they
  // meant, not the dashboard itself. Skips invisible/minimised/cloaked/tool/title-less.
  private static IntPtr FindTarget() {
    IntPtr fg = GetForegroundWindow();
    IntPtr h = fg;
    for (int i = 0; i < 80 && h != IntPtr.Zero; i++) {
      h = GetWindow(h, GW_HWNDNEXT);
      if (h == IntPtr.Zero || h == fg) continue;
      if (!IsWindowVisible(h) || IsIconic(h)) continue;
      if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) continue;
      if (GetWindowTextLength(h) == 0) continue;
      int cloaked = 0;
      try { DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, sizeof(int)); } catch {}
      if (cloaked != 0) continue;
      return h;
    }
    return IntPtr.Zero;
  }

  private static List<Rect> GetMonitors() {
    var list = new List<Rect>();
    MonitorEnumProc cb = delegate(IntPtr hm, IntPtr hdc, ref Rect r, IntPtr d) {
      MonitorInfo m = new MonitorInfo(); m.cbSize = Marshal.SizeOf(typeof(MonitorInfo));
      if (GetMonitorInfo(hm, ref m)) list.Add(m.rcWork);
      return true;
    };
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
    list.Sort(delegate(Rect a, Rect b) { return a.Left != b.Left ? a.Left - b.Left : a.Top - b.Top; });
    return list;
  }

  private static readonly string[] VERBS = { "next-monitor", "prev-monitor", "left", "right", "maximize", "minimize", "center" };

  public static string Run(string verb) {
    if (Array.IndexOf(VERBS, verb) < 0) return "bad_verb";  // validate before ANY window mutation
    try { SetProcessDPIAware(); } catch {}
    // Act on the window BEHIND the dashboard (the app the user was last in), not
    // the dashboard the touch just focused — otherwise "move window" moves the
    // dashboard itself.
    IntPtr h = FindTarget();
    if (h == IntPtr.Zero) return "no_target";

    if (verb == "minimize") { ShowWindow(h, SW_MINIMIZE); return "ok"; }
    if (verb == "maximize") { ShowWindow(h, SW_MAXIMIZE); return "ok"; }

    IntPtr mon = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
    MonitorInfo mi = new MonitorInfo(); mi.cbSize = Marshal.SizeOf(typeof(MonitorInfo));
    if (!GetMonitorInfo(mon, ref mi)) return "no_monitor";

    bool wasMax = IsZoomed(h);
    if (wasMax) ShowWindow(h, SW_RESTORE);

    Rect w; if (!GetWindowRect(h, out w)) return "no_rect";
    int ww = w.Right - w.Left, wh = w.Bottom - w.Top;
    int mw = mi.rcWork.Right - mi.rcWork.Left, mh = mi.rcWork.Bottom - mi.rcWork.Top;

    if (verb == "left" || verb == "right") {
      int halfW = mw / 2;
      int x = (verb == "left") ? mi.rcWork.Left : mi.rcWork.Left + halfW;
      SetWindowPos(h, IntPtr.Zero, x, mi.rcWork.Top, halfW, mh, SWP_NOZORDER | SWP_NOACTIVATE);
      return "ok";
    }
    if (verb == "center") {
      int x = mi.rcWork.Left + (mw - ww) / 2;
      int y = mi.rcWork.Top + (mh - wh) / 2;
      SetWindowPos(h, IntPtr.Zero, x, y, ww, wh, SWP_NOZORDER | SWP_NOACTIVATE);
      return "ok";
    }
    if (verb == "next-monitor" || verb == "prev-monitor") {
      var mons = GetMonitors();
      if (mons.Count < 2) { if (wasMax) ShowWindow(h, SW_MAXIMIZE); return "single_monitor"; }
      int idx = 0;
      for (int i = 0; i < mons.Count; i++) { if (mons[i].Left == mi.rcWork.Left && mons[i].Top == mi.rcWork.Top) { idx = i; break; } }
      int t = (verb == "next-monitor") ? (idx + 1) % mons.Count : (idx - 1 + mons.Count) % mons.Count;
      Rect src = mi.rcWork, dst = mons[t];
      int dw = dst.Right - dst.Left, dh = dst.Bottom - dst.Top;
      double rx = (double)(w.Left - src.Left) / Math.Max(1, mw);
      double ry = (double)(w.Top - src.Top) / Math.Max(1, mh);
      int nw = Math.Min(ww, dw), nh = Math.Min(wh, dh);
      int nx = dst.Left + (int)(rx * dw), ny = dst.Top + (int)(ry * dh);
      if (nx + nw > dst.Right) nx = dst.Right - nw;
      if (ny + nh > dst.Bottom) ny = dst.Bottom - nh;
      if (nx < dst.Left) nx = dst.Left;
      if (ny < dst.Top) ny = dst.Top;
      SetWindowPos(h, IntPtr.Zero, nx, ny, nw, nh, SWP_NOZORDER | SWP_NOACTIVATE);
      if (wasMax) ShowWindow(h, SW_MAXIMIZE);   // re-maximise on the new monitor
      return "ok";
    }
    return "bad_verb";
  }
}
"@

try {
  Add-Type -TypeDefinition $source -Language CSharp | Out-Null
  $r = [XenonWindow]::Run($verb)
  if ($r -eq 'ok') { Write-Output '{"ok":true}' }
  else { Write-Output ('{"ok":false,"error":"' + $r + '"}') }
} catch {
  $msg = ($_.Exception.Message -replace '\\', '\\' -replace '"', '\"')
  Write-Output ('{"ok":false,"error":"' + $msg + '"}')
}
