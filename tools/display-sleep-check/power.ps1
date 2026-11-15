# The Windows side of tools/display-sleep-check: one action per run, JSON out.
#
#   off      turn every screen off, as the idle timer does (SC_MONITORPOWER 2)
#   wake     a tiny mouse move there and back, as a user waking the PC
#   events   display-driver and crash events since -SinceMs (ms since 1970, UTC)
#   reports  the kernel live dumps Windows wrote (LiveKernelReports)
#   hung     visible windows of the shell and its WebView2 that stopped answering
#   watch    write each screens on/off Windows announces (GUID_CONSOLE_DISPLAY_STATE)
#            to -Out, one "<ms> <state>" line each, for -Seconds; 0 off, 1 on, 2 dimmed
#
# Nothing is changed beyond the screens' power: no settings, no registry. (The
# display timeout the idle mode needs is set and put back by check.mjs.)
param(
  [Parameter(Mandatory)][ValidateSet('off', 'wake', 'events', 'reports', 'hung', 'watch')][string]$Action,
  [long]$SinceMs = 0,
  [string]$Out = '',
  [int]$Seconds = 0
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DisplaySleepCheck {
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  delegate bool EnumProc(IntPtr h, IntPtr l);

  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; }

  // Posted, not sent: a window that does not answer must not block the check.
  public static void Off() {
    PostMessage(new IntPtr(0xFFFF), 0x0112, new IntPtr(0xF170), new IntPtr(2));
  }

  public static void Wake() {
    var move = new INPUT[2];
    move[0].type = 0; move[0].mi.dx = 1; move[0].mi.flags = 1;
    move[1].type = 0; move[1].mi.dx = -1; move[1].mi.flags = 1;
    SendInput(2, move, Marshal.SizeOf(typeof(INPUT)));
  }

  public static List<string> Hung(HashSet<uint> pids) {
    var hung = new List<string>();
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid) && IsWindowVisible(h) && IsHungAppWindow(h)) {
        var t = new StringBuilder(256);
        GetWindowText(h, t, t.Capacity);
        hung.Add(pid + " " + t.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return hung;
  }
}
'@

if ($Action -eq 'watch') {
  Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class ScreensWatch : NativeWindow {
  [DllImport("user32.dll")] static extern IntPtr RegisterPowerSettingNotification(IntPtr h, ref Guid g, int flags);
  static Guid Display = new Guid("6FE69556-704A-47A0-8F24-C28D936FDA47");
  readonly string file;
  public ScreensWatch(string file) {
    this.file = file;
    CreateHandle(new CreateParams());
    RegisterPowerSettingNotification(Handle, ref Display, 0);
  }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x0218 && m.WParam.ToInt64() == 0x8013 && m.LParam != IntPtr.Zero) {
      var g = (Guid)Marshal.PtrToStructure(m.LParam, typeof(Guid));
      if (g == Display) {
        int state = Marshal.ReadInt32(m.LParam, 20);
        File.AppendAllText(file, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + " " + state + Environment.NewLine);
      }
    }
    base.WndProc(ref m);
  }
}
'@
  $watch = New-Object ScreensWatch $Out
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = [Math]::Max(1, $Seconds) * 1000
  $timer.add_Tick({ [System.Windows.Forms.Application]::Exit() })
  $timer.Start()
  [System.Windows.Forms.Application]::Run()
  exit 0
}

function Out-Json($value) { $value | ConvertTo-Json -Depth 4 -Compress }

switch ($Action) {
  'off' { [DisplaySleepCheck]::Off(); Out-Json @{ ok = $true } }
  'wake' { [DisplaySleepCheck]::Wake(); Out-Json @{ ok = $true } }
  'events' {
    $since = [DateTimeOffset]::FromUnixTimeMilliseconds($SinceMs).LocalDateTime
    $rows = @()
    $filters = @(
      @{ LogName = 'System'; Id = 4101, 41, 6008, 1001; StartTime = $since },
      @{ LogName = 'Application'; Id = 1001; StartTime = $since }
    )
    foreach ($f in $filters) {
      try {
        foreach ($e in Get-WinEvent -FilterHashtable $f -ErrorAction Stop) {
          $rows += @{ log = $e.LogName; id = $e.Id; provider = $e.ProviderName; at = $e.TimeCreated.ToUniversalTime().ToString('o'); message = [string]$e.Message }
        }
      } catch [Exception] {
        # "No events were found" is the normal answer; anything else is reported.
        if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { $rows += @{ log = $f.LogName; id = 0; provider = 'check'; at = ''; message = "could not read: $($_.Exception.Message)" } }
      }
    }
    Out-Json @($rows)
  }
  'reports' {
    $root = Join-Path $env:WINDIR 'LiveKernelReports'
    $files = @()
    try {
      foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction Stop) {
        $files += @{ path = $f.FullName; size = $f.Length; at = $f.LastWriteTimeUtc.ToString('o') }
      }
      Out-Json @{ readable = $true; files = @($files) }
    } catch { Out-Json @{ readable = $false; files = @($files); error = $_.Exception.Message } }
  }
  'hung' {
    $pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
    foreach ($p in Get-Process -Name 'xenon-native', 'msedgewebview2' -ErrorAction SilentlyContinue) { [void]$pids.Add([uint32]$p.Id) }
    Out-Json @{ watched = $pids.Count; hung = @([DisplaySleepCheck]::Hung($pids)) }
  }
}
