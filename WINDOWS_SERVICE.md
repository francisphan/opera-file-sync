# Running as Windows Service

This guide shows how to run the OPERA sync (`opera-sync-db.exe`, the Oracle polling sync) as a Windows Service so it starts automatically with the server.

Throughout this guide the service is named `OPERASync` — use the same name in every command.

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
.\nssm.exe install OPERASync "D:\opera-sync\opera-sync-db.exe"
```

### Step 3: Configure Service

```powershell
$SERVICE_NAME = "OPERASync"

# Working directory (so it finds .env and writes logs here)
.\nssm.exe set $SERVICE_NAME AppDirectory "D:\opera-sync"

# Start automatically on boot
.\nssm.exe set $SERVICE_NAME Start SERVICE_AUTO_START

# Display name and description
.\nssm.exe set $SERVICE_NAME DisplayName "OPERA to Salesforce Sync"
.\nssm.exe set $SERVICE_NAME Description "Syncs OPERA guest records to Salesforce TVRS_Guest__c"

# Redirect console output to log files (optional)
.\nssm.exe set $SERVICE_NAME AppStdout "D:\opera-sync\logs\service-output.log"
.\nssm.exe set $SERVICE_NAME AppStderr "D:\opera-sync\logs\service-error.log"

# Auto-restart on failure
.\nssm.exe set $SERVICE_NAME AppExit Default Restart
```

### Step 4: Start Service

```powershell
.\nssm.exe start OPERASync
# Or: net start OPERASync
```

### Managing the Service

```powershell
.\nssm.exe status OPERASync
.\nssm.exe stop OPERASync
.\nssm.exe restart OPERASync
.\nssm.exe remove OPERASync confirm
```

---

## Option 2: Using Windows Task Scheduler

Alternative if you can't install NSSM.

1. Open Task Scheduler (`Win + R` -> `taskschd.msc`).
2. Click **Create Task** (not "Create Basic Task").
3. **General:** Name `OPERA Salesforce Sync`; check **Run whether user is logged on or not** and **Run with highest privileges**.
4. **Triggers:** New -> Begin **At startup**, delay **1 minute** (lets the network initialize).
5. **Actions:** New -> Start a program -> Program/script `D:\opera-sync\opera-sync-db.exe`, Start in `D:\opera-sync`.
6. **Conditions:** uncheck **Start only if on AC power**.
7. **Settings:** check **Run task as soon as possible after a scheduled start is missed**; restart every **1 minute**, up to **3 times**.
8. Click **OK**, enter admin credentials, then right-click the task -> **Run** and check the logs.

---

## Option 3: Using SC (Service Control)

Built-in Windows tool, but more manual.

```powershell
# Run as Administrator
sc create OPERASync `
  binPath= "D:\opera-sync\opera-sync-db.exe" `
  DisplayName= "OPERA to Salesforce Sync" `
  start= auto `
  obj= "NT AUTHORITY\LocalSystem"

sc description OPERASync "Syncs OPERA guest records to Salesforce"
sc failure OPERASync reset= 86400 actions= restart/60000/restart/60000/restart/60000
sc start OPERASync
```

Manage:

```powershell
sc query OPERASync
sc stop OPERASync
sc delete OPERASync
```

---

## Verifying the Service

```powershell
# Status
Get-Service OPERASync

# Application logs
Get-Content D:\opera-sync\logs\opera-sync.log -Tail 50

# Monitor in real time
Get-Content D:\opera-sync\logs\opera-sync.log -Wait -Tail 20
```

A healthy startup logs the Oracle connection, the sync watermark (`sync-state.json`), and the first poll. Confirm new/updated records appear in Salesforce.

---

## Troubleshooting

### Service Won't Start

Check Event Viewer (`eventvwr.msc` -> Windows Logs -> Application) for errors from `OPERASync`. Common causes:

1. **Missing `.env`** — ensure it exists in the working directory.
2. **Incorrect working directory** — must be `D:\opera-sync` (set via `nssm set OPERASync AppDirectory`).
3. **Permission issues** — run as administrator or grant permissions to LocalSystem.

### Service Crashes Immediately

```powershell
type D:\opera-sync\logs\opera-sync-errors.log
```

Common causes: invalid Salesforce credentials, unreachable Oracle host, network connectivity, or antivirus blocking the binary.

> If Salesforce credentials are temporarily broken but you want polling, front desk reports, and Sheets sync to keep running, set `ANDON_CORD=true` in `.env` and restart. This pauses Salesforce writes (holding the backlog for replay) without crashing the service.

### Service Runs but No Records Sync

Verify the `ORACLE_*` credentials, that the account can read the `OPERA.*` tables, and that outbound access to Salesforce is allowed. Check `logs\opera-sync.log`.

---

## Service Management Scripts

### start-service.ps1

```powershell
# Start the OPERA sync service
$serviceName = "OPERASync"

Write-Host "Starting $serviceName..."
Start-Service $serviceName

Start-Sleep -Seconds 2
$status = Get-Service $serviceName
Write-Host "Service status: $($status.Status)"

if ($status.Status -eq "Running") {
    Write-Host "[OK] Service started successfully"
    Write-Host "`nMonitoring logs..."
    Get-Content "D:\opera-sync\logs\opera-sync.log" -Wait -Tail 20
} else {
    Write-Host "[FAIL] Service failed to start"
    Write-Host "`nCheck Event Viewer for errors:"
    Write-Host "  eventvwr.msc -> Windows Logs -> Application"
}
```

### restart-service.ps1

```powershell
# Restart the OPERA sync service
$serviceName = "OPERASync"

Write-Host "Stopping $serviceName..."
Stop-Service $serviceName -Force
Start-Sleep -Seconds 2

Write-Host "Starting $serviceName..."
Start-Service $serviceName
Start-Sleep -Seconds 2

$status = Get-Service $serviceName
Write-Host "Service status: $($status.Status)"
```

### check-status.ps1

```powershell
# Check status of the OPERA sync service
$serviceName = "OPERASync"

$service = Get-Service $serviceName -ErrorAction SilentlyContinue

if ($service) {
    Write-Host "Service: $($service.DisplayName)"
    Write-Host "Status: $($service.Status)"
    Write-Host "Start Type: $($service.StartType)"

    Write-Host "`n--- Recent Log Entries ---"
    Get-Content "D:\opera-sync\logs\opera-sync.log" -Tail 10

    Write-Host "`n--- Sync State ---"
    Get-Content "D:\opera-sync\sync-state.json" -Raw
} else {
    Write-Host "Service not found: $serviceName"
}
```

---

## Uninstalling the Service

```powershell
# NSSM
nssm stop OPERASync
nssm remove OPERASync confirm

# SC
sc stop OPERASync
sc delete OPERASync

# Task Scheduler: open taskschd.msc, find "OPERA Salesforce Sync", right-click -> Delete
```

---

## Summary

```powershell
# 1. Copy files to server
copy opera-sync-db.exe D:\opera-sync\
copy .env D:\opera-sync\   # must include SF_*, ORACLE_*, and GMAIL_* credentials

# 2. Install service
nssm.exe install OPERASync "D:\opera-sync\opera-sync-db.exe"
nssm.exe set OPERASync AppDirectory "D:\opera-sync"
nssm.exe set OPERASync Start SERVICE_AUTO_START

# 3. Start service
nssm.exe start OPERASync

# 4. Verify
Get-Service OPERASync
Get-Content D:\opera-sync\logs\opera-sync.log -Tail 20
```

The service will now start automatically on boot, restart on failure, run in the background, and poll the OPERA database continuously.
