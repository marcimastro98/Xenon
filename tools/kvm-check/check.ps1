# What a KVM switch does to the kiosk, on this PC: every screen but the Edge goes away for
# a few seconds, the way a switch takes the main screen, then the layout comes back.
#
#   pwsh -NoProfile -File tools/kvm-check/check.ps1 -ShellPid <pid> [-ControlPid <pid>] [-Out <folder>]
#
# -ShellPid is the shell under test (a side copy, see side-shell.mjs), -ControlPid an
# optional second shell to compare with (the installed one). A window of our own is
# maximized in front on the main screen first, standing in for the browser the switch
# user had open. The check reads the window stack once the screens are gone: the shell
# under test must be above that window, and must not have taken the foreground.
# A picture of the Edge goes in -Out. The screens are restored in `finally`, from the
# exact layout read at the start; if that fails, Windows' saved layout is applied.
# Nothing is saved to Windows' display settings. If the screens do not come back,
# Win+P then Extend puts them back.
param(
  [Parameter(Mandatory)][int]$ShellPid,
  [int]$ControlPid = 0,
  [string]$Out = (Join-Path ([IO.Path]::GetTempPath()) 'xenon-kvm-check'),
  [int]$AwaySeconds = 9
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class KvmCcd {
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint paths, byte[] p, ref uint modes, byte[] m, IntPtr topology);
  [DllImport("user32.dll")] static extern int SetDisplayConfig(uint paths, byte[] p, uint modes, byte[] m, uint flags);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(byte[] packet);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr ctx);
  const uint QDC_ONLY_ACTIVE_PATHS = 2;
  const uint SDC_APPLY = 0x80, SDC_USE_SUPPLIED = 0x20, SDC_ALLOW_CHANGES = 0x400, SDC_USE_DATABASE_CURRENT = 0xF;
  // DISPLAYCONFIG_PATH_INFO and DISPLAYCONFIG_MODE_INFO, kept as raw bytes.
  const int PATH = 72, MODE = 64;
  static byte[] savedPaths, savedModes;
  static uint savedPathCount, savedModeCount;

  public static void PerMonitorAware() { SetProcessDpiAwarenessContext(new IntPtr(-4)); }

  static int Query(out byte[] p, out uint np, out byte[] m, out uint nm) {
    p = null; m = null;
    int rc = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out np, out nm);
    if (rc != 0) return rc;
    p = new byte[np * PATH]; m = new byte[nm * MODE];
    return QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref np, p, ref nm, m, IntPtr.Zero);
  }

  // The GDI name (\\.\DISPLAYn) of a path's source.
  static string SourceName(byte[] paths, int i) {
    var packet = new byte[84];
    BitConverter.GetBytes(1).CopyTo(packet, 0);    // DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME
    BitConverter.GetBytes(84).CopyTo(packet, 4);
    Array.Copy(paths, i * PATH, packet, 8, 12);    // the source's adapter id and id
    if (DisplayConfigGetDeviceInfo(packet) != 0) return "";
    return System.Text.Encoding.Unicode.GetString(packet, 20, 64).TrimEnd('\0');
  }

  // Leave only the named screen on, at the origin, as when a switch takes the others.
  public static string KeepOnly(string gdiName) {
    byte[] p, m; uint np, nm;
    int rc = Query(out p, out np, out m, out nm);
    if (rc != 0) return "could not read the screens: " + rc;
    savedPaths = p; savedModes = m; savedPathCount = np; savedModeCount = nm;
    for (int i = 0; i < np; i++) {
      if (!string.Equals(SourceName(p, i), gdiName, StringComparison.OrdinalIgnoreCase)) continue;
      var kept = new byte[PATH];
      Array.Copy(p, i * PATH, kept, 0, PATH);
      var modes = (byte[])m.Clone();
      uint src = BitConverter.ToUInt32(kept, 12);
      if (src < nm) { Array.Clear(modes, (int)src * MODE + 28, 8); }
      rc = SetDisplayConfig(1, kept, nm, modes, SDC_APPLY | SDC_USE_SUPPLIED | SDC_ALLOW_CHANGES);
      return rc == 0 ? "" : "could not switch the other screens off: " + rc;
    }
    return "no screen named " + gdiName;
  }

  public static string Restore() {
    if (savedPaths == null) return "";
    int rc = SetDisplayConfig(savedPathCount, savedPaths, savedModeCount, savedModes, SDC_APPLY | SDC_USE_SUPPLIED | SDC_ALLOW_CHANGES);
    if (rc == 0) return "";
    int rc2 = SetDisplayConfig(0, null, 0, null, SDC_APPLY | SDC_USE_DATABASE_CURRENT);
    return rc2 == 0 ? "restored from Windows' saved layout (exact restore failed: " + rc + ")" : "restore failed: " + rc + ", " + rc2;
  }
}

