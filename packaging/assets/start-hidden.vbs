' OpenPOS installed launcher: hidden, logged and single-instance.
Option Explicit
Dim sh, fso, base, node, appdir, dataRoot, datadir, logdir, logfile, command, openBrowser, i
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base     = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
node     = base & "\runtime\node.exe"
appdir   = base & "\app"
dataRoot = sh.ExpandEnvironmentStrings("%ProgramData%") & "\OpenPOS"
datadir  = dataRoot & "\data"
logdir   = dataRoot & "\logs"
logfile  = logdir & "\server.log"
openBrowser = False
If WScript.Arguments.Count > 0 Then openBrowser = (LCase(WScript.Arguments(0)) = "/open")

EnsureFolder dataRoot
EnsureFolder datadir
EnsureFolder logdir

If ServerUp() Then
  If openBrowser Then sh.Run "http://localhost:3000", 1, False
  WScript.Quit 0
End If

If Not fso.FileExists(node) Then Fail "OpenPOS runtime was not found:" & vbCrLf & node
If Not fso.FileExists(appdir & "\server.js") Then Fail "OpenPOS server was not found:" & vbCrLf & appdir & "\server.js"
If Not fso.FolderExists(base & "\node_modules") Then Fail "OpenPOS components were not found:" & vbCrLf & base & "\node_modules"
If Not fso.FolderExists(appdir & "\routes") Or Not fso.FolderExists(appdir & "\services") Then
  Fail "OpenPOS application files are incomplete. Reinstall OpenPOS."
End If

sh.CurrentDirectory = appdir
sh.Environment("Process")("POS_DATA_DIR") = datadir
sh.Environment("Process")("POS_BACKUP_DIR") = dataRoot & "\backups"
sh.Environment("Process")("PORT") = "3000"
AppendLog "Starting OpenPOS from " & appdir
command = "cmd.exe /d /c " & Chr(34) & Chr(34) & node & Chr(34) & " server.js >> " & Chr(34) & logfile & Chr(34) & " 2>&1" & Chr(34)
sh.Run command, 0, False

If openBrowser Then
  For i = 1 To 60
    WScript.Sleep 500
    If ServerUp() Then
      sh.Run "http://localhost:3000", 1, False
      WScript.Quit 0
    End If
  Next
  Fail "OpenPOS did not start within 30 seconds." & vbCrLf & vbCrLf & "Diagnostics:" & vbCrLf & logfile
End If
WScript.Quit 0

Sub EnsureFolder(folder)
  If Not fso.FolderExists(folder) Then fso.CreateFolder(folder)
End Sub

Sub AppendLog(message)
  On Error Resume Next
  Dim file
  Set file = fso.OpenTextFile(logfile, 8, True)
  file.WriteLine Now & "  " & message
  file.Close
  On Error GoTo 0
End Sub

Sub Fail(message)
  AppendLog "LAUNCH ERROR: " & Replace(message, vbCrLf, " | ")
  MsgBox message, vbCritical, "OpenPOS"
  WScript.Quit 1
End Sub

Function ServerUp()
  On Error Resume Next
  Dim http
  Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  If Err.Number <> 0 Then ServerUp = False : Exit Function
  http.Open "GET", "http://127.0.0.1:3000/healthz", False
  http.SetTimeouts 1200, 1200, 1200, 1200
  http.Send
  ServerUp = (Err.Number = 0 And http.Status = 200)
  On Error GoTo 0
End Function
