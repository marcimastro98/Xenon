param(
  [ValidateSet('info', 'playpause', 'next', 'previous')]
  [string]$Action = 'info',

  [string]$PreferredSource = ''
)

$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Write-Json($Value) {
  $Value | ConvertTo-Json -Depth 8 -Compress
}

function Complete-Json($Value) {
  Write-Json $Value
  [Console]::Out.Flush()
  [Environment]::Exit(0)
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

  $script:AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.IsGenericMethod -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1)

  function Await($Operation, [Type]$ResultType, [int]$TimeoutMs = 4000) {
    $task = $script:AsTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    if (-not $task.Wait($TimeoutMs)) {
      throw "WinRT operation timed out after $TimeoutMs ms"
    }
    $task.Result
  }

  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $manager = Await ($managerType::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $currentSession = $manager.GetCurrentSession()
  $sessions = @($manager.GetSessions())

  function Get-AppName($Source, $Title, $Album) {
    if ($Source -match 'Spotify') { return 'Spotify' }
    if (($Title -match 'YouTube') -or ($Album -match 'YouTube')) { return 'YouTube' }
    if ($Source -match 'Chrome|MSEdge|Firefox|Brave|Opera') { return 'YouTube' }
    if ($Source -match 'ZuneMusic|ZuneVideo|MicrosoftMediaPlayer|WindowsMediaPlayer') { return 'Lettore Multimediale' }
    if ($Source -match 'Music') { return 'Music' }
    if ([string]::IsNullOrWhiteSpace($Source)) { return 'Media' }
    # Strip Windows package format: Publisher.Name_hash!AppId → Name
    if ($Source -match '^(?:[^.]+\.)+([^._!]+)[_!]') { return $matches[1] }
    return $Source
  }

  function Get-SessionInfo($Session, $IsCurrent) {
    $mediaPropsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
    $props = Await ($Session.TryGetMediaPropertiesAsync()) $mediaPropsType
    $playback = $Session.GetPlaybackInfo()
    $timeline = $Session.GetTimelineProperties()
    $source = [string]$Session.SourceAppUserModelId
    $status = [string]$playback.PlaybackStatus
    $title = [string]$props.Title
    $artist = [string]$props.Artist
    $album = [string]$props.AlbumTitle
    $app = Get-AppName $source $title $album

    if ($app -eq 'Spotify' -and [string]::IsNullOrWhiteSpace($artist) -and $title -match '^(.+?)\s+-\s+(.+)$') {
      $artist = $matches[1].Trim()
      $title = $matches[2].Trim()
    }

    $score = 0
    if ($status -eq 'Playing') { $score += 1000 }
    elseif ($status -eq 'Paused') { $score += 300 }
    elseif ($status -eq 'Stopped') { $score += 50 }
    if ($title) { $score += 120 }
    if ($artist) { $score += 40 }
    if ($app -match 'Spotify|YouTube|Browser') { $score += 80 }
    if ($IsCurrent) { $score += 15 }
    if ($source -match 'ShellExperienceHost|System|Windows') { $score -= 500 }
    if ($title -match 'Microsoft|Windows|Operating System') { $score -= 500 }

    $duration = 0
    $position = 0
    try {
      $duration = [Math]::Max(0, [int][Math]::Round(($timeline.EndTime - $timeline.StartTime).TotalSeconds))
      $position = [Math]::Max(0, [int][Math]::Round(($timeline.Position - $timeline.StartTime).TotalSeconds))
    } catch { }

    return [pscustomobject]@{
      session = $Session
      score = $score
      source = $source
      app = $app
      title = $title
      artist = $artist
      album = $album
      playbackStatus = $status
      position = $position
      duration = $duration
      thumbnailRef = $props.Thumbnail
    }
  }

  function New-SessionSummary($Info, $SelectedSource) {
    [pscustomobject]@{
      source = $Info.source
      app = $Info.app
      title = $Info.title
      artist = $Info.artist
      album = $Info.album
      playbackStatus = $Info.playbackStatus
      activePlayback = ($Info.playbackStatus -eq 'Playing' -and -not [string]::IsNullOrWhiteSpace(($Info.title + $Info.artist + $Info.app)))
      position = $Info.position
      duration = $Info.duration
      score = $Info.score
      selected = ($Info.source -eq $SelectedSource)
    }
  }

  $candidates = @()
  foreach ($candidate in $sessions) {
    try {
      $candidates += Get-SessionInfo $candidate ($candidate -eq $currentSession)
    } catch { }
  }

  $preferredSourceSafe = [string]$PreferredSource
  $activeCandidates = @($candidates | Where-Object { $_.playbackStatus -eq 'Playing' -and -not [string]::IsNullOrWhiteSpace(($_.title + $_.artist + $_.app)) })
  $selected = $null
  $selectionMode = 'auto'
  if (-not [string]::IsNullOrWhiteSpace($preferredSourceSafe)) {
    $selected = $activeCandidates | Where-Object { $_.source -eq $preferredSourceSafe } | Sort-Object score -Descending | Select-Object -First 1
    if ($selected) { $selectionMode = 'preferred' }
  }
  if (-not $selected) {
    $selected = $candidates | Sort-Object score -Descending | Select-Object -First 1
  }
  $session = if ($selected) { $selected.session } else { $currentSession }
  $sessionSummaries = @($candidates | Sort-Object score -Descending | ForEach-Object { New-SessionSummary $_ $selected.source })

  if ($null -eq $session) {
    Complete-Json @{ active = $false; app = ''; source = ''; title = ''; artist = ''; album = ''; playbackStatus = 'Closed'; thumbnail = $null; position = 0; duration = 0; sessions = @(); preferredSource = $preferredSourceSafe; selectionMode = 'auto' }
  }

  if ($Action -ne 'info') {
    switch ($Action) {
      'playpause' { $ok = Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
      'next'      { $ok = Await ($session.TrySkipNextAsync())       ([bool]) }
      'previous'  { $ok = Await ($session.TrySkipPreviousAsync())   ([bool]) }
    }
    Complete-Json @{ ok = [bool]$ok; source = $selected.source; app = $selected.app }
  }

  $thumbnail = $null
  $stream = $null
  $input = $null
  $reader = $null
  try {
    if ($null -ne $selected.thumbnailRef) {
      $streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
      $stream = Await ($selected.thumbnailRef.OpenReadAsync()) $streamType
      if ($stream.Size -gt 0 -and $stream.Size -lt 5242880) {
        $input = $stream.GetInputStreamAt(0)
        $reader = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]::new($input)
        [void](Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32]))
        $bytes = New-Object byte[] ([int]$stream.Size)
        $reader.ReadBytes($bytes)
        $contentType = if ($stream.ContentType) { [string]$stream.ContentType } else { 'image/jpeg' }
        $thumbnail = 'data:' + $contentType + ';base64,' + [Convert]::ToBase64String($bytes)
      }
    }
  } catch {
    $thumbnail = $null
  } finally {
    # Release WinRT/COM handles in reverse order. Without this the system media
    # broker accumulates dangling references after every poll and eventually
    # starts refusing new SMTC sessions (widget freezes on last snapshot, other
    # SMTC consumers stop receiving updates).
    if ($reader) { try { $reader.Dispose() } catch {} }
    if ($input)  { try { $input.Dispose()  } catch {} }
    if ($stream) { try { $stream.Dispose() } catch {} }
    $reader = $null
    $input  = $null
    $stream = $null
  }

  Complete-Json @{
    active = $true
    app = $selected.app
    source = $selected.source
    title = $selected.title
    artist = $selected.artist
    album = $selected.album
    playbackStatus = $selected.playbackStatus
    thumbnail = $thumbnail
    position = $selected.position
    duration = $selected.duration
    score = $selected.score
    sessions = $sessionSummaries
    preferredSource = $preferredSourceSafe
    selectionMode = $selectionMode
  }
} catch {
  Complete-Json @{ active = $false; app = ''; source = ''; title = ''; artist = ''; album = ''; playbackStatus = 'Unavailable'; thumbnail = $null; position = 0; duration = 0; sessions = @(); preferredSource = [string]$PreferredSource; selectionMode = 'auto'; error = $_.Exception.Message }
}