# ─────────────────────────────────────────────────────────────────────────
# Windows Search catalog host for the local file search (Spotlight).
#
# Queries the SystemIndex catalog over the Search.CollatorDSO OLE DB provider
# via ADODB COM — no admin rights, no extra install, and the index already
# covers file names AND document contents for everything Windows indexes.
# ADODB via COM is why this lives in PowerShell and not the C# helper: the
# helper is trimmed self-contained and System.Data.OleDb would drag trimming
# risk into it for a query PowerShell does natively. It also means search
# works for EVERY install, helper or not.
#
# Persistent host, own process: pwsh-worker.ps1 answers serially and an
# interactive as-you-type query must never stall a sensor read behind it (the
# same reason battery.ps1 is excluded there). Node spawns this on the first
# query and retires it (stdin close) after idle.
#
# Protocol (one message per line, both directions, mirrors pwsh-worker):
#   stdin  : {"id":N,"q":{"terms":[],"exts":[],"after":ms,"before":ms,
#             "minBytes":n,"maxBytes":n,"content":bool,"max":n}}
#   stdout : "XESRCH " + base64( UTF8( {"id":N,"ok":bool,"out":[...],"err":"..."} ) )
# out is an ARRAY of {p,n,s,m}: full path, file name, size, mtime (ms epoch).
#
# SECURITY: this script accepts a STRUCTURED query and builds the SQL itself —
# never SQL from the wire. Terms are single-quote-escaped and stripped of LIKE
# wildcards; extensions are charset-checked; numbers are cast. A caller that
# somehow injected here would still only be querying an index it already owns,
# but the boundary is kept clean anyway.
# ─────────────────────────────────────────────────────────────────────────
param([switch]$Serve)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$script:conn = $null

function Get-Connection {
  if ($script:conn) { return $script:conn }
  $c = New-Object -ComObject ADODB.Connection
  # Throws when the Windows Search service is disabled — surfaced to Node as
  # 'wds_unavailable' so the UI can say exactly that.
  $c.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
  $script:conn = $c
  return $c
}

# Term → safe SQL fragment: drop LIKE wildcards and brackets, double the quotes.
function Sanitize-Term([string]$t) {
  $s = $t -replace '[%_\[\]\^"]', ''
  return ($s -replace "'", "''")
}

function Build-Sql($q) {
  $max = 100
  if ($q.max -is [int] -or $q.max -is [long]) { $max = [Math]::Max(1, [Math]::Min(200, [int]$q.max)) }
  $conds = New-Object System.Collections.Generic.List[string]
  $conds.Add("SCOPE='file:'")

  foreach ($raw in @($q.terms)) {
    if ($null -eq $raw) { continue }
    $t = Sanitize-Term ([string]$raw)
    if ($t.Length -lt 1 -or $t.Length -gt 64) { continue }
    if ($q.content) {
      # Name match OR indexed-content match. Which one hit is not knowable
      # per-row; Node treats every row as a potential content hit and lets the
      # ranker floor the ones whose NAME does not match.
      $conds.Add("(System.FileName LIKE '%$t%' OR CONTAINS(System.Search.Contents, '""$t""'))")
    } else {
      $conds.Add("(System.FileName LIKE '%$t%')")
    }
  }

  # WDS SQL has no IN — an OR chain of equals is the supported form.
  $exts = New-Object System.Collections.Generic.List[string]
  foreach ($raw in @($q.exts)) {
    if ($null -eq $raw) { continue }
    $e = ([string]$raw).ToLowerInvariant()
    if ($e -match '^[a-z0-9]{1,6}$') { $exts.Add("System.FileExtension = '.$e'") }
  }
  if ($exts.Count -gt 0) { $conds.Add('(' + ($exts -join ' OR ') + ')') }

  # Epoch ms → UTC literal; the provider compares datetime literals in UTC.
  if ($q.after -is [long] -or $q.after -is [int] -or $q.after -is [double]) {
    $dt = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$q.after).UtcDateTime
    $conds.Add("System.DateModified >= '" + $dt.ToString('yyyy-MM-dd HH:mm:ss') + "'")
  }
  if ($q.before -is [long] -or $q.before -is [int] -or $q.before -is [double]) {
    $dt = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$q.before).UtcDateTime
    $conds.Add("System.DateModified < '" + $dt.ToString('yyyy-MM-dd HH:mm:ss') + "'")
  }
  if ($q.minBytes -is [long] -or $q.minBytes -is [int] -or $q.minBytes -is [double]) {
    $conds.Add('System.Size >= ' + [long]$q.minBytes)
  }
  if ($q.maxBytes -is [long] -or $q.maxBytes -is [int] -or $q.maxBytes -is [double]) {
    $conds.Add('System.Size <= ' + [long]$q.maxBytes)
  }

  # System.ItemUrl, NOT System.ItemPathDisplay: the display path is LOCALIZED
  # ("C:\Utenti\...\Download" on an Italian Windows) and does not exist on the
  # filesystem — opening it would fail. ItemUrl carries the real path.
  return "SELECT TOP $max System.ItemUrl, System.FileName, System.Size, System.DateModified " +
         'FROM SystemIndex WHERE ' + ($conds -join ' AND ') +
         ' ORDER BY System.DateModified DESC'
}

