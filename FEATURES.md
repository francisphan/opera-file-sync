# Features Documentation

This document provides detailed information about the advanced features available in the OPERA File Sync system.

---

## Table of Contents

1. [Duplicate Detection](#duplicate-detection)
2. [Daily Summary Reports](#daily-summary-reports)
3. [Phone and Language Fields](#phone-and-language-fields)
4. [Agent Filtering](#agent-filtering)
5. [Sync Modes](#sync-modes)

---

## Duplicate Detection

Automatically detects likely duplicate guest records before syncing to Salesforce using intelligent probability scoring.

### How It Works

The system compares each incoming guest record against all existing records in Salesforce using a multi-factor probability algorithm:

| Factor | Weight | Description |
|--------|--------|-------------|
| **Name Uniqueness** | 30% | Rare names (e.g., "Maximilian") indicate higher probability |
| **City Match** | 20% | Same city strongly suggests same person |
| **Check-in Proximity** | 20% | Check-ins within 365 days increase likelihood |
| **Email Domain** | 15% | Same domain (e.g., @gmail.com) adds to probability |
| **Country Match** | 10% | Geographic indicator |
| **State Match** | 5% | Additional geographic indicator |

### Probability Thresholds

- **≥75%**: High probability duplicate — **Skipped** and notification sent for human review
- **50-74%**: Medium probability — **Synced** with warning logged
- **<50%**: Low probability — **Synced** normally

### Configuration

```bash
# .env
ENABLE_DUPLICATE_DETECTION=true
DUPLICATE_THRESHOLD=75              # Skip if probability >= 75%
DUPLICATE_CACHE_TTL=3600000         # 1 hour (milliseconds)
```

### Performance

- **Caching**: Salesforce records cached for 1 hour (configurable)
- **Lazy Loading**: Cache only loads on first duplicate check
- **Efficient Queries**: Only 7 fields retrieved (not full records)
- **Name Indexing**: O(1) lookups via `nameKey(first, last)`

Average performance: <100ms per batch of records

### Notifications

When high-probability duplicates are detected, a notification is sent via email/Slack containing:
- Guest details (name, email, check-in dates)
- Probability score
- Matching Salesforce records with comparison table
- Direct link to review in Salesforce

### Testing

```bash
node test-duplicate-detection.js
```

Tests duplicate detection with known duplicate records from the database.

---

## Daily Summary Reports

Automated daily reports sent via email and/or Slack showing sync activity and statistics.

### Report Contents

**Daily Statistics:**
- Records successfully synced to Salesforce
- Records skipped (agents, duplicates, invalid data)
- Errors encountered with details (up to 10 most recent)

**All-Time File Statistics** (file sync mode only):
- Total files processed
- Successful file syncs
- Failed file syncs

### Scheduling

Reports are sent at a configurable time using timezone-aware scheduling:

```bash
# .env
ENABLE_DAILY_SUMMARY=true
DAILY_SUMMARY_TIME=9:00                             # 24-hour format (HH:MM)
DAILY_SUMMARY_TIMEZONE=America/Argentina/Buenos_Aires
```

**Supported Timezones:** Any IANA timezone (e.g., `America/New_York`, `Europe/London`, `Asia/Tokyo`)

### Email Format

Reports are sent in HTML format with:
- Clear statistics tables
- Color-coded sections (success = green, errors = red)
- Error details with timestamps
- Responsive design (mobile-friendly)

### Behavior

- **Activity Detection**: Reports only sent if there was activity (uploads, skips, or errors)
- **Auto-Reset**: Statistics automatically reset at midnight in configured timezone
- **Persistence**: Statistics saved to `daily-stats.json` (survives restarts)

### Manual Testing

```bash
node test-daily-summary.js
```

Manually triggers a daily summary email to verify formatting and delivery.

### Delivery Methods

- **Email**: Via Gmail OAuth2 API (primary)
- **Slack**: Via webhook (optional, simultaneous with email)

---

## Phone and Language Fields

Enhanced guest data by querying Oracle database directly for phone numbers and language preferences.

### Database Query

**Available in:** Database-based sync mode only (`opera-db-sync.js`)

The system queries the following Oracle tables:
- `OPERA.NAME` — Guest names and language preferences
- `OPERA.NAME_PHONE` — Phone numbers (MOBILE and PHONE roles)
- `OPERA.NAME_ADDRESS` — Address information
- `OPERA.RESERVATION_NAME` — Check-in/out dates

### Phone Number Logic

**Prioritization:**
1. MOBILE role (preferred)
2. PHONE role (fallback)
3. NULL if neither available

**Filter:** Only `PRIMARY_YN='Y'` records

### Language Mapping

Oracle language codes are mapped to Salesforce picklist values:

| Oracle Code | Salesforce Value |
|-------------|------------------|
| ENG, E, EN | English |
| SPA, SP, S, ES, ESP | Spanish |
| POR, PR, P, PT, PORTUG | Portuguese |
| (any other) | Unknown |

### Salesforce Fields

| Field | Type | Description |
|-------|------|-------------|
| `Telephone__c` | Text(40) | Phone number |
| `Language__c` | Picklist | Language preference |

### Configuration

```bash
# .env
SYNC_PHONE_FIELD=true
SYNC_LANGUAGE_FIELD=true
```

Set to `false` to disable specific field syncing if needed.

### Testing

```bash
node test-phone-language.js
```

Queries Oracle for sample records and displays phone/language field mapping.

### Coverage

Based on testing:
- **Phone**: ~80% of guest records have phone numbers
- **Language**: ~70% of guest records have language codes
- **NULL Handling**: Safe defaults (NULL for phone, "Unknown" for language)

---

## Agent Filtering

Automatically excludes travel agents, OTAs, and business accounts from syncing to prevent cluttering guest records.

### Detection Methods

**1. Known Agent/OTA Domains:**
- booking.com, expedia.com
- smartflyer, fora.travel
- traveledge, protravelinc
- globaltravelcollection
- (50+ domains total)

**2. Business Email Patterns:**
- Keywords: reserv, travel, tour, viaje, incoming, operacion
- Matches in email domain indicate business account

**3. Name-Based Detection:**
- Empty first name
- First name = "." or "TBC"
- Placeholder values

### Categories

Skipped records are logged by category:
- `booking-proxy` — Booking.com guest accounts
- `expedia-proxy` — Expedia partner accounts
- `agent-domain` — Travel agent email domains
- `company` — Missing/placeholder first names

### Statistics

Agent filtering statistics included in:
- Daily summary reports ("Skipped: Agents")
- Real-time logs
- `daily-stats.json` file

### Configuration

Agent filtering is **always enabled** and cannot be disabled (intentional design to prevent data quality issues).

To modify agent domain list, edit:
```javascript
// src/guest-utils.js
const AGENT_DOMAIN_KEYWORDS = [
  'reserv', 'travel', 'tour', ...
];
```

---

## Sync Modes

### File-Based Sync (`opera-file-sync.js`)

**How it works:**
1. Watches export directory for new CSV files
2. Detects `customers*.csv` files automatically
3. Finds matching `invoices*.csv` by date
4. Joins on Opera Internal ID
5. Transforms and upserts to Salesforce

**Best for:**
- OPERA without OXI license
- Scheduled CSV exports
- Existing export workflows

**Features:**
- File deduplication tracking
- Automatic file moving (processed/failed)
- All-time file statistics

**Executable:** `opera-sync-file.exe`

### Database-Based Sync (`opera-db-sync.js`)

**How it works:**
1. Connects to Oracle database
2. Subscribes to Continuous Query Notification (CQN)
3. Receives real-time updates on NAME/RESERVATION_NAME changes
4. Queries phone and language fields
5. Transforms and upserts to Salesforce

**Best for:**
- Real-time sync requirements
- Direct Oracle database access available
- Need phone/language field support

**Features:**
- Real-time updates via CQN
- Phone field support (MOBILE prioritized)
- Language field support (mapped to picklist)
- Initial catch-up sync on startup
- Sync state persistence

**Executable:** `opera-sync-db.exe`

### Choosing a Mode

| Feature | File Sync | DB Sync |
|---------|-----------|---------|
| Real-time updates | ❌ No | ✅ Yes |
| Phone field | ❌ No | ✅ Yes |
| Language field | ❌ No | ✅ Yes |
| Oracle access required | ❌ No | ✅ Yes |
| File statistics | ✅ Yes | ❌ No |
| Complexity | Simple | Moderate |

**Recommendation:** Use file sync for simplicity, DB sync for completeness.

---

## Feature Matrix

| Feature | File Sync | DB Sync | Configurable |
|---------|-----------|---------|--------------|
| Duplicate Detection | ✅ | ✅ | ✅ |
| Daily Summary Reports | ✅ | ✅ | ✅ |
| Agent Filtering | ✅ | ✅ | ❌ |
| Phone Field | ❌ | ✅ | ✅ |
| Language Field | ❌ | ✅ | ✅ |
| Email Notifications | ✅ | ✅ | ✅ |
| Slack Notifications | ✅ | ✅ | ✅ |
| File Statistics | ✅ | ❌ | N/A |
| Real-time Sync | ❌ | ✅ | N/A |

---

## Testing All Features

### Complete Test Suite

```bash
# 1. Test Salesforce connection
npm run test

# 2. Test Oracle connection (DB mode only)
npm run test:oracle

# 3. Test email notifications
npm run test:notifications

# 4. Test duplicate detection
node test-duplicate-detection.js

# 5. Test phone/language fields (DB mode only)
node test-phone-language.js

# 6. Test daily summary email
node test-daily-summary.js

# 7. Test full sync workflow
npm start              # File sync
# OR
npm run start:db       # DB sync
```

### Recommended Test Order

1. **Connectivity**: Test Salesforce and Oracle connections first
2. **Notifications**: Verify email/Slack delivery
3. **Individual Features**: Test each feature in isolation
4. **Full Integration**: Run full sync and monitor logs

---

## Troubleshooting

### Duplicate Detection Issues

**Problem:** False positives (legitimate guests skipped)
- **Solution:** Increase `DUPLICATE_THRESHOLD` (try 85% or 90%)
- **Check:** Review notification emails to verify false positives

**Problem:** False negatives (duplicates not detected)
- **Solution:** Decrease `DUPLICATE_THRESHOLD` (try 65% or 70%)
- **Note:** Will generate more notifications for review

**Problem:** Performance degradation
- **Solution:** Increase `DUPLICATE_CACHE_TTL` (try 7200000 = 2 hours)
- **Check:** Monitor logs for cache refresh messages

### Daily Summary Issues

**Problem:** Reports not arriving
- **Check:** Verify `ENABLE_DAILY_SUMMARY=true`
- **Check:** Confirm email configuration (Gmail OAuth)
- **Test:** Run `node test-daily-summary.js`

**Problem:** Wrong send time
- **Check:** Verify `DAILY_SUMMARY_TIMEZONE` is correct
- **Check:** System timezone vs configured timezone
- **Test:** Check logs for "Next run:" message after startup

**Problem:** Empty reports
- **Behavior:** Normal — reports only sent if there's activity
- **Override:** Run `node test-daily-summary.js` to force send

### Phone/Language Issues

**Problem:** Phone numbers not syncing
- **Check:** `SYNC_PHONE_FIELD=true` in `.env`
- **Check:** Oracle connection established
- **Check:** Using DB sync mode (not file sync)
- **Test:** Run `node test-phone-language.js`

**Problem:** Language showing "Unknown"
- **Check:** Oracle NAME.LANGUAGE field populated
- **Check:** Language codes in `mapLanguageToSalesforce()` function
- **Test:** Query Oracle directly: `SELECT LANGUAGE FROM OPERA.NAME WHERE NAME_ID=12345`

---

## Support

For issues or questions:
1. Check logs: `logs/opera-sync.log` or `logs/opera-db-sync.log`
2. Review `.env` configuration
3. Run relevant test script
4. Check Salesforce for records/errors
5. Review email/Slack notifications

For feature requests or bugs, create an issue in the project repository.
