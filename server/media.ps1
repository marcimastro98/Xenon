param(
  [ValidateSet('info', 'playpause', 'next', 'previous')]
  [string]$Action = 'info',

  [string]$PreferredSource = '',

  # Persistent host mode: keep ONE process alive holding the SMTC session
  # manager and answer requests over stdin/stdout instead of paying the
  # ~150-300ms CLR + WinRT startup on every poll (the dashboard polls media
  # every 2s — one-shot spawning was the server's dominant CPU/temp cost).
  # Protocol (one message per line, both directions):
  #   stdin  : {"id":N,"action":"info","preferredSource":"..."}
  #   stdout : "XEMED " + base64( UTF8( {"id":N,"ok":bool,"out":"<json>","err":"..."} ) )
  # Base64-framing keeps any payload (newlines, braces) from breaking the line
  # protocol. On stdin EOF the loop ends and the process exits cleanly, which is
  # how its WinRT/COM broker handles must be released (never hard-kill first).
  [switch]$Serve
)

$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$script:bootstrapError = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

  $script:AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.IsGenericMethod -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1)
} catch {
  $script:bootstrapError = $_.Exception.Message
}

function Await($Operation, [Type]$ResultType, [int]$TimeoutMs = 4000) {
  $task = $script:AsTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  if (-not $task.Wait($TimeoutMs)) {
    throw "WinRT operation timed out after $TimeoutMs ms"
  }
  $task.Result
}

# The session manager is acquired lazily and cached for the lifetime of the
# process (one-shot: a single request; serve: every request). On any request
# failure it is dropped so the next request re-acquires a fresh one.
$script:manager = $null

# Self-heal a wedged media broker (parity with the native helper's MediaHost.cs,
# issue #80). After the PC has been idle a while the SMTC broker can go stale so
# GetSessions() returns an EMPTY list WITHOUT throwing — the catch-block drop
# below never fires and the cached manager stays blind to any track started
# afterwards ("Nothing playing" forever, the reported bug). A streak of empty
# enumerations drops the manager so the next request re-acquires a fresh one,
# exactly as the one-shot reader does on every call. A genuinely idle machine
# trips the streak too, so re-acquires are floored by a cooldown; a wedged broker
# still heals within ~a minute of music actually starting.
$script:emptyEnumerations = 0
$script:lastEmptyReacquire = [DateTime]::MinValue
$MEDIA_EMPTY_REACQUIRE_STREAK = 3        # empty enumerations before re-acquiring
$MEDIA_REACQUIRE_COOLDOWN_MS  = 60000    # floor between streak-triggered re-acquires
function Get-MediaManager {
  if ($null -ne $script:manager) { return $script:manager }
  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $script:manager = Await ($managerType::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  return $script:manager
}

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
    # Spotify (and a few other apps) only push a fresh SMTC timeline on events
    # (play/pause/seek/track change), so the raw Position goes stale mid-song.
    # While playing, project it forward by the wall-clock time since the app's
    # own LastUpdatedTime stamp, scaled by the playback rate. A missing stamp
    # (default epoch -> absurd elapsed) skips the projection, and so does a zero
    # duration (live streams/radio): with nothing to clamp against the projection
    # would grow without bound - same rule as server.js liveMediaSnapshot.
    if ($status -eq 'Playing' -and $duration -gt 0) {
      $elapsed = ([DateTimeOffset]::UtcNow - $timeline.LastUpdatedTime).TotalSeconds
      if ($elapsed -gt 0 -and $elapsed -lt 86400) {
        $rate = 1.0
        $pr = $playback.PlaybackRate
        if ($null -ne $pr -and $pr -gt 0 -and $pr -le 16) { $rate = [double]$pr }
        $position += [int][Math]::Round($elapsed * $rate)
      }
      if ($position -gt $duration) { $position = $duration }
    }
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

# Album-art read with a single-slot per-track cache (serve mode only): the art
# only changes with the track, so re-opening the WinRT thumbnail stream and
# re-encoding ~50-100KB of base64 on EVERY 2s poll was pure waste. A failed
# read is NOT cached, so a transient broker hiccup retries on the next poll.
$script:thumbCacheKey = $null
$script:thumbCacheValue = $null
function Read-Thumbnail($Selected) {
  if ($null -eq $Selected -or $null -eq $Selected.thumbnailRef) { return $null }
  $cacheKey = ($Selected.source + '|' + $Selected.title + '|' + $Selected.artist + '|' + $Selected.album)
  if ($Serve -and $cacheKey -eq $script:thumbCacheKey) { return $script:thumbCacheValue }

  $thumbnail = $null
  $stream = $null
  $inStream = $null
  $reader = $null
  try {
    $streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $stream = Await ($Selected.thumbnailRef.OpenReadAsync()) $streamType
    if ($stream.Size -gt 0 -and $stream.Size -lt 5242880) {
      $inStream = $stream.GetInputStreamAt(0)
      $reader = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]::new($inStream)
      [void](Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32]))
      $bytes = New-Object byte[] ([int]$stream.Size)
      $reader.ReadBytes($bytes)
      $contentType = if ($stream.ContentType) { [string]$stream.ContentType } else { 'image/jpeg' }
      $thumbnail = 'data:' + $contentType + ';base64,' + [Convert]::ToBase64String($bytes)
    }
  } catch {
    $thumbnail = $null
  } finally {
    # Release WinRT/COM handles in reverse order. Without this the system media
    # broker accumulates dangling references after every poll and eventually
    # starts refusing new SMTC sessions (widget freezes on last snapshot, other
    # SMTC consumers stop receiving updates).
    if ($reader)   { try { $reader.Dispose()   } catch {} }
    if ($inStream) { try { $inStream.Dispose() } catch {} }
    if ($stream)   { try { $stream.Dispose()   } catch {} }
    $reader = $null
    $inStream = $null
    $stream = $null
  }

  if ($Serve -and $null -ne $thumbnail) {
    $script:thumbCacheKey = $cacheKey
    $script:thumbCacheValue = $thumbnail
  }
  return $thumbnail
}

