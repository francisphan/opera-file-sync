# How to Test Server Requirements

This guide shows you how to verify the OPERA server meets all requirements.

---

## Option 1: Automated PowerShell Script (Recommended)

### Quick Test (Basic)

Copy `test-server-requirements.ps1` to the OPERA server and run:

```powershell
# Run basic tests
.\test-server-requirements.ps1
```

This tests:
- ✅ Windows version
- ✅ Disk space
- ✅ Memory (RAM)
- ✅ CPU
- ✅ Network connectivity to Salesforce
- ✅ File system access
- ✅ PowerShell version

### Full Test (Including Email)

```powershell
# Test everything including SMTP (for email notifications)
.\test-server-requirements.ps1 -TestSMTP -SMTPHost smtp.gmail.com -SMTPPort 587
```

### Custom Directories

```powershell
# Test with your actual OPERA export directories
.\test-server-requirements.ps1 `
  -ExportDir "D:\OPERA\Exports\Reservations" `
  -ProcessedDir "D:\OPERA\Exports\Processed" `
  -FailedDir "D:\OPERA\Exports\Failed"
```

### Test Different Salesforce Instance

```powershell
# If using a specific Salesforce instance
.\test-server-requirements.ps1 -SalesforceInstance "na1.salesforce.com"
```

### What It Tests

The script will show output like this:

```
======================================================================
Test 1: Windows Version
======================================================================
  OS: Microsoft Windows Server 2019 Standard
  Version: 10.0.17763
  Architecture: 64-bit

✓ Windows Version
  Supported: Microsoft Windows Server 2019 Standard (10.0.17763) 64-bit

======================================================================
Test 2: Disk Space
======================================================================
  Total: 238.37 GB
  Used: 45.23 GB
  Free: 193.14 GB (197771 MB)

✓ Disk Space
  Sufficient space: 193.14 GB free
  Requires: 150 MB

[... more tests ...]

======================================================================
Test Summary
======================================================================

Total Tests: 9
Passed: 9
Failed: 0

✓ ALL TESTS PASSED - Server is ready for deployment!
```

### Results File

The script creates `server-requirements-test-results.txt` with detailed results you can send to your team.

---

## Option 2: Manual Testing (If PowerShell Script Doesn't Work)

### Test 1: Check Windows Version

```powershell
# Get Windows version
Get-WmiObject Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture
```

**Expected:**
- Caption: Windows Server 2012 R2 or later
- OSArchitecture: 64-bit

**Pass if:** Windows Server 2012 R2+ and 64-bit

---

### Test 2: Check Disk Space

```powershell
# Check C: drive space
Get-PSDrive C | Select-Object Used, Free

# Or use GUI
# Open File Explorer → This PC → Check C: drive
```

**Expected:** At least 150 MB free

**Pass if:** More than 150 MB available

---

### Test 3: Check Memory (RAM)

```powershell
# Check total memory
$os = Get-WmiObject Win32_OperatingSystem
$totalMemoryMB = [math]::Round($os.TotalVisibleMemorySize / 1KB, 0)
Write-Host "Total Memory: $totalMemoryMB MB"
```

**Expected:** At least 256 MB (512 MB recommended)

**Pass if:** 256 MB or more

---

### Test 4: Test Salesforce Connectivity

```powershell
# Test HTTPS connection to Salesforce
Test-NetConnection login.salesforce.com -Port 443
```

**Expected output:**
```
ComputerName     : login.salesforce.com
RemoteAddress    : [IP Address]
TcpTestSucceeded : True
```

**Pass if:** `TcpTestSucceeded : True`

**If fails:** Check firewall rules, or test with:
```powershell
# Alternative test
(New-Object System.Net.WebClient).DownloadString("https://login.salesforce.com")
```

---

### Test 5: Test File System Access

#### Test Export Directory

```powershell
# Check if directory exists and you can access it
$exportDir = "C:\OPERA\Exports\Reservations"

# Test read
Test-Path $exportDir
Get-ChildItem $exportDir

# Test write
"test" | Out-File "$exportDir\test-file.tmp"
Remove-Item "$exportDir\test-file.tmp"
```

**Pass if:** No errors

**If directory doesn't exist:**
```powershell
# Create it
New-Item -ItemType Directory -Path $exportDir -Force
```

#### Test Processed/Failed Directories

```powershell
# Create and test directories
$dirs = @(
    "C:\OPERA\Exports\Processed",
    "C:\OPERA\Exports\Failed"
)

