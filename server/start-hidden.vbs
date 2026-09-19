' The dashboard engine's Windows launcher: started by wscript.exe, from the
' per-logon scheduled task and from install.ps1, with no window at all.
'
' NOTHING HERE MAY BE LOOKED UP ON PATH. This script used to end with
'
'   shell.Run "cmd /c node """ & serverPath & """", 0, False
'
' which asks PATH for TWO programs - cmd and node - and says nothing whatsoever
' when either one is not on it: no window, no file, no event, no exit code
' anybody sees. That is two separate holes:
'
'   * System32 missing from PATH. A PATH edited past the 2047-character limit
'     of the old System Properties dialog is truncated in place, and "debloat"
'     scripts rewrite it wholesale; either leaves a perfectly healthy Windows
'     where "cmd" is not a command (issue #127, already fixed the same way in
'     xenon-bootstrap.ps1 - nothing there is looked up on PATH any more).
'   * node installed somewhere unusual. The installer resolves node.exe in its
'     own process, with the machine and user PATH freshly merged in; the logon
'     task's process gets neither. Reported on Discord (Sep 2026) from a PC with
'     node at F:\Nodejs: every component [OK], the task registered, npm install
'     clean - and nothing ever listening on 3030, on a fresh install and on a
'     full reinstall alike, with not one line in server.log because node never
'     ran to write it.
'
' So: System32 by absolute path, node.exe resolved to an absolute path here,
' node started directly with no cmd in the middle, and - when there is no node
' to be found - a line written into the same server.log that the installer and
' the app splash already tell people to send. startup-log.js closed this hole
' from the inside, for a node that starts and then fails; this closes the half
' of it where node never starts at all, which was the only launcher left that
' could still fail in complete silence.
Dim shell, fso
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

Dim scriptDir, serverPath, sys32, localAppData, logDir
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
serverPath = scriptDir & "\server.js"
sys32 = shell.ExpandEnvironmentStrings("%WINDIR%") & "\System32"
localAppData = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%")
logDir = localAppData & "\Xenon"

' The absolute path of the node.exe the installer verified, written by
' install.ps1 (Save-NodePath) beside setup.log. First choice, because it is the
' only one that knows about an install outside the usual folders.
Dim recordedNodeFile
recordedNodeFile = logDir & "\node-path.txt"

' Expands %NAME% and returns "" when the variable is not set, so an unset
' ProgramFiles(x86) contributes a candidate that is skipped rather than the
' literal string "%ProgramFiles(x86)%\nodejs\node.exe".
Function EnvVar(name)
  Dim value
  value = shell.ExpandEnvironmentStrings("%" & name & "%")
  If value = "%" & name & "%" Then value = ""
  EnvVar = value
End Function

Function FileText(path)
  Dim stream, text
  FileText = ""
  On Error Resume Next
  Err.Clear
  ' -1 = Unicode (UTF-16LE): the recorded path can contain any character a
  ' Windows profile name can, so it is not written in the system codepage.
  Set stream = fso.OpenTextFile(path, 1, False, -1)
  If Err.Number <> 0 Then Exit Function
  text = stream.ReadAll()
  stream.Close
  On Error Goto 0
  FileText = Trim(Replace(Replace(text, vbCr, ""), vbLf, ""))
End Function

Function Exists(path)
  Exists = False
  If path = "" Then Exit Function
  On Error Resume Next
  Exists = fso.FileExists(path)
  On Error Goto 0
End Function

' Every place node.exe can be, in the order we trust them - and only ones that
' are actually there. PATH is read here by hand, one entry at a time, rather
' than handed to a shell: a PATH that still carries node is honoured, and a PATH
' that has been truncated cannot take cmd.exe down with it.
Function FindNode()
  Dim candidates, dirs, i, entry, candidate
  FindNode = ""

  If Exists(recordedNodeFile) Then
    candidate = FileText(recordedNodeFile)
    If Exists(candidate) Then
      FindNode = candidate
      Exit Function
    End If
  End If

  candidates = Array( _
    EnvVar("ProgramFiles") & "\nodejs\node.exe", _
    EnvVar("ProgramFiles(x86)") & "\nodejs\node.exe", _
    EnvVar("LOCALAPPDATA") & "\Programs\nodejs\node.exe" _
  )
  For i = 0 To UBound(candidates)
    If Left(candidates(i), 1) <> "\" And Exists(candidates(i)) Then
      FindNode = candidates(i)
      Exit Function
    End If
  Next

  dirs = Split(EnvVar("PATH"), ";")
  For i = 0 To UBound(dirs)
    entry = Trim(dirs(i))
    If entry <> "" Then
      If Right(entry, 1) = "\" Then entry = Left(entry, Len(entry) - 1)
      candidate = entry & "\node.exe"
      If Exists(candidate) Then
        FindNode = candidate
        Exit Function
      End If
    End If
  Next
End Function

' The engine's own log, in the engine's own format (see startup-log.js). Only
' ever written when node will NOT be started: a line written just before a
' successful start would be rotated straight into server.log.1 by the engine
' itself, where nobody looks.
Sub LogFailure(message)
  Dim stream
  On Error Resume Next
  If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
  Err.Clear
  ' 0 = ASCII (the system codepage), not Unicode: the engine writes this same
  ' file as UTF-8 from node, and everything written below is ASCII, so the two
  ' produce identical bytes. A UTF-16 line appended to a UTF-8 file would not.
  Set stream = fso.OpenTextFile(logDir & "\server.log", 8, True, 0)
  If Err.Number <> 0 Then Exit Sub
  stream.WriteLine Now & "  " & message
  stream.Close
  On Error Goto 0
End Sub

' Stop any existing widget server on port 3030 before launching a new one.
' Runs synchronously (last arg = True) so we wait for the kill + sleep before
' handing off to node, avoiding an EADDRINUSE race on fast machines. Skipped
' rather than fatal when powershell.exe is not where it belongs: the kill is a
' precaution, the start is the job.
Dim ps, psKill
ps = sys32 & "\WindowsPowerShell\v1.0\powershell.exe"
If Exists(ps) Then
  psKill = Chr(34) & ps & Chr(34) & " -NoProfile -ExecutionPolicy Bypass -Command " & _
      Chr(34) & "try{" & _
      "$p=(Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue).OwningProcess;" & _
      "if($p){Stop-Process -Id $p -Force -ErrorAction SilentlyContinue};" & _
      "Start-Sleep -Milliseconds 800" & _
      "}catch{}" & Chr(34)
  shell.Run psKill, 0, True
End If

Dim nodeExe
nodeExe = FindNode()
If nodeExe = "" Then
  LogFailure "The engine did not start: node.exe was not found. " & _
    "Xenon looked at " & recordedNodeFile & ", the usual Node.js install folders, " & _
    "and every folder on PATH. Install Node.js LTS from https://nodejs.org/ (or, " & _
    "if it is already installed somewhere unusual, put its folder on PATH), then " & _
    "run INSTALL.bat again."
  WScript.Quit 1
End If

shell.CurrentDirectory = scriptDir
shell.Run Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & serverPath & Chr(34), 0, False
