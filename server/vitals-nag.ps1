# Bit's PC-side nag — a small pixel-art popup in the corner of the real
# monitor(s), spawned by POST /api/vitals/nag (strict opt-in, enforced
# server-side). One-shot and self-terminating: the form slides in, sits for
# -Duration seconds, and the process exits — nothing long-lived to clean up at
# server shutdown.
#
#   -Text        the roast to display (server caps length + strips newlines)
#   -Mood        angry | ghost | worried  (border/sprite palette)
#   -AllScreens  popup on every monitor ("invasion") instead of primary only
#   -Duration    seconds before auto-close (click always dismisses)
#   -Minimize    minimize every window first, then show the popup as receipt
#
# The window is WS_EX_NOACTIVATE + non-focusable TopMost: it must NEVER steal
# focus from what the user is doing — it appears, it judges, it leaves.

param(
  [string]$Text = '',
  [string]$Mood = 'angry',
  [switch]$AllScreens,
  [int]$Duration = 9,
  [switch]$Minimize,
  [string]$Font = 'Consolas'   # body font; server picks a CJK-capable one for ko/ja/zh
)

$ErrorActionPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'   # Add-Type warns about the no-public-member form subclass

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('XenonNagForm' -as [type])) {
  Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class XenonNagForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE — never steal focus
      return cp;
    }
  }
  // The server spawns powershell with windowsHide (STARTUPINFO wShowWindow =
  // SW_HIDE), which Windows applies to the process's FIRST ShowWindow call —
  // silently hiding the popup. Bypass it with an explicit no-activate show.
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
  public void ForceShowNoActivate() { ShowWindow(this.Handle, 4); } // SW_SHOWNOACTIVATE
}
"@
}

if ($Minimize) {
  try { (New-Object -ComObject Shell.Application).MinimizeAll() } catch {}
}

# Sanitize + cap (server already does; belt and braces).
$Text = ($Text -replace '[\r\n\t]+', ' ')
if ($Text.Length -gt 220) { $Text = $Text.Substring(0, 220) }
if ($Text -eq '') { $Text = 'BIT SAYS: TAKE CARE OF YOURSELF.' }
if ($Duration -lt 3) { $Duration = 3 }
if ($Duration -gt 30) { $Duration = 30 }

# ── 12x12 pixel sprite (mirrors the dashboard pet) ──
$angryRows = @(
  '......B.....',
  'W.....B.....',
  '...BBBBBB..W',
  '..BKKBBKKB..',
  '..BBKBBKBB..',
  '..BBKBBKBB..',
  '..BBBBBBBB..',
  '..BBBKBKBB..',
  '..BBKBKBBB..',
  '...BBBBBB...',
  '...BB..BB...',
  '............'
)
$ghostRows = @(
  '............',
  '...WWWWWW...',
  '..WWWWWWWW..',
  '..WWWWWWWW..',
  '..WWKWWKWW..',
  '..WWKWWKWW..',
  '..WWWWWWWW..',
  '..WWWKKWWW..',
  '..WWWWWWWW..',
  '..W.W..W.W..',
  '............',
  '............'
)

$accent = [System.Drawing.Color]::FromArgb(255, 90, 95)
$rows = $angryRows
if ($Mood -eq 'ghost')   { $rows = $ghostRows;  $accent = [System.Drawing.Color]::FromArgb(232, 244, 255) }
if ($Mood -eq 'worried') { $accent = [System.Drawing.Color]::FromArgb(255, 166, 87) }

$ink  = [System.Drawing.Color]::FromArgb(13, 17, 23)
$body = $accent
$white = [System.Drawing.Color]::FromArgb(232, 244, 255)

$bmp = New-Object System.Drawing.Bitmap(12, 12)
for ($y = 0; $y -lt 12; $y++) {
  $line = $rows[$y]
  for ($x = 0; $x -lt 12; $x++) {
    $ch = $line[$x]
    if ($ch -eq 'B') { $bmp.SetPixel($x, $y, $body) }
    elseif ($ch -eq 'K') { $bmp.SetPixel($x, $y, $ink) }
    elseif ($ch -eq 'W') { $bmp.SetPixel($x, $y, $white) }
  }
}

# ── one popup per target screen ──
$screens = @([System.Windows.Forms.Screen]::PrimaryScreen)
if ($AllScreens) { $screens = [System.Windows.Forms.Screen]::AllScreens }

$formW = 384
$pad = 14
$spriteSize = 72
$textW = $formW - $spriteSize - (3 * $pad)

