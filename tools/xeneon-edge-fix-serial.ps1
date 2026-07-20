# Xeneon Edge - restore the EDID serial number (Windows-side, fully reversible).
#
# Some Xeneon Edge panels left the factory with a placeholder serial ("00") in the
# EDID that the video connection reports. iCUE reads the real serial from the panel
# over USB, then looks for a monitor whose EDID carries the same serial. On these
# panels it finds none, and Screen Setup says the Edge cannot be configured.
#
# This script writes NOTHING to the panel. It installs a Windows EDID override for
# the monitor device, so Windows reports the serial the panel already gives over USB.
# Only the serial text and the block checksum change; resolution and timings are
# untouched. Undo: delete the registry key printed at the end, then reboot.
#
# Run in an ADMINISTRATOR PowerShell, then REBOOT:
#   powershell -ExecutionPolicy Bypass -File .\xeneon-edge-fix-serial.ps1
#
# -Serial  the panel serial, if auto-detection cannot find it (see the iCUE log line
#          'No monitor found for serial "XXXXXXXXXXXX"')
# -WhatIf  show what would change and exit without writing anything

param([string]$Serial, [switch]$WhatIf)

$ErrorActionPreference = 'Stop'

try {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin -and -not $WhatIf) { throw 'Run this from an Administrator PowerShell window.' }

  # --- 1. the monitor device, and only the one that is actually connected ---
  # Windows keeps a devnode per port the panel was ever plugged into. Patching a
  # stale one silently does nothing, so require exactly one present device.
  $all = @(Get-PnpDevice -Class Monitor -ErrorAction Stop | Where-Object { $_.InstanceId -like 'DISPLAY\CRXED00\*' })
  $mon = @($all | Where-Object { $_.Present })
  if ($mon.Count -eq 0) {
    if ($all.Count -gt 0) { throw 'The XENEON EDGE is known to Windows but not connected right now. Plug it in and re-run.' }
    throw 'No XENEON EDGE monitor device found (DISPLAY\CRXED00\...).'
  }
  if ($mon.Count -gt 1) {
    throw ("More than one connected XENEON EDGE found; stopping rather than guessing:`n  " + ($mon.InstanceId -join "`n  "))
  }
  $mon = $mon[0]
  $dpPath = "HKLM:\SYSTEM\CurrentControlSet\Enum\$($mon.InstanceId)\Device Parameters"
  Write-Host "Monitor device : $($mon.InstanceId)"
  if ($all.Count -gt 1) { Write-Host "                 (ignoring $($all.Count - 1) stale devnode(s) from other ports)" -ForegroundColor DarkGray }

  # --- 2. the serial the panel reports over USB ---------------------------
  if (-not $Serial) {
    $usb = @(Get-PnpDevice -ErrorAction SilentlyContinue |
      Where-Object { $_.InstanceId -match '^USB\\VID_1B1C&PID_[0-9A-F]{4}\\\d{10,14}$' -and $_.Present })
    # PID_1D0D is the Edge itself; other Corsair gear can also carry numeric serials.
    $edge = @($usb | Where-Object { $_.InstanceId -match 'PID_1D0D' })
    $from = $usb
    if ($edge.Count -gt 0) { $from = $edge }
    $pick = @($from | ForEach-Object { $_.InstanceId.Split('\')[-1] } | Sort-Object -Unique)
    if ($pick.Count -eq 1) { $Serial = $pick[0] }
    elseif ($pick.Count -gt 1) {
      throw ("Found several Corsair USB serials. Re-run with the right one:`n  " + (($pick | ForEach-Object { "-Serial $_" }) -join "`n  "))
    } else {
      throw @'
Could not auto-detect the serial. Open your newest iCUE log in
  %LOCALAPPDATA%\Corsair\Logs\CUE5\
find the line
  No monitor found for serial "XXXXXXXXXXXX" for Device(CRXED00)
and re-run with  -Serial XXXXXXXXXXXX
'@
    }
  }
  if ($Serial -notmatch '^[\x20-\x7E]{1,13}$') { throw "Serial '$Serial' must be 1-13 printable ASCII characters." }
  Write-Host "USB serial     : $Serial"

  # --- 3. read the current EDID and back it up ----------------------------
  $edid = (Get-ItemProperty $dpPath -Name EDID -ErrorAction SilentlyContinue).EDID
  if (-not $edid -or $edid.Length -lt 128) { throw "Could not read an EDID from $dpPath" }
  if ((($edid[0..7] | ForEach-Object { '{0:X2}' -f $_ }) -join '') -ne '00FFFFFFFFFFFF00') { throw 'That registry value is not a valid EDID (bad header).' }

  # --- 4. patch the serial-string descriptor (tag 0xFF) -------------------
  $off = -1
  foreach ($o in 54, 72, 90, 108) {
    if ($edid[$o] -eq 0 -and $edid[$o+1] -eq 0 -and $edid[$o+2] -eq 0 -and $edid[$o+3] -eq 0xFF) { $off = $o; break }
  }
  if ($off -lt 0) { throw 'This EDID has no serial-string descriptor (tag 0xFF) to patch.' }
  $old = ([Text.Encoding]::ASCII.GetString($edid[($off+5)..($off+17)]) -replace '[\x00-\x1F]', '').Trim()
  Write-Host "EDID serial    : '$old'  ->  '$Serial'"
  if ($old -eq $Serial) { Write-Host 'Already correct, nothing to do.' -ForegroundColor Green; return }

  $new = [byte[]]$edid.Clone()
  $bytes = [Text.Encoding]::ASCII.GetBytes($Serial)
  for ($i = 0; $i -lt 13; $i++) {
    $new[$off+5+$i] = if ($i -lt $bytes.Length) { $bytes[$i] } elseif ($i -eq $bytes.Length) { [byte]0x0A } else { [byte]0x20 }
  }
  # block 0 checksum: bytes 0..127 must sum to 0 mod 256
  $sum = 0; for ($i = 0; $i -lt 127; $i++) { $sum = ($sum + $new[$i]) % 256 }
  $new[127] = [byte]((256 - $sum) % 256)
  $check = 0; for ($i = 0; $i -lt 128; $i++) { $check = ($check + $new[$i]) % 256 }
  if ($check -ne 0) { throw 'Internal error: checksum did not balance, refusing to write.' }

  if ($WhatIf) { Write-Host '-WhatIf: nothing written.' -ForegroundColor Yellow; return }

  $bak = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'xeneon-edge-EDID-original.bin'
  [IO.File]::WriteAllBytes($bak, $edid)
  Write-Host "Backup         : $bak"

  # --- 5. install the override and restart the monitor device -------------
  $ovPath = Join-Path $dpPath 'EDID_OVERRIDE'
  New-Item -Path $ovPath -Force | Out-Null
  Set-ItemProperty -Path $ovPath -Name '0' -Value ([byte[]]$new[0..127]) -Type Binary
  if ($new.Length -ge 256) { Set-ItemProperty -Path $ovPath -Name '1' -Value ([byte[]]$new[128..255]) -Type Binary }
  Write-Host "Override key   : $ovPath"

  Disable-PnpDevice -InstanceId $mon.InstanceId -Confirm:$false
  Start-Sleep -Seconds 2
  Enable-PnpDevice -InstanceId $mon.InstanceId -Confirm:$false
  Start-Sleep -Seconds 4

  Write-Host ''
  Write-Host 'Done. Now REBOOT Windows, then quit iCUE from the tray and start it again.' -ForegroundColor Green
  Write-Host "To undo: delete the registry key above, then reboot. Original EDID saved at $bak" -ForegroundColor DarkGray
} catch {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
