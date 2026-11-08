$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

# Battery percent of wireless peripherals - mouse, keyboard, headset, phone -
# read from the PnP property Windows populates for devices that report a battery
# level (DEVPKEY_Bluetooth_Battery). Neither Bluetooth nor the PnP layer exposes
# a charging state, so only { name, percent } is emitted.
#
# Two things are deliberate and load-bearing:
#
# 1. The sweep covers the WHOLE PnP tree, not PNPClass='Bluetooth'. Windows files
#    a device's battery under whichever node owns the profile: a Bluetooth
#    headset's level lives on a PNPClass='System' node ("<name> Hands-Free AG"),
#    so a class filter silently loses headsets. 338 devices sweep in ~2s.
# 2. Devices are dropped when DEVPKEY_Device_IsConnected is explicitly False.
#    Windows keeps the LAST KNOWN percent of a paired device forever - a keyboard
#    unpaired-in-practice for a year still reports Status=OK and a year-old
#    percent, which would show as a live reading. Absent property => keep (not
#    every device reports it); only an explicit False means "not here now".
#    The node with the battery is not always the one that knows: a connected
#    headset's "Hands-Free AG" node says False while its own Bluetooth node says
#    True. So any node of the device saying True wins, matched by name.
#
# Devices behind a proprietary 2.4GHz dongle (Logitech Unifying/Lightspeed and
# most custom-keyboard receivers) expose NO battery to Windows at all - their
# level rides a vendor HID protocol. They cannot appear here; that needs a
# per-vendor reader, not a wider sweep.
$batteryKey   = '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2'
$connectedKey = '{83DA6326-97A6-4088-9453-A1923F573B29} 15'

# Windows appends the Bluetooth profile role to the node name ("Zone Vibe 100
# Hands-Free AG"). Not localized - these are protocol names - so trimming them
# is safe and gives the user the device name they know.
$profileSuffix = '\s+(Hands-Free (AG|HF)|Stereo|AVRCP Transport|Avrcp Transport)$'

$devices = @()
$seen = @{}
$readings = @()
$connectedNames = @{}
try {
  $entities = @(Get-CimInstance -ClassName Win32_PnPEntity -ErrorAction Stop)
  foreach ($dev in $entities) {
    try {
      $name = ([string]$dev.Name).Trim()
      if (-not $name) { continue }

      $res = Invoke-CimMethod -InputObject $dev -MethodName GetDeviceProperties -Arguments @{ devicePropertyKeys = [string[]]@($batteryKey, $connectedKey) } -ErrorAction SilentlyContinue
      if ($null -eq $res -or $null -eq $res.deviceProperties) { continue }

      $raw = $null
      $connected = $null
      foreach ($prop in @($res.deviceProperties)) {
        if ($prop.KeyName -eq $batteryKey) { $raw = $prop.Data }
        elseif ($prop.KeyName -eq $connectedKey) { $connected = $prop.Data }
      }
      $name = ($name -replace $profileSuffix, '').Trim()
      if (-not $name) { continue }
      if ($name.Length -gt 64) { $name = $name.Substring(0, 64) }
      $key = $name.ToLowerInvariant()
      # Two headphones of one model share a name: the address in a node's id tells them
      # apart. Not every node has it (HID ones do not), and it stays inside the server.
      $unit = ''
      if (([string]$dev.DeviceID) -match '(?:DEV_|[&_])([0-9A-Fa-f]{12})(?:[\\_&]|$)') { $unit = $Matches[1].ToUpperInvariant() }
      $who = "$key|$unit"
      if ($connected -is [bool] -and $connected) {
        $connectedNames[$who] = $true
        $connectedNames[$key] = $true
      }
      if ($null -eq $raw) { continue }

      $percent = 0
      if (-not [int]::TryParse(([string]$raw), [ref]$percent)) { continue }
      if ($percent -lt 0 -or $percent -gt 100) { continue }

      $gone = $connected -is [bool] -and -not $connected
      $readings += [pscustomobject]@{ key = $key; who = $who; unit = $unit; name = $name; percent = $percent; gone = $gone }
    } catch { }
  }
} catch { }

# Nodes with an address first, so one without it can tell it mirrors a device already listed.
$withAddress = @($readings | Where-Object { $_.unit })
$withoutAddress = @($readings | Where-Object { -not $_.unit })
foreach ($reading in ($withAddress + $withoutAddress)) {
  # A node that says connected and has no address could be either twin, so it speaks for both.
  $here = $connectedNames.ContainsKey($reading.who) -or $connectedNames.ContainsKey("$($reading.key)|") -or (-not $reading.unit -and $connectedNames.ContainsKey($reading.key))
  if ($reading.gone -and -not $here) { continue }

  # One entry per device: a single peripheral owns several PnP nodes (audio
  # profile, HID service, transport) that mirror the same battery.
  if ($seen.ContainsKey($reading.who)) { continue }
  if (-not $reading.unit -and $seen.ContainsKey($reading.key)) { continue }
  $seen[$reading.who] = $true
  $seen[$reading.key] = $true

  $devices += [pscustomobject]@{ name = $reading.name; percent = $reading.percent; unit = $reading.unit }
}

# System battery packs (laptops) and USB-connected UPS units: Win32_Battery is
# the one source here that also knows the charging state. A desktop tower with
# no UPS simply enumerates nothing - silent no-op.
try {
  foreach ($b in @(Get-CimInstance -ClassName Win32_Battery -ErrorAction Stop)) {
    try {
      $name = ([string]$b.Name).Trim()
      if (-not $name) { $name = 'Battery' }
      if ($name.Length -gt 64) { $name = $name.Substring(0, 64) }
      $percent = [int]$b.EstimatedChargeRemaining
      if ($percent -lt 0 -or $percent -gt 100) { continue }
      # Win32_Battery.BatteryStatus: 6-9 are charging states; 2 is "on AC power
      # (not necessarily charging)" per the Microsoft docs - close enough to what
      # the charging badge means (plugged in) to include it.
      $charging = @(2, 6, 7, 8, 9) -contains [int]$b.BatteryStatus

      $key = $name.ToLowerInvariant()
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true

      $devices += [pscustomobject]@{ name = $name; percent = $percent; charging = $charging; type = 'system' }
    } catch { }
  }
} catch { }

[pscustomobject]@{ devices = @($devices) } | ConvertTo-Json -Compress -Depth 4
