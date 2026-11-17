<#
  Alexia watchdog. Runs every two minutes as a scheduled task (install.ps1 sets it up).

  The startup task already restarts the platform if it exits. This catches the other failure:
  the process is alive but no longer answering - hung, or stuck on a port. Three failed checks
  in a row (about six minutes) and it restarts the platform. It also starts the startup task
  if that is not running at all.
#>
param(
  [string]$Root = "C:\Alexia",
  [int]$Port = 8080
)
$ErrorActionPreference = "SilentlyContinue"

$logs = Join-Path $Root "logs"
$log = Join-Path $logs "watchdog.log"
$stateFile = Join-Path $Root "watchdog.state"
New-Item -ItemType Directory -Force $logs | Out-Null

function Log($text) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Move-Item $log "$log.1" -Force }
  Add-Content -Path $log -Value ("[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $text)
}

# Stopped on purpose from the Server Manager: leave it stopped until it is started again.
$desired = Join-Path $Root "desired-state"
if ((Test-Path $desired) -and ((Get-Content $desired -Raw).Trim() -eq "stopped")) { exit 0 }

$task = Get-ScheduledTask -TaskName "Alexia"
if (-not $task) { Log "The Alexia task is missing - run install.ps1 again"; exit 1 }
if ($task.State -ne "Running") {
  Log "The Alexia task was $($task.State) - starting it"
  Start-ScheduledTask -TaskName "Alexia"
  Set-Content $stateFile 0
  exit 0
}

$ok = $false
try {
  $health = Invoke-RestMethod "http://127.0.0.1:$Port/v1/health" -TimeoutSec 10
  $ok = [bool]($health.ok -or $health.status -eq "healthy")
} catch { $ok = $false }

$failures = 0
if (Test-Path $stateFile) { $failures = [int](Get-Content $stateFile -Raw) }

if ($ok) {
  if ($failures -gt 0) { Log "Answering again after $failures failed check(s)" }
  Set-Content $stateFile 0
  exit 0
}

# Give a platform that has just started a moment to open its port.
$proc = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq "AlexiaServer.exe") -or
  ($_.Name -eq "python.exe" -and $_.CommandLine -like "*$Root\app*")
}
$young = $proc | Where-Object { ((Get-Date) - $_.CreationDate).TotalSeconds -lt 90 }
if ($young) { exit 0 }

$failures++
Set-Content $stateFile $failures
Log "No answer on port $Port (check $failures of 3)"
if ($failures -ge 3) {
  Log "Restarting the platform"
  $proc | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Set-Content $stateFile 0
}
