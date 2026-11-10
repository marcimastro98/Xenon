# A plain window maximized on the main screen, in front, standing in for the browser a
# KVM switch user leaves open. It closes itself after -Seconds so a failed run leaves
# nothing behind. Started by check.ps1.
param([int]$Seconds = 90)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$primary = [System.Windows.Forms.Screen]::PrimaryScreen
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Xenon KVM check'
$form.BackColor = [System.Drawing.Color]::FromArgb(200, 60, 40)
$form.StartPosition = 'Manual'
$form.Bounds = $primary.Bounds
$form.WindowState = 'Maximized'
$label = New-Object System.Windows.Forms.Label
$label.Text = 'KVM CHECK WINDOW'
$label.ForeColor = [System.Drawing.Color]::White
$label.Font = New-Object System.Drawing.Font('Segoe UI', 48, [System.Drawing.FontStyle]::Bold)
$label.Dock = 'Fill'
$label.TextAlign = 'MiddleCenter'
$form.Controls.Add($label)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $Seconds * 1000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
