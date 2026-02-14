# Setup Checklist

Use this checklist to track what's done and what still needs configuration.

---

## Complete (Ready to Use)

- [x] Core file watching system (chokidar)
- [x] File deduplication tracking (`processed-files.json`)
- [x] Salesforce connection and authentication (jsforce v3, OAuth2)
- [x] OPERA CSV parser (customers + invoices join on Opera Internal ID)
- [x] Field mapping to `TVRS_Guest__c` with `Email__c` as external ID
- [x] Email notifications (Gmail API OAuth2)
- [x] Slack notifications (webhook)
- [x] Error handling and logging (Winston)
- [x] Standalone executable build system (pkg)
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

### 4. Directory Paths

**Status:** Required

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

- [ ] **Test email notifications** (if configured)
  ```bash
  npm run test:notifications
  ```

- [ ] **Test OPERA parser with sample files**
  ```bash
  node test-opera-parser.js
  ```

- [ ] **Test with real export file**
  1. Place a `customers*.csv` (and matching `invoices*.csv`) in export directory
  2. Run `npm start`
  3. Verify records appear in Salesforce under `TVRS_Guest__c`
  4. Check `logs/opera-sync.log` for any errors

- [ ] **Review logs**
  - Check `logs/opera-sync.log` format
  - Verify error details are captured
  - Confirm log rotation works

---

## Deployment Steps

### When everything above is complete:

1. **Build standalone executable**
   ```bash
   npm run build:exe
   ```

2. **Copy to OPERA server**
   - `dist/opera-sync.exe`
   - `.env` file (with real credentials)

3. **Test run manually**
   ```powershell
   cd D:\opera-sync
   .\opera-sync.exe
   ```

4. **Set up as Windows Service** (optional)
   - See `WINDOWS_SERVICE.md`
   - Use NSSM or Task Scheduler

5. **Monitor for 24-48 hours**
   - Check logs regularly
   - Verify records in Salesforce
   - Watch for errors

---

## Summary

**Critical (must do):**
- Salesforce OAuth credentials
- OPERA export path in `.env`

**Recommended:**
- Gmail OAuth for email notifications
- Test with real export files before deploying

**Optional:**
- Tune batch size (`BATCH_SIZE`)
- Adjust error thresholds (`ERROR_THRESHOLD`)
- Slack notifications (`SLACK_WEBHOOK_URL`)
