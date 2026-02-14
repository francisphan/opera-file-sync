# How to Deploy to OPERA Server

Step-by-step guide to copy files to the OPERA server and get the sync script running.

---

## What Files to Copy

### Standalone Executable Deployment (Recommended)

**Minimum files needed:**
```
D:\opera-sync\
├── opera-sync.exe          # The executable (build with: npm run build:exe)
└── .env                    # Configuration file (create on server)
```

**That's it!** Just 2 files.

### Optional Files

```
D:\opera-sync\
├── opera-sync.exe
├── .env
├── test-server-requirements.ps1   # Server testing script (optional)
└── samples\                        # Test files (optional)
    ├── sample-export.csv
    └── sample-export.xml
```

---

## Step-by-Step Deployment

### Step 1: Build the Executable

**On your development machine:**

```bash
cd /home/phancis/workspace/opera-file-sync

# Install dependencies (if not already done)
npm install

# Build the standalone executable
npm run build:exe
```

This creates: `dist/opera-sync.exe` (~80 MB)

---

## Step 2: Copy Files to Server

Choose the method that works for your setup:

---

## Method 1: Network Share / UNC Path (Easiest)

If you have network access to the OPERA server:

### From Windows (Command Prompt or PowerShell)

```powershell
# Copy executable
copy dist\opera-sync.exe \\OPERA-SERVER\C$\OPERA\Sync\

# Or if C$ is not accessible, use a shared folder
copy dist\opera-sync.exe \\OPERA-SERVER\SharedFolder\OPERA\Sync\
```

### From Linux/WSL

```bash
# Mount the share (if not already mounted)
sudo mount -t cifs //OPERA-SERVER/C$ /mnt/opera -o username=Administrator

# Copy files
cp dist/opera-sync.exe /mnt/opera/OPERA/Sync/
```

### Find UNC Path

**On OPERA server:**
```powershell
# Share the C: drive (if not already shared)
net share C$=C:\ /grant:Everyone,FULL

# Or check existing shares
net share
```

**On your machine:**
```powershell
# Test access
dir \\OPERA-SERVER\C$\

# If access denied, you may need to:
# 1. Log in with admin credentials
# 2. Enable file sharing on OPERA server
# 3. Use a different share path
```

---

## Method 2: Remote Desktop (RDP) Copy/Paste

### Enable Clipboard in RDP

**When connecting via Remote Desktop:**

1. Open **Remote Desktop Connection** (mstsc.exe)
2. Click **Show Options**
3. Go to **Local Resources** tab
4. Under "Local devices and resources" → Click **More**
5. Check **Drives** (or select specific drive)
6. Click **OK** and **Connect**

### Copy Files via RDP

**Option A: Clipboard Copy/Paste**
1. On your local machine: Copy `opera-sync.exe`
2. RDP to OPERA server
3. Navigate to `D:\opera-sync\`
4. Right-click → Paste

**Option B: Shared Drive**
1. RDP to OPERA server
2. Open File Explorer
3. Go to **This PC**
4. You'll see your local drives listed (e.g., "C on LOCAL-PC")
5. Navigate to your local `dist` folder
6. Copy `opera-sync.exe` to `D:\opera-sync\`

---

## Method 3: PowerShell Remoting

### Enable PowerShell Remoting on OPERA Server

**On OPERA server (one-time setup):**
```powershell
# Run as Administrator
Enable-PSRemoting -Force
```

### Copy Files

**From your machine:**

```powershell
# Set credentials
$cred = Get-Credential

# Create session
$session = New-PSSession -ComputerName OPERA-SERVER -Credential $cred

# Copy executable
Copy-Item -Path "dist\opera-sync.exe" -Destination "D:\opera-sync\" -ToSession $session

# Copy test script (optional)
Copy-Item -Path "test-server-requirements.ps1" -Destination "D:\opera-sync\" -ToSession $session

# Close session
Remove-PSSession $session
```

### Alternative: Single Command

```powershell
# Copy in one command
$session = New-PSSession -ComputerName OPERA-SERVER -Credential (Get-Credential)
Copy-Item -Path "dist\opera-sync.exe" -Destination "D:\opera-sync\" -ToSession $session
Remove-PSSession $session
```

---

## Method 4: SCP/SFTP (If Available)

If SFTP/SCP server is running on OPERA server:

### Using WinSCP (Windows GUI)

1. Download WinSCP: https://winscp.net
2. Open WinSCP
3. Connect to OPERA server (SFTP protocol)
4. Navigate to `D:\opera-sync\`
5. Drag and drop `opera-sync.exe`

### Using SCP Command (Linux/macOS/WSL)

```bash
# Copy executable
scp dist/opera-sync.exe Administrator@OPERA-SERVER:/C:/OPERA/Sync/

# Copy test script
scp test-server-requirements.ps1 Administrator@OPERA-SERVER:/C:/OPERA/Sync/
```

### Using PSCP (Windows Command Line)

```cmd
# Download PSCP from PuTTY website
# https://www.chiark.greenend.org.uk/~sgtatham/putty/latest.html

# Copy file
pscp dist\opera-sync.exe Administrator@OPERA-SERVER:/C:/OPERA/Sync/
```

---

## Method 5: FTP (If Available)

If FTP server is running on OPERA server:

### Using FileZilla

1. Download FileZilla: https://filezilla-project.org
2. Connect to OPERA server via FTP
3. Navigate to `/C:/OPERA/Sync/`
4. Upload `opera-sync.exe`

### Using Windows FTP Command

```cmd
ftp
open OPERA-SERVER
[enter username]
[enter password]
cd OPERA/Sync
binary
put dist\opera-sync.exe
bye
```

---

## Method 6: USB Drive (Physical Transfer)

If no network access:

### Copy to USB

**On your development machine:**

```bash
# Mount USB drive
# Windows: Shows as E:, F:, etc.
# Linux: /media/username/USB_NAME

# Copy executable
copy dist\opera-sync.exe E:\

# Or on Linux
cp dist/opera-sync.exe /media/username/USB_NAME/
```

### Copy from USB on Server

1. Insert USB drive into OPERA server
2. Open File Explorer
3. Navigate to USB drive
4. Copy `opera-sync.exe` to `D:\opera-sync\`

---

## Method 7: Email/Cloud Transfer (Small Files Only)

For the test script (2 KB) - not recommended for the .exe (80 MB):

### Via Email

1. Email `test-server-requirements.ps1` to yourself
2. Log in to email on OPERA server
3. Download attachment to `D:\opera-sync\`

### Via Cloud (OneDrive, Dropbox, Google Drive)

1. Upload `opera-sync.exe` to cloud storage
2. On OPERA server, download from cloud
3. Move to `D:\opera-sync\`

---

## Step 3: Create .env File on Server

**On the OPERA server:**

```powershell
# Navigate to directory
cd D:\opera-sync

# Create .env file
notepad .env
```

**Paste this content and update with your values:**

```bash
# Salesforce OAuth Credentials
SF_INSTANCE_URL=https://your-instance.my.salesforce.com
SF_CLIENT_ID=your-client-id-here
SF_CLIENT_SECRET=your-client-secret-here
SF_REFRESH_TOKEN=your-refresh-token-here

# Salesforce Object Configuration
SF_OBJECT=TVRS_Guest__c
SF_EXTERNAL_ID_FIELD=Email__c

# OPERA Export Configuration
EXPORT_DIR=D:\MICROS\opera\export\OPERA\vines
PROCESSED_DIR=D:\MICROS\opera\export\OPERA\vines\processed
FAILED_DIR=D:\MICROS\opera\export\OPERA\vines\failed

# File Processing
FILE_FORMAT=auto
SYNC_MODE=upsert
BATCH_SIZE=200

# Logging
LOG_LEVEL=warn

# Email Notifications (Gmail OAuth2 - optional)
EMAIL_ENABLED=false
# SMTP_USER=your-email@gmail.com
# GMAIL_CLIENT_ID=your-google-client-id
# GMAIL_CLIENT_SECRET=your-google-client-secret
# GMAIL_REFRESH_TOKEN=your-gmail-refresh-token
# EMAIL_FROM=OPERA Sync <your-email@gmail.com>
# EMAIL_TO=admin@yourcompany.com
```

**Save and close** (Ctrl+S, Alt+F4)

---

## Step 4: Create Directories

**On OPERA server:**

```powershell
# Create required directories
New-Item -ItemType Directory -Path "D:\opera-sync" -Force
New-Item -ItemType Directory -Path "D:\opera-sync\logs" -Force
New-Item -ItemType Directory -Path "D:\MICROS\opera\export\OPERA\vines\processed" -Force
New-Item -ItemType Directory -Path "D:\MICROS\opera\export\OPERA\vines\failed" -Force
```

---

## Step 5: Test the Deployment

### Test Server Requirements

```powershell
cd D:\opera-sync

# Run server test (if you copied the test script)
.\test-server-requirements.ps1
```

### Test the Executable

```powershell
cd D:\opera-sync

# Test run (will watch for files)
.\opera-sync.exe
```

**Expected output:**
```
======================================================================
OPERA File Export to Salesforce Sync - Starting
======================================================================
Testing Salesforce connection...
Connected to Salesforce as user@example.com
Configuration:
  Export Directory: D:\MICROS\opera\export\OPERA\vines
  Processed Directory: D:\MICROS\opera\export\OPERA\vines\processed
  ...
======================================================================
Initialization complete. Watching for files...
======================================================================
```

Press **Ctrl+C** to stop.

---

## Deployment Script (Automated)

Create this PowerShell script on your development machine to automate deployment:

### deploy-to-server.ps1

```powershell
param(
    [Parameter(Mandatory=$true)]
    [string]$ServerName,

    [string]$DestPath = "D:\opera-sync"
)

