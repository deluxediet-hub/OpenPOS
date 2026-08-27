' OpenPOS hidden launcher for the portable/source installation.
' Double-click this file directly, or double-click start-pos.bat which delegates here.
Option Explicit

Dim shell, fso, root, launcher, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = root & "\start-pos.bat"

If Not fso.FileExists(launcher) Then
  MsgBox "OpenPOS launcher was not found:" & vbCrLf & launcher, vbCritical, "OpenPOS"
  WScript.Quit 1
End If

command = Chr(34) & launcher & Chr(34) & " --hidden"
shell.CurrentDirectory = root
shell.Run command, 0, False