function Run-Query($q) {
  $sql = Build-Sql $q
  $conn = Get-Connection
  $rs = $conn.Execute($sql)
  $items = New-Object System.Collections.Generic.List[object]
  try {
    while (-not $rs.EOF) {
      $u = $rs.Fields.Item('System.ItemUrl').Value
      $n = $rs.Fields.Item('System.FileName').Value
      $s = $rs.Fields.Item('System.Size').Value
      $m = $rs.Fields.Item('System.DateModified').Value
      # ItemUrl → real filesystem path: "file:C:/Users/x/y.txt" (sometimes
      # "file://C:/..."), URL-escaped. Non-file URLs (mapi:, etc.) are skipped.
      $p = $null
      if ($u -is [string] -and $u.StartsWith('file:')) {
        $rest = $u.Substring(5).TrimStart('/')
        try { $p = [Uri]::UnescapeDataString($rest).Replace('/', '\') } catch { $p = $null }
      }
      $ms = 0
      if ($m -is [DateTime]) {
        # The provider hands the datetime back in UTC.
        $ms = ([DateTimeOffset][DateTime]::SpecifyKind($m, [DateTimeKind]::Utc)).ToUnixTimeMilliseconds()
      }
      # Folders report a DBNull size — treat as 0 rather than crash the frame.
      $size = 0L
      if ($s -ne $null -and $s -isnot [DBNull]) { try { $size = [long]$s } catch { $size = 0L } }
      if ($p -is [string] -and $p.Length -gt 0) {
        $items.Add([pscustomobject]@{ p = $p; n = [string]$n; s = $size; m = $ms })
      }
      $rs.MoveNext()
    }
  } finally {
    try { $rs.Close() } catch {}
  }
  return $items
}

function Write-Frame($obj) {
  $json = ConvertTo-Json $obj -Compress -Depth 6
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  [Console]::Out.WriteLine('XESRCH ' + $b64)
  [Console]::Out.Flush()
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }   # stdin closed: parent gone, exit cleanly
  $line = $line.Trim()
  if ($line -eq '') { continue }

  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $items = Run-Query $req.q
    # ConvertTo-Json folds a single-item list into a bare object; wrap so the
    # wire shape is always an array.
    Write-Frame ([pscustomobject]@{ id = $id; ok = $true; out = @($items); err = '' })
  } catch {
    $msg = $_.Exception.Message
    # The provider/service being unavailable is a recognizable state the UI
    # explains ("Windows Search is off"), not a generic failure.
    if ($msg -match 'CollatorDSO|0x80040154|provider|WSearch|Search service') { $msg = 'wds_unavailable' }
    Write-Frame ([pscustomobject]@{ id = $id; ok = $false; out = @(); err = $msg })
  }
}

# Release the COM connection on clean exit.
if ($script:conn) { try { $script:conn.Close() } catch {} }
