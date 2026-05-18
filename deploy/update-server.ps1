# Opera Sync - Download latest build and restart service
# Manual: double-click or run from PowerShell
# Unattended (Task Scheduler): pass -Unattended to suppress prompts
# Force: pass -Force to redeploy even if release marker matches

param(
    [switch]$Force,
    [switch]$Unattended
)

# Force TLS 1.2 (older Windows/PowerShell defaults to TLS 1.0 which GitHub rejects)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = "francisphan/opera-file-sync"
$serviceName = "OPERASync"
$installDir = "D:\opera-sf-sync"
$exeName = "opera-sync-db.exe"
$nssm = Join-Path $installDir "nssm.exe"
$markerFile = Join-Path $installDir "last-deploy.txt"
$logDir = Join-Path $installDir "logs"
$logFile = Join-Path $logDir "update-server.log"

# Set up transcript log (always, for both manual and scheduled runs)
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 5MB)) {
    Get-Content $logFile -Tail 1000 | Set-Content $logFile
}
Start-Transcript -Path $logFile -Append | Out-Null

function Exit-Script($code) {
    try { Stop-Transcript | Out-Null } catch {}
    if (-not $Unattended -and $code -ne 0) { Read-Host "Press Enter to exit" }
    exit $code
}

Write-Host ""
Write-Host "=== Opera Sync Updater === $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan

# Fetch latest release info
$apiUrl = "https://api.github.com/repos/$repo/releases/tags/latest"
try {
    $release = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "opera-sync-updater" }
} catch {
    Write-Host "ERROR: Failed to fetch release info: $_" -ForegroundColor Red
    Exit-Script 1
}

$asset = $release.assets | Where-Object { $_.name -eq $exeName }
if (-not $asset) {
    Write-Host "ERROR: Could not find $exeName in latest release" -ForegroundColor Red
    Exit-Script 1
}

# Skip if this release was already deployed (idempotent for polling)
$assetMarker = "$($asset.id):$($asset.updated_at)"
if (-not $Force -and (Test-Path $markerFile)) {
    $lastMarker = (Get-Content $markerFile -Raw).Trim()
    if ($lastMarker -eq $assetMarker) {
        Write-Host "No new release - already on asset $($asset.id) ($($asset.updated_at)). Skipping." -ForegroundColor Gray
        Exit-Script 0
    }
}

Write-Host "New release detected: asset $($asset.id) updated $($asset.updated_at)" -ForegroundColor Yellow

$tempPath = Join-Path $env:TEMP $exeName
$destPath = Join-Path $installDir $exeName
$backupPath = Join-Path $installDir "$exeName.bak"

Write-Host "Downloading $exeName ($([math]::Round($asset.size / 1MB, 1)) MB)..."
try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tempPath
} catch {
    Write-Host "ERROR: Download failed: $_" -ForegroundColor Red
    Exit-Script 1
}

# Stop service
Write-Host "Stopping $serviceName..."
& $nssm stop $serviceName
Start-Sleep -Seconds 5

# Backup current exe
if (Test-Path $destPath) {
    Write-Host "Backing up current exe..."
    Copy-Item $destPath $backupPath -Force
}

# Replace exe
Write-Host "Installing new exe..."
Copy-Item $tempPath $destPath -Force
Remove-Item $tempPath -Force

# Start service
Write-Host "Starting $serviceName..."
& $nssm start $serviceName

# Record this release as deployed
Set-Content -Path $markerFile -Value $assetMarker -NoNewline

Write-Host ""
Write-Host "Done! Service restarted with latest build." -ForegroundColor Green
Write-Host "Backup saved to $backupPath"
Write-Host "Release: $($release.body)"
if (-not $Unattended) { Read-Host "Press Enter to exit" }
Exit-Script 0
