$ErrorActionPreference = 'SilentlyContinue'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

# ----- PING + LATENZA (verso 1.1.1.1, 3 echo per misurare jitter) -----
$ping = $null
$latency = $null
try {
  $samples = Test-Connection -ComputerName '1.1.1.1' -Count 3 -ErrorAction Stop
  if ($samples) {
    $rtts = @($samples | ForEach-Object {
      if ($_.PSObject.Properties['Latency'])      { [int]$_.Latency }
      elseif ($_.PSObject.Properties['ResponseTime']) { [int]$_.ResponseTime }
    }) | Where-Object { $_ -ne $null }
    if ($rtts.Count -gt 0) {
      $ping = [int]($rtts | Measure-Object -Average).Average
      if ($rtts.Count -gt 1) {
        $min = ($rtts | Measure-Object -Minimum).Minimum
        $max = ($rtts | Measure-Object -Maximum).Maximum
        $latency = [int]($max - $min)
      } else {
        $latency = 0
      }
    }
  }
} catch { }

# ----- BANDWIDTH (byte cumulativi su tutti gli adapter "Up") -----
# server.js calcola la velocita' istantanea facendo la differenza tra letture consecutive
$rx = 0
$tx = 0
try {
  $stats = Get-NetAdapter -Physical -ErrorAction Stop |
           Where-Object { $_.Status -eq 'Up' } |
           Get-NetAdapterStatistics -ErrorAction Stop
  foreach ($s in $stats) {
    if ($s.ReceivedBytes) { $rx += [int64]$s.ReceivedBytes }
    if ($s.SentBytes)     { $tx += [int64]$s.SentBytes }
  }
} catch { }

# ----- FPS -----
# Metodo 1: LibreHardwareMonitor via WMI (se LHM e' in esecuzione)
$fps = $null
$gpuLatency = $null
try {
  $lhmSensors = Get-CimInstance -Namespace 'root/LibreHardwareMonitor' -ClassName Sensor -ErrorAction Stop
  $fpsSensor  = @($lhmSensors | Where-Object { $_.SensorType -eq 'Fps' -and $_.Value -gt 0 }) | Select-Object -First 1
  if ($fpsSensor) { $fps = [int]$fpsSensor.Value }
} catch { }

# Metodo 2: contatore DWM cFramesDisplayed (funziona per giochi borderless/windowed)
# Struct DWM_TIMING_INFO: size=320, cFramesDisplayed a offset 208
if ($null -eq $fps) {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class DwmFps {
    [DllImport("dwmapi.dll")] static extern int DwmQueryCompositionTimingInfo(IntPtr h, IntPtr p);
    public static double Sample(int ms) {
        const int sz = 320, off = 208;
        IntPtr a = Marshal.AllocHGlobal(sz), b = Marshal.AllocHGlobal(sz);
        try {
            for (int i = 0; i < sz; i++) { Marshal.WriteByte(a, i, 0); Marshal.WriteByte(b, i, 0); }
            Marshal.WriteInt32(a, 0, sz);
            if (DwmQueryCompositionTimingInfo(IntPtr.Zero, a) != 0) return -1;
            Thread.Sleep(ms);
            Marshal.WriteInt32(b, 0, sz);
            if (DwmQueryCompositionTimingInfo(IntPtr.Zero, b) != 0) return -1;
            long d = Marshal.ReadInt64(b, off) - Marshal.ReadInt64(a, off);
            return (d > 0 && d < 3600) ? Math.Round(d * 1000.0 / ms, 0) : -1;
        } finally { Marshal.FreeHGlobal(a); Marshal.FreeHGlobal(b); }
    }
}
'@ -Language CSharp -ErrorAction Stop
    $v = [DwmFps]::Sample(600)
    if ($v -ge 1 -and $v -le 480) { $fps = [int]$v }
  } catch { }
}

@{
  ping       = $ping
  latency    = $latency
  rxBytes    = $rx
  txBytes    = $tx
  fps        = $fps
  gpuLatency = $gpuLatency
} | ConvertTo-Json -Compress
