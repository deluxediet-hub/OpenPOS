' =====================================================================
'  OpenPOS watchdog - if the server stops answering, start it again.
'  Runs every few minutes from a scheduled task; never opens a window.
' =====================================================================
Option Explicit
Dim sh, fso, base
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

If Not ServerUp() Then
  sh.Run "wscript.exe """ & base & "\scripts\start-hidden.vbs""", 0, False
End If

Function ServerUp()
  On Error Resume Next
  Dim http
  Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  If Err.Number <> 0 Then ServerUp = False : Exit Function
  http.Open "GET", "http://127.0.0.1:3000/healthz", False
  http.SetTimeouts 800, 800, 800, 800
  http.Send
  ServerUp = (Err.Number = 0 And http.Status = 200)
  On Error GoTo 0
End Function
