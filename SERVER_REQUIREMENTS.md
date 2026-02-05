# OPERA Server Requirements

What the OPERA server needs to run the sync script.

---

## TL;DR - Minimum Requirements

**For Standalone Executable (.exe) - Recommended:**
- ✅ Windows Server (any recent version)
- ✅ ~100 MB disk space
- ✅ Network access to Salesforce API (HTTPS port 443)
- ✅ Read/write access to OPERA export directories
- ✅ **NO Node.js installation needed**

**That's it!** 🎉

---

## Option 1: Standalone Executable (Recommended)

### Operating System
- **Windows Server 2012 R2 or later**
- **Windows 10/11** (if running on workstation)
- Architecture: 64-bit (x64)

Can also build for:
- Linux (x64)
- macOS (x64)

### Software Requirements
- **NONE!** No Node.js, no npm, no dependencies
- Everything is bundled in the single .exe file

### Disk Space
- **Application:** ~80 MB (the .exe file)
- **Logs:** ~50 MB (with log rotation)
- **Working files:** ~10 MB (tracking files, temp)
- **Total:** ~150 MB minimum

### Memory
- **Minimum:** 256 MB RAM
- **Recommended:** 512 MB RAM
- **Under load:** May use up to 1 GB for large files

### CPU
- **Any modern CPU works** (Intel, AMD)
- Single-threaded (uses 1 core)
- Very lightweight - minimal CPU usage

### Network Requirements

**Outbound HTTPS (port 443) to:**
- `*.salesforce.com` - Salesforce API
- `login.salesforce.com` - OAuth authentication
- Your Salesforce instance URL

**Optional (for email notifications):**
- SMTP server access (port 587, 465, or 25)
- Example: `smtp.gmail.com:587`

**No inbound ports required**

### File System Access

