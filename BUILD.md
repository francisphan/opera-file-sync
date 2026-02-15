# Building Standalone Executables

This guide shows you how to create portable versions of the OPERA sync script that you can easily copy to the OPERA server.

---

## Sync Modes

This project now supports two sync modes with **separate executables**:

1. **File-based sync** (`opera-file-sync.js`) — Watches for CSV exports
2. **Database-based sync** (`opera-db-sync.js`) — Connects directly to Oracle DB

Each mode has its own executable build command.

---

## Option 1: Standalone Executables (Recommended for Windows)

Creates `.exe` files that include Node.js runtime and all dependencies. **No Node.js installation required on the server.**

### Build Steps

```bash
# On your development machine:
cd /home/phancis/workspace/opera-file-sync

# Install dependencies (including build tools)
npm install

# Build file-based sync executable
npm run build:exe

# Build database-based sync executable
npm run build:exe:db

# Or build both at once
npm run build:all
```

This creates:
- `dist/opera-sync-file.exe` (~50-80 MB) — File-based sync
- `dist/opera-sync-db.exe` (~50-80 MB) — Database-based sync with phone/language fields

### What to Copy to OPERA Server

**File-based sync:**
```
opera-sync/
├── opera-sync-file.exe      # File watcher executable
├── .env                     # Configuration file (create this)
└── (logs/ and exports/ will be auto-created)
```

**Database-based sync:**
```
opera-sync/
├── opera-sync-db.exe        # Oracle CQN executable
├── .env                     # Configuration file with Oracle credentials
└── (logs/ will be auto-created)
```

### Run on Server

```powershell
# Create .env file with your configuration
notepad .env

# Run file-based sync
.\opera-sync-file.exe

# OR run database-based sync
.\opera-sync-db.exe
```

That's it! No Node.js installation needed.

---

## Option 2: Bundled JavaScript (Requires Node.js on Server)

This creates a single JavaScript file with all dependencies bundled, but still requires Node.js to be installed on the server.

### Build Steps

```bash
# Build bundled version
npm run build:bundle
```

This creates: `dist/index.js` (~5-10 MB)

### What to Copy to OPERA Server

```
opera-sync/
├── index.js                 # Bundled JavaScript file
├── .env                     # Configuration file (create this)
└── (logs/ and exports/ will be auto-created)
```

### Run on Server

```bash
# Requires Node.js installed on server
node index.js
```

---

## Option 3: Minimal Install (Copy Source Files)

If you prefer to keep it as regular Node.js code:

### What to Copy

```
opera-sync/
├── package.json
├── package-lock.json
├── opera-file-sync.js
├── src/
│   ├── logger.js
│   ├── file-tracker.js
│   ├── salesforce-client.js
│   └── parsers/
│       ├── csv-parser.js
│       └── xml-parser.js
├── .env                     # Create this on server
└── (logs/ and exports/ will be auto-created)
```

### Install on Server

```bash
# On OPERA server:
npm install --production
node opera-file-sync.js
```

---

## Comparison

| Option | File Size | Requires Node.js? | Ease of Deployment | Best For |
|--------|-----------|-------------------|-------------------|----------|
| **Standalone Executable** | ~80 MB | ❌ No | ⭐⭐⭐⭐⭐ Easiest | Windows servers without Node.js |
| **Bundled JavaScript** | ~10 MB | ✅ Yes | ⭐⭐⭐⭐ Easy | Servers with Node.js |
| **Source Files** | ~5 MB + node_modules | ✅ Yes | ⭐⭐⭐ Moderate | Development/testing |

---

## Platform-Specific Builds

### Windows (64-bit)
```bash
# File-based sync
npm run build:exe
# Creates: dist/opera-sync-file.exe

# Database-based sync
npm run build:exe:db
# Creates: dist/opera-sync-db.exe

# Both
npm run build:all
# Creates: both executables
```

