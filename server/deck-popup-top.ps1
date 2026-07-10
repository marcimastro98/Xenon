# ─────────────────────────────────────────────────────────────────────────
# Virtual Deck popup — one-shot always-on-top pass.
#
# Pins the popup with SetWindowPos(HWND_TOPMOST). The window is identified by
# the Edge PROCESS ID server.js spawned (-ProcessId, primary match) — never by
# title alone, or any unrelated window whose title merely contains the needle
# (a browser tab, an editor) would be pinned. -Title is the fallback for the
# rare Edge process-singleton handoff, and it must match the popup's document
# title EXACTLY and belong to an msedge.exe process. Runs ONCE and exits: no
# loop, no timer, no lingering process (performance invariant). Inputs are
# fixed constants from server.js (argv-bound, never a shell string).
# Prints a single JSON line.
# ─────────────────────────────────────────────────────────────────────────
param(
  [int]$ProcessId = 0,
  [string]$Title = ''
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom

$source = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class XenonPopupTop {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
  public delegate bool EnumProc(IntPtr h, IntPtr lp);

  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_SHOWWINDOW = 0x0040;

  static string ProcName(uint pid) {
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
    catch { return ""; }
  }

  public static bool Pin(int ownerPid, string exactTitle) {
    bool pinned = false;
    EnumWindows((h, lp) => {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      bool match = ownerPid > 0 && pid == (uint)ownerPid;
      if (!match && exactTitle.Length > 0) {
        int len = GetWindowTextLength(h);
        if (len > 0) {
          var sb = new StringBuilder(len + 1);
          GetWindowText(h, sb, sb.Capacity);
          // Fallback: EXACT title (an Edge app window's title is the bare
          // document title; tabs/editors carry suffixes) AND an Edge process.
          match = string.Equals(sb.ToString(), exactTitle, StringComparison.OrdinalIgnoreCase)
               && string.Equals(ProcName(pid), "msedge", StringComparison.OrdinalIgnoreCase);
        }
      }
      if (match) {
        SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        pinned = true;
      }
      return true;   // keep going: an app window and its splash can coexist briefly
    }, IntPtr.Zero);
    return pinned;
  }
}
"@
Add-Type -TypeDefinition $source

$ok = [XenonPopupTop]::Pin($ProcessId, $Title)
[Console]::Out.WriteLine(('{"ok":' + $(if ($ok) { 'true' } else { 'false' }) + '}'))
