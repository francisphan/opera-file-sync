# Opera Sync — Download latest build and restart service
# Double-click or run manually to update the server

$repo = "francisphan/opera-file-sync"
$serviceName = "opera-sf-sync"         # UPDATE: your NSSM service name
$ghToken = $env:GITHUB_TOKEN           # Set via: [System.Environment]::SetEnvironmentVariable('GITHUB_TOKEN', 'ghp_...', 'User')
$installDir = "D:\opera-sf-sync"
$exeName = "opera-sync-db.exe"

Write-Host "=== Opera Sync Updater ===" -ForegroundColor Cyan

if (-not $ghToken) {
    Write-Host "ERROR: GITHUB_TOKEN not set. Run:" -ForegroundColor Red
    Write-Host '  [System.Environment]::SetEnvironmentVariable("GITHUB_TOKEN", "ghp_...", "User")' -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

$headers = @{
    "User-Agent" = "opera-sync-updater"
    "Authorization" = "Bearer $ghToken"
}

# Download latest release
$apiUrl = "https://api.github.com/repos/$repo/releases/tags/latest"
Write-Host "Fetching latest release info..."
$release = Invoke-RestMethod -Uri $apiUrl -Headers $headers
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
$dlHeaders = $headers.Clone()
$dlHeaders["Accept"] = "application/octet-stream"
Invoke-WebRequest -Uri $asset.url -Headers $dlHeaders -OutFile $tempPath

# Stop service
Write-Host "Stopping $serviceName..."
nssm stop $serviceName
Start-Sleep -Seconds 3

# Backup current exe
if (Test-Path $destPath) {
    Write-Host "Backing up current exe..."
    Copy-Item $destPath $backupPath -Force
}

# Replace exe
Write-Host "Installing new exe..."
Move-Item $tempPath $destPath -Force

# Start service
Write-Host "Starting $serviceName..."
nssm start $serviceName

Write-Host ""
Write-Host "Done! Service restarted with latest build." -ForegroundColor Green
Write-Host "Backup saved to $backupPath"
Write-Host "Release: $($release.body)"
Read-Host "Press Enter to exit"
