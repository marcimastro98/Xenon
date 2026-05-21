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

# ----- FPS + GPU FRAME LATENCY -----
# Non disponibili nativamente: nvidia-smi NON espone FPS/frame latency dei giochi.
# Per dati reali serve PresentMon (NVIDIA FrameView) in esecuzione e parsing del log.
# Restituiamo $null: la UI mostrera' "N/D".
$fps = $null
$gpuLatency = $null

@{
  ping       = $ping
  latency    = $latency
  rxBytes    = $rx
  txBytes    = $tx
  fps        = $fps
  gpuLatency = $gpuLatency
} | ConvertTo-Json -Compress