public static class KvmStack {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

  public static int ForegroundPid() { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return (int)pid; }

  // The process's window the size of the Edge (its kiosk; a shell also has layer and menu
  // windows), else its biggest visible one: its place in the stack (0 = top) and rect.
  public static int[] Main(int pid) {
    int[] best = null; long bestArea = -1; int i = 0;
    EnumWindows((h, l) => {
      if (IsWindowVisible(h) && !IsIconic(h)) {
        uint owner; GetWindowThreadProcessId(h, out owner);
        RECT r; GetWindowRect(h, out r);
        bool kiosk = r.R - r.L == 2560 && r.B - r.T == 720;
        long area = kiosk ? long.MaxValue : (long)(r.R - r.L) * (r.B - r.T);
        if (owner == pid && area > bestArea) { bestArea = area; best = new[] { i, r.L, r.T, r.R - r.L, r.B - r.T }; }
        i++;
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
'@
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[KvmCcd]::PerMonitorAware()

function Screens { [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { '{0} {1}x{2} at {3},{4}{5}' -f $_.DeviceName, $_.Bounds.Width, $_.Bounds.Height, $_.Bounds.X, $_.Bounds.Y, $(if ($_.Primary) { ' primary' } else { '' }) } }
function Place($name, $procId) {
  if (-not $procId) { return $null }
  $w = [KvmStack]::Main($procId)
  if (-not $w) { "  ${name}: no visible window"; return $null }
  '  {0}: place {1} in the stack, at {2},{3} {4}x{5}' -f $name, $w[0], $w[1], $w[2], $w[3], $w[4]
  return $null
}
function Stack($label) {
  "$label (foreground: pid $([KvmStack]::ForegroundPid()))"
  Place 'shell under test' $ShellPid
  Place 'control shell' $ControlPid
  Place 'test window' $script:testPid
}

$edge = [System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Bounds.Width -eq 2560 -and $_.Bounds.Height -eq 720 } | Select-Object -First 1
if (-not $edge) { throw 'no 2560x720 screen: the check needs the Edge connected' }
New-Item -ItemType Directory -Force $Out | Out-Null
$before = Screens
"screens before:"; $before | ForEach-Object { "  $_" }

$script:testPid = (Start-Process pwsh -ArgumentList '-NoProfile', '-File', (Join-Path $PSScriptRoot 'test-window.ps1'), '-Seconds', ($AwaySeconds + 40) -PassThru -WindowStyle Hidden).Id
Start-Sleep -Seconds 4
Stack 'before the switch'

$switched = $false
try {
  $err = [KvmCcd]::KeepOnly($edge.DeviceName)
  if ($err) { throw $err }
  $switched = $true
  Start-Sleep -Seconds $AwaySeconds
  "screens while away:"; Screens | ForEach-Object { "  $_" }
  Stack 'while away'
  $shot = Join-Path $Out 'edge-while-away.png'
  $b = ([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Bounds.Width -eq 2560 } | Select-Object -First 1).Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  "picture: $shot"
} finally {
  if ($switched) {
    $msg = [KvmCcd]::Restore()
    if ($msg) { "RESTORE: $msg" }
    Start-Sleep -Seconds 6
    $after = Screens
    "screens after:"; $after | ForEach-Object { "  $_" }
    if (Compare-Object $before $after) { 'WARNING: the layout is not the same as before. Win+P then Extend, or Settings > Display.' } else { 'layout restored as before' }
    Stack 'after the switch'
  }
  Stop-Process -Id $script:testPid -ErrorAction SilentlyContinue
}
