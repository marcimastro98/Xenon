$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

# Battery percent of paired Bluetooth (LE) peripherals — mouse, keyboard,
# headset — read from the PnP device property Windows populates for devices
# that implement the GATT battery service (DEVPKEY_Bluetooth_Battery).
# Bluetooth exposes no charging state, so only { name, percent } is emitted;
# devices without the property (or asleep) are skipped per-device.
#
# Deliberately CIM, not the PnpDevice cmdlets: Get-PnpDeviceProperty costs
# ~450ms PER DEVICE (18s over a typical 37-device Bluetooth tree — past every
# sane timeout), while Win32_PnPEntity + GetDeviceProperties reads the same
# property in ~800ms total. Keep this path if you touch this file.
$batteryKey = '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2'

$devices = @()
$seen = @{}
try {
  $entities = @(Get-CimInstance -ClassName Win32_PnPEntity -Filter "PNPClass='Bluetooth' AND Status='OK'" -ErrorAction Stop)
  foreach ($dev in $entities) {
    try {
      $name = ([string]$dev.Name).Trim()
      if (-not $name) { continue }

      # One query per device: pairing creates sibling PnP nodes (AVRCP, audio,
      # HID service…) that share the friendly name, so skip a name already
      # answered rather than paying the CIM round-trip again.
      $key = $name.ToLowerInvariant()
      if ($seen.ContainsKey($key)) { continue }

      $res = Invoke-CimMethod -InputObject $dev -MethodName GetDeviceProperties -Arguments @{ devicePropertyKeys = [string[]]@($batteryKey) } -ErrorAction SilentlyContinue
      if ($null -eq $res -or $null -eq $res.deviceProperties) { continue }

      foreach ($prop in @($res.deviceProperties)) {
        if ($null -eq $prop.Data) { continue }
        $percent = 0
        if (-not [int]::TryParse(([string]$prop.Data), [ref]$percent)) { continue }
        if ($percent -lt 0 -or $percent -gt 100) { continue }
        if ($name.Length -gt 64) { $name = $name.Substring(0, 64) }
        $seen[$key] = $true
        $devices += [pscustomobject]@{ name = $name; percent = $percent }
        break
      }
    } catch { }
  }
} catch { }

[pscustomobject]@{ devices = @($devices) } | ConvertTo-Json -Compress -Depth 4
