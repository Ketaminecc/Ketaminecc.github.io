# ── Ketamine.cc tunnel watchdog ───────────────────────────────────────────────
# Keeps the local API server and a Cloudflare Quick Tunnel alive, and syncs the
# public hostname into assets/config.js + assets/api-base.json (published to
# GitHub Pages), server/.env (used for payment return URLs), and the desktop
# client's api.txt / api.cache.txt.
#
# Quick Tunnels need no Cloudflare account, expose no public IP, and keep one
# hostname for the lifetime of the cloudflared process. Two tunnels run side by
# side so a rotation can promote a proven standby instead of waiting for Pages.
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
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Git = 'C:\Program Files\Git\cmd\git.exe'
$Node = 'node'
$Curl = Join-Path $env:SystemRoot 'System32\curl.exe'
$Cloudflared = Join-Path $env:LOCALAPPDATA 'cloudflared\cloudflared.exe'
$CloudflaredDownload = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'

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
# A named mutex is immune to command-line false positives: launcher shells and
# diagnostic commands mention this script in their own arguments, which used to
# make a fresh watchdog exit immediately.
$script:InstanceMutex = New-Object System.Threading.Mutex($false, 'KetamineTunnelWatchdog')
if (-not $script:InstanceMutex.WaitOne(0)) {
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

function Get-PublicDnsAddress([string]$HostName) {
  # Ask a public resolver directly. The router in front of this PC caches the
  # first NXDOMAIN for a fresh Quick Tunnel name for several minutes, and that
  # cache would otherwise make a healthy tunnel look dead and trigger churn.
  foreach ($server in @('1.1.1.1', '8.8.8.8')) {
    try {
      $answers = Resolve-DnsName -Name $HostName -Server $server -Type A -DnsOnly -ErrorAction Stop
      $ip = $answers | Where-Object { $_.IPAddress } | Select-Object -First 1 -ExpandProperty IPAddress
      if ($ip) { return $ip }
    } catch {
      # try the next resolver
    }
  }
  return $null
}

function Test-PublicApi([string]$Url) {
  if (-not $Url) { return $false }
  $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  try {
    $uri = [uri]$Url
    if ($uri.Host -like '*.trycloudflare.com' -and (Test-Path $Curl)) {
      $ip = Get-PublicDnsAddress $uri.Host
      if (-not $ip) { return $false }
      $body = (& $Curl --noproxy '*' --resolve "$($uri.Host):443:$ip" -sS -m 12 "$Url/api/health?t=$stamp" 2>$null | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or -not $body) { return $false }
      $r = $body | ConvertFrom-Json -ErrorAction Stop
      return [bool]$r.ok
    }
    $r = Invoke-RestMethod -Uri "$Url/api/health?t=$stamp" -TimeoutSec 8
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
  Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'"
}

function Ensure-Cloudflared {
  if (Test-Path $Cloudflared) { return $true }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Cloudflared) | Out-Null
  Write-Log "cloudflared is missing; downloading to $Cloudflared"
  try {
    Invoke-WebRequest -Uri $CloudflaredDownload -OutFile $Cloudflared -TimeoutSec 180 -UseBasicParsing
    if (Test-Path $Cloudflared) { return $true }
  } catch {
    Write-Log "cloudflared download failed: $($_.Exception.Message)"
  }
  return $false
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

function Stop-TunnelInstance($Instance) {
  if ($Instance -and $Instance.Pid) {
    Stop-Process -Id $Instance.Pid -Force -ErrorAction SilentlyContinue
  }
}

function Start-CloudflaredInstance([string]$Name) {
  if (-not (Ensure-Cloudflared)) { return $null }

  $out = Join-Path $LogDir "cloudflared.$Name.out.log"
  $err = Join-Path $LogDir "cloudflared.$Name.err.log"
  Remove-Item -Path $out, $err -Force -ErrorAction SilentlyContinue

  Write-Log "Opening Cloudflare $Name tunnel"
  $process = Start-Process -FilePath $Cloudflared `
    -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$LocalPort", '--no-autoupdate') `
    -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru

  $url = $null
  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    if ($process.HasExited) { break }
    $text = [string](Get-Content -Path $err -Raw -ErrorAction SilentlyContinue) +
      "`n" + [string](Get-Content -Path $out -Raw -ErrorAction SilentlyContinue)
    $match = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($match.Success) {
      $url = $match.Value.TrimEnd('.', ',', ')', '"', "'")
      break
    }
  }

  if (-not $url) {
    Write-Log "Cloudflare $Name did not report a hostname"
    Stop-TunnelInstance ([pscustomobject]@{ Pid = $process.Id })
    return $null
  }

  # Do not publish a hostname before it actually reaches the API. This also
  # gives the standby a proven health check before it is offered as failover.
  for ($i = 0; $i -lt 24; $i++) {
    if (Test-PublicApi $url) {
      Write-Log "Cloudflare $Name registered: $url"
      return [pscustomobject]@{ Name = $Name; Pid = $process.Id; Url = $url }
    }
    Start-Sleep -Seconds 5
  }

  Write-Log "Cloudflare $Name registered but is not healthy: $url"
  Stop-TunnelInstance ([pscustomobject]@{ Pid = $process.Id })
  return $null
}

function Start-TunnelPair {
  Get-TunnelProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1

  $primary = Start-CloudflaredInstance 'primary'
  $standby = $null
  if ($primary) { $standby = Start-CloudflaredInstance 'standby' }

  if (-not $primary -and $standby) {
    $primary = $standby
    $standby = $null
  }

  if (-not $primary) {
    Write-Log 'Cloudflare did not provide a tunnel; retrying'
  }

  return [pscustomobject]@{ Primary = $primary; Standby = $standby }
}

function Set-FileText([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Update-SiteConfig([string]$Url, [string[]]$Fallbacks) {
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
  $fallbackList = @($Fallbacks | Where-Object { $_ -and $_ -ne $Url } | Select-Object -Unique)
  if ($fallbackList.Count -gt 0) {
    $items = $fallbackList | ForEach-Object { "    `"$_`"" }
    $json = "{`n  `"api`": `"$Url`",`n  `"fallbacks`": [`n" + ($items -join ",`n") + "`n  ]`n}`n"
  } else {
    $json = "{`n  `"api`": `"$Url`"`n}`n"
  }
  $current = if (Test-Path $jsonPath) { [string](Get-Content -Path $jsonPath -Raw) } else { '' }
  if ($current.Trim() -ne $json.Trim()) {
    Set-FileText $jsonPath $json
    $changed = $true
  }

  # The desktop client reads api.txt from the folder it was launched from, and
  # caches the last good base in api.cache.txt. Writing both lets a shipped exe
  # follow a rotated tunnel without a rebuild. Local files only: they never
  # enter the Pages commit.
  if (Test-Path $PublicDir) {
    foreach ($name in @('api.txt', 'api.cache.txt')) {
      $path = Join-Path $PublicDir $name
      $currentApi = if (Test-Path $path) { [string](Get-Content -Path $path -Raw) } else { '' }
      if ($currentApi.Trim() -ne $Url) {
        Set-FileText $path "$Url`n"
        Write-Log "Wrote client $name -> $Url"
      }
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

$script:Primary = $null
$script:Standby = $null
$script:PublicUrl = $null
$script:Failures = 0
$script:LastPublish = [datetime]::MinValue
$script:LastStandbyAttempt = [datetime]::MinValue

function Get-FallbackUrls {
  if ($script:Standby -and $script:Standby.Url) { return @($script:Standby.Url) }
  return @()
}

function Publish-Tunnels {
  if (-not $script:Primary -or -not $script:Primary.Url) { return $false }
  $previous = $script:PublicUrl
  $script:PublicUrl = $script:Primary.Url
  $fallbacks = Get-FallbackUrls
  if (-not (Update-SiteConfig $script:PublicUrl $fallbacks)) { return $false }

  if ($previous -ne $script:PublicUrl) {
    Write-Log 'Primary API base changed; restarting API'
    Start-Api | Out-Null
  }
  $suffix = if ($fallbacks.Count -gt 0) { " (standby: $($fallbacks -join ', '))" } else { ' (no standby)' }
  Write-Log "Publishing API base $script:PublicUrl$suffix"
  Publish-Config
  $script:LastPublish = Get-Date
  return $true
}

while ($true) {
  try {
    if (-not (Get-ApiProcess)) {
      Start-Api | Out-Null
    } elseif (-not (Test-LocalApi)) {
      Write-Log 'API server is not responding; restarting it'
      Start-Api | Out-Null
    }

    if (-not $script:Primary) {
      $pair = Start-TunnelPair
      $script:Primary = $pair.Primary
      $script:Standby = $pair.Standby
      $script:Failures = 0
      if ($script:Primary) {
        Publish-Tunnels | Out-Null
      } else {
        Write-Log 'No tunnel is available; retrying'
      }
    } else {
      $primaryOk = Test-PublicApi $script:Primary.Url
      $standbyOk = Test-PublicApi $script:Standby.Url

      if ($primaryOk) {
        $script:Failures = 0
        $standbyBad = [bool]($script:Standby -and -not $standbyOk)
        $standbyMissing = -not $script:Standby
        # Quick Tunnels are unlimited enough for a spare, but do not spin up a
        # new process every 20 seconds when a provider-side failure is ongoing.
        if (($standbyMissing -or $standbyBad) -and ((Get-Date) - $script:LastStandbyAttempt).TotalMinutes -ge 5) {
          $script:LastStandbyAttempt = Get-Date
          if ($standbyBad) {
            Write-Log 'Standby tunnel is unhealthy; replacing it'
            Stop-TunnelInstance $script:Standby
          } else {
            Write-Log 'Opening a standby tunnel'
          }
          $script:Standby = Start-CloudflaredInstance 'standby'
          Publish-Tunnels | Out-Null
        }
      } elseif ($standbyOk) {
        # Swap labels instead of killing the survivor. The former primary stays
        # as the spare and can recover while it is off the published api field.
        Write-Log 'Primary tunnel is unreachable; promoting standby'
        $old = $script:Primary
        $script:Primary = $script:Standby
        $script:Standby = $old
        $script:Failures = 0
        Publish-Tunnels | Out-Null
      } else {
        $script:Failures++
        if ($script:Failures -ge 2) {
          Write-Log "No tunnel is reachable ($script:Failures checks); restarting both"
          $script:Failures = 0
          $pair = Start-TunnelPair
          $script:Primary = $pair.Primary
          $script:Standby = $pair.Standby
          if ($script:Primary) { Publish-Tunnels | Out-Null }
        }
      }
    }

    # Self-heal drift: the published files and .env must name the tunnel that is
    # actually live, even when the tunnel itself never dropped. Without this a
    # restart that rotates the hostname leaves Pages pointing at the old one.
    if ($script:Primary) {
      $fallbacks = Get-FallbackUrls
      if (Update-SiteConfig $script:Primary.Url $fallbacks) {
        Write-Log "Published files were stale; repointing at $($script:Primary.Url)"
        Publish-Config
        $script:LastPublish = Get-Date
      }
    }

    if ($script:Primary -and ((Get-Date) - $script:LastPublish).TotalSeconds -gt 300) {
      Publish-Config
      $script:LastPublish = Get-Date
    }
  } catch {
    Write-Log "Loop error: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds $PollSeconds
}
