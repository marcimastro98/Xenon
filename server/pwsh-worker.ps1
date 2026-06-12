# Persistent PowerShell collector host for XenonEdge Hub.
#
# Spawning powershell.exe for every poll pays the ~150ms CLR + engine startup
# cost each time, which dominates the server's steady-state CPU. This long-lived
# host runs the read-only sensor collectors (gpu / cpu-temp / network) in ONE
# process, so that cost is paid once instead of on every refresh.
#
# Protocol (one message per line, both directions):
#   stdin  : {"id":N,"script":"gpu.ps1","args":[...]}
#   stdout : "XEHWK " + base64( UTF8( {"id":N,"ok":bool,"out":"...","err":"..."} ) )
# Base64-framing the response keeps any script output (newlines, braces, etc.)
# from ever breaking the line protocol.
#
# Only exit-free, SMTC-free collectors are allowed through here. media.ps1
# (WinRT / SMTC) runs in its OWN persistent host (`media.ps1 -Serve`): it holds
# broker handles that must be released by a clean process exit, so Node retires
# it gracefully (stdin close), whereas these collectors only touch
# LibreHardwareMonitor / perf counters, whose handles the OS reclaims on
# process death — which is why the Node side can safely kill a wedged worker.

$ErrorActionPreference = 'Continue'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$root  = $PSScriptRoot
$allow = @{ 'gpu.ps1' = $true; 'cpu-temp.ps1' = $true; 'network.ps1' = $true }

function Write-Frame($obj) {
  $json = ConvertTo-Json $obj -Compress -Depth 8
  $b64  = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  [Console]::Out.WriteLine('XEHWK ' + $b64)
  [Console]::Out.Flush()
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }            # stdin closed: parent gone, exit cleanly
  $line = $line.Trim()
  if ($line -eq '') { continue }

  $id = $null
  try {
    $req  = $line | ConvertFrom-Json
    $id   = $req.id
    $name = [string]$req.script
    if (-not $allow.ContainsKey($name)) {
      Write-Frame ([pscustomobject]@{ id = $id; ok = $false; out = ''; err = 'script not allowed' })
      continue
    }
    $scriptPath = Join-Path $root $name
    $argList = @()
    if ($null -ne $req.args) { $argList = @($req.args | ForEach-Object { [string]$_ }) }

    # Call operator runs the collector in a child scope, so its $script:-scoped
    # state resets per call and its (exit-free) body returns here instead of
    # terminating this host. The collectors trap their own errors and always emit
    # JSON, so $out is the JSON text we hand back verbatim.
    $out = (& $scriptPath @argList 2>$null | Out-String)
    Write-Frame ([pscustomobject]@{ id = $id; ok = $true; out = $out; err = '' })
  } catch {
    Write-Frame ([pscustomobject]@{ id = $id; ok = $false; out = ''; err = $_.Exception.Message })
  }
}
