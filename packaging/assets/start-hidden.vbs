' =====================================================================
'  OpenPOS hidden launcher (appliance model).
'    - Runs the EXISTING server headless (no console window).
'    - Single-instance: if the server already answers on :3000, quit.
'    - Business data lives in %ProgramData%\OpenPOS\data  (OUTSIDE the
'      application directory and outside Program Files' write-protected app tree).
'    - Derives the app path from its own location; never needs editing.
' =====================================================================
Option Explicit
Dim sh, fso, base, node, appdir, dataRoot, datadir

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base    = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)) ' <root>
node    = base & "\runtime\node.exe"
appdir  = base & "\app"
dataRoot= sh.ExpandEnvironmentStrings("%ProgramData%") & "\OpenPOS"
datadir = dataRoot & "\data"

' --- single-instance guard: do not launch a second copy ---
If ServerUp() Then WScript.Quit 0

If Not fso.FileExists(node) Then
  MsgBox "OpenPOS runtime not found:" & vbCrLf & node, vbCritical, "OpenPOS"
  WScript.Quit 1
End If
If Not fso.FolderExists(dataRoot) Then fso.CreateFolder(dataRoot)
If Not fso.FolderExists(datadir)  Then fso.CreateFolder(datadir)

sh.CurrentDirectory = appdir
sh.Environment("Process")("POS_DATA_DIR") = datadir
sh.Environment("Process")("PORT") = "3000"
sh.Run """" & node & """ server.js", 0, False

' Returns True if a server already answers on the local port.
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
