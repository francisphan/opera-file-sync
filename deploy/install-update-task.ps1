# Install scheduled task that polls GitHub for new opera-file-sync releases
# and auto-deploys via update-server.ps1.
#
# Run ONCE as Administrator after copying update-server.ps1 to $installDir.
# Re-running is safe — it replaces any existing task with the same name.

param(
    [int]$IntervalMinutes = 10
)

$taskName = "OperaSyncAutoDeploy"
$installDir = "D:\opera-sf-sync"
$scriptPath = Join-Path $installDir "update-server.ps1"

# Verify update-server.ps1 is in place
if (-not (Test-Path $scriptPath)) {
    Write-Host "ERROR: $scriptPath not found." -ForegroundColor Red
    Write-Host "Copy update-server.ps1 to $installDir first." -ForegroundColor Red
    exit 1
}

# Verify running as admin (scheduled task creation requires it)
$current = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($current)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: This script must be run as Administrator." -ForegroundColor Red
    exit 1
}

# Remove existing task (idempotent re-install)
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing '$taskName' task..." -ForegroundColor Gray
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Unattended"

# Triggers: at boot, then every $IntervalMinutes thereafter (24h repetition cycle)
$startTrigger = New-ScheduledTaskTrigger -AtStartup
$repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2)
$repeatTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 365)).Repetition

# Run as SYSTEM — no password needed, has full disk access, matches NSSM service context
$taskPrincipal = New-ScheduledTaskPrincipal `
    -UserId "SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger @($startTrigger, $repeatTrigger) `
    -Principal $taskPrincipal `
    -Settings $settings `
    -Description "Polls GitHub for new opera-file-sync releases and auto-deploys via update-server.ps1" | Out-Null

Write-Host ""
Write-Host "Installed scheduled task '$taskName'." -ForegroundColor Green
Write-Host "  - Runs at server startup"
Write-Host "  - Polls every $IntervalMinutes minutes thereafter"
Write-Host "  - Runs as SYSTEM, no login required"
Write-Host ""
Write-Host "Logs: $installDir\logs\update-server.log"
Write-Host "Manage: Task Scheduler GUI, or:"
Write-Host "  Get-ScheduledTask -TaskName $taskName"
Write-Host "  Start-ScheduledTask -TaskName $taskName    # run immediately"
Write-Host "  Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false"
