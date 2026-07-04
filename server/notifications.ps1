# ─────────────────────────────────────────────────────────────────────────
# Windows notification mirror — PowerShell fallback for the native helper's
# notifications-serve mode (used transparently when xenon-helper.exe is
# absent). Reads the toasts currently in Action Center via the WinRT
# UserNotificationListener and prints the same bare JSON lines:
#
#   {"event":"status","status":"allowed"|"denied"|"unavailable"}
#   {"event":"seed","items":[item,...]}          # newest first, once at start
#   {"event":"notification","item":{...}}        # each new toast afterwards
#
# item = {id, app, aumid, title, body, at, icon} — icon is always null here
# (app-logo decoding stays a helper nicety); lengths are capped at this
# boundary so the server never receives a runaway payload.
#
# Polling, not events: NotificationChanged is documented-broken without
# package identity; ids are session-monotonic so "new" is id > maxSeen.
# Long-lived loop like foreground.ps1 — the server owns the child lifetime.
# ─────────────────────────────────────────────────────────────────────────
param([int]$IntervalMs = 2000)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Emit($obj) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 5))
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $script:AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.IsGenericMethod -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1)
  $script:listenerType = [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $script:listener = $script:listenerType::Current
} catch {
  Emit @{ event = 'status'; status = 'unavailable' }
  exit 1
}

function Await($Operation, [Type]$ResultType, [int]$TimeoutMs = 4000) {
  $task = $script:AsTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  if (-not $task.Wait($TimeoutMs)) {
    throw "WinRT operation timed out after $TimeoutMs ms"
  }
  $task.Result
}

function Get-AccessState {
  # RequestAccessAsync first (may show the one-time consent), GetAccessStatus
  # as the cheap re-check; either throwing means an identity-gated build.
  param([switch]$Request)
  try {
    if ($Request) {
      $status = Await ($script:listener.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
    } else {
      $status = $script:listener.GetAccessStatus()
    }
    if ("$status" -eq 'Allowed') { return 'allowed' }
    return 'denied'
  } catch {
    if ($Request) { return (Get-AccessState) }
    return 'unavailable'
  }
}

function Cap([string]$s, [int]$max) {
  if ($null -eq $s) { return '' }
  if ($s.Length -le $max) { return $s }
  return $s.Substring(0, $max)
}

function Project($n) {
  $app = ''; $aumid = ''
  try { $app = $n.AppInfo.DisplayInfo.DisplayName } catch { }
  try { $aumid = $n.AppInfo.AppUserModelId } catch { }
  $title = ''; $body = ''
  try {
    $binding = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
    if ($binding) {
      $texts = @($binding.GetTextElements() | ForEach-Object { "$($_.Text)".Trim() } | Where-Object { $_.Length -gt 0 })
      if ($texts.Count -gt 0) { $title = $texts[0] }
      if ($texts.Count -gt 1) { $body = ($texts | Select-Object -Skip 1) -join "`n" }
    }
  } catch { }
  $at = 0
  try { $at = $n.CreationTime.ToUnixTimeMilliseconds() } catch { }
  return @{
    id    = [long]$n.Id
    app   = Cap $app 200
    aumid = Cap $aumid 200
    title = Cap $title 200
    body  = Cap $body 400
    at    = $at
    icon  = $null
  }
}

function Read-Current {
  $listType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]
  return @(Await ($script:listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) $listType)
}

$state = Get-AccessState -Request
Emit @{ event = 'status'; status = $state }
if ($state -eq 'unavailable') { exit 1 }

$maxSeen = -1
while ($true) {
  try {
    if ($state -ne 'allowed') {
      # Denied: the user can grant access in Windows Settings at any time —
      # keep re-checking cheaply so the feed self-heals.
      $s = Get-AccessState
      if ($s -ne $state) { $state = $s; Emit @{ event = 'status'; status = $s } }
      if ($s -ne 'allowed') { Start-Sleep -Milliseconds 5000; continue }
    }

    $current = Read-Current
    if ($maxSeen -lt 0) {
      # First successful read: seed with what's in Action Center now (newest
      # first, capped) instead of flooding one event per line.
      $seed = @($current | Sort-Object -Property Id -Descending | Select-Object -First 30 | ForEach-Object { Project $_ })
      Emit @{ event = 'seed'; items = $seed }
      $maxSeen = 0
      foreach ($n in $current) { if ([long]$n.Id -gt $maxSeen) { $maxSeen = [long]$n.Id } }
    } else {
      foreach ($n in @($current | Where-Object { [long]$_.Id -gt $maxSeen } | Sort-Object -Property Id)) {
        Emit @{ event = 'notification'; item = (Project $n) }
        $maxSeen = [long]$n.Id
      }
    }
  } catch {
    # Transient WinRT hiccup: keep the loop alive, next tick retries. If access
    # was revoked the status probe above notices on the next pass.
    $state = Get-AccessState
  }
  Start-Sleep -Milliseconds $IntervalMs
}
