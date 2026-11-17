' Starts the Ketamine.cc tunnel watchdog hidden and restarts it if it exits.
' A copy lives in the Windows Startup folder so it runs at every logon.

Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Users\angel\OneDrive\Pictures\fwaf\scripts\tunnel-watchdog.ps1"""

Do
  shell.Run command, 0, True
  WScript.Sleep 15000
Loop