### Linux (64-bit)
```bash
npm run build:linux
# Creates: dist/opera-sync-linux
# (Note: Only file sync mode currently configured for Linux/macOS builds)
```

### macOS (64-bit)
```bash
npm run build:macos
# Creates: dist/opera-sync-macos
# (Note: Only file sync mode currently configured for Linux/macOS builds)
```

---

## Configuration File

Regardless of which option you choose, you need to create a `.env` file on the server.

### File-Based Sync Configuration

```bash
# .env for opera-sync-file.exe
SF_INSTANCE_URL=https://your-instance.my.salesforce.com
SF_CLIENT_ID=3MVG9...
SF_CLIENT_SECRET=1234567890ABCDEF...
SF_REFRESH_TOKEN=5Aep861...
SF_OBJECT=TVRS_Guest__c
SF_EXTERNAL_ID_FIELD=Email__c

EXPORT_DIR=D:\MICROS\opera\export\OPERA\vines
PROCESSED_DIR=D:\MICROS\opera\export\OPERA\vines\processed
FAILED_DIR=D:\MICROS\opera\export\OPERA\vines\failed

FILE_FORMAT=auto
SYNC_MODE=upsert
LOG_LEVEL=info
BATCH_SIZE=200

# Optional: Duplicate Detection
ENABLE_DUPLICATE_DETECTION=true
DUPLICATE_THRESHOLD=75

# Optional: Daily Summary
ENABLE_DAILY_SUMMARY=true
DAILY_SUMMARY_TIME=9:00
DAILY_SUMMARY_TIMEZONE=America/Argentina/Buenos_Aires

# Optional: Email/Slack Notifications
EMAIL_ENABLED=true
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
SLACK_WEBHOOK_URL=...
```

### Database-Based Sync Configuration

```bash
# .env for opera-sync-db.exe
# (All Salesforce settings same as above, PLUS:)

ORACLE_USER=opera_user
ORACLE_PASSWORD=your_password
ORACLE_CONNECTION_STRING=host:port/servicename

SYNC_PHONE_FIELD=true
SYNC_LANGUAGE_FIELD=true
```

---

## Testing the Build

### Test File-Based Sync Executable Locally

```bash
# Build
npm run build:exe

# Create test .env
cp .env.example .env
# Edit .env with your credentials

# Run
./dist/opera-sync-file.exe
```

### Test Database-Based Sync Executable Locally

```bash
# Build
npm run build:exe:db

# Create test .env with Oracle credentials
cp .env.example .env
# Add Oracle credentials

# Run
./dist/opera-sync-db.exe
```

### Verify It Works

**File sync:**
1. Place a test `customers*.csv` (+ `invoices*.csv`) in the export directory
2. Check that it processes successfully
3. Verify records appear in Salesforce
4. Check logs in `logs/opera-sync.log`

**DB sync:**
1. Verify Oracle connection established (check logs)
2. Confirm CQN subscription active
3. Check initial catch-up sync completes
4. Verify phone and language fields populated in Salesforce
5. Check logs in `logs/opera-db-sync.log`

**Both modes:**
- Test duplicate detection (if enabled): Check for skip notifications
- Test daily summary: Wait for scheduled time or run `node test-daily-summary.js`
- Verify email/Slack notifications arrive

---

## Deploying to OPERA Server

### Step 1: Build Locally

```bash
# Choose which sync mode you need
npm run build:exe        # File-based
npm run build:exe:db     # Database-based
npm run build:all        # Both
```

### Step 2: Copy to Server

**Option A: Copy via Network Share**
```powershell
# From your dev machine:
copy dist\opera-sync-file.exe \\opera-server\c$\OPERA\Sync\
# Or
copy dist\opera-sync-db.exe \\opera-server\c$\OPERA\Sync\
```

