# Setup Checklist - What's Needed

Use this checklist to track what's done and what still needs configuration.

---

## ✅ Complete (Ready to Use)

- [x] Core file watching system
- [x] File deduplication tracking
- [x] Salesforce connection and authentication
- [x] Email/Slack notifications
- [x] Error handling and logging
- [x] CSV parser (structure ready)
- [x] XML parser (structure ready)
- [x] Standalone executable build system
- [x] Windows Service setup instructions
- [x] Test scripts

---

## 🔧 Needs Configuration (Before First Use)

### 1. Salesforce OAuth Credentials

**Status:** ⚠️ Required

**What to do:**
1. Create Salesforce Connected App (see `SALESFORCE_OAUTH_SETUP.md`)
2. Run `node get-refresh-token.js` to obtain credentials
3. Add credentials to `.env` file

**Files to update:**
- `.env` (create from `.env.example`)

**Estimated time:** 30 minutes

---

### 2. Field Mappings (Most Important!)

**Status:** ⚠️ **CRITICAL - Must be configured**

**Current state:** Parsers have placeholder TODOs where field mappings go

**What to do:**
1. Get a sample OPERA export file (CSV or XML)
2. Identify the column names / XML structure
3. Map OPERA fields to Salesforce fields
4. Update parser files with actual mappings

**Files to update:**
- `src/parsers/csv-parser.js` (lines 43-75)
- `src/parsers/xml-parser.js` (lines 101-135)

**See:** `FIELD_MAPPING.md` for detailed instructions

**Estimated time:** 1-2 hours (depending on field complexity)

---

### 3. OPERA Export Configuration

**Status:** ⚠️ Required

**What to do:**
1. Configure OPERA to export reservations
2. Set export format (CSV or XML)
3. Set export schedule (e.g., every 4 hours)
4. Set output directory

**Where to configure:** OPERA PMS system

**See:** `INTEGRATION_OPTIONS.md` (lines 602-609) for OPERA setup

**Estimated time:** 30 minutes - 1 hour

---

### 4. Directory Paths

**Status:** ⚠️ Required

**What to do:**
Update `.env` with actual server paths:

```bash
EXPORT_DIR=C:\OPERA\Exports\Reservations     # Where OPERA writes files
PROCESSED_DIR=C:\OPERA\Exports\Processed     # Where to move processed files
FAILED_DIR=C:\OPERA\Exports\Failed           # Where to move failed files
```

**Files to update:**
- `.env`

**Estimated time:** 5 minutes

---

### 5. Salesforce Object Mapping

**Status:** ⚠️ Required

**Current state:** Hardcoded to sync to `Account` object

**What to do:**
Determine which Salesforce object to sync to:
- `Account` (Person Account or Business Account)
- `Contact`
- Custom object (e.g., `OPERA_Reservation__c`)

**Files to update:**
- `opera-file-sync.js` (line 280) - Change `'Account'` to your object
- Or make it configurable via `.env`

**Estimated time:** 15 minutes

---

### 6. External ID Field

**Status:** ⚠️ Required

