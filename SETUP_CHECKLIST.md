# Setup Checklist

Use this checklist to track what's done and what still needs configuration.

---

## Complete (Ready to Use)

### Core Features
- [x] File-based sync system (chokidar watcher for CSV exports)
- [x] Database-based sync system (Oracle CQN for real-time updates)
- [x] File processing tracking (`processed-files.json`)
- [x] Salesforce connection and authentication (jsforce v3, OAuth2)
- [x] OPERA CSV parser (customers + invoices join on Opera Internal ID)
- [x] Field mapping to `TVRS_Guest__c` with `Email__c` as external ID

### Advanced Features
- [x] Duplicate detection with probability scoring
- [x] Daily summary reports (scheduled via node-schedule)
- [x] Phone field support (from Oracle DB, MOBILE prioritized)
- [x] Language field support (from Oracle DB, mapped to picklist)
- [x] Agent filtering (travel agents, OTAs automatically excluded)

### Notifications & Logging
- [x] Email notifications (Gmail API OAuth2)
- [x] Slack notifications (webhook)
- [x] Error handling and logging (Winston)

### Deployment
- [x] Standalone executable build system (pkg)
- [x] Separate executables for file and DB sync modes
- [x] Windows Service setup instructions

---

## Needs Configuration (Before First Use)

### 1. Salesforce OAuth Credentials

**Status:** Required

**What to do:**
1. Create Salesforce Connected App (see `SALESFORCE_OAUTH_SETUP.md`)
2. Run `node get-refresh-token.js` to obtain credentials
3. Add credentials to `.env` file

**Estimated time:** 30 minutes

---

### 2. Gmail OAuth Credentials (for email alerts)

**Status:** Optional but recommended

**What to do:**
1. Create Google Cloud project and OAuth credentials
2. Run `node get-gmail-oauth-token.js` to obtain refresh token
3. Add `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` to `.env`

**Estimated time:** 30 minutes

---

### 3. OPERA Export Configuration

**Status:** Required

**What to do:**
1. Verify OPERA is configured to export `customers*.csv` and `invoices*.csv`
2. Confirm export path (default: `D:\MICROS\opera\export\OPERA\vines`)
3. Set export schedule as needed

**Where to configure:** OPERA PMS system

**Estimated time:** 30 minutes

---

### 4. Oracle Database Connection (for DB Sync Mode)

**Status:** Required for database-based sync (opera-db-sync.js)

**What to do:**
1. Obtain Oracle database credentials from OPERA administrator
2. Test connection using `npm run test:oracle`
3. Add credentials to `.env` file:

```bash
ORACLE_USER=opera_user
ORACLE_PASSWORD=your_password
ORACLE_CONNECTION_STRING=host:port/servicename
```

**Features enabled:**
- Real-time sync via Oracle Continuous Query Notification (CQN)
- Phone field sync (MOBILE/PHONE from NAME_PHONE table)
- Language field sync (NAME.LANGUAGE mapped to SF picklist)

**Estimated time:** 30 minutes

---

### 5. Duplicate Detection Configuration (Optional)

**Status:** Optional but recommended

**What to do:**
Configure duplicate detection settings in `.env`:

```bash
ENABLE_DUPLICATE_DETECTION=true
DUPLICATE_THRESHOLD=75              # Skip if probability >= 75%
DUPLICATE_CACHE_TTL=3600000         # 1 hour Salesforce cache
```

**What it does:**
- Detects likely duplicates before syncing to Salesforce
- Uses probability scoring (name, location, dates, email domain)
- Skips high-probability duplicates (≥75%) and sends notification for review
- Prevents duplicate guest records in Salesforce

**Estimated time:** 5 minutes

---

### 6. Daily Summary Reports (Optional)

**Status:** Optional but recommended

**What to do:**
Configure daily summary email schedule in `.env`:

```bash
ENABLE_DAILY_SUMMARY=true
DAILY_SUMMARY_TIME=9:00
DAILY_SUMMARY_TIMEZONE=America/Argentina/Buenos_Aires
```

**What it does:**
- Sends automated daily report at 9:00 AM (configurable)
- Shows records synced, skipped (agents/duplicates/invalid), and errors
- Includes all-time file processing statistics
- Delivered via email and/or Slack

**Estimated time:** 5 minutes

