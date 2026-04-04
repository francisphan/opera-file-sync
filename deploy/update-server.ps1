# Opera Sync — Download latest build and restart service
# Double-click or run manually to update the server

# Force TLS 1.2 (older Windows/PowerShell defaults to TLS 1.0 which GitHub rejects)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = "francisphan/opera-file-sync"
$serviceName = "OPERASync"
$installDir = "D:\opera-sf-sync"
$exeName = "opera-sync-db.exe"
$nssm = Join-Path $installDir "nssm.exe"

Write-Host "=== Opera Sync Updater ===" -ForegroundColor Cyan

# Download latest release
$apiUrl = "https://api.github.com/repos/$repo/releases/tags/latest"
Write-Host "Fetching latest release info..."
$release = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "opera-sync-updater" }
$asset = $release.assets | Where-Object { $_.name -eq $exeName }

if (-not $asset) {
    Write-Host "ERROR: Could not find $exeName in latest release" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

$tempPath = Join-Path $env:TEMP $exeName
$destPath = Join-Path $installDir $exeName
$backupPath = Join-Path $installDir "$exeName.bak"

Write-Host "Downloading $exeName ($([math]::Round($asset.size / 1MB, 1)) MB)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tempPath

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

Write-Host ""
Write-Host "Done! Service restarted with latest build." -ForegroundColor Green
Write-Host "Backup saved to $backupPath"
Write-Host "Release: $($release.body)"
Read-Host "Press Enter to exit"
