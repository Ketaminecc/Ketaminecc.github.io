# ── Ketamine.cc tunnel watchdog ───────────────────────────────────────────────
# Keeps the local API server and the localhost.run SSH tunnel alive, and syncs
# the rotating public tunnel hostname into assets/config.js (published to
# GitHub Pages) and server/.env (used for Stripe return URLs).
#
# Start it with:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tunnel-watchdog.ps1
# A logon Scheduled Task is registered by scripts\install-watchdog.ps1.

param(
  [string]$RepoRoot = 'C:\Users\angel\OneDrive\Pictures\fwaf',
  [int]$LocalPort = 3000,
  [int]$PollSeconds = 20,
  [string]$PublicDir = 'D:\Roblox\Source\Public'
)

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Git = 'C:\Program Files\Git\cmd\git.exe'
$Ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'
$Node = 'node'

$LogDir = Join-Path $RepoRoot 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'tunnel-watchdog.log'
$GitUser = 'Ketamine.cc'
$GitEmail = 'support@ketaminecc.site'

function Write-Log([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -Path $Log -Value $line
  Write-Host $line
}

# Rotate the log if it grows past 2 MB.
if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 2MB)) {
  Move-Item -Path $Log -Destination (Join-Path $LogDir 'tunnel-watchdog.old.log') -Force
}

# ── Single instance ──────────────────────────────────────────────────────────
$running = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
  Where-Object { $_.CommandLine -like '*tunnel-watchdog.ps1*' -and $_.ProcessId -ne $PID }
if ($running) {
  exit
}

Write-Log 'Watchdog starting'

function Test-LocalApi {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$LocalPort/api/health" -TimeoutSec 5
    return [bool]$r.ok
  } catch {
    return $false
  }
}

function Test-PublicApi([string]$Url) {
  if (-not $Url) { return $false }
  try {
    $r = Invoke-RestMethod -Uri "$Url/api/health" -TimeoutSec 15
    return [bool]$r.ok
  } catch {
    return $false
  }
}

function Get-ApiProcess {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*src/server.js*' }
}

function Get-TunnelProcess {
  Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" |
    Where-Object { $_.CommandLine -like '*localhost.run*' }
}

function Start-Api {
  Get-ApiProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  Write-Log 'Starting API server'
  Start-Process -FilePath $Node -ArgumentList 'src/server.js' `
    -WorkingDirectory (Join-Path $RepoRoot 'server') -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir 'server.out.log') `
    -RedirectStandardError (Join-Path $LogDir 'server.err.log') | Out-Null
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    if (Test-LocalApi) {
      Write-Log 'API server is healthy'
      return $true
    }
  }
  Write-Log 'API server did not become healthy'
  return $false
}

function Start-Tunnel {
  Get-TunnelProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1

  $out = Join-Path $LogDir 'tunnel.out.log'
  $err = Join-Path $LogDir 'tunnel.err.log'
  Remove-Item -Path $out, $err -Force -ErrorAction SilentlyContinue

  $sshArgs = @(
    '-T',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', "80:127.0.0.1:$LocalPort",
    'nokey@localhost.run',
    '--', '--output', 'json'
  )

  Write-Log 'Opening SSH tunnel'
  Start-Process -FilePath $Ssh -ArgumentList $sshArgs -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null

  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Test-Path $out)) { continue }
    $text = [string](Get-Content -Path $out -Raw -ErrorAction SilentlyContinue)
    $match = [regex]::Match($text, '"address":"([^"]+)"')
    if ($match.Success) {
      $url = 'https://' + $match.Groups[1].Value
      Write-Log "Tunnel registered: $url"
      return $url
    }
  }

  Write-Log 'Tunnel did not report a hostname'
  return $null
}

