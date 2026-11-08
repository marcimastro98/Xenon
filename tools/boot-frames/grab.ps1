# Frames of one screen while something starts, for reading a start-up frame by frame. Real pixels,
# per-monitor aware, so any monitor works. Windows only. Layer windows stay out of screen grabs.
# usage: grab.ps1 -Dir <folder> -Name <device name, e.g. DISPLAY5> -Seconds 14 -EveryMs 180 -Scale 0.4
param([string]$Dir, [string]$Name = 'DISPLAY5', [double]$Seconds = 14, [int]$EveryMs = 180, [double]$Scale = 0.4)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Dpi3 {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
[Dpi3]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.DeviceName -like "*$Name" } | Select-Object -First 1
if (-not $screen) { throw "no screen $Name" }
$b = $screen.Bounds
"screen $($b.X),$($b.Y) $($b.Width)x$($b.Height)"
New-Item -ItemType Directory -Force $Dir | Out-Null
$sw = [int]($b.Width * $Scale); $sh = [int]($b.Height * $Scale)
$end = (Get-Date).AddSeconds($Seconds)
$n = 0
$start = Get-Date
while ((Get-Date) -lt $end) {
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $g.Dispose()
  $small = New-Object System.Drawing.Bitmap $sw, $sh
  $s = [System.Drawing.Graphics]::FromImage($small)
  $s.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
  $s.DrawImage($bmp, 0, 0, $sw, $sh)
  $s.Dispose()
  $ms = [int]((Get-Date) - $start).TotalMilliseconds
  $small.Save((Join-Path $Dir ('f{0:d3}-{1:d6}.png' -f $n, $ms)), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose(); $small.Dispose()
  $n++
  Start-Sleep -Milliseconds $EveryMs
}
"frames $n"
