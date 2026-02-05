# Building Standalone Executables

This guide shows you how to create portable versions of the OPERA sync script that you can easily copy to the OPERA server.

---

## Option 1: Standalone Executable (Recommended for Windows)

This creates a single `.exe` file that includes Node.js runtime and all dependencies. **No Node.js installation required on the server.**

### Build Steps

```bash
# On your development machine:
cd /home/phancis/workspace/opera-file-sync

# Install dependencies (including build tools)
npm install

# Build Windows executable
npm run build:exe
```

This creates: `dist/opera-sync.exe` (~50-80 MB)

### What to Copy to OPERA Server

```
opera-sync/
├── opera-sync.exe           # Single executable file
├── .env                     # Configuration file (create this)
└── (logs/ and exports/ will be auto-created)
```

### Run on Server

```powershell
# Create .env file with your configuration
notepad .env

# Run the executable
.\opera-sync.exe
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
npm run build:exe
# Creates: dist/opera-sync.exe
```

### Linux (64-bit)
```bash
npm run build:linux
# Creates: dist/opera-sync-linux
```

### macOS (64-bit)
```bash
npm run build:macos
# Creates: dist/opera-sync-macos
```

### Build All Platforms at Once
```bash
npm run build:all
```

---

## Configuration File

Regardless of which option you choose, you need to create a `.env` file on the server:

```bash
# .env
SF_INSTANCE_URL=https://your-instance.salesforce.com
SF_CLIENT_ID=3MVG9...
SF_CLIENT_SECRET=1234567890ABCDEF...
SF_REFRESH_TOKEN=5Aep861...

EXPORT_DIR=C:\OPERA\Exports\Reservations
PROCESSED_DIR=C:\OPERA\Exports\Processed
FAILED_DIR=C:\OPERA\Exports\Failed

FILE_FORMAT=auto
SYNC_MODE=upsert
SF_EXTERNAL_ID_FIELD=OPERA_Reservation_ID__c
LOG_LEVEL=info
BATCH_SIZE=200
```

---

## Testing the Build

### Test Executable Locally

```bash
# Build
npm run build:exe

# Create test .env
cp .env.example .env
# Edit .env with your credentials

# Run
./dist/opera-sync.exe
```

### Verify It Works

1. Place a test CSV/XML file in the export directory
2. Check that it processes successfully
3. Verify records appear in Salesforce
4. Check logs in `logs/` directory

---

## Deploying to OPERA Server

### Step 1: Build Locally

```bash
npm run build:exe
```

### Step 2: Copy to Server

**Option A: Copy via Network Share**
```powershell
# From your dev machine:
copy dist\opera-sync.exe \\opera-server\c$\OPERA\Sync\
```

**Option B: Copy via RDP**
1. Remote Desktop to OPERA server
2. Copy `opera-sync.exe` to desired location (e.g., `C:\OPERA\Sync\`)

**Option C: Copy via SFTP/SCP**
```bash
scp dist/opera-sync.exe user@opera-server:/path/to/sync/
```

### Step 3: Create .env File on Server

```powershell
# On OPERA server:
cd C:\OPERA\Sync
notepad .env
# Paste configuration and save
```

### Step 4: Create Directories

```powershell
mkdir C:\OPERA\Exports\Reservations
mkdir C:\OPERA\Exports\Processed
mkdir C:\OPERA\Exports\Failed
```

### Step 5: Test Run

```powershell
# Run manually first to test
.\opera-sync.exe
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

**Recommended for most users:**
```bash
# 1. Build executable
npm run build:exe

# 2. Copy to server:
#    - dist/opera-sync.exe
#    - .env (create on server)

# 3. Run
.\opera-sync.exe
```

**Total deployment:** 1 executable + 1 config file

No Node.js, no npm install, no dependencies. Just copy and run!
