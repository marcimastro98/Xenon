' Opens the Xenon dashboard in the default browser at Windows logon.
' Registered on demand as the scheduled task "Xenon Edge Dashboard" by the
' server (POST /startup/auto-open) when the user keeps "open in browser at
' startup" enabled while viewing the dashboard in a real browser. It is NEVER
' registered for Xeneon-Edge-only use (the iCUE iframe loads the URL itself),
' so pure-Edge setups never get a surprise browser tab.
'
' When the Xenon app starts at logon it IS the dashboard, so no tab opens: an
' older dashboard registered this task from inside the app, and Chrome came up
' at every logon while the app itself was still waiting its turn to start.
'
' The server already auto-starts at logon (its own task), but the browser tab
' could open before Node is listening and show a connection error. So we poll
' /status and open the page only once it answers; a server that never comes up
' gets no tab at all, rather than an error page.

Option Explicit

Const WAIT_TRIES = 360       ' x 0.5 s: a cold logon can take minutes to start node
Const RUN_KEY = "HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Xenon"
Const APPROVED_KEY = "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run\Xenon"

Dim shell, http, url, i, ready, q, status
q = Chr(34) ' double-quote, kept out of the string soup below
url = "http://127.0.0.1:3030/"
Set shell = CreateObject("WScript.Shell")

' The app's login entry is there and not switched off in Task Manager (whose
' first byte is odd, 3 or 7, when the user disabled it).
Function AppStartsAtLogon()
  Dim entry, approved
  AppStartsAtLogon = False
  On Error Resume Next
  entry = shell.RegRead(RUN_KEY)
  If Err.Number <> 0 Then Exit Function
  If InStr(1, entry, "xenon-native.exe", vbTextCompare) = 0 Then Exit Function
  Err.Clear
  approved = shell.RegRead(APPROVED_KEY)
  If Err.Number = 0 Then
    If (approved(0) Mod 2) = 1 Then Exit Function
  End If
  On Error GoTo 0
  AppStartsAtLogon = True
End Function

If AppStartsAtLogon() Then WScript.Quit 0

' The status goes through a variable on purpose. VBScript evaluates both sides of
' "Err.Number = 0 And http.Status = 200", reading Status after a failed Send
' raises, and On Error Resume Next then resumes INSIDE the If: the old line set
' ready on the very first refused connection and opened the tab at once.
ready = False
For i = 1 To WAIT_TRIES
  On Error Resume Next
  status = 0
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.SetTimeouts 1000, 1000, 2000, 2000
  http.Open "GET", url & "status", False
  http.Send
  If Err.Number = 0 Then status = http.Status
  Err.Clear
  Set http = Nothing
  On Error GoTo 0
  If status = 200 Then ready = True
  If ready Then Exit For
  WScript.Sleep 500
Next

If Not ready Then WScript.Quit 1

' Open the URL in the default browser. "start" performs a ShellExecute on the
' URL (so it honours the user's default browser); the empty "" is start's title
' argument. Window style 0 hides the transient cmd window.
shell.Run "cmd /c start " & q & q & " " & q & url & q, 0, False
