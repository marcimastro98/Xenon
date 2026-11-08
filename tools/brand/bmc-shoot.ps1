# Turns the pages tools/brand/bmc.mjs wrote into PNGs, with headless Edge.
param([Parameter(Mandatory = $true)][string]$Folder)
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$sizes = & node (Join-Path $PSScriptRoot 'bmc.mjs') $Folder
foreach ($line in $sizes) {
  $name, $w, $h = $line -split ' '
  $page = Join-Path $Folder "$name.html"
  $png = Join-Path $Folder "$name.png"
  $profile = Join-Path $Folder '.edge'
  $url = 'file:///' + ($page -replace '\\', '/')
  $args = @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', "--user-data-dir=$profile",
    "--window-size=$w,$h", '--virtual-time-budget=2000', "--screenshot=$png", $url)
  Start-Process -FilePath $edge -ArgumentList $args -Wait -WindowStyle Hidden
  "$name $w x $h"
}
