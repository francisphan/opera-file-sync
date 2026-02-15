# Running as Windows Service

This guide shows how to run the OPERA sync script as a Windows Service so it starts automatically with the server.

**Note:** This project now has two separate executables:
- `opera-sync-file.exe` — File-based sync (CSV watching)
- `opera-sync-db.exe` — Database-based sync (Oracle CQN)

Choose one based on your sync mode. The setup process is the same for both.

---

## Option 1: Using NSSM (Recommended)

NSSM (Non-Sucking Service Manager) is the easiest way to create Windows services.

### Step 1: Download NSSM

1. Download from: https://nssm.cc/download
2. Extract `nssm.exe` to a folder (e.g., `D:\opera-sync\`)

### Step 2: Install Service

```powershell
# Run as Administrator
cd D:\opera-sync

# For file-based sync (CSV watching):
.\nssm.exe install OPERAFileSyncService "D:\opera-sync\opera-sync-file.exe"

# Or for database-based sync (Oracle CQN):
.\nssm.exe install OPERADBSyncService "D:\opera-sync\opera-sync-db.exe"

# Or for Node.js version:
.\nssm.exe install OperaSalesforceSync "C:\Program Files\nodejs\node.exe" "D:\opera-sync\opera-file-sync.js"
```

### Step 3: Configure Service

```powershell
# Replace SERVICE_NAME with either OPERAFileSyncService or OPERADBSyncService
$SERVICE_NAME = "OPERAFileSyncService"  # or "OPERADBSyncService"

# Set working directory
.\nssm.exe set $SERVICE_NAME AppDirectory "D:\opera-sync"

# Set startup type to automatic
.\nssm.exe set $SERVICE_NAME Start SERVICE_AUTO_START

# Set display name
.\nssm.exe set $SERVICE_NAME DisplayName "OPERA to Salesforce Sync (File Mode)"
# Or for DB mode:
# .\nssm.exe set $SERVICE_NAME DisplayName "OPERA to Salesforce Sync (DB Mode)"

# Set description
.\nssm.exe set $SERVICE_NAME Description "Syncs OPERA guest records to Salesforce TVRS_Guest__c"

# Redirect logs (optional)
.\nssm.exe set $SERVICE_NAME AppStdout "D:\opera-sync\logs\service-output.log"
.\nssm.exe set $SERVICE_NAME AppStderr "D:\opera-sync\logs\service-error.log"

# Auto-restart on failure
.\nssm.exe set $SERVICE_NAME AppExit Default Restart
```

### Step 4: Start Service

```powershell
# Start the service
.\nssm.exe start OperaSalesforceSync

# Or use Windows services
net start OperaSalesforceSync
```

### Managing the Service

```powershell
# Check status
.\nssm.exe status OperaSalesforceSync

# Stop service
.\nssm.exe stop OperaSalesforceSync

# Restart service
.\nssm.exe restart OperaSalesforceSync

# Remove service
.\nssm.exe remove OperaSalesforceSync confirm
```

---

## Option 2: Using Windows Task Scheduler

Alternative if you can't install NSSM.

### Step 1: Open Task Scheduler

1. Press `Win + R`
2. Type `taskschd.msc`
3. Press Enter

### Step 2: Create Task

1. Click **Create Task** (not "Create Basic Task")
2. **General Tab:**
   - Name: `OPERA Salesforce Sync`
   - Description: `Syncs OPERA file exports to Salesforce`
   - Check: **Run whether user is logged on or not**
   - Check: **Run with highest privileges**
   - Configure for: **Windows Server 2019** (or your version)

3. **Triggers Tab:**
   - Click **New**
   - Begin the task: **At startup**
   - Delay task for: **1 minute** (gives network time to initialize)
   - Enabled: **Checked**

4. **Actions Tab:**
   - Click **New**
   - Action: **Start a program**
   - Program/script: `D:\opera-sync\opera-sync.exe`
   - Start in: `D:\opera-sync`

5. **Conditions Tab:**
   - Uncheck: **Start only if computer is on AC power**
   - Check: **Wake the computer to run this task**

6. **Settings Tab:**
   - Check: **Allow task to be run on demand**
   - Check: **Run task as soon as possible after a scheduled start is missed**
   - If the task fails, restart every: **1 minute**
   - Attempt to restart up to: **3 times**
   - Check: **If the running task does not end when requested, force it to stop**

### Step 3: Save and Test

1. Click **OK**
2. Enter Windows administrator credentials
3. Right-click the task → **Run**
4. Check logs to verify it's working

---

## Option 3: Using SC (Service Control)

Built-in Windows tool, but more complex.

### Create Service

```powershell
# Run as Administrator
sc create OperaSalesforceSync `
  binPath= "D:\opera-sync\opera-sync.exe" `
  DisplayName= "OPERA to Salesforce Sync" `
  start= auto `
  obj= "NT AUTHORITY\LocalSystem"

# Set description
sc description OperaSalesforceSync "Syncs OPERA file exports to Salesforce"

# Configure failure recovery
sc failure OperaSalesforceSync reset= 86400 actions= restart/60000/restart/60000/restart/60000

# Start service
sc start OperaSalesforceSync
```

### Manage Service

```powershell
# Check status
sc query OperaSalesforceSync

# Stop service
sc stop OperaSalesforceSync

# Delete service
sc delete OperaSalesforceSync
```

---

## Verifying the Service

### Check Service Status

```powershell
# Using services.msc
services.msc
# Look for "OPERA to Salesforce Sync"

# Using PowerShell
Get-Service OperaSalesforceSync

# Using sc
sc query OperaSalesforceSync
```

### Check Logs

```powershell
# View application logs
type D:\opera-sync\logs\opera-sync.log

# View last 50 lines
Get-Content D:\opera-sync\logs\opera-sync.log -Tail 50

# Monitor in real-time
Get-Content D:\opera-sync\logs\opera-sync.log -Wait -Tail 20
```

### Test Processing

1. Copy a test file to `D:\MICROS\opera\export\OPERA\vines\`
2. Watch the logs
3. Verify file is processed
4. Check Salesforce for new records

---

## Troubleshooting

### Service Won't Start

**Check Event Viewer:**
```powershell
# Open Event Viewer
eventvwr.msc

# Navigate to:
# Windows Logs → Application
# Look for errors from "OperaSalesforceSync"
```

**Common issues:**
1. **Missing .env file**
   - Ensure `.env` exists in working directory
   - Check file permissions

2. **Incorrect working directory**
   - Service must run from `D:\opera-sync`
   - Set with NSSM: `nssm set OperaSalesforceSync AppDirectory`

3. **Permission issues**
   - Run service as administrator account
   - Or grant necessary permissions to LocalSystem

4. **Missing Node.js** (if using Node.js version)
   - Install Node.js on server
   - Or use standalone executable instead

### Service Crashes Immediately

**Check logs:**
```powershell
type D:\opera-sync\logs\opera-sync-errors.log
```

**Common causes:**
1. Invalid Salesforce credentials
2. Export directory doesn't exist
3. Network connectivity issues
4. Antivirus blocking

### Service Runs but Doesn't Process Files

**Verify:**
1. Export directory path is correct in `.env`
2. Service has read permissions on export directory
3. Service has write permissions on processed/failed directories
4. Files are in correct format (CSV or XML)

**Check file watcher:**
```powershell
# Logs should show:
# "Starting file watcher on: D:\MICROS\opera\export\OPERA\vines"
# "File watcher ready"
```

---

## Service Management Scripts

### start-service.ps1

```powershell
# Start the OPERA sync service
$serviceName = "OperaSalesforceSync"

Write-Host "Starting $serviceName..."
Start-Service $serviceName

Start-Sleep -Seconds 2
$status = Get-Service $serviceName
Write-Host "Service status: $($status.Status)"

if ($status.Status -eq "Running") {
    Write-Host "✓ Service started successfully" -ForegroundColor Green
    Write-Host "`nMonitoring logs..."
    Get-Content "D:\opera-sync\logs\opera-sync.log" -Wait -Tail 20
} else {
    Write-Host "✗ Service failed to start" -ForegroundColor Red
    Write-Host "`nCheck Event Viewer for errors:"
    Write-Host "  eventvwr.msc → Windows Logs → Application"
}
```

### restart-service.ps1

```powershell
# Restart the OPERA sync service
$serviceName = "OperaSalesforceSync"

Write-Host "Stopping $serviceName..."
Stop-Service $serviceName -Force

Start-Sleep -Seconds 2

Write-Host "Starting $serviceName..."
Start-Service $serviceName

Start-Sleep -Seconds 2
$status = Get-Service $serviceName
Write-Host "Service status: $($status.Status)" -ForegroundColor $(if ($status.Status -eq "Running") { "Green" } else { "Red" })
```

### check-status.ps1

```powershell
# Check status of OPERA sync service
$serviceName = "OperaSalesforceSync"

$service = Get-Service $serviceName -ErrorAction SilentlyContinue

if ($service) {
    Write-Host "Service: $($service.DisplayName)"
    Write-Host "Status: $($service.Status)" -ForegroundColor $(if ($service.Status -eq "Running") { "Green" } else { "Red" })
    Write-Host "Start Type: $($service.StartType)"

    Write-Host "`n--- Recent Log Entries ---"
    Get-Content "D:\opera-sync\logs\opera-sync.log" -Tail 10

    Write-Host "`n--- Statistics ---"
    $processed = Get-Content "D:\opera-sync\processed-files.json" -Raw | ConvertFrom-Json
    Write-Host "Total files processed: $($processed.PSObject.Properties.Count)"
} else {
    Write-Host "Service not found: $serviceName" -ForegroundColor Red
}
```

---

## Uninstalling the Service

### If Using NSSM

```powershell
# Stop service
nssm stop OperaSalesforceSync

# Remove service
nssm remove OperaSalesforceSync confirm
```

### If Using Task Scheduler

1. Open Task Scheduler
2. Find "OPERA Salesforce Sync"
3. Right-click → Delete

### If Using SC

```powershell
# Stop service
sc stop OperaSalesforceSync

# Delete service
sc delete OperaSalesforceSync
```

---

## Best Practices

### Monitoring

1. **Enable CloudWatch/Monitoring** (if using AWS)
2. **Set up email alerts** for errors
3. **Monitor disk space** for log files
4. **Check service status daily**

### Maintenance

1. **Rotate log files** periodically
2. **Review failed files** in `Failed/` directory
3. **Update credentials** before expiration
4. **Test after OPERA updates**

### Backup

1. **Backup .env file** securely
2. **Backup processed-files.json** tracking file
3. **Keep copy of executable** for quick recovery

---

## Summary

**Recommended setup (NSSM) — File-based sync:**

```powershell
# 1. Copy files to server
copy opera-sync-file.exe D:\opera-sync\
copy .env D:\opera-sync\

# 2. Install service
nssm.exe install OPERAFileSyncService "D:\opera-sync\opera-sync-file.exe"
nssm.exe set OPERAFileSyncService AppDirectory "D:\opera-sync"
nssm.exe set OPERAFileSyncService Start SERVICE_AUTO_START

# 3. Start service
nssm.exe start OPERAFileSyncService

# 4. Verify
Get-Service OPERAFileSyncService
Get-Content D:\opera-sync\logs\opera-sync.log -Tail 20
```

**Recommended setup (NSSM) — Database-based sync:**

```powershell
# 1. Copy files to server
copy opera-sync-db.exe D:\opera-sync\
copy .env D:\opera-sync\  # (must include Oracle credentials)

# 2. Install service
nssm.exe install OPERADBSyncService "D:\opera-sync\opera-sync-db.exe"
nssm.exe set OPERADBSyncService AppDirectory "D:\opera-sync"
nssm.exe set OPERADBSyncService Start SERVICE_AUTO_START

# 3. Start service
nssm.exe start OPERADBSyncService

# 4. Verify
Get-Service OPERADBSyncService
Get-Content D:\opera-sync\logs\opera-db-sync.log -Tail 20
```

The service will now:
- ✅ Start automatically on server boot
- ✅ Restart automatically on failure
- ✅ Run in the background
- ✅ Process guests continuously (file watching or real-time CQN)
