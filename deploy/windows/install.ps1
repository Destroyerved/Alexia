#Requires -RunAsAdministrator
<#
  Alexia — Autonomous DevSecOps Guardian: Windows Server Installer & Upgrader.

  Run once from an elevated PowerShell window (or from the Alexia Server Manager Setup tab):
    powershell -ExecutionPolicy Bypass -File .\deploy\windows\install.ps1

  Safe to run again: an upgrade replaces C:\Alexia\app and leaves C:\Alexia\data,
  C:\Alexia\backups, and C:\Alexia\app\.env untouched. If the new version fails to
  start within 60 seconds, the previous version is automatically restored.

    C:\Alexia\app        the platform (AlexiaServer.exe, alexia/, dashboard/, config/, target-app/)
    C:\Alexia\data       SQLite database (alexia.db), forensic evidence, and snapshots
    C:\Alexia\backups    nightly SQLite backups (alexia-YYYYMMDD-HHMMSS.db)
    C:\Alexia\logs       alexia.log and watchdog.log
    C:\Alexia\app\.env   settings; created once, never overwritten
#>
param(
  [string]$Root = "C:\Alexia",
  [string]$SourceDir = "",
  [switch]$Tailscale,
  [switch]$Funnel,
  [string]$CloudflareToken = "",
  [string]$CloudflareTokenFile = "",
  [string]$InternetUrl = "",
  [switch]$QuickTunnel,
  [switch]$RemoteDesktop,
  [switch]$SkipSystemTuning
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Say($text)  { Write-Host "`n==> $text" -ForegroundColor Green }
function Note($text) { Write-Host "    $text" -ForegroundColor Gray }
function Warn($text) { Write-Host " !! $text" -ForegroundColor Yellow }

function Try-Step([string]$What, [scriptblock]$Body) {
  try { & $Body } catch { Warn "$What could not be changed ($($_.Exception.Message)) - continuing" }
}

function Set-Setting([string]$File, [string]$Key, [string]$Value) {
  $lines = @()
  if (Test-Path $File) { $lines = @(Get-Content $File) }
  $found = $false
  $out = foreach ($line in $lines) {
    if ($line -match "^\s*$([Regex]::Escape($Key))\s*=") {
      $found = $true
      "$Key=$Value"
    } else {
      $line
    }
  }
  if (-not $found) { $out += "$Key=$Value" }
  $out | Set-Content -Path $File -Encoding ASCII
}

if ($Funnel) { $Tailscale = $true }
if ($CloudflareTokenFile) {
  if (-not (Test-Path $CloudflareTokenFile)) { throw "Cloudflare token file not found: $CloudflareTokenFile" }
  $CloudflareToken = (Get-Content $CloudflareTokenFile -Raw).Trim()
}

# ---------------------------------------------------------------- find source files
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $SourceDir) {
  foreach ($candidate in @($here, (Join-Path $here "..\.."), (Join-Path $here "..\bundle\server"))) {
    $resolved = Resolve-Path $candidate -ErrorAction SilentlyContinue
    if ($resolved -and ((Test-Path (Join-Path $resolved.Path "AlexiaServer.exe")) -or (Test-Path (Join-Path $resolved.Path "alexia\api\main.py")))) {
      $SourceDir = $resolved.Path
      break
    }
  }
}
if (-not $SourceDir) {
  throw "Could not find the Alexia server files. Pass -SourceDir C:\path\to\Alexia"
}

$version = "1.0.0"
$pkgFile = Join-Path $SourceDir "package.json"
if (Test-Path $pkgFile) {
  try {
    $pkg = Get-Content $pkgFile -Raw | ConvertFrom-Json
    if ($pkg.version) { $version = $pkg.version }
  } catch { }
}
Say "Installing Alexia DevSecOps Guardian $version into $Root"