Write-Host "Deploying to $ServerName..." -ForegroundColor Cyan

# Build executable
Write-Host "Building executable..." -ForegroundColor Yellow
npm run build:exe

if (-not (Test-Path "dist\opera-sync.exe")) {
    Write-Host "Error: Build failed - opera-sync.exe not found" -ForegroundColor Red
    exit 1
}

# Get credentials
$cred = Get-Credential -Message "Enter credentials for $ServerName"

# Create remote session
Write-Host "Connecting to $ServerName..." -ForegroundColor Yellow
try {
    $session = New-PSSession -ComputerName $ServerName -Credential $cred -ErrorAction Stop
} catch {
    Write-Host "Error connecting to server: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Create directories on remote server
Write-Host "Creating directories..." -ForegroundColor Yellow
Invoke-Command -Session $session -ScriptBlock {
    param($path)
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    New-Item -ItemType Directory -Path "$path\logs" -Force | Out-Null
} -ArgumentList $DestPath

# Copy executable
Write-Host "Copying opera-sync.exe..." -ForegroundColor Yellow
Copy-Item -Path "dist\opera-sync.exe" -Destination $DestPath -ToSession $session -Force

# Copy test script
if (Test-Path "test-server-requirements.ps1") {
    Write-Host "Copying test script..." -ForegroundColor Yellow
    Copy-Item -Path "test-server-requirements.ps1" -Destination $DestPath -ToSession $session -Force
}

# Check if .env exists on server
$envExists = Invoke-Command -Session $session -ScriptBlock {
    param($path)
    Test-Path "$path\.env"
} -ArgumentList $DestPath

if (-not $envExists) {
    Write-Host "Warning: .env file not found on server" -ForegroundColor Yellow
    Write-Host "You'll need to create it manually" -ForegroundColor Yellow
}

# Close session
Remove-PSSession $session

Write-Host "`n✓ Deployment complete!" -ForegroundColor Green
Write-Host "`nNext steps:" -ForegroundColor Cyan
Write-Host "  1. RDP to $ServerName"
Write-Host "  2. Create/update .env file at $DestPath\.env"
Write-Host "  3. Test: cd $DestPath; .\opera-sync.exe"
```

### Use the Script

```powershell
# Deploy to server
.\deploy-to-server.ps1 -ServerName OPERA-SERVER

# Custom destination
.\deploy-to-server.ps1 -ServerName OPERA-SERVER -DestPath "D:\OPERA\Sync"
```

---

## Troubleshooting

### "Access is denied" when copying to C$

**Fix:**
1. Make sure you're using admin credentials
2. Enable admin shares on OPERA server:
   ```powershell
   # On OPERA server (as admin)
   reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v LocalAccountTokenFilterPolicy /t REG_DWORD /d 1 /f
   ```
3. Or use a regular shared folder instead of C$

### "Network path not found"

**Fix:**
1. Ping the server: `ping OPERA-SERVER`
2. Check firewall allows file sharing
3. Try IP address instead: `\\192.168.1.100\C$\`
4. Enable File and Printer Sharing in Windows Firewall

### "PowerShell remoting access denied"

**Fix:**
1. On OPERA server, enable remoting:
   ```powershell
   Enable-PSRemoting -Force
   Set-Item WSMan:\localhost\Client\TrustedHosts * -Force
   ```
2. On your machine, add server to trusted hosts:
   ```powershell
   Set-Item WSMan:\localhost\Client\TrustedHosts OPERA-SERVER -Force
   ```

### Can't paste files via RDP

**Fix:**
1. Disconnect from RDP
2. In Remote Desktop Connection, go to Local Resources → More
3. Check "Drives" or "Clipboard"
4. Reconnect and try again

---

## Verification Checklist

After copying files, verify:

- [ ] `opera-sync.exe` is in `D:\opera-sync\`
- [ ] `.env` file exists and has correct credentials
- [ ] Directories exist: `Reservations`, `Processed`, `Failed`
- [ ] Can run `.\opera-sync.exe` without errors
- [ ] Logs directory is created

**Verify file integrity:**
```powershell
# Check file size (should be ~80 MB)
Get-Item D:\opera-sync\opera-sync.exe | Select Name, Length

# Check if executable
.\opera-sync.exe --version
```

---

## Security Note

**After copying .env file:**

```powershell
# Restrict permissions to protect credentials
icacls D:\opera-sync\.env /inheritance:r /grant:r "%USERNAME%:F"
```

---

## Summary

**Simplest method:**
1. Build: `npm run build:exe`
2. RDP to OPERA server
3. Copy `dist\opera-sync.exe` via RDP clipboard
4. Create `.env` file with notepad
5. Test: `.\opera-sync.exe`

**Most automated method:**
1. Use the `deploy-to-server.ps1` script
2. Create `.env` file on server
3. Done!

**Choose the method that works best for your environment!**
