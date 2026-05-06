' Double-click this file on Windows to start Studio Launcher.
' Runs silently — no console window appears.
' On first run, installs dependencies automatically (brief window visible during install).
Dim shell, fso, dir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))

If Not fso.FolderExists(dir & "node_modules") Then
  shell.Run "cmd /c cd " & Chr(34) & dir & Chr(34) & " && npm install", 1, True
End If

shell.Run Chr(34) & dir & "node_modules\.bin\electron.cmd" & Chr(34) & " " & Chr(34) & dir & "." & Chr(34), 0, False
