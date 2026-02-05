# OPERA File Export to Salesforce Sync

Standalone script that syncs OPERA PMS batch file exports to Salesforce. Perfect for OPERA installations **without OXI license** that use scheduled file exports.

---

## Features

- ✅ **File-based sync** - No OXI license required
- ✅ **Multiple formats** - CSV and XML support
- ✅ **Automatic file watching** - Processes files as they appear
- ✅ **Deduplication** - Prevents duplicate processing
- ✅ **Smart error handling** - Failed files moved to separate directory
- ✅ **Email/Slack notifications** - Get alerted when issues occur
- ✅ **Standalone executable** - Single .exe file, no Node.js required
- ✅ **Windows Service** - Runs in background, auto-starts with server
- ✅ **Comprehensive logging** - Full audit trail

---

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Get Salesforce Credentials

```bash
# Run OAuth helper to get refresh token
node get-refresh-token.js
```

Follow the prompts to log in to Salesforce and get your credentials.

### 3. Configure Environment

```bash
# Copy example configuration
cp .env.example .env

# Edit with your settings
nano .env
```

**Minimum required settings:**
```bash
SF_INSTANCE_URL=https://your-instance.salesforce.com
SF_CLIENT_ID=your-client-id
SF_CLIENT_SECRET=your-client-secret
SF_REFRESH_TOKEN=your-refresh-token

EXPORT_DIR=C:\OPERA\Exports\Reservations
PROCESSED_DIR=C:\OPERA\Exports\Processed
FAILED_DIR=C:\OPERA\Exports\Failed
```

### 4. Update Field Mappings

**IMPORTANT:** You must configure field mappings based on your OPERA export format.

1. Get a sample OPERA export file
2. Open `src/parsers/csv-parser.js` or `xml-parser.js`
3. Update the `transformRecord` function with your field mappings

See `FIELD_MAPPING.md` for detailed instructions.

### 5. Test Connection

```bash
npm run test
```

### 6. Test with Sample File

```bash
# Place a test file in the export directory
cp samples/sample-export.csv exports/

# Run the script
npm start
```

Check logs and Salesforce to verify records were created.

### 7. Build Standalone Executable (Optional)

```bash
npm run build:exe
```

This creates `dist/opera-sync.exe` - a single file you can copy to the OPERA server.

### 8. Deploy to OPERA Server

See `BUILD.md` and `WINDOWS_SERVICE.md` for deployment instructions.

---

## Architecture

```
OPERA Server
    ↓ (scheduled export every 4 hours)
Export Directory (C:\OPERA\Exports\)
    ↓ (file watcher detects new files)
Node.js Script / Standalone .exe
    ↓ (parse CSV/XML, transform data)
Salesforce API
    ↓ (upsert records)
Salesforce
```

**File flow:**
1. OPERA creates export file → `Reservations/`
2. Script processes file
3. Success → moves to `Processed/`
4. Failure → moves to `Failed/` + sends alert

---

## Project Structure

```
opera-file-sync/
├── opera-file-sync.js          # Main entry point
├── get-refresh-token.js        # OAuth helper
├── test-connection.js          # Test Salesforce connection
├── test-notifications.js       # Test email/Slack alerts
├── package.json                # Dependencies & build scripts
├── .env.example                # Configuration template
│
├── src/
│   ├── logger.js               # Logging system
│   ├── file-tracker.js         # Deduplication tracking
│   ├── salesforce-client.js    # Salesforce API wrapper
│   ├── notifier.js             # Email/Slack notifications
│   └── parsers/
│       ├── csv-parser.js       # CSV file parser
│       └── xml-parser.js       # XML file parser
│
├── samples/
│   ├── sample-export.csv       # Example CSV file
│   └── sample-export.xml       # Example XML file
│
└── docs/
    ├── README.md               # This file
    ├── SETUP_CHECKLIST.md      # What's needed to deploy
    ├── FIELD_MAPPING.md        # How to configure field mappings
    ├── SALESFORCE_OAUTH_SETUP.md  # OAuth setup guide
    ├── NOTIFICATIONS.md        # Email/Slack setup (quick)
    ├── EMAIL_SETUP.md          # Email setup (detailed)
    ├── BUILD.md                # How to build executable
    ├── WINDOWS_SERVICE.md      # Run as Windows Service
    └── INTEGRATION_OPTIONS.md  # All sync approaches
```

---

## Documentation Guide

**Start here:**
1. **`SETUP_CHECKLIST.md`** - What do you need to configure?
2. **`SALESFORCE_OAUTH_SETUP.md`** - Get Salesforce credentials
3. **`FIELD_MAPPING.md`** - Configure field mappings (critical!)
4. **`NOTIFICATIONS.md`** - Set up email alerts (optional)

