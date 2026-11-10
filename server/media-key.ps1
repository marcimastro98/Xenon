# Reaches a player: presses one of the keyboard's media keys, or tells an app directly with
# a message to its window (server/media-key.js says when and which).
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Key')][ValidateSet(176, 177, 179)][int]$Key,
  [Parameter(Mandatory = $true, ParameterSetName = 'App')][ValidateSet(11, 12, 14)][int]$Command,
  [Parameter(Mandatory = $true, ParameterSetName = 'App')][ValidateLength(1, 128)][string]$App
)

if ($PSCmdlet.ParameterSetName -eq 'App') {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class XenonMediaApp {
  delegate bool Each(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(Each each, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, IntPtr from, IntPtr command, uint flags, uint ms, out IntPtr answer);
  const uint WM_APPCOMMAND = 0x319, SMTO_ABORTIFHUNG = 2;
  // Visible windows first; a player closed to the tray keeps a hidden one with its title.
  public static bool Tell(int[] pids, int command) {
    var owners = new HashSet<uint>();
    foreach (var pid in pids) owners.Add((uint)pid);
    var shown = new List<IntPtr>();
    var hidden = new List<IntPtr>();
    EnumWindows((window, data) => {
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      if (!owners.Contains(pid)) return true;
      if (IsWindowVisible(window)) shown.Add(window);
      else if (GetWindowTextLengthW(window) > 0) hidden.Add(window);
      return true;
    }, IntPtr.Zero);
    shown.AddRange(hidden);
    foreach (var window in shown) {
      IntPtr answer;
      var sent = SendMessageTimeoutW(window, WM_APPCOMMAND, window, (IntPtr)(command << 16), SMTO_ABORTIFHUNG, 1000, out answer);
      // Zero is the system's answer for a window that took no such command.
      if (sent != IntPtr.Zero && answer != IntPtr.Zero) return true;
    }
    return false;
  }
}
'@
  $pids = @(Get-Process | Where-Object { $_.ProcessName -eq $App } | ForEach-Object { $_.Id })
  if ($pids.Count -gt 0 -and [XenonMediaApp]::Tell([int[]]$pids, $Command)) { '{"ok":true}' } else { '{"ok":false}' }
  return
}

Add-Type -Namespace XenonMedia -Name Keys -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, UIntPtr extra);
'@

$KEYEVENTF_EXTENDEDKEY = 1
$KEYEVENTF_KEYUP = 2
[XenonMedia.Keys]::keybd_event([byte]$Key, 0, $KEYEVENTF_EXTENDEDKEY, [UIntPtr]::Zero)
[XenonMedia.Keys]::keybd_event([byte]$Key, 0, $KEYEVENTF_EXTENDEDKEY -bor $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
'{"ok":true}'
