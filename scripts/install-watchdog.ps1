# Registers the tunnel watchdog so it starts at logon and is re-checked every
# 10 minutes. Run once:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-watchdog.ps1

$ErrorActionPreference = 'Stop'

$repo = 'C:\Users\angel\OneDrive\Pictures\fwaf'
$script = Join-Path $repo 'scripts\tunnel-watchdog.ps1'

if (-not (Test-Path $script)) { throw "Watchdog script not found: $script" }

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $script)

$atLogon = New-ScheduledTaskTrigger -AtLogOn
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 10) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
  -TaskName 'Ketaminecc Tunnel Watchdog' `
  -Description 'Keeps the Ketamine.cc API and SSH tunnel online and republishes the tunnel URL.' `
  -Action $action `
  -Trigger @($atLogon, $repeat) `
  -Settings $settings `
  -RunLevel Limited `
  -Force | Out-Null

Write-Host 'Registered task: Ketaminecc Tunnel Watchdog'
Write-Host 'Starting it now...'
Start-ScheduledTask -TaskName 'Ketaminecc Tunnel Watchdog'
Start-Sleep -Seconds 3
Get-ScheduledTask -TaskName 'Ketaminecc Tunnel Watchdog' | Select-Object State
Get-ScheduledTaskInfo -TaskName 'Ketaminecc Tunnel Watchdog' | Select-Object LastRunTime, LastTaskResult