**Option B: Copy via RDP**
1. Remote Desktop to OPERA server
2. Copy executable to desired location (e.g., `D:\opera-sync\`)
   - `opera-sync-file.exe` for file-based sync
   - `opera-sync-db.exe` for database-based sync

**Option C: Copy via SFTP/SCP**
```bash
scp dist/opera-sync-file.exe user@opera-server:/path/to/sync/
# Or
scp dist/opera-sync-db.exe user@opera-server:/path/to/sync/
```

### Step 3: Create .env File on Server

```powershell
# On OPERA server:
cd D:\opera-sync
notepad .env
# Paste configuration and save
```

### Step 4: Create Directories

```powershell
mkdir D:\MICROS\opera\export\OPERA\vines
mkdir D:\MICROS\opera\export\OPERA\vines\processed
mkdir D:\MICROS\opera\export\OPERA\vines\failed
```

### Step 5: Test Run

```powershell
# Run manually first to test
.\opera-sync-file.exe

# Or for DB sync
.\opera-sync-db.exe

# Check logs
type logs\opera-sync.log
# Or
type logs\opera-db-sync.log
```

### Step 6: Set Up as Windows Service (Optional)

See WINDOWS_SERVICE.md for instructions on running as a Windows Service.

---

## File Size Optimization

If the executable size is a concern:

### Option 1: Use UPX Compression

```bash
# Install UPX
npm install -g upx

# Compress executable (reduces size by ~60%)
upx dist/opera-sync.exe
```

**Result:** ~80 MB → ~30 MB

### Option 2: Use Bundled Version Instead

```bash
# Much smaller, but requires Node.js
npm run build:bundle
# Result: ~10 MB instead of 80 MB
```

---

## Troubleshooting Build Issues

### "Error: Cannot find module"

**Solution:** Make sure all dependencies are installed
```bash
npm install
```

### "pkg: command not found"

**Solution:** Install pkg globally
```bash
npm install -g pkg
```

Or use npx:
```bash
npx pkg . --targets node18-win-x64 --output dist/opera-sync.exe
```

### Executable Doesn't Run on Server

**Possible causes:**
1. Antivirus blocking - whitelist the executable
2. Missing .env file - create configuration file
3. Insufficient permissions - run as administrator

**Check logs:**
```powershell
# Logs are created in logs/ directory
type logs\opera-sync.log
```

---

## Updating the Application

### To Deploy Updates:

1. **Build new version**
   ```bash
   npm run build:exe
   ```

2. **Stop running service** (if running as service)
   ```powershell
   net stop OperaSalesforceSync
   ```

3. **Replace executable**
   ```powershell
   copy dist\opera-sync.exe \\opera-server\c$\OPERA\Sync\
   ```

4. **Restart service**
   ```powershell
   net start OperaSalesforceSync
   ```

---

## Security Considerations

### Executable Safety

The standalone executable:
- ✅ Contains only Node.js runtime + your code + dependencies
- ✅ Does not phone home or send telemetry
- ✅ Reads only from configured directories
- ✅ Connects only to Salesforce API

### .env File Security

**Important:** Protect your `.env` file!

```powershell
# Restrict file permissions (Windows)
icacls .env /inheritance:r /grant:r "%USERNAME%:F"

# Only the current user can read/write
```

---

## Summary

**Recommended deployment approach:**

**For file-based sync (CSV watching):**
```bash
# 1. Build executable
npm run build:exe

# 2. Copy to server:
#    - dist/opera-sync-file.exe
#    - .env (create on server)

# 3. Run
.\opera-sync-file.exe
```

**For database-based sync (Oracle CQN with phone/language):**
```bash
# 1. Build executable
npm run build:exe:db

# 2. Copy to server:
#    - dist/opera-sync-db.exe
#    - .env (create on server with Oracle credentials)

# 3. Run
.\opera-sync-db.exe
```

**Total deployment:** 1 executable + 1 config file

No Node.js, no npm install, no dependencies. Just copy and run!

**Which sync mode to use?**
- **File-based**: Simple, works with existing OPERA CSV exports
- **Database-based**: Real-time sync, includes phone/language fields, requires Oracle access
