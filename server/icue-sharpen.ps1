# icue-sharpen.ps1 — fix for the blurry dashboard in iCUE widget mode (GitHub issue #53).
#
# Root cause (verified on-device): iCUE hosts its Xeneon Edge surface in a Qt window,
# and QtWebEngine derives the widget's devicePixelRatio from that window's QScreen
# association. When the association goes stale — the boot race where the renderer is
# created before Windows finishes bringing up the USB display, or a DPI change on
# another monitor — Qt hands the renderer the PRIMARY monitor's scale (e.g. 1.5).
# The page then rasterises ~1.5x too large and iCUE resamples it down onto the panel,
# smearing text and hairlines. A page reload does not help (same window, same scale);
# removing and re-adding the widget does (new window).
#
# The fix: nudge the window by 1px and move it straight back. The WM_WINDOWPOSCHANGED
# round-trip makes Qt re-check which screen the window is on, re-associate it with the
# Edge (100% scale), and push the corrected device scale to the renderer — the widget
# re-rasterises at the panel's native size. Verified: DPR 1.8 -> 1.2, raster
# 3807px -> 2538px (native slot size), repeatably, with no iCUE restart.
#
# Targets only visible top-level Qt windows of iCUE.exe with a bar-like shape (the
# Edge is 2560x720 landscape or 720x2560 portrait); hidden windows and the main iCUE
# GUI are never touched. The 1px round-trip is imperceptible. Emits one-line JSON.

$ErrorActionPreference = 'Stop'

try {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class XenonIcueSharpen {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lparam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int len);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);

  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

  // SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER: position only,
  // never steal focus or reorder — the move must be invisible to the user.
  const uint SWP_FLAGS = 0x0001 | 0x0004 | 0x0010 | 0x0200;

  public static int Run(uint[] pids) {
    // Physical (per-monitor-v2) coordinates, so the same rect goes back verbatim.
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    var targets = new List<IntPtr>();
    var pidSet = new HashSet<uint>(pids);
    EnumWindows((hwnd, l) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (!pidSet.Contains(pid) || !IsWindowVisible(hwnd)) return true;
      var cls = new StringBuilder(256);
      GetClassName(hwnd, cls, 256);
      if (!cls.ToString().StartsWith("Qt")) return true;
      RECT r; GetWindowRect(hwnd, out r);
      int w = r.R - r.L, h = r.B - r.T;
      if (w <= 0 || h <= 0) return true;
      bool bar = (w >= 1000 && (double)w / h >= 2.5) || (h >= 1000 && (double)h / w >= 2.5);
      if (bar) targets.Add(hwnd);
      return true;
    }, IntPtr.Zero);

    int wiggled = 0;
    foreach (var hwnd in targets) {
      RECT r; if (!GetWindowRect(hwnd, out r)) continue;
      if (!SetWindowPos(hwnd, IntPtr.Zero, r.L + 1, r.T, 0, 0, SWP_FLAGS)) continue;
      System.Threading.Thread.Sleep(50);
      SetWindowPos(hwnd, IntPtr.Zero, r.L, r.T, 0, 0, SWP_FLAGS);
      wiggled++;
    }
    return wiggled;
  }
}
'@

  $procs = @(Get-Process -Name 'iCUE' -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) {
    Write-Output '{"ok":false,"error":"icue-not-running"}'
    exit 0
  }
  $pids = [uint32[]]($procs | ForEach-Object { $_.Id })
  $wiggled = [XenonIcueSharpen]::Run($pids)
  Write-Output ('{"ok":true,"wiggled":' + $wiggled + '}')
} catch {
  $msg = ($_.Exception.Message -replace '[\r\n"\\]', ' ')
  Write-Output ('{"ok":false,"error":"' + $msg + '"}')
}