function Set-FileText([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Update-SiteConfig([string]$Url) {
  $changed = $false

  $configPath = Join-Path $RepoRoot 'assets\config.js'
  if (Test-Path $configPath) {
    $config = [string](Get-Content -Path $configPath -Raw)
    $updated = [regex]::Replace($config, "const TUNNEL_API = '[^']*';", "const TUNNEL_API = '$Url';")
    if ($updated -ne $config) {
      Set-FileText $configPath $updated
      $changed = $true
    }
  }

  $envPath = Join-Path $RepoRoot 'server\.env'
  if (Test-Path $envPath) {
    $envText = [string](Get-Content -Path $envPath -Raw -ErrorAction SilentlyContinue)
    # Never write back an empty read. A locked or transiently unreadable .env
    # used to round-trip through the regex as '' and truncate the file, which
    # took the API down until every secret was restored by hand.
    if ($envText.Length -eq 0) {
      Write-Log 'server/.env is empty or unreadable; leaving it untouched'
    } else {
      if ($envText -match '(?m)^\s*PUBLIC_BASE_URL=') {
        $updatedEnv = [regex]::Replace($envText, '(?m)^\s*PUBLIC_BASE_URL=.*$', "PUBLIC_BASE_URL=$Url")
      } else {
        $updatedEnv = $envText.TrimEnd() + "`nPUBLIC_BASE_URL=$Url`n"
      }
      if ($updatedEnv -ne $envText) {
        Set-FileText $envPath $updatedEnv
        $changed = $true
      }
    }
  }

  $jsonPath = Join-Path $RepoRoot 'assets\api-base.json'
  $json = "{`n  `"api`": `"$Url`"`n}`n"
  $current = if (Test-Path $jsonPath) { [string](Get-Content -Path $jsonPath -Raw) } else { '' }
  if ($current.Trim() -ne $json.Trim()) {
    Set-FileText $jsonPath $json
    $changed = $true
  }

  # The desktop client reads api.txt from the folder it was launched from, so
  # a rotated tunnel reaches the shipped exe without a rebuild. Local file
  # only: it never enters the Pages commit.
  if (Test-Path $PublicDir) {
    $apiPath = Join-Path $PublicDir 'api.txt'
    $currentApi = if (Test-Path $apiPath) { [string](Get-Content -Path $apiPath -Raw) } else { '' }
    if ($currentApi.Trim() -ne $Url) {
      Set-FileText $apiPath "$Url`n"
      Write-Log "Wrote client api.txt -> $Url"
    }
  }

  return $changed
}

function Publish-Config {
  $env:GIT_TERMINAL_PROMPT = '0'
  Push-Location $RepoRoot
  try {
    & $Git add assets/config.js assets/api-base.json 2>&1 | Out-Null
    $staged = & $Git diff --cached --name-only 2>&1
    if ($staged) {
      & $Git -c "user.name=$GitUser" -c "user.email=$GitEmail" commit -q -m "chore: point api at $script:PublicUrl" 2>&1 | Out-Null
    }

    $ahead = & $Git log 'origin/main..HEAD' --oneline 2>&1
    if (-not $ahead) { return }

    $output = & $Git push origin main 2>&1 | Out-String
    $code = $LASTEXITCODE
    if ($code -eq 0) {
      Write-Log 'Pushed new API base to GitHub Pages'
    } else {
      Write-Log "git push failed (exit $code): $($output.Trim())"
    }
  } catch {
    Write-Log "Publish failed: $($_.Exception.Message)"
  } finally {
    Pop-Location
  }
}

# ── Main loop ────────────────────────────────────────────────────────────────

$script:PublicUrl = $null
$lastPublish = [datetime]::MinValue

while ($true) {
  try {
    if (-not (Get-ApiProcess)) {
      Start-Api | Out-Null
    } elseif (-not (Test-LocalApi)) {
      Write-Log 'API server is not responding; restarting it'
      Start-Api | Out-Null
    }

    if (-not $script:PublicUrl -or -not (Test-PublicApi $script:PublicUrl)) {
      if (Get-TunnelProcess) { Write-Log 'Tunnel is not reachable; reconnecting' }
      $url = Start-Tunnel
      if ($url) {
        $script:PublicUrl = $url
        for ($i = 0; $i -lt 15; $i++) {
          if (Test-PublicApi $url) { break }
          Start-Sleep -Seconds 2
        }
        if (Update-SiteConfig $url) {
          Write-Log 'Public API base changed; restarting API and publishing'
          Start-Api | Out-Null
          Publish-Config
          $lastPublish = Get-Date
        }
      }
    }

    # Self-heal drift: the published files and .env must name the tunnel that is
    # actually live, even when the tunnel itself never dropped. Without this a
    # restart that rotates the hostname leaves Pages pointing at the old one.
    if ($script:PublicUrl -and (Update-SiteConfig $script:PublicUrl)) {
      Write-Log "Published files were stale; repointing at $script:PublicUrl"
      Publish-Config
      $lastPublish = Get-Date
    }

    if ($script:PublicUrl -and ((Get-Date) - $lastPublish).TotalSeconds -gt 300) {
      Publish-Config
      $lastPublish = Get-Date
    }
  } catch {
    Write-Log "Loop error: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds $PollSeconds
}
