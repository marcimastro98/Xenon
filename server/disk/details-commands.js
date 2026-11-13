// The two PowerShell questions that read drive details on Windows: volumes, and the name of
// each physical disk.

const VOLUME_DETAILS_COMMAND = `
    $ErrorActionPreference = 'Stop'
    try {
      $volumes = @(Get-Volume -ErrorAction Stop | Where-Object { $_.DriveLetter } | ForEach-Object {
        [pscustomobject]@{
          drive = (([string]$_.DriveLetter + ':').ToUpperInvariant())
          label = ([string]$_.FileSystemLabel).Trim()
          fileSystem = ([string]$_.FileSystem).Trim()
          driveType = ([string]$_.DriveType).Trim()
        }
      })
    } catch {
      # Guarded on its own: an unguarded fallback that throws takes the whole
      # script down with it, and this one is the last answer there is.
      try {
        $volumes = @(Get-CimInstance Win32_LogicalDisk -ErrorAction Stop | Where-Object { $_.DeviceID } | ForEach-Object {
          [pscustomobject]@{
            drive = ([string]$_.DeviceID).Trim()
            label = ([string]$_.VolumeName).Trim()
            fileSystem = ([string]$_.FileSystem).Trim()
            driveType = ([string]$_.Description).Trim()
          }
        })
      } catch { $volumes = @() }
    }
    [pscustomobject]@{ volumes = $volumes } | ConvertTo-Json -Depth 4 -Compress
`;

const DISK_MODELS_COMMAND = `
    $ErrorActionPreference = 'Stop'
    try {
      $diskNames = @{}
      Get-Disk -ErrorAction Stop | ForEach-Object {
        $diskNames[[int]$_.Number] = ([string]$_.FriendlyName).Trim()
      }
      $models = @(Get-Partition -ErrorAction Stop | Where-Object { $_.DriveLetter } | ForEach-Object {
        [pscustomobject]@{
          drive = (([string]$_.DriveLetter + ':').ToUpperInvariant())
          model = ([string]$diskNames[[int]$_.DiskNumber]).Trim()
        }
      })
    } catch { $models = @() }
    [pscustomobject]@{ models = $models } | ConvertTo-Json -Depth 4 -Compress
`;

module.exports = { VOLUME_DETAILS_COMMAND, DISK_MODELS_COMMAND };