**For deployment:**
5. **`BUILD.md`** - Create standalone executable
6. **`WINDOWS_SERVICE.md`** - Run as background service

**Reference:**
- **`INTEGRATION_OPTIONS.md`** - Compare all sync approaches
- **`EMAIL_SETUP.md`** - Detailed email configuration

---

## Configuration

All configuration is in `.env` file:

### Required

```bash
# Salesforce
SF_INSTANCE_URL=https://your-instance.salesforce.com
SF_CLIENT_ID=...
SF_CLIENT_SECRET=...
SF_REFRESH_TOKEN=...

# Directories
EXPORT_DIR=C:\OPERA\Exports\Reservations
PROCESSED_DIR=C:\OPERA\Exports\Processed
FAILED_DIR=C:\OPERA\Exports\Failed
```

### Optional

```bash
# File Processing
FILE_FORMAT=auto                    # csv, xml, or auto
SYNC_MODE=upsert                    # upsert or insert
SF_EXTERNAL_ID_FIELD=OPERA_Reservation_ID__c
BATCH_SIZE=200                      # Records per Salesforce batch

# Logging
LOG_LEVEL=warn                      # error, warn, info, debug

# Email Notifications
EMAIL_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password
EMAIL_TO=admin@yourcompany.com

# Error Behavior
ERROR_THRESHOLD=3                   # Errors before notification
ERROR_NOTIFICATION_THROTTLE=15      # Minutes between notifications
```

---

## Testing

### Test Salesforce Connection

```bash
npm run test
```

Verifies credentials and API access.

### Test Email Notifications

```bash
npm run test:notifications
```

Sends test email and Slack message.

### Test File Processing

```bash
# Use sample files
cp samples/sample-export.csv exports/
npm start

# Check results
cat logs/opera-sync.log
```

---

## Deployment Options

### Option 1: Standalone Executable (Recommended)

**Pros:** No Node.js installation required on server

```bash
# Build
npm run build:exe

# Deploy
copy dist\opera-sync.exe \\opera-server\C$\OPERA\Sync\
copy .env \\opera-server\C$\OPERA\Sync\

# Run on server
.\opera-sync.exe
```

**File size:** ~80 MB (includes Node.js runtime)

### Option 2: Node.js Script

**Pros:** Smaller file size, easier to update

```bash
# Copy source files to server
# Install Node.js on server
npm install --production
node opera-file-sync.js
```

### Option 3: Bundled JavaScript

**Pros:** Single JS file, still requires Node.js

```bash
npm run build:bundle
# Creates dist/index.js (~10 MB)
```

See `BUILD.md` for detailed deployment instructions.

---

## Running as Windows Service

Use NSSM (recommended):

```powershell
# Install NSSM
# Download from https://nssm.cc/

# Create service
nssm install OperaSalesforceSync "C:\OPERA\Sync\opera-sync.exe"
nssm set OperaSalesforceSync AppDirectory "C:\OPERA\Sync"
nssm set OperaSalesforceSync Start SERVICE_AUTO_START

# Start service
nssm start OperaSalesforceSync
```

See `WINDOWS_SERVICE.md` for complete instructions.

---

## Monitoring

### Logs

**Console output:**
- Errors and warnings (default LOG_LEVEL=warn)

**File logs:**
- `logs/opera-sync.log` - All activity
- `logs/opera-sync-errors.log` - Errors only

**View logs:**
```bash
# Tail logs
tail -f logs/opera-sync.log

# Windows
Get-Content logs\opera-sync.log -Wait -Tail 20
```

### Email Notifications

Automatic alerts when:
- File processing fails (after 3 consecutive errors)
- Salesforce connection fails
- System recovers from errors

Configure in `.env`:
```bash
EMAIL_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password
EMAIL_TO=admin@yourcompany.com
```

See `NOTIFICATIONS.md` for setup instructions.

### File Tracking

**Processed files:**
- Moved to `PROCESSED_DIR`
- Tracked in `processed-files.json` (prevents re-processing)

**Failed files:**
- Moved to `FAILED_DIR`
- Review and re-process manually

---

## Troubleshooting

### "Cannot connect to Salesforce"

**Check:**
- Credentials in `.env` are correct
- Run `npm run test` to verify
- Refresh token hasn't been revoked

**Fix:**
- Re-run `node get-refresh-token.js`
- Update `.env` with new credentials

### "No records found in file"

**Check:**
- File format matches parser (CSV vs XML)
- Field mappings are correct
- File has data rows (not just headers)