# ---------------------------------------------------------------- folders & permissions
$app     = Join-Path $Root "app"
$data    = Join-Path $Root "data"
$backups = Join-Path $Root "backups"
$logs    = Join-Path $Root "logs"
$runtime = Join-Path $Root "runtime"
foreach ($dir in @($Root, $app, $data, (Join-Path $data "evidence"), (Join-Path $data "snapshots"), $backups, $logs, $runtime)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

foreach ($private in @($data, $backups)) {
  Try-Step "Restrict folder permissions on $private" {
    & icacls $private /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
  }
}

Try-Step "Tell Windows Defender to skip SQLite database & log folders" {
  Add-MpPreference -ExclusionPath @($data, $backups, $logs) -ErrorAction Stop
}

# ---------------------------------------------------------------- runtime (AlexiaServer.exe / Python)
$bundledExe = Join-Path $SourceDir "AlexiaServer.exe"
$runtimeExe = Join-Path $runtime "AlexiaServer.exe"
if (Test-Path $bundledExe) {
  Say "Installing standalone runtime binary (AlexiaServer.exe)"
  Copy-Item -Force $bundledExe $runtimeExe
}

# ---------------------------------------------------------------- stop existing task before swap
$taskName     = "Alexia"
$watchdogName = "Alexia watchdog"

function Stop-Platform {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "AlexiaServer.exe") -or
    ($_.Name -eq "python.exe" -and $_.CommandLine -like "*$app*")
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

function Start-Platform {
  Set-Content -Path (Join-Path $Root "desired-state") -Value "running" -Encoding ASCII
  Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

Stop-Platform

# ---------------------------------------------------------------- stage & swap app
Say "Copying Alexia platform to $app"
$envFile  = Join-Path $app ".env"
$staging  = Join-Path $Root "app.new"
$previous = Join-Path $Root "app.old"
$failed   = Join-Path $Root "app.failed"
foreach ($leftover in @($staging, $previous, $failed)) {
  if (Test-Path $leftover) { Remove-Item -Recurse -Force $leftover }
}
New-Item -ItemType Directory -Force $staging | Out-Null

foreach ($item in @("AlexiaServer.exe", "launcher.py", "MainFrame.py", "alexia", "dashboard", "config", "target-app", "package.json", ".env.example")) {
  $srcItem = Join-Path $SourceDir $item
  if (Test-Path $srcItem) {
    Copy-Item -Recurse -Force $srcItem (Join-Path $staging $item)
  }
}
if ((Test-Path $envFile)) {
  Copy-Item -Force $envFile (Join-Path $staging ".env")
}

function Undo-Swap {
  if (-not (Test-Path $previous)) { return }
  if (Test-Path $app) { Move-Item $app $failed -Force }
  Move-Item $previous $app -Force
}

try {
  if (Test-Path $app) { Move-Item $app $previous }
  Move-Item $staging $app
} catch {
  Undo-Swap
  throw
}

# ---------------------------------------------------------------- settings (.env on first install)
$firstInstall = -not (Test-Path $envFile)
$adminPassword = ""
$ntfyUrl = ""
$newAlerts = $false

if ($firstInstall) {
  Say "Writing initial settings to $envFile"
  $bytes = New-Object byte[] 36
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $jwtSecret = [Convert]::ToBase64String($bytes)

  $pwChars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  $pwBytes = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($pwBytes)
  $adminPassword = -join ($pwBytes | ForEach-Object { $pwChars[$_ % $pwChars.Length] })

  $topicBytes = New-Object byte[] 6
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($topicBytes)
  $ntfyTopic = "alexia-" + ([BitConverter]::ToString($topicBytes).Replace("-", "").ToLower())
  $ntfyUrl = "https://ntfy.sh/$ntfyTopic"
  $newAlerts = $true

  @"
# Alexia — Autonomous DevSecOps Guardian Settings
# After editing: restart from Alexia Server Manager or run C:\Alexia\restart.cmd
PORT=8080
HOST=0.0.0.0
ALEXIA_DATA_DIR=$data
ALEXIA_BACKUP_DIR=$backups
ALEXIA_BACKUP_COPY_DIR=
ALEXIA_BACKUP_KEEP=14
ALEXIA_BACKUP_HOUR=3
ALEXIA_JWT_SECRET=$jwtSecret
ALEXIA_ADMIN_EMAIL=admin@alexia.local
ALEXIA_ADMIN_PASSWORD=$adminPassword
ALEXIA_ALERT_NTFY=$ntfyUrl
ALEXIA_HEARTBEAT_URL=
ALEXIA_INTERNET_PORT=8080
ALEXIA_INTERNET_URL=
ALEXIA_TUNNEL=

# Nebius Token Factory (NVIDIA Nemotron 3) & Tavily Search API Keys
NEBIUS_API_KEY=
NEBIUS_BASE_URL=https://api.tokenfactory.nebius.com/v1/
TAVILY_API_KEY=

# Security & Budget Guardrails
DAILY_USD_BUDGET=10.00
DAILY_TOKEN_BUDGET=5000000
SHOPLITE_URL=http://127.0.0.1:8000
"@ | Set-Content -Path $envFile -Encoding ASCII
} else {
  Note "Keeping existing settings in $envFile"
  Set-Setting $envFile "ALEXIA_DATA_DIR" $data
  if (-not (Select-String -Path $envFile -Pattern "^\s*ALEXIA_BACKUP_DIR=" -Quiet)) {
    Set-Setting $envFile "ALEXIA_BACKUP_DIR" $backups
  }
}

$port = 8080
$portLine = Get-Content $envFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\s*PORT\s*=\s*(\d+)' } | Select-Object -First 1
if ($portLine -match '(\d+)') { $port = [int]$Matches[1] }
$internetPort = $port

# ---------------------------------------------------------------- helper scripts & runner
foreach ($helper in @("watchdog.ps1", "check.ps1", "restart.ps1")) {
  $srcHelper = Join-Path $here $helper
  if (Test-Path $srcHelper) {
    Copy-Item -Force $srcHelper (Join-Path $Root $helper)
  }
}

$runner = Join-Path $Root "run.cmd"
@"
@echo off
title Alexia DevSecOps Guardian
cd /d "$app"
set ALEXIA_SUPERVISED=1
set ALEXIA_DATA_DIR=$data
set ALEXIA_BACKUP_DIR=$backups
:loop
if exist "$logs\alexia.log" (
  for %%F in ("$logs\alexia.log") do if %%~zF GTR 20971520 move /y "$logs\alexia.log" "$logs\alexia.log.1" >nul
)
echo [%date% %time%] Starting Alexia Guardian platform >> "$logs\alexia.log"
if exist "$app\AlexiaServer.exe" (
  "$app\AlexiaServer.exe" --no-browser --port $port >> "$logs\alexia.log" 2>&1
) else if exist "$runtime\AlexiaServer.exe" (
  "$runtime\AlexiaServer.exe" --no-browser --port $port >> "$logs\alexia.log" 2>&1
) else (
  python "$app\launcher.py" --no-browser --port $port >> "$logs\alexia.log" 2>&1
)
echo [%date% %time%] Alexia exited with code %errorlevel%. >> "$logs\alexia.log"
:wait_if_stopped
if exist "$Root\desired-state" (
  findstr /i "stopped" "$Root\desired-state" >nul 2>&1
  if not errorlevel 1 (
    timeout /t 5 /nobreak >nul
    goto wait_if_stopped
  )
)
timeout /t 3 /nobreak >nul
goto loop
"@ | Set-Content -Path $runner -Encoding ASCII

@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Root\restart.ps1" -Root "$Root"
pause
"@ | Set-Content -Path (Join-Path $Root "restart.cmd") -Encoding ASCII

# ---------------------------------------------------------------- scheduled tasks
Say "Registering Windows Scheduled Tasks ($taskName + $watchdogName)"
$action    = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$runner`"" -WorkingDirectory $app
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

$wdAction  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Root\watchdog.ps1`" -Root `"$Root`" -Port $port"
$wdTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 2) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$wdSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $watchdogName -Action $wdAction -Trigger $wdTrigger -Principal $principal -Settings $wdSettings -Force | Out-Null

# ---------------------------------------------------------------- firewall
Say "Opening Windows Firewall for Alexia Guardian (TCP $port)"
Remove-NetFirewallRule -DisplayName "Alexia Guardian API" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "Alexia Guardian API" -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Private,Domain,Public | Out-Null

# ---------------------------------------------------------------- PC server tuning
if (-not $SkipSystemTuning) {
  Say "Applying server power and reliability settings"
  foreach ($setting in @("standby-timeout-ac", "standby-timeout-dc", "hibernate-timeout-ac", "hibernate-timeout-dc", "disk-timeout-ac", "disk-timeout-dc")) {
    & powercfg /change $setting 0 2>$null
  }
  & powercfg /h off 2>$null
  Try-Step "Configure automatic restart on crash" {
    & wmic recoveros set AutoReboot = True >$null 2>&1
  }
}

if ($RemoteDesktop) {
  Say "Enabling Remote Desktop"
  Try-Step "Enable Remote Desktop" {
    Set-ItemProperty -Path "HKLM:\System\CurrentControlSet\Control\Terminal Server" -Name "fDenyTSConnections" -Value 0
    Enable-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------- internet access
$tailscaleExe = "C:\Program Files\Tailscale\tailscale.exe"
if ($Tailscale) {
  Say "Checking Tailscale"
  if (-not (Test-Path $tailscaleExe)) {
    winget install --id Tailscale.Tailscale --silent --accept-package-agreements --accept-source-agreements
  }
}
if ($QuickTunnel) {
  Set-Setting $envFile "ALEXIA_INTERNET_PORT" "$internetPort"
  Set-Setting $envFile "ALEXIA_TUNNEL" "quick"
  Set-Setting $envFile "ALEXIA_INTERNET_URL" ""
}
if ($CloudflareToken) {
  Say "Configuring Cloudflare Tunnel"
  if (-not $InternetUrl) { throw "-CloudflareToken needs -InternetUrl too, e.g. -InternetUrl https://alexia.example.com" }
  $cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
  if (-not $cloudflared) {
    winget install --id Cloudflare.cloudflared --silent --accept-package-agreements --accept-source-agreements
    foreach ($candidate in @("C:\Program Files (x86)\cloudflared\cloudflared.exe", "C:\Program Files\cloudflared\cloudflared.exe")) {
      if (-not $cloudflared -and (Test-Path $candidate)) { $cloudflared = $candidate }
    }
  }
  if ($cloudflared) {
    if (-not (Get-Service cloudflared -ErrorAction SilentlyContinue)) {
      & $cloudflared service install $CloudflareToken
    }
    Set-Service cloudflared -StartupType Automatic -ErrorAction SilentlyContinue
    Start-Service cloudflared -ErrorAction SilentlyContinue
  }
  $InternetUrl = $InternetUrl.TrimEnd("/")
}
if ($Funnel -and (Test-Path $tailscaleExe)) {
  Say "Configuring Tailscale Funnel"
  try {
    & $tailscaleExe funnel --bg $internetPort
    $self = (& $tailscaleExe status --json | ConvertFrom-Json).Self
    if ($self -and $self.DNSName) { $InternetUrl = "https://" + $self.DNSName.TrimEnd(".") }
  } catch {
    Warn "Tailscale Funnel could not be enabled automatically: $($_.Exception.Message)"
  }
}
if ($InternetUrl) {
  Set-Setting $envFile "ALEXIA_INTERNET_PORT" "$internetPort"
  Set-Setting $envFile "ALEXIA_INTERNET_URL" $InternetUrl
  Set-Setting $envFile "ALEXIA_TUNNEL" ""
  Note "Internet address: $InternetUrl"
}

# ---------------------------------------------------------------- start and verify
function Wait-Healthy([int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $h = Invoke-RestMethod "http://127.0.0.1:$port/v1/health" -TimeoutSec 3
      if ($h -and ($h.ok -or $h.status -eq "healthy")) { return $h }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $null
}

Say "Starting Alexia Guardian service"
Start-Platform
Start-ScheduledTask -TaskName $watchdogName -ErrorAction SilentlyContinue
$health = Wait-Healthy 60
$healthy = [bool]$health

if (-not $healthy -and (Test-Path $previous)) {
  Warn "Alexia $version did not answer within 60 seconds. Rolling back to previous version."
  Get-Content (Join-Path $logs "alexia.log") -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "      $_" }
  Stop-Platform
  Undo-Swap
  Start-Platform
  $health = Wait-Healthy 45
  throw "Alexia $version did not start; previous version restored. See $logs\alexia.log"
}

if (Test-Path $previous) {
  Remove-Item -Recurse -Force $previous -ErrorAction SilentlyContinue
}

if ($healthy) {
  Say "Alexia $($health.version) is running on port $port"
  # Take initial backup if none exists yet
  $existingBackups = @(Get-ChildItem $backups -Filter "alexia-*.db" -ErrorAction SilentlyContinue)
  if ($existingBackups.Count -eq 0 -and (Test-Path (Join-Path $app "AlexiaServer.exe"))) {
    Try-Step "Take initial SQLite backup" {
      & (Join-Path $app "AlexiaServer.exe") --backup | Out-Null
    }
  }
} else {
  Warn "The platform did not answer yet. Check $logs\alexia.log"
}

Write-Host ""
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | ForEach-Object {
  $label = "On the network"
  if ($_.IPAddress -like "100.*") { $label = "From anywhere" }
  Write-Host ("   {0,-15} http://{1}:{2}" -f $label, $_.IPAddress, $port)
}
Write-Host "   Data           $data"
Write-Host "   Backups        $backups   (nightly at 03:00 IST)"
Write-Host "   Log            $logs\alexia.log"
Write-Host "   Health check   powershell -ExecutionPolicy Bypass -File $Root\check.ps1"
Write-Host "   Restart        $Root\restart.cmd  (Run as administrator)"
if ($firstInstall) {
  Write-Host ""
  Write-Host "   First admin    admin@alexia.local"
  Write-Host "   Password       $adminPassword   (shown once - change it from the console)"
  Write-Host "   Demo operator  demo / alexiaguardian2026"
}
if ($newAlerts -and $ntfyUrl) {
  Write-Host ""
  Write-Host "   Phone alerts   Install the ntfy app, tap +, and subscribe to:" -ForegroundColor Cyan
  Write-Host "                  $($ntfyUrl -replace '^https://ntfy.sh/', '')" -ForegroundColor Cyan
}
Write-Host ""
