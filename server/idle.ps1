# System idle probe — seconds since the last keyboard/mouse input, session-wide.
#
# Used by Bit (the vitals pet) as PRESENCE: the Xeneon touchscreen alone can't
# prove the user is at the PC (they may never tap that monitor), so the
# PC-invading nag actions (monitor popups / minimize / lock) only fire while
# real input happened recently. Runs inside pwsh-worker.ps1 (allowlisted), so
# the Add-Type compilation cost is paid once per worker lifetime; the type-load
# guard makes repeat calls in the same AppDomain instant.
#
# Output: {"ok":true,"idleSec":N} — always JSON, errors trapped (exit-free, as
# the worker requires).

try {
  if (-not ('XenonIdleProbe' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class XenonIdleProbe {
  [StructLayout(LayoutKind.Sequential)]
  private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")]
  private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static long IdleMillis() {
    var li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref li)) return -1;
    // uint subtraction wraps correctly across the 49.7-day TickCount rollover.
    unchecked { return (uint)Environment.TickCount - li.dwTime; }
  }
}
"@
  }
  $ms = [XenonIdleProbe]::IdleMillis()
  if ($ms -lt 0) {
    Write-Output '{"ok":false,"error":"GetLastInputInfo failed"}'
  } else {
    Write-Output ('{"ok":true,"idleSec":' + [math]::Floor($ms / 1000) + '}')
  }
} catch {
  $msg = $_.Exception.Message -replace '[\r\n"\\]', ' '
  Write-Output ('{"ok":false,"error":"' + $msg + '"}')
}
