Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
serverPath = scriptDir & "\server.js"

' Stop any existing widget server on port 3030 before launching a new one.
' Runs synchronously (last arg = True) so we wait for the kill + sleep before
' handing off to node, avoiding an EADDRINUSE race on fast machines.
Dim psKill
psKill = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command " & _
    Chr(34) & "try{" & _
    "$p=(Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue).OwningProcess;" & _
    "if($p){Stop-Process -Id $p -Force -ErrorAction SilentlyContinue};" & _
    "Start-Sleep -Milliseconds 800" & _
    "}catch{}" & Chr(34)
shell.Run psKill, 0, True

shell.CurrentDirectory = scriptDir
shell.Run "cmd /c node """ & serverPath & """", 0, False
