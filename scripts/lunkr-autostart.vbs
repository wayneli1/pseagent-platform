Option Explicit

Dim fileSystem, shell, scriptsDirectory, repositoryRoot, command
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptsDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
repositoryRoot = fileSystem.GetParentFolderName(scriptsDirectory)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ _
  & scriptsDirectory & "\lunkr-service.ps1"""

shell.CurrentDirectory = repositoryRoot
shell.Run command, 0, False
