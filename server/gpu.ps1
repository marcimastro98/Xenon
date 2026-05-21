$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$gpuName = $null
$gpuTemp = $null

try {
  $nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if ($nvidiaSmi) {
    $line = & $nvidiaSmi.Source --query-gpu=utilization.gpu,temperature.gpu,name --format=csv,noheader,nounits 2>$null | Select-Object -First 1
    if ($line -match '^\s*(\d+)\s*,\s*(\d+)\s*,\s*(.+?)\s*$') {
      @{ gpu = [int]$matches[1]; gpuTemp = [int]$matches[2]; gpuName = $matches[3] } | ConvertTo-Json -Compress
      exit 0
    }
    if ($line -match '^\s*(\d+)\s*,\s*(.+?)\s*$') {
      @{ gpu = [int]$matches[1]; gpuTemp = $null; gpuName = $matches[2] } | ConvertTo-Json -Compress
      exit 0
    }
  }
} catch { }

try {
  $gpuName = (Get-CimInstance Win32_VideoController |
    Where-Object { $_.Name -and $_.Status -eq 'OK' } |
    Sort-Object AdapterRAM -Descending |
    Select-Object -First 1 -ExpandProperty Name)
} catch { }

try {
  $samples = Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop
  $sum = 0
  foreach ($sample in $samples.CounterSamples) {
    if ($sample.InstanceName -match 'engtype_(3d|compute|videoencode|videodecode)') {
      $sum += $sample.CookedValue
    }
  }
  $gpu = [Math]::Min(100, [Math]::Max(0, [Math]::Round($sum, 0)))
  @{ gpu = $gpu; gpuTemp = $gpuTemp; gpuName = $gpuName } | ConvertTo-Json -Compress
} catch {
  @{ gpu = $null; gpuTemp = $gpuTemp; gpuName = $gpuName; error = $_.Exception.Message } | ConvertTo-Json -Compress
}