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
        # Set WorkingDirectory to the exe's own folder so apps that look for
        # resources relative to themselves (e.g. OBS locale/) can find them.
        $dir = Split-Path -Parent $value
        if ($dir -and (Test-Path -LiteralPath $dir -PathType Container)) {
          Start-Process -FilePath $value -WorkingDirectory $dir
        } else {
          Start-Process -FilePath $value
        }
      }
    }
    'openapp' {
      # Launch a Store/UWP app by its AppUserModelID via the shell's Apps folder.
      # The AUMID is validated server-side (PackageFamilyName!AppId) before we get here.
      Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + $value)
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
