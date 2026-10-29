<#
  Restarts the Alexia Guardian platform - after editing C:\Alexia\app\.env, for example.
  Stops the running platform; the startup task's loop starts it again within seconds.
  Run as administrator (or double-click C:\Alexia\restart.cmd and allow it).
#>
param([string]$Root = "C:\Alexia")
$ErrorActionPreference = "Stop"

$liveness = Join-Path $Root "data\monitor.json"
if (Test-Path $liveness) {
  try {
    $state = Get-Content $liveness -Raw | ConvertFrom-Json
    $state | Add-Member -NotePropertyName cleanStop -NotePropertyValue $true -Force
    $state | ConvertTo-Json -Compress | Set-Content -Path $liveness -Encoding ASCII
  } catch { }
}

Set-Content -Path (Join-Path $Root "desired-state") -Value "running" -Encoding ASCII

$running = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq "AlexiaServer.exe") -or
  ($_.Name -eq "python.exe" -and $_.CommandLine -like "*$Root\app*")
}
if ($running) {
  $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "Stopped. Alexia starts again in a few seconds."
} else {
  Write-Host "Alexia was not running; starting the task."
  Start-ScheduledTask -TaskName "Alexia" -ErrorAction SilentlyContinue
}

$port = 8080
$portLine = Get-Content (Join-Path $Root "app\.env") -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\s*PORT\s*=\s*(\d+)' } | Select-Object -First 1
if ($portLine -match '(\d+)') { $port = [int]$Matches[1] }

for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 2
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:$port/v1/health" -TimeoutSec 3
    Write-Host "Alexia $($health.version) is running." -ForegroundColor Green
    exit 0
  } catch { }
}
Write-Warning "No answer yet. Look at $Root\logs\alexia.log"