# One full request: session enumeration, scoring/selection, then either the
# control action or the info payload. Always returns a hashtable (never exits,
# never throws), so the serve loop survives any per-request failure.
function Invoke-MediaRequest([string]$ReqAction, [string]$ReqPreferredSource) {
  $preferredSourceSafe = [string]$ReqPreferredSource
  if ($script:bootstrapError) {
    return @{ active = $false; app = ''; source = ''; title = ''; artist = ''; album = ''; playbackStatus = 'Unavailable'; thumbnail = $null; position = 0; duration = 0; sessions = @(); preferredSource = $preferredSourceSafe; selectionMode = 'auto'; error = $script:bootstrapError }
  }
  try {
    $manager = Get-MediaManager
    $currentSession = $manager.GetCurrentSession()
    $sessions = @($manager.GetSessions())

    $candidates = @()
    foreach ($candidate in $sessions) {
      try {
        $candidates += Get-SessionInfo $candidate ($candidate -eq $currentSession)
      } catch { }
    }

    # Self-heal a wedged broker: an empty enumeration doesn't throw, so the cached
    # manager would otherwise stay blind forever (#80). Drop it after a short streak
    # so the next request re-acquires a fresh manager; reset the moment we see any
    # session again. Floored by a cooldown so a genuinely idle machine stays cheap.
    if ($candidates.Count -gt 0) {
      $script:emptyEnumerations = 0
    } else {
      $script:emptyEnumerations++
      if ($script:emptyEnumerations -ge $MEDIA_EMPTY_REACQUIRE_STREAK) {
        $script:emptyEnumerations = 0
        if (([DateTime]::UtcNow - $script:lastEmptyReacquire).TotalMilliseconds -ge $MEDIA_REACQUIRE_COOLDOWN_MS) {
          $script:lastEmptyReacquire = [DateTime]::UtcNow
          $script:manager = $null   # next request re-acquires a fresh manager
        }
      }
    }

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
      return @{ active = $false; app = ''; source = ''; title = ''; artist = ''; album = ''; playbackStatus = 'Closed'; thumbnail = $null; position = 0; duration = 0; sessions = @(); preferredSource = $preferredSourceSafe; selectionMode = 'auto' }
    }

    if ($ReqAction -ne 'info') {
      $ok = $false
      switch ($ReqAction) {
        'playpause' { $ok = Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
        'next'      { $ok = Await ($session.TrySkipNextAsync())       ([bool]) }
        'previous'  { $ok = Await ($session.TrySkipPreviousAsync())   ([bool]) }
      }
      return @{ ok = [bool]$ok; source = $selected.source; app = $selected.app }
    }

    $thumbnail = Read-Thumbnail $selected

    return @{
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
    # Drop the cached manager: if the media broker RPC went away (logon/lock,
    # broker restart) the next request must re-acquire instead of failing forever.
    $script:manager = $null
    return @{ active = $false; app = ''; source = ''; title = ''; artist = ''; album = ''; playbackStatus = 'Unavailable'; thumbnail = $null; position = 0; duration = 0; sessions = @(); preferredSource = $preferredSourceSafe; selectionMode = 'auto'; error = $_.Exception.Message }
  }
}

if (-not $Serve) {
  # One-shot mode (unchanged contract): emit a single JSON object and exit.
  # Kept as the transparent fallback path when the persistent host is down.
  Invoke-MediaRequest $Action $PreferredSource | ConvertTo-Json -Depth 8 -Compress
  [Console]::Out.Flush()
  [Environment]::Exit(0)
}

# ── Serve mode ────────────────────────────────────────────────────────────────
if ($script:bootstrapError) { [Environment]::Exit(1) }   # Node falls back to one-shot

function Write-Frame($obj) {
  $json = ConvertTo-Json $obj -Compress -Depth 8
  $b64  = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  [Console]::Out.WriteLine('XEMED ' + $b64)
  [Console]::Out.Flush()
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }            # stdin closed: parent gone, exit cleanly
  $line = $line.Trim()
  if ($line -eq '') { continue }

  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id  = $req.id
    $result = Invoke-MediaRequest ([string]$req.action) ([string]$req.preferredSource)
    Write-Frame ([pscustomobject]@{ id = $id; ok = $true; out = (ConvertTo-Json $result -Depth 8 -Compress); err = '' })
  } catch {
    Write-Frame ([pscustomobject]@{ id = $id; ok = $false; out = ''; err = $_.Exception.Message })
  }
}
