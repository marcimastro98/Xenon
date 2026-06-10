' Opens the Xenon dashboard in the default browser at Windows logon.
' Registered on demand as the scheduled task "Xenon Edge Dashboard" by the
' server (POST /startup/auto-open) when the user keeps "open in browser at
' startup" enabled while viewing the dashboard in a real browser. It is NEVER
' registered for Xeneon-Edge-only use (the iCUE iframe loads the URL itself),
' so pure-Edge setups never get a surprise browser tab.
'
' The server already auto-starts at logon (its own task), but the browser tab
' could open before Node is listening and show a connection error. So we poll
' /status for up to ~30s and only then open the page — best effort either way.

Option Explicit

Dim shell, http, url, i, ready, q
q = Chr(34) ' double-quote, kept out of the string soup below
url = "http://127.0.0.1:3030/"
Set shell = CreateObject("WScript.Shell")
ready = False

For i = 1 To 60
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.SetTimeouts 1000, 1000, 2000, 2000
  http.Open "GET", url & "status", False
  http.Send
  If Err.Number = 0 And http.Status = 200 Then ready = True
  Set http = Nothing
  On Error GoTo 0
  If ready Then Exit For
  WScript.Sleep 500
Next

' Open the URL in the default browser. "start" performs a ShellExecute on the
' URL (so it honours the user's default browser); the empty "" is start's title
' argument. Window style 0 hides the transient cmd window.
shell.Run "cmd /c start " & q & q & " " & q & url & q, 0, False
