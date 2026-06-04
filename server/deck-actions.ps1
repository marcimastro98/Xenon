param([string]$verb, [string]$value)
$ErrorActionPreference = 'Stop'
try {
  switch ($verb) {
    'open' {
      # A folder opens most reliably (and comes to the foreground) via Explorer;
      # files / apps / URLs go through the shell's default handler.
      if (Test-Path -LiteralPath $value -PathType Container) {
        Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $value + '"')
      } else {
        Start-Process -FilePath $value
      }
    }
    default {
      Write-Output '{"ok":false,"error":"bad_verb"}'
      exit
    }
  }
  Write-Output '{"ok":true}'
} catch {
  $msg = ($_.Exception.Message -replace '\\', '\\' -replace '"', '\"')
  Write-Output ('{"ok":false,"error":"' + $msg + '"}')
}