---

### 7. Directory Paths

**Status:** Required for file-based sync

**What to do:**
Update `.env` with actual server paths:

```bash
EXPORT_DIR=D:\MICROS\opera\export\OPERA\vines
PROCESSED_DIR=D:\MICROS\opera\export\OPERA\vines\processed
FAILED_DIR=D:\MICROS\opera\export\OPERA\vines\failed
```

**Estimated time:** 5 minutes

---

## Pre-Deployment Testing

### Before deploying to OPERA server:

- [ ] **Test Salesforce connection**
  ```bash
  npm run test
  ```

- [ ] **Test Oracle database connection** (if using DB sync mode)
  ```bash
  npm run test:oracle
  ```

- [ ] **Test email notifications** (if configured)
  ```bash
  npm run test:notifications
  ```

- [ ] **Test OPERA parser with sample files** (file sync mode)
  ```bash
  node test-opera-parser.js
  ```

- [ ] **Test duplicate detection** (optional)
  ```bash
  node test-duplicate-detection.js
  ```
  Validates probability scoring with known duplicates

- [ ] **Test phone and language fields** (DB sync mode)
  ```bash
  node test-phone-language.js
  ```
  Queries Oracle and shows field mapping

- [ ] **Test daily summary email** (optional)
  ```bash
  node test-daily-summary.js
  ```
  Manually triggers daily report to verify formatting and delivery

- [ ] **Test with real export file** (file sync mode)
  1. Place a `customers*.csv` (and matching `invoices*.csv`) in export directory
  2. Run `npm start`
  3. Verify records appear in Salesforce under `TVRS_Guest__c`
  4. Check `logs/opera-sync.log` for any errors

- [ ] **Test with real Oracle data** (DB sync mode)
  1. Run `npm run start:db`
  2. Verify CQN connection established
  3. Check initial catch-up sync completes
  4. Verify phone and language fields populated
  5. Check `logs/opera-db-sync.log` for any errors

- [ ] **Review logs**
  - Check log file format
  - Verify error details are captured
  - Confirm log rotation works
  - Check duplicate detection notifications (if enabled)

---

## Deployment Steps

### When everything above is complete:

1. **Build standalone executable(s)**
   ```bash
   # For file-based sync
   npm run build:exe

   # For database-based sync
   npm run build:exe:db

   # Or build both
   npm run build:all
   ```

2. **Choose sync mode and copy to OPERA server**

   **File-based sync:**
   - `dist/opera-sync-file.exe`
   - `.env` file (with Salesforce + email credentials)

   **Database-based sync:**
   - `dist/opera-sync-db.exe`
   - `.env` file (with Salesforce + Oracle + email credentials)

3. **Test run manually**
   ```powershell
   cd D:\opera-sync

   # File sync
   .\opera-sync-file.exe

   # Or DB sync
   .\opera-sync-db.exe
   ```

4. **Set up as Windows Service** (optional)
   - See `WINDOWS_SERVICE.md`
   - Use NSSM or Task Scheduler
   - Service name suggestions: `OPERAFileSyncService` or `OPERADBSyncService`

5. **Monitor for 24-48 hours**
   - Check logs regularly (`logs/opera-sync.log` or `logs/opera-db-sync.log`)
   - Verify records in Salesforce (check phone/language fields if using DB mode)
   - Watch for duplicate detection notifications
   - Confirm daily summary email arrives at scheduled time
   - Check Slack notifications if configured

---

## Summary

**Critical (must do):**
- Salesforce OAuth credentials
- Choose sync mode (file-based or database-based)
- For file sync: OPERA export path in `.env`
- For DB sync: Oracle database credentials in `.env`

**Recommended:**
- Gmail OAuth for email notifications
- Enable duplicate detection (`ENABLE_DUPLICATE_DETECTION=true`)
- Enable daily summary reports (`ENABLE_DAILY_SUMMARY=true`)
- Test with real data before deploying (CSV files or Oracle connection)

**Optional:**
- Tune duplicate detection threshold (`DUPLICATE_THRESHOLD`)
- Adjust daily summary time and timezone
- Slack notifications (`SLACK_WEBHOOK_URL`)
- Disable phone/language sync if not needed (`SYNC_PHONE_FIELD`, `SYNC_LANGUAGE_FIELD`)
