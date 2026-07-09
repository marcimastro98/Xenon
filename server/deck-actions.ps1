param([string]$verb, [string]$value, [string]$opt)
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
    'runscript' {
      # Run a user-configured script. The path is validated server-side to an
      # existing, allowlisted script extension before we get here, and $value is
      # bound as a discrete param (no shell), so it can't break out. Each type is
      # dispatched to its interpreter: Windows scripts (.bat/.cmd) run directly;
      # .ps1 via powershell -File (not the Notepad edit-handler); .vbs/.vbe/.wsf
      # via cscript; .jar via java -jar; and .py/.js/.rb/.pl/.php/.lua/.r/.sh via
      # the matching interpreter on PATH. The window is VISIBLE by default (an
      # installer / interactive script needs its console) — the key opts into a
      # hidden window via $opt='hidden'. WorkingDirectory is the script's own
      # folder so relative paths resolve. A missing interpreter throws and is
      # reported as a clean error by the catch below.
      $ext = [System.IO.Path]::GetExtension($value).ToLowerInvariant()
      $dir = Split-Path -Parent $value
      $hasDir = ($dir -and (Test-Path -LiteralPath $dir -PathType Container))
      $hidden = ($opt -eq 'hidden')
      $ws = if ($hidden) { 'Hidden' } else { 'Normal' }
      # A file path can't contain a double-quote, so quoting is injection-safe.
      $quoted = '"' + $value + '"'
      # Extension → interpreter for the "run <interp> <script>" script types.
      $interp = @{
        '.py'='python'; '.pyw'='pythonw';
        '.js'='node'; '.cjs'='node'; '.mjs'='node';
        '.rb'='ruby'; '.pl'='perl'; '.php'='php'; '.lua'='lua'; '.r'='Rscript';
        '.sh'='bash'; '.bash'='bash'
      }
      $exe = $null
      $argLine = $null
      if ($ext -eq '.ps1') {
        $exe = 'powershell.exe'
        $wsFlag = if ($hidden) { '-WindowStyle Hidden ' } else { '' }
        $argLine = '-NoProfile -ExecutionPolicy Bypass ' + $wsFlag + '-File ' + $quoted
      } elseif ($ext -eq '.bat' -or $ext -eq '.cmd') {
        $exe = $value   # cmd runs the batch directly
      } elseif ($ext -eq '.vbs' -or $ext -eq '.vbe' -or $ext -eq '.wsf') {
        $exe = 'cscript'; $argLine = '//nologo ' + $quoted
      } elseif ($ext -eq '.jar') {
        $exe = 'java'; $argLine = '-jar ' + $quoted
      } elseif ($interp.ContainsKey($ext)) {
        $exe = $interp[$ext]; $argLine = $quoted
      } else {
        Write-Output '{"ok":false,"error":"bad_script_ext"}'
        exit
      }
      $sp = @{ FilePath = $exe; WindowStyle = $ws }
      if ($argLine) { $sp['ArgumentList'] = $argLine }
      if ($hasDir) { $sp['WorkingDirectory'] = $dir }
      Start-Process @sp
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