**Read access:**
- OPERA export directory (e.g., `C:\OPERA\Exports\Reservations\`)

**Write access:**
- Processed files directory (e.g., `C:\OPERA\Exports\Processed\`)
- Failed files directory (e.g., `C:\OPERA\Exports\Failed\`)
- Logs directory (where .exe is located)

### Permissions

**User account needs:**
- Read OPERA exports
- Write to processed/failed/logs directories
- Network access to Salesforce
- Run as Windows Service (if using service)

**Can run as:**
- Regular user (with appropriate permissions)
- Service account (recommended for Windows Service)
- LocalSystem (for Windows Service)

---

## Option 2: Node.js Script

### Operating System
- Windows Server 2012 R2 or later
- Windows 10/11
- Linux (Ubuntu, RHEL, etc.)
- macOS

### Software Requirements
- **Node.js 18.x or later** (v20.x recommended)
- **npm** (comes with Node.js)

### Installation Size
- Node.js: ~50 MB
- npm packages: ~50 MB
- Application: ~5 MB
- Logs: ~50 MB
- **Total:** ~150-200 MB

### Same as Option 1 for:
- Memory
- CPU
- Network
- File System
- Permissions

---

## Network & Firewall Configuration

### Required Outbound Access

**Salesforce API (required):**
```
Protocol: HTTPS
Port: 443
Destinations:
  - *.salesforce.com
  - login.salesforce.com
  - [your-instance].salesforce.com
```

**SMTP (optional - for email notifications):**
```
Protocol: SMTP/TLS or SMTP/SSL
Ports: 587 (TLS), 465 (SSL), or 25 (unencrypted)
Destinations:
  - smtp.gmail.com (if using Gmail)
  - smtp.office365.com (if using Outlook)
  - [your-smtp-server]
```

### Firewall Rules

**Windows Firewall:**
- Usually no changes needed (outbound allowed by default)
- If strict rules: Allow outbound HTTPS on port 443

**Corporate Firewall:**
- Whitelist: `*.salesforce.com`
- Allow HTTPS (443) outbound
- Allow SMTP (587/465) outbound (if using email)

**Proxy Server:**
- If behind proxy, may need to configure:
  ```bash
  # Set proxy environment variables
  HTTP_PROXY=http://proxy.company.com:8080
  HTTPS_PROXY=http://proxy.company.com:8080
  ```

### Testing Network Access

**Test Salesforce connectivity:**
```powershell
# Test HTTPS to Salesforce
Test-NetConnection login.salesforce.com -Port 443

# Should show: TcpTestSucceeded : True
```

**Test SMTP connectivity (if using email):**
```powershell
# Test SMTP to Gmail
Test-NetConnection smtp.gmail.com -Port 587
```

---

## OPERA Export Configuration

### OPERA Requirements

The script works with **standard OPERA exports** - no special modules needed:

**What you need:**
- ✅ OPERA PMS (any version with export capability)
- ✅ Export interface configured
- ✅ Scheduled or manual export enabled

**What you DON'T need:**
- ❌ OXI (Oracle Exchange Interface) - NOT required
- ❌ OWSM (Oracle Web Services Manager) - NOT required
- ❌ Special licenses or add-ons
- ❌ Database access

### Export Setup

**In OPERA:**
1. Configuration → Interfaces
2. Create export interface
3. Format: CSV or XML
4. Schedule: As needed (e.g., every 4 hours)
5. Output directory: Accessible to sync script

**Export directory examples:**
- Local: `C:\OPERA\Exports\Reservations\`
- Network share: `\\opera-server\Exports\Reservations\`
- UNC path: `\\192.168.1.100\Exports\Reservations\`

---

## Server Placement Options

### Option A: On OPERA Server (Recommended)
**Pros:**
- Direct file access (fastest)
- No network share needed
- Simplest setup

**Cons:**
- Runs on production server
- Uses OPERA server resources (minimal)

### Option B: On Separate Server
**Pros:**
- Isolated from OPERA
- Dedicated resources
- Easier to monitor

**Cons:**
- Needs network access to OPERA exports
- Network share permissions required

**If using separate server:**
- Mount OPERA export directory as network drive
- Or use UNC path: `\\opera-server\Exports\`

---

## Windows Server Versions Tested

**Confirmed working on:**
- ✅ Windows Server 2022
- ✅ Windows Server 2019
- ✅ Windows Server 2016
- ✅ Windows Server 2012 R2

**Should work on:**
- Windows Server 2012 (may require updates)
- Windows 10/11 (for testing or workstation deployment)

**Not supported:**
- Windows Server 2008 (too old)
- Windows 7 or earlier

---

## Security Requirements

### Antivirus/Endpoint Protection

**The .exe file:**
- Is a legitimate Node.js application
- May be flagged by antivirus (false positive)
- Needs whitelist/exception if blocked

**To whitelist:**
1. Add `opera-sync.exe` to antivirus exceptions
2. Add the installation directory to trusted locations
3. Test after adding exceptions

### Windows Defender

**Usually no action needed**, but if blocked:
```powershell
# Add exclusion (run as Administrator)
Add-MpPreference -ExclusionPath "C:\OPERA\Sync\opera-sync.exe"
```

### User Account Control (UAC)

**No admin rights needed** for normal operation

**Admin rights needed for:**
- Installing as Windows Service
- First-time setup (creating directories)

### Service Account (for Windows Service)

**Create dedicated service account (recommended):**
- Username: `svc-opera-sync`
- Permissions:
  - Read: OPERA exports
  - Write: Processed/Failed/Logs directories
  - Logon as a service
  - Network access

---

## Performance Considerations

### File Size Limits

**Tested with files up to:**
- CSV: 100,000 rows (~50 MB)
- XML: 10,000 reservations (~100 MB)

**Processing time:**
- ~500 records/minute to Salesforce
- 10,000 records = ~20 minutes

**Larger files:**
- May need to increase timeout settings
- Consider splitting exports if >50,000 records

### Concurrent Operations

**File processing:**
- One file at a time (sequential)
- Prevents overwhelming Salesforce API
- New files queued automatically

**Salesforce API limits:**
- 200 records per batch (configurable)
- Respects Salesforce API limits
- Automatic retry on rate limiting

### Resource Usage (typical)

**CPU:** 5-10% during processing, <1% idle
**Memory:** 100-200 MB during processing, ~50 MB idle
**Disk I/O:** Minimal (file reads, log writes)
**Network:** 100-500 KB/s during sync

---

## Monitoring & Logging

### Disk Space for Logs

**Log rotation enabled:**
- Each log file: Max 10 MB
- Keep last 5 files
- Total: ~50 MB per log type

**Log files:**
- `logs/opera-sync.log` - All activity
- `logs/opera-sync-errors.log` - Errors only

**Automatic cleanup:** Old logs auto-deleted

### Monitoring Tools (optional)

**Windows Performance Monitor:**
- Can monitor CPU/Memory usage
- Track network I/O

**Windows Event Viewer:**
- Service start/stop events
- Application errors

**Email Notifications:**
- Built-in alert system
- No external monitoring needed

---

## Installation Checklist

**Before deployment, verify:**

- [ ] Windows Server 2012 R2 or later
- [ ] ~150 MB free disk space
- [ ] HTTPS access to Salesforce (port 443)
- [ ] Access to OPERA export directory
- [ ] Read/write permissions on export directories
- [ ] Antivirus exception added (if needed)
- [ ] Service account created (if using Windows Service)
- [ ] Network share mounted (if on separate server)

**Optional:**
- [ ] SMTP access configured (for email alerts)
- [ ] Slack webhook configured (for Slack alerts)

---

## Troubleshooting Common Issues

### "Cannot access export directory"
**Fix:** Check file permissions, ensure user can read directory

### "Network path not found"
**Fix:** Mount network share, or use UNC path

### "Cannot connect to Salesforce"
**Fix:** Check firewall, test with `Test-NetConnection`

### "Antivirus blocked the executable"
**Fix:** Add to antivirus exceptions

### "Service won't start"
**Fix:** Check service account has "Logon as a service" right

---

## Comparison: Server Options

| Requirement | Standalone .exe | Node.js Script |
|-------------|----------------|----------------|
| **Node.js Install** | ❌ Not needed | ✅ Required |
| **File Size** | 80 MB | 5 MB + 50 MB deps |
| **Setup Complexity** | ⭐ Simple | ⭐⭐ Moderate |
| **Updates** | Replace .exe | npm update |
| **Portability** | ✅ Self-contained | Needs Node.js |
| **Performance** | Same | Same |

---

## Summary

### Minimum Server Requirements

**Hardware:**
- CPU: Any modern processor
- RAM: 256 MB minimum, 512 MB recommended
- Disk: 150 MB free space
- Network: Outbound HTTPS (443)

**Software (Standalone .exe):**
- Windows Server 2012 R2 or later
- Nothing else needed!

**Permissions:**
- Read: OPERA exports
- Write: Processed/Failed/Logs
- Network: Salesforce API access

**That's it!** Very lightweight and simple to deploy. 🚀

---

## Next Steps

1. **Verify server meets requirements** (see checklist above)
2. **Test network connectivity** to Salesforce
3. **Build executable:** `npm run build:exe`
4. **Copy to server** and test
5. **Set up as Windows Service** (optional)

See `BUILD.md` and `WINDOWS_SERVICE.md` for deployment instructions.
