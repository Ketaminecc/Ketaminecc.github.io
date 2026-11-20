# Registers the tunnel watchdog without requiring an elevated shell.
#
# scripts\watchdog-launcher.vbs is copied into the per-user Startup folder. It
# runs the watchdog hidden at logon and restarts it 15 seconds after it exits.
# The watchdog also holds a named mutex, so a manual start or a second launcher
# can never create a duplicate.
#
# Run once:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-watchdog.ps1

$ErrorActionPreference = 'Stop'

$repo = 'C:\Users\angel\OneDrive\Pictures\fwaf'
$source = Join-Path $repo 'scripts\watchdog-launcher.vbs'
$startup = [Environment]::GetFolderPath('Startup')
$target = Join-Path $startup 'Ketaminecc Watchdog.vbs'

if (-not (Test-Path $source)) { throw "Watchdog launcher not found: $source" }
New-Item -ItemType Directory -Force -Path $startup | Out-Null
Copy-Item -Path $source -Destination $target -Force
Write-Host "Startup supervisor: $target"

# Remove the task/shortcut experiments so only the Startup supervisor remains.
foreach ($task in @('Ketaminecc Test Minute', 'Ketaminecc Tunnel Watchdog Keepalive', 'Ketaminecc Tunnel Watchdog')) {
  & cmd.exe /c "schtasks /delete /tn `"$task`" /f >nul 2>&1" | Out-Null
}
$shortcut = Join-Path $startup 'Ketaminecc Tunnel Watchdog.lnk'
if (Test-Path $shortcut) { Remove-Item -Path $shortcut -Force }

# Stop a stale supervisor, but leave the Startup copy alone when it is already
# running. The running watchdog keeps running either way; a new supervisor takes
# over as soon as it exits.
$supervisors = @(Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe'" |
  Where-Object { $_.CommandLine -match 'watchdog-launcher\.vbs|Ketaminecc Watchdog\.vbs' })
$alreadyRunning = $supervisors | Where-Object { $_.CommandLine -like "*$target*" }
if ($alreadyRunning) {
  Write-Host 'Startup supervisor is already running'
} else {
  $supervisors | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$target`"" -WindowStyle Hidden
  Start-Sleep -Seconds 2
}

Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe'" |
  Where-Object { $_.CommandLine -match 'watchdog-launcher\.vbs|Ketaminecc Watchdog\.vbs' } |
  Select-Object ProcessId, CommandLine
