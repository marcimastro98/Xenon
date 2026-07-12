; Xenon NSIS installer hooks (tauri.conf.json > bundle > windows > nsis > installerHooks).
;
; NSIS_HOOK_POSTINSTALL turns the setup.exe into a FULL installer: when the
; Xenon backend (the Node server that actually renders the dashboard) is not on
; this machine, it launches the bundled PowerShell bootstrap, which downloads
; the latest verified release and runs the normal backend installer. Without
; this, a user who downloaded the setup.exe from GitHub got only the WebView2
; shell — a gray screen pointing at a 127.0.0.1:3030 nobody was serving.
;
; The hook must stay silent in every flow where the backend already exists or
; another installer is in charge:
;   • install.ps1 / install-native.ps1 pass /NOBOOTSTRAP (they ARE the backend
;     installer — re-bootstrapping would loop);
;   • the Tauri self-updater re-runs this installer silently on every shell
;     update — the scheduled-task check keeps a console from ever popping there;
;   • an unexpected schtasks failure fails CLOSED toward doing nothing.

!include "LogicLib.nsh"
!include "FileFunc.nsh"

!macro NSIS_HOOK_POSTINSTALL
  ; 1) Explicit opt-out from our own installers.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/NOBOOTSTRAP" $R1
  ${IfNot} ${Errors}
    Goto xenon_bootstrap_done
  ${EndIf}

  ; 2) Backend already installed? The per-logon scheduled task "Xenon Edge
  ;    Widget" is registered by install.ps1 on every backend install and is the
  ;    reliable machine-wide marker (it encodes the install root too).
  nsExec::ExecToStack 'schtasks /Query /TN "Xenon Edge Widget"'
  Pop $R2
  Pop $R3
  StrCmp $R2 "0" xenon_bootstrap_done
  StrCmp $R2 "error" xenon_bootstrap_done

  ; 3) No backend: hand off to the bootstrap, detached (NOT ExecWait — the
  ;    setup finishes immediately; the bootstrap console carries on visibly
  ;    with its own download/verify/install progress). PowerShell is addressed
  ;    by its FULL system path: an unqualified exe name on a raw command line
  ;    resolves from the setup's own directory first (binary planting, CWE-427)
  ;    — e.g. a rogue powershell.exe sitting next to the setup in Downloads.
  Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows\xenon-bootstrap.ps1"'

  xenon_bootstrap_done:
!macroend