$measure = New-Object System.Drawing.Bitmap(1, 1)
$mg = [System.Drawing.Graphics]::FromImage($measure)
# Body font honours -Font (CJK scripts need Malgun Gothic / Yu Gothic UI / YaHei —
# Consolas has no CJK glyphs). Fall back to Consolas if the named font is missing;
# GDI+ silently substitutes anyway, but this keeps the intent explicit. The header
# is ASCII ("BIT // XENON VITALS"), so it stays on Consolas.
# NB: do NOT name this `$font` — PowerShell variables are case-insensitive, so it
# would collide with the [string]-typed `$Font` parameter and get coerced back to a
# string, silently breaking every MeasureString/DrawString (header shows, body blank).
try { $bodyFont = New-Object System.Drawing.Font($Font, 11, [System.Drawing.FontStyle]::Bold) }
catch { $bodyFont = New-Object System.Drawing.Font('Consolas', 11, [System.Drawing.FontStyle]::Bold) }
$headFont = New-Object System.Drawing.Font('Consolas', 8, [System.Drawing.FontStyle]::Bold)
$textSize = $mg.MeasureString($Text, $bodyFont, $textW)
$formH = [int][math]::Max($spriteSize + 2 * $pad, $textSize.Height + 30 + 2 * $pad)
$mg.Dispose()
$measure.Dispose()

$forms = New-Object System.Collections.ArrayList
$timers = New-Object System.Collections.ArrayList

foreach ($scr in $screens) {
  $wa = $scr.WorkingArea
  $form = New-Object XenonNagForm
  $form.Text = 'XenonBitNag'   # invisible (no border) but lets tests/tools find the window
  $form.FormBorderStyle = 'None'
  $form.StartPosition = 'Manual'
  $form.ShowInTaskbar = $false
  $form.TopMost = $true
  $form.BackColor = $ink
  $form.Size = New-Object System.Drawing.Size($formW, $formH)
  $targetX = $wa.Right - $formW - 24
  $startX = $wa.Right + 8
  $y = $wa.Bottom - $formH - 24
  $form.Location = New-Object System.Drawing.Point($startX, $y)

  $form.Add_Paint({
    param($s, $e)
    $g = $e.Graphics
    # 3px pixel border
    $pen = New-Object System.Drawing.Pen($accent, 3)
    $g.DrawRectangle($pen, 1, 1, $s.Width - 3, $s.Height - 3)
    $pen.Dispose()
    # sprite, nearest-neighbour scaled
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $sy = [int](($s.Height - $spriteSize) / 2)
    $g.DrawImage($bmp, (New-Object System.Drawing.Rectangle($pad, $sy, $spriteSize, $spriteSize)))
    # header + roast
    $ab = New-Object System.Drawing.SolidBrush($accent)
    $wb = New-Object System.Drawing.SolidBrush($white)
    $tx = $pad + $spriteSize + $pad
    $g.DrawString('BIT // XENON VITALS', $headFont, $ab, $tx, $pad)
    $rect = New-Object System.Drawing.RectangleF($tx, ($pad + 20), $textW, ($s.Height - $pad - 20))
    $g.DrawString($Text, $bodyFont, $wb, $rect)
    $ab.Dispose(); $wb.Dispose()
  }.GetNewClosure())

  $form.Add_Click({ [System.Windows.Forms.Application]::Exit() })

  # Slide-in from the right edge.
  $slide = New-Object System.Windows.Forms.Timer
  $slide.Interval = 15
  $slide.Add_Tick({
    $dx = $form.Location.X - $targetX
    if ($dx -le 2) {
      $form.Location = New-Object System.Drawing.Point($targetX, $y)
      $slide.Stop()
    } else {
      $form.Location = New-Object System.Drawing.Point(($form.Location.X - [int][math]::Max(3, $dx * 0.22)), $y)
    }
  }.GetNewClosure())

  [void]$forms.Add($form)
  [void]$timers.Add($slide)
}

$life = New-Object System.Windows.Forms.Timer
$life.Interval = $Duration * 1000
$life.Add_Tick({ [System.Windows.Forms.Application]::Exit() })

foreach ($i in 0..($forms.Count - 1)) {
  $forms[$i].Show()
  $forms[$i].ForceShowNoActivate()  # beat the spawn-time SW_HIDE (see class comment)
  $timers[$i].Start()
}
$life.Start()
[System.Windows.Forms.Application]::Run()

foreach ($f in $forms) { try { $f.Dispose() } catch {} }
$bmp.Dispose()
$bodyFont.Dispose()
$headFont.Dispose()
