# Runs the REAL Invoke-UpdaterHandoff out of the shipped update-apply.ps1 through
# every outcome it can reach. Only Start-Process is stubbed.
#
# The function is lifted by AST into a file of its own and dot-sourced, so
# $PSCommandPath inside it is a path this test owns -- and so that file can then
# be overwritten under the already-loaded function, which is precisely what step 3
# does to the real updater while it is running.
$src = Join-Path (Split-Path -Parent $PSScriptRoot) 'update-apply.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($src, [ref]$tokens, [ref]$errors)
if ($errors.Count) { Write-Host 'PARSE FAILED'; exit 1 }
$fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-UpdaterHandoff' }, $true)
if ($fn.Count -ne 1) { Write-Host "expected 1 Invoke-UpdaterHandoff, found $($fn.Count)"; exit 1 }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("ho-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$updDir = Join-Path $tmp 'update'; New-Item -ItemType Directory -Force -Path $updDir | Out-Null
$selfPath = Join-Path $tmp 'update-apply.ps1'
Set-Content -LiteralPath $selfPath -Value $fn[0].Extent.Text -NoNewline
. $selfPath
$env:WINDIR = $tmp

$script:logLines = @()
function Log($m) { $script:logLines += $m }

$script:spCalls = 0; $script:spWritesMarker = $true; $script:spExit = 0; $script:spThrows = $false
function Start-Process {
  param([string]$FilePath, $ArgumentList, $WindowStyle, [switch]$PassThru, [switch]$Wait, $ErrorAction)
  $script:spCalls++
  if ($script:spThrows) { throw 'simulated launch failure' }
  if ($script:spWritesMarker) { New-Item -ItemType File -Force -Path (Join-Path $updDir 'handoff.started') | Out-Null }
  return [pscustomobject]@{ ExitCode = $script:spExit }
}

$script:fails = 0
function Check($name, $cond, $detail) {
  if ($cond) { Write-Host ("  ok   " + $name) } else { Write-Host ("  FAIL " + $name + " -- " + $detail); $script:fails++ }
}
function HashOf($content) {
  $f = Join-Path $tmp 'h.tmp'; Set-Content -LiteralPath $f -Value $content -NoNewline
  return (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash
}
function Reset($content, $baseline) {
  Set-Content -LiteralPath $selfPath -Value $content -NoNewline   # <- the real step 3
  $script:selfHashBefore = $baseline
  $script:logLines = @(); $script:spCalls = 0
  Remove-Item -LiteralPath (Join-Path $updDir 'handoff.started') -Force -ErrorAction SilentlyContinue
}
$OLD = 'the updater that was already installed'
$NEW = 'the updater this update brings with it'

Write-Host 'A. the update ships the SAME updater -> no hand-off, nothing launched'
Reset $OLD (HashOf $OLD)
$r = Invoke-UpdaterHandoff '4.11.6'
Check 'returns null (carry on in-process)' ($null -eq $r) "got '$r'"
Check 'never launched anything' ($script:spCalls -eq 0) "calls=$($script:spCalls)"
Check 'says why' (($script:logLines -join '|') -match 'same updater') ($script:logLines -join '|')

Write-Host 'B. a DIFFERENT updater that runs and succeeds -> its exit code wins'
Reset $NEW (HashOf $OLD)
$script:spWritesMarker = $true; $script:spExit = 0; $script:spThrows = $false
$r = Invoke-UpdaterHandoff '4.11.6'
Check 'returns 0 (stop here, success)' ($r -eq 0) "got '$r'"
Check 'launched exactly once' ($script:spCalls -eq 1) "calls=$($script:spCalls)"
Check 'marker cleaned up afterwards' (-not (Test-Path (Join-Path $updDir 'handoff.started'))) 'marker left behind'

Write-Host 'C. a DIFFERENT updater that runs and FAILS -> propagated, never retried here'
Reset $NEW (HashOf $OLD)
$script:spExit = 1
$r = Invoke-UpdaterHandoff '4.11.6'
Check 'returns 1 (stop here, failed)' ($r -eq 1) "got '$r'"
Check 'did NOT fall through to a second attempt' ($script:spCalls -eq 1) "calls=$($script:spCalls)"

Write-Host 'D. the successor never starts -> carry on in-process (nothing was done)'
Reset $NEW (HashOf $OLD)
$script:spWritesMarker = $false; $script:spExit = 9
$r = Invoke-UpdaterHandoff '4.11.6'
Check 'returns null despite a non-zero exit' ($null -eq $r) "got '$r'"
Check 'says the successor never started' (($script:logLines -join '|') -match 'never started') ($script:logLines -join '|')

Write-Host 'E. launching throws -> carry on in-process'
Reset $NEW (HashOf $OLD)
$script:spWritesMarker = $true; $script:spThrows = $true
$r = Invoke-UpdaterHandoff '4.11.6'
Check 'returns null' ($null -eq $r) "got '$r'"
Check 'records the reason' (($script:logLines -join '|') -match 'could not hand over') ($script:logLines -join '|')

Write-Host 'F. no baseline hash -> never hands off'
Reset $NEW ''
$script:spThrows = $false
$r = Invoke-UpdaterHandoff '4.11.6'
Check 'returns null' ($null -eq $r) "got '$r'"
Check 'nothing launched' ($script:spCalls -eq 0) "calls=$($script:spCalls)"

Write-Host 'G. the successor is passed -Resume and the version it cannot read any more'
Reset $NEW (HashOf $OLD)
$script:capturedArgs = $null
function Start-Process {
  param([string]$FilePath, $ArgumentList, $WindowStyle, [switch]$PassThru, [switch]$Wait, $ErrorAction)
  $script:capturedArgs = ($ArgumentList -join ' ')
  New-Item -ItemType File -Force -Path (Join-Path $updDir 'handoff.started') | Out-Null
  return [pscustomobject]@{ ExitCode = 0 }
}
$null = Invoke-UpdaterHandoff '4.11.6'
Check 'passes -Resume' ($script:capturedArgs -match '(^| )-Resume( |$)') "args: $($script:capturedArgs)"
Check 'passes -FromVersion 4.11.6' ($script:capturedArgs -match '-FromVersion "4\.11\.6"') "args: $($script:capturedArgs)"
Check 'passes -Worker (the successor must not relaunch itself)' ($script:capturedArgs -match '(^| )-Worker( |$)') "args: $($script:capturedArgs)"
Check 'no elevation switch (inherits this token, no second UAC)' ($script:capturedArgs -notmatch 'RunAs') "args: $($script:capturedArgs)"

Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
if ($script:fails) { Write-Host "$($script:fails) CHECK(S) FAILED"; exit 1 }
Write-Host 'ALL HAND-OFF CHECKS PASSED'
