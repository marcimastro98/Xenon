# -SkipFps: il server lo passa quando PresentMon e' disponibile (la sua lettura
# ha comunque la precedenza). Evita il campionamento DWM, che dorme 600ms DENTRO
# il worker seriale a ogni poll bloccando anche le altre letture in coda.
param([switch]$SkipFps)

$ErrorActionPreference = 'SilentlyContinue'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

# ----- PING + LATENZA (verso 1.1.1.1, 3 echo per misurare jitter) -----
# Ping .NET diretto: Test-Connection in PowerShell 5.1 passa da WMI
# (Win32_PingStatus) e costava piu' di tutto il resto del collector. Questo
# script gira ogni 3s nel worker mentre il pannello Sistema e' visibile.
$ping = $null
$latency = $null
try {
  if (-not $global:XenonPinger) { $global:XenonPinger = New-Object System.Net.NetworkInformation.Ping }
  $rtts = @()
  for ($i = 0; $i -lt 3; $i++) {
    try {
      $reply = $global:XenonPinger.Send('1.1.1.1', 800)
      if ($reply -and $reply.Status -eq [System.Net.NetworkInformation.IPStatus]::Success) {
        $rtts += [int]$reply.RoundtripTime
      }
    } catch { }
  }
  if ($rtts.Count -gt 0) {
    $ping = [int](($rtts | Measure-Object -Average).Average)
    if ($rtts.Count -gt 1) {
      $min = ($rtts | Measure-Object -Minimum).Minimum
      $max = ($rtts | Measure-Object -Maximum).Maximum
      $latency = [int]($max - $min)
    } else {
      $latency = 0
    }
  }
} catch { }

# ----- BANDWIDTH (byte cumulativi sugli adapter fisici "Up") -----
# server.js calcola la velocita' istantanea facendo la differenza tra letture
# consecutive. Lettura .NET pura (niente CIM/WMI): GetAllNetworkInterfaces e'
# in-process. Il filtro tipo+descrizione replica Get-NetAdapter -Physical
# escludendo loopback, tunnel/VPN e adapter virtuali (che duplicherebbero i byte).
$rx = 0
$tx = 0
try {
  foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($nic.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
    $nicType = $nic.NetworkInterfaceType.ToString()
    if ($nicType -ne 'Ethernet' -and $nicType -ne 'GigabitEthernet' -and $nicType -ne 'Wireless80211') { continue }
    if ($nic.Description -match 'virtual|hyper-v|vmware|virtualbox|tap|tun(nel)?|vpn|loopback|bluetooth') { continue }
    $stats = $nic.GetIPv4Statistics()
    if ($stats.BytesReceived) { $rx += [int64]$stats.BytesReceived }
    if ($stats.BytesSent)     { $tx += [int64]$stats.BytesSent }
  }
} catch { }

# ----- FPS (solo senza PresentMon) -----
# Metodo 1: LibreHardwareMonitor via WMI (se l'app LHM e' in esecuzione)
$fps = $null
$gpuLatency = $null
if (-not $SkipFps) {
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
}

@{
  ping       = $ping
  latency    = $latency
  rxBytes    = $rx
  txBytes    = $tx
  fps        = $fps
  gpuLatency = $gpuLatency
} | ConvertTo-Json -Compress