**Fix:**
- Review logs for parsing errors
- Check `src/parsers/` field mappings
- See `FIELD_MAPPING.md`

### "Required field missing"

**Check:**
- Salesforce object has all required fields
- Parser is mapping all required fields

**Fix:**
- Add missing fields to Salesforce
- Update parser to map required fields

### Email notifications not working

**Check:**
- `EMAIL_ENABLED=true` in `.env`
- SMTP credentials are correct
- For Gmail: Using App Password (not regular password)

**Fix:**
- Run `npm run test:notifications`
- See `EMAIL_SETUP.md` troubleshooting section

---

## FAQ

**Q: Do I need OXI license?**
A: No! This uses OPERA's standard file export feature.

**Q: How often does it sync?**
A: As often as OPERA creates exports. Typical: every 2-4 hours.

**Q: Can I run this without Node.js on the server?**
A: Yes! Build the standalone .exe: `npm run build:exe`

**Q: What if the same file is exported twice?**
A: File deduplication prevents re-processing based on checksums.

**Q: Does it handle errors gracefully?**
A: Yes. Failed files move to Failed directory, you get email alerts, and processing continues.

**Q: Can I sync to custom Salesforce objects?**
A: Yes! Update the parser to map to your custom object fields.

**Q: What about real-time sync?**
A: This is batch-based (hourly/daily). For real-time, see OXI webhooks approach in `INTEGRATION_OPTIONS.md`.

**Q: Can I use this with Salesforce sandbox?**
A: Yes! Just use your sandbox credentials when running `get-refresh-token.js`.

---

## Cost

**Infrastructure:** $0 (runs on OPERA server or any Windows server)

**Licenses:** $0 (uses standard OPERA export, no OXI required)

**AWS:** Not needed

**Total:** Free! 🎉

---

## Comparison to OXI Webhooks

| Feature | This Solution (File Export) | OXI Webhooks |
|---------|----------------------------|--------------|
| **Latency** | Hours (batch) | Seconds (real-time) |
| **Cost** | $0 | $$$$ (OXI license) |
| **Setup** | Moderate | Simple |
| **OPERA License** | Standard | Requires OXI |
| **Infrastructure** | On-premises script | AWS Lambda |

**Use this if:** Batch sync is acceptable, no OXI budget

**Use OXI if:** Real-time sync required, OXI already licensed

See `INTEGRATION_OPTIONS.md` for detailed comparison.

---

## Security

- ✅ Credentials stored in `.env` (not in code)
- ✅ File permissions: `chmod 600 .env`
- ✅ Salesforce OAuth 2.0 with refresh tokens
- ✅ SMTP authentication for emails
- ✅ TLS encryption for all API calls
- ✅ Audit trail in logs

**Best practices:**
- Never commit `.env` to git
- Use AWS Secrets Manager for production (if deploying to AWS)
- Rotate refresh tokens periodically
- Use Windows file permissions to protect `.env`

---

## Support

**Issues:**
- Check `SETUP_CHECKLIST.md` - What's still needed?
- Review logs: `logs/opera-sync.log`
- See troubleshooting section above

**Documentation:**
- `SETUP_CHECKLIST.md` - Setup guide
- `FIELD_MAPPING.md` - Configure parsers
- `EMAIL_SETUP.md` - Email alerts
- `BUILD.md` - Deployment

---

## Roadmap

**Completed:**
- ✅ CSV and XML parsing
- ✅ File watching and processing
- ✅ Salesforce sync with upsert
- ✅ Email and Slack notifications
- ✅ Standalone executable builds
- ✅ Comprehensive logging
- ✅ Error handling and recovery

**Potential Future Enhancements:**
- Daily summary emails
- Salesforce custom object templates
- Multiple export directory watching
- SFTP file retrieval
- Database direct connection option

---

## License

MIT

---

## Getting Started Checklist

- [ ] Install dependencies: `npm install`
- [ ] Get Salesforce credentials: `node get-refresh-token.js`
- [ ] Copy `.env.example` to `.env`
- [ ] Update `.env` with credentials and paths
- [ ] Get sample OPERA export file
- [ ] Update field mappings in `src/parsers/`
- [ ] Test connection: `npm run test`
- [ ] Test with sample file
- [ ] Configure email notifications (optional)
- [ ] Build executable: `npm run build:exe`
- [ ] Deploy to OPERA server
- [ ] Set up as Windows Service
- [ ] Monitor for 24 hours
- [ ] Done! 🚀

**Next step:** See `SETUP_CHECKLIST.md` for detailed setup guide.
