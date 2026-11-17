<#
  Alexia health check - one screen with everything that matters on the server box.
  Run from an administrator PowerShell:
    powershell -ExecutionPolicy Bypass -File C:\Alexia\check.ps1
#>
param([string]$Root = "C:\Alexia")
$ErrorActionPreference = "SilentlyContinue"

function Row($label, $value, $good) {
  $color = "Gray"
  if ($good -eq $true) { $color = "Green" }
  if ($good -eq $false) { $color = "Yellow" }
  Write-Host ("  {0,-22} " -f $label) -NoNewline
  Write-Host $value -ForegroundColor $color
}

$envFile = Join-Path $Root "app\.env"
$settings = @{}
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $settings[$Matches[1]] = $Matches[2].Trim() }
  }
}
$port = 8080
if ($settings["PORT"]) { $port = [int]$settings["PORT"] }

Write-Host ""
Write-Host "  Alexia Guardian server - $env:COMPUTERNAME" -ForegroundColor Cyan
Write-Host ""

$task = Get-ScheduledTask -TaskName "Alexia"
Row "Startup task" $(if ($task) { $task.State } else { "MISSING - run install.ps1" }) ($task -and $task.State -eq "Running")
$wd = Get-ScheduledTask -TaskName "Alexia watchdog"
Row "Watchdog" $(if ($wd) { "installed" } else { "MISSING" }) ([bool]$wd)

$h = $null
try {
  $h = Invoke-RestMethod "http://127.0.0.1:$port/v1/health" -TimeoutSec 5
  $up = [TimeSpan]::FromSeconds($h.uptimeSec)
  Row "Platform" ("{0} answering, up {1}d {2}h {3}m, mode {4}" -f $h.version, $up.Days, $up.Hours, $up.Minutes, $h.gateway.mode) $true
  Row "Incidents / approvals" ("{0} open / {1} pending ({2} agents active)" -f $h.counts.incidents, $h.counts.approvals, $h.counts.agents) $null
} catch {
  Row "Platform" "NOT ANSWERING on port $port - see $Root\logs\alexia.log" $false
}

try {
  $audit = Invoke-RestMethod "http://127.0.0.1:$port/api/v1/audit/verify" -TimeoutSec 5
  # /api/v1/audit/verify returns { valid, records_checked, verification_error }
  Row "Audit SHA-256 chain" $(if ($audit.valid) { "VERIFIED ($($audit.records_checked) signed blocks)" } else { "TAMPER DETECTED: $($audit.verification_error)" }) ([bool]$audit.valid)
} catch { }

$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
Row "Machine up since" $boot $null

Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" } | ForEach-Object {
  $ip = $_.IPv4Address.IPAddress
  $dhcp = (Get-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4).Dhcp
  Row "LAN address" ("http://{0}:{1}  ({2}, {3}, gateway {4})" -f $ip, $port, $_.InterfaceAlias, $(if ($dhcp -eq "Enabled") { "DHCP - reserve it in the router" } else { "static" }), $_.IPv4DefaultGateway.NextHop) $null
  $category = (Get-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex).NetworkCategory
  Row "Network type" $category ("$category" -ne "Public")
}

$tailscale = "C:\Program Files\Tailscale\tailscale.exe"
if (Test-Path $tailscale) {
  $tsIp = (& $tailscale ip -4 2>$null | Select-Object -First 1)
  Row "Tailscale" $(if ($tsIp) { "http://${tsIp}:$port  (reachable from your phone anywhere)" } else { "installed but not connected - run: tailscale up --unattended" }) ([bool]$tsIp)
} else {
  Row "Tailscale" "not installed - no remote access" $false
}

try {
  $internet = Invoke-WebRequest "https://connectivitycheck.gstatic.com/generate_204" -UseBasicParsing -TimeoutSec 8
  Row "Internet" "reachable" $true
} catch { Row "Internet" "NOT reachable (LAN console still works)" $false }

$publicUrl = $settings["ALEXIA_INTERNET_URL"]
if ($h -and $h.internetUrl) { $publicUrl = $h.internetUrl }
if ($publicUrl) {
  Row "Internet address" $publicUrl $true
} else {
  Row "Internet address" "off - Guardian console and mobile companion only work on this network" $null
}

Row "Phone alerts" $(if ($settings["ALEXIA_ALERT_NTFY"]) { "on ($($settings['ALEXIA_ALERT_NTFY']))" } else { "off - set ALEXIA_ALERT_NTFY" }) ([bool]$settings["ALEXIA_ALERT_NTFY"])
Row "Heartbeat" $(if ($settings["ALEXIA_HEARTBEAT_URL"]) { "on" } else { "off - power cuts will go unnoticed" }) ([bool]$settings["ALEXIA_HEARTBEAT_URL"])

$backupDir = $settings["ALEXIA_BACKUP_DIR"]
if (-not $backupDir) { $backupDir = Join-Path $Root "backups" }
$latest = Get-ChildItem $backupDir -Filter "alexia-*.db" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latest) {
  $age = (Get-Date) - $latest.LastWriteTime
  Row "Last backup" ("{0}  ({1:N0} h ago)" -f $latest.Name, $age.TotalHours) ($age.TotalHours -lt 30)
} else { Row "Last backup" "none yet" $false }

$drive = (Split-Path $Root -Qualifier)
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$drive'"
if ($disk) {
  $freePct = [math]::Round(100 * $disk.FreeSpace / $disk.Size)
  Row "Disk $drive" ("{0:N0} GB free of {1:N0} GB ({2}%)" -f ($disk.FreeSpace / 1GB), ($disk.Size / 1GB), $freePct) ($freePct -gt 10)
}

$standby = (powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Select-String "Current AC Power Setting Index" | Select-Object -First 1)
$sleeps = $standby -and ($standby.ToString() -notmatch "0x00000000")
Row "Sleep" $(if ($sleeps) { "ON - the server will go to sleep" } else { "never" }) (-not $sleeps)

$wdLog = Join-Path $Root "logs\watchdog.log"
if (Test-Path $wdLog) {
  $last = Get-Content $wdLog -Tail 1
  if ($last) { Row "Watchdog last said" $last $null }
}
Write-Host ""
Write-Host "  Log: $Root\logs\alexia.log   (Get-Content $Root\logs\alexia.log -Tail 40)"
Write-Host ""
