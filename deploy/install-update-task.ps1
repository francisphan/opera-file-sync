# Install scheduled task that checks GitHub for new opera-file-sync releases
# twice a week and auto-deploys via update-server.ps1.
#
# Run ONCE as Administrator after copying update-server.ps1 to $installDir.
# Re-running is safe — it replaces any existing task with the same name.
#
# Manual triggers (no scheduled task changes needed):
#   Start-ScheduledTask -TaskName OperaSyncAutoDeploy     # run a poll now
#   powershell -File D:\opera-sf-sync\update-server.ps1   # interactive deploy
#   powershell -File D:\opera-sf-sync\update-server.ps1 -Force   # bypass marker

param(
    [string[]]$DaysOfWeek = @("Monday", "Thursday"),
    [string]$TimeOfDay = "09:00"
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

# Twice-weekly trigger: e.g., Mon + Thu at 09:00 local time
$trigger = New-ScheduledTaskTrigger `
    -Weekly `
    -DaysOfWeek $DaysOfWeek `
    -At $TimeOfDay

# Run as SYSTEM — no password needed, has full disk access, matches NSSM service context
$taskPrincipal = New-ScheduledTaskPrincipal `
    -UserId "SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel Highest

# StartWhenAvailable: if the server was off at the scheduled time, run as soon as it's up
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $taskPrincipal `
    -Settings $settings `
    -Description "Polls GitHub for new opera-file-sync releases (twice weekly) and auto-deploys via update-server.ps1" | Out-Null

Write-Host ""
Write-Host "Installed scheduled task '$taskName'." -ForegroundColor Green
Write-Host "  - Runs on: $($DaysOfWeek -join ', ') at $TimeOfDay (server local time)"
Write-Host "  - Runs as SYSTEM, no login required"
Write-Host "  - Catches missed runs if server was off (StartWhenAvailable)"
Write-Host ""
Write-Host "Logs: $installDir\logs\update-server.log"
Write-Host ""
Write-Host "Manual triggers:"
Write-Host "  Start-ScheduledTask -TaskName $taskName"
Write-Host "    -> runs the scheduled task now (still skips if release unchanged)"
Write-Host "  powershell -File $scriptPath"
Write-Host "    -> interactive run (same idempotent behavior, shows output, prompts on error)"
Write-Host "  powershell -File $scriptPath -Force"
Write-Host "    -> bypass the 'unchanged' marker and redeploy regardless"
Write-Host ""
Write-Host "Remove the task:"
Write-Host "  Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false"
