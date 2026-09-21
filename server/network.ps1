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
# Ogni adapter viene EMESSO, non scartato: il totale resta la somma dei soli
# fisici (il riquadro Rete mostra quello, e sommare una VPN conterebbe due volte
# lo stesso traffico), ma la lista li porta tutti con `kind` = physical|virtual,
# perche' chi monitora una VMnet o una scheda NAS vuole proprio quelle. Chiesto
# via Discord per un widget SDK.
#
# .NET puro, niente CIM: GetAllNetworkInterfaces + GetIPv4Statistics sono
# in-process, e questo script gira ogni 3s nel worker seriale.
$rx = 0
$tx = 0
$ifaces = New-Object System.Collections.ArrayList
try {
  foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    $nicType = $nic.NetworkInterfaceType.ToString()
    if ($nicType -eq 'Loopback') { continue }
    $up = ($nic.OperationalStatus -eq [System.Net.NetworkInformation.OperationalStatus]::Up)
    $real = ($nicType -eq 'Ethernet' -or $nicType -eq 'GigabitEthernet' -or $nicType -eq 'Wireless80211') -and
            ($nic.Description -notmatch 'virtual|hyper-v|vmware|virtualbox|tap|tun(nel)?|vpn|loopback|bluetooth')
    $stats = $null
    try { $stats = $nic.GetIPv4Statistics() } catch { }
    $nrx = 0; $ntx = 0
    if ($stats) {
      if ($stats.BytesReceived) { $nrx = [int64]$stats.BytesReceived }
      if ($stats.BytesSent)     { $ntx = [int64]$stats.BytesSent }
    }
    if ($up -and $real) { $rx += $nrx; $tx += $ntx }
    # `name` e' il nome che l'utente vede e rinomina in Windows; `description`
    # e' l'hardware. Sono due cose diverse e servono entrambe.
    [void]$ifaces.Add(@{
      id          = [string]$nic.Id
      name        = [string]$nic.Name
      description = [string]$nic.Description
      kind        = $(if ($real) { 'physical' } else { 'virtual' })
      up          = $up
      speedBps    = $(if ($nic.Speed -gt 0) { [int64]$nic.Speed } else { $null })
      rxBytes     = $nrx
      txBytes     = $ntx
    })
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

# -Depth 3: senza, ConvertTo-Json rende ogni hashtable dentro l'array come
# "System.Collections.Hashtable" e la lista arriva al server come stringhe.
@{
  ping       = $ping
  latency    = $latency
  rxBytes    = $rx
  txBytes    = $tx
  fps        = $fps
  gpuLatency = $gpuLatency
  interfaces = @($ifaces)
} | ConvertTo-Json -Compress -Depth 3