**What to do:**
1. Create External ID field in Salesforce (if it doesn't exist)
2. Update `.env` with field API name

**Example:**
```bash
SF_EXTERNAL_ID_FIELD=OPERA_Reservation_ID__c
```

**Requirements:**
- Field must exist on target Salesforce object
- Field must be marked as "External ID"
- Field must be unique

**Estimated time:** 15 minutes

---

## 🎯 Optional Configuration

### 7. Email Notifications

**Status:** Optional (recommended)

**What to do:**
1. Configure SMTP settings in `.env`
2. Test with `npm run test:notifications`

**See:** `NOTIFICATIONS.md` or `EMAIL_SETUP.md`

**Estimated time:** 15-30 minutes

---

### 8. Batch Size Tuning

**Status:** Optional (default: 200)

**What to do:**
Adjust based on record size and Salesforce limits:

```bash
BATCH_SIZE=200  # Increase for small records, decrease for large
```

**When to adjust:**
- Records are very large → reduce to 50-100
- Records are small → increase to 500
- Getting timeout errors → reduce

**Estimated time:** 5 minutes (if needed)

---

### 9. Error Threshold Tuning

**Status:** Optional (default: 3 errors before notification)

**What to do:**
Adjust notification sensitivity:

```bash
ERROR_THRESHOLD=3              # Errors before notification
ERROR_NOTIFICATION_THROTTLE=15  # Minutes between notifications
```

**Estimated time:** 2 minutes

---

## 📋 Pre-Deployment Testing

### Before deploying to OPERA server:

- [ ] **Test Salesforce connection**
  ```bash
  npm run test
  ```

- [ ] **Test email notifications** (if configured)
  ```bash
  npm run test:notifications
  ```

- [ ] **Test with sample file**
  1. Create sample CSV/XML file
  2. Place in export directory
  3. Watch logs to verify processing
  4. Check Salesforce for created records

- [ ] **Verify field mappings**
  - Check all required Salesforce fields are populated
  - Verify data types match (dates, numbers, text)
  - Confirm External ID field works for upsert

- [ ] **Test error handling**
  - Create invalid file
  - Verify it moves to Failed directory
  - Check error notification is sent

- [ ] **Review logs**
  - Check `logs/opera-sync.log` format
  - Verify error details are captured
  - Confirm log rotation works

---

## 🚀 Deployment Steps

### When everything above is complete:

1. **Build standalone executable**
   ```bash
   npm run build:exe
   ```

2. **Copy to OPERA server**
   - `dist/opera-sync.exe`
   - `.env` file (with real credentials)

3. **Create directories on server**
   ```powershell
   mkdir C:\OPERA\Exports\Reservations
   mkdir C:\OPERA\Exports\Processed
   mkdir C:\OPERA\Exports\Failed
   ```

4. **Test run manually**
   ```powershell
   cd C:\OPERA\Sync
   .\opera-sync.exe
   ```

5. **Set up as Windows Service**
   - See `WINDOWS_SERVICE.md`
   - Use NSSM or Task Scheduler

6. **Monitor for 24-48 hours**
   - Check logs regularly
   - Verify records in Salesforce
   - Watch for errors

---

## 🔍 What You Need from OPERA

To complete the field mappings, you need:

### For CSV Format:
- [ ] Sample export file
- [ ] Column names list
- [ ] Data format documentation
  - Date format (YYYY-MM-DD? MM/DD/YYYY?)
  - Phone format
  - Any coded values (e.g., status codes)

### For XML Format:
- [ ] Sample export file
- [ ] XML schema or documentation
- [ ] Field path structure (which tags contain which data)

### Export Configuration:
- [ ] Export schedule (how often?)
- [ ] Export trigger (automatic? manual?)
- [ ] File naming pattern
- [ ] Character encoding (UTF-8, Windows-1252, etc.)

---

## 💡 Quick Start Path

**Fastest way to get running:**

1. **Get credentials** (30 min)
   - Run `node get-refresh-token.js`
   - Add to `.env`

2. **Get sample OPERA file** (ask OPERA admin)
   - Request sample reservation export

3. **Update field mappings** (1 hour)
   - Open the sample file
   - Update `src/parsers/csv-parser.js` or `xml-parser.js`
   - Map fields to Salesforce

4. **Test locally** (30 min)
   - Place sample file in export directory
   - Run `node opera-file-sync.js`
   - Verify records appear in Salesforce

5. **Build & deploy** (30 min)
   - `npm run build:exe`
   - Copy to server
   - Set up as service

**Total time:** ~3-4 hours for initial setup

---

## 📞 Ready to Deploy?

**You're ready when:**

✅ Salesforce credentials are working (`npm run test` passes)
✅ Field mappings are configured (parsers updated)
✅ Sample file processes successfully
✅ Records appear in Salesforce correctly
✅ Email notifications work (optional)
✅ Standalone .exe is built

**Then:**
- Deploy to OPERA server
- Set up as Windows Service
- Monitor for first 24 hours
- You're live! 🎉

---

## 🆘 Still Stuck?

**Most common issues:**

1. **"I don't know what fields OPERA exports"**
   - Ask OPERA admin for sample export
   - Or configure test export in OPERA interface
   - Export one reservation manually to see format

2. **"I don't know which Salesforce object to use"**
   - Usually `Account` for Person Account model
   - Or `Contact` if using Business Account + Contact
   - Ask Salesforce admin

3. **"Field mappings are confusing"**
   - See `FIELD_MAPPING.md` for detailed examples
   - Start with just 2-3 essential fields
   - Add more fields later

4. **"Email notifications don't work"**
   - Gmail: Use App Password, not regular password
   - See `EMAIL_SETUP.md` troubleshooting section

---

## Summary

**Critical (must do):**
- Salesforce OAuth credentials
- Field mappings in parsers
- OPERA export configuration

**Recommended:**
- Email notifications
- Test with sample files

**Optional:**
- Tune batch sizes
- Adjust error thresholds
- Slack notifications

**Next step:** Get a sample OPERA export file and update the field mappings!