foreach ($dir in $dirs) {
    New-Item -ItemType Directory -Path $dir -Force
    "test" | Out-File "$dir\test-file.tmp"
    Remove-Item "$dir\test-file.tmp"
    Write-Host "✓ $dir - OK" -ForegroundColor Green
}
```

**Pass if:** All directories created and writable

---

### Test 6: Test SMTP (Optional - For Email Notifications)

```powershell
# Test SMTP server connectivity
Test-NetConnection smtp.gmail.com -Port 587
```

**Expected:** `TcpTestSucceeded : True`

**Pass if:** Connection succeeds (optional - only needed for email alerts)

---

### Test 7: Check Antivirus Status

```powershell
# Check Windows Defender status
Get-MpComputerStatus | Select-Object AntivirusEnabled, RealTimeProtectionEnabled

# Or use GUI
# Windows Security → Virus & threat protection
```

**Note:** Antivirus may block the .exe initially - you'll need to whitelist it

---

### Test 8: Check Network Proxy Settings

```powershell
# Check if proxy is configured
netsh winhttp show proxy
```

**If using proxy:** You may need to configure proxy settings in the .env file

---

## Option 3: Quick One-Line Tests

### All-in-One Quick Test

```powershell
# Quick system check
Write-Host "OS: $($(Get-WmiObject Win32_OperatingSystem).Caption)"; `
Write-Host "Free Space: $([math]::Round((Get-PSDrive C).Free/1GB, 2)) GB"; `
Write-Host "Total RAM: $([math]::Round((Get-WmiObject Win32_OperatingSystem).TotalVisibleMemorySize/1MB, 2)) GB"; `
Write-Host "Salesforce: $(if((Test-NetConnection login.salesforce.com -Port 443 -InformationLevel Quiet)){ 'OK' } else { 'FAILED' })"
```

---

## Interpreting Results

### ✅ All Tests Pass
**Your server is ready!**

Next steps:
1. Build executable: `npm run build:exe`
2. Copy to server
3. Create `.env` file
4. Deploy!

### ⚠️ Some Tests Fail

**Common issues and fixes:**

#### "Cannot connect to Salesforce"
**Fix:**
- Check firewall rules
- Whitelist `*.salesforce.com`
- Test from browser: Open https://login.salesforce.com
- Contact network admin if behind corporate firewall

#### "Insufficient disk space"
**Fix:**
- Free up disk space
- Use different drive (update paths in .env)

#### "Cannot access export directory"
**Fix:**
- Check directory path
- Verify permissions
- Create directory manually
- Run as administrator

#### "SMTP connection failed" (optional)
**Fix:**
- Check SMTP server address
- Verify port (587 for TLS, 465 for SSL)
- Test from firewall rules
- Or disable email notifications (use Slack instead)

---

## Troubleshooting Test Script

### "Execution policy doesn't allow scripts"

```powershell
# Allow script execution
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

# Or run with bypass
PowerShell.exe -ExecutionPolicy Bypass -File .\test-server-requirements.ps1
```

### "Test-NetConnection not found"

You're on older PowerShell. Use alternative:

```powershell
# Alternative connectivity test
$client = New-Object System.Net.Sockets.TcpClient
try {
    $client.Connect("login.salesforce.com", 443)
    Write-Host "✓ Connected to Salesforce" -ForegroundColor Green
    $client.Close()
} catch {
    Write-Host "✗ Cannot connect to Salesforce" -ForegroundColor Red
}
```

### "Access denied" errors

Run PowerShell as Administrator:
1. Right-click PowerShell
2. "Run as Administrator"
3. Re-run tests

---

## Testing Checklist

Use this to manually verify requirements:

- [ ] Windows Server 2012 R2 or later
- [ ] 64-bit operating system
- [ ] At least 150 MB free disk space
- [ ] At least 256 MB RAM (512 MB recommended)
- [ ] Can connect to login.salesforce.com:443
- [ ] Can read OPERA export directory
- [ ] Can write to processed/failed directories
- [ ] SMTP accessible (optional - for email alerts)
- [ ] No antivirus blocking (whitelist ready)

---

## After Testing

### If All Tests Pass:

**You're ready to deploy!** See:
- `BUILD.md` - How to build the executable
- `SETUP_CHECKLIST.md` - Deployment steps

### If Tests Fail:

**Review and fix issues:**
1. Note which tests failed
2. Check "Common issues and fixes" above
3. Contact network/system admin if needed
4. Re-run tests after fixes

### Save Test Results

The automated script saves results to `server-requirements-test-results.txt`

Share this with your team:
```powershell
# Email results
Get-Content server-requirements-test-results.txt | Out-String
```

---

## Need Help?

**Test failed and not sure why?**
1. Run the automated script to get detailed output
2. Check the specific test section in this guide
3. Review the "Common issues and fixes"
4. Check server logs or Windows Event Viewer

**Still stuck?**
- Include test results output when asking for help
- Note your Windows version and network setup
- Specify if behind corporate firewall/proxy
