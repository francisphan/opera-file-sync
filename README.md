# OPERA File Sync → Salesforce

Syncs OPERA PMS guest records to the `TVRS_Guest__c` custom object in Salesforce. Supports both **file-based sync** (CSV exports) and **database-based sync** (Oracle CQN events).

**Key Features:**
- Intelligent duplicate detection with probability scoring
- Automated daily summary reports (email + Slack)
- Phone and language field support via Oracle database
- Real-time sync via Oracle CQN or scheduled CSV processing

## How It Works

```
OPERA Server (scheduled export)
    ↓
D:\MICROS\opera\export\OPERA\vines\
    customers20260213.csv + invoices20260213.csv
    ↓ (file watcher detects new customers*.csv)
opera-sync.exe
    ↓ (joins customers + invoices by Opera Internal ID)
    ↓ (transforms & upserts via Email__c)
Salesforce TVRS_Guest__c
```

1. OPERA exports `customers*.csv` and `invoices*.csv` to the vines directory
2. The watcher detects new `customers*.csv` files and automatically finds matching `invoices*.csv`
3. Records are joined on Opera Internal ID, transformed, and upserted to Salesforce
4. Processed files move to `processed/`, failures move to `failed/` with email alerts

**Note:** On first startup, the watcher processes all existing files in the export directory. On subsequent runs, files already recorded in `processed-files.json` are skipped (matched by filename).

## Fields Synced

| OPERA Source | Salesforce Field | Notes |
|---|---|---|
| Email Address | `Email__c` (external ID) | Required for upsert |
| First Name | `Guest_First_Name__c` | |
| Last Name | `Guest_Last_Name__c` | |
| Billing City | `City__c` | |
| Billing State | `State_Province__c` | |
| Billing Country | `Country__c` | |
| Phone Number | `Telephone__c` | From Oracle DB (MOBILE prioritized) |
| Language | `Language__c` | From Oracle DB, mapped to picklist |
| Check in (from invoices) | `Check_In_Date__c` | |
| Check out (from invoices) | `Check_Out_Date__c` | |

**Language Mapping:** Oracle language codes → Salesforce picklist (English, Spanish, Portuguese, Unknown)

Records without a valid email address are skipped. All required boolean fields on TVRS_Guest__c are set to `false`.

## Sync Modes

### File-Based Sync (opera-file-sync.js)
Watches for CSV exports and processes them automatically. Ideal for OPERA installations without OXI license.

```bash
npm start              # File sync mode
npm run build:exe      # Build opera-sync-file.exe
```

### Database-Based Sync (opera-db-sync.js)
Connects directly to Oracle database via Continuous Query Notification (CQN) for real-time updates. Includes phone and language field support.

```bash
npm run start:db       # DB sync mode
npm run build:exe:db   # Build opera-sync-db.exe
```

## Key Features

### 1. Duplicate Detection
Automatically detects likely duplicates before syncing to Salesforce using probability scoring:
- **Name uniqueness** (30%): Rare names = higher probability
- **Location match** (20%): Same city increases score
- **Check-in proximity** (20%): Similar dates = likely same person
- **Email domain** (15%): Same domain boosts probability
- **Country/State** (10% + 5%): Geographic indicators

**Behavior:**
- ≥75% probability: **Skip** and notify for human review
- 50-74% probability: **Sync** with warning logged
- <50% probability: **Sync** normally

Configure via `.env`:
```bash
ENABLE_DUPLICATE_DETECTION=true
DUPLICATE_THRESHOLD=75
DUPLICATE_CACHE_TTL=3600000  # 1 hour cache
```

### 2. Daily Summary Reports
Automated email reports sent at 9:00 AM Argentina Time (configurable) showing:
- Records uploaded to Salesforce
- Records skipped (agents, duplicates, invalid data)
- Errors encountered with details
- All-time file processing statistics

Configure via `.env`:
```bash
ENABLE_DAILY_SUMMARY=true
DAILY_SUMMARY_TIME=9:00
DAILY_SUMMARY_TIMEZONE=America/Argentina/Buenos_Aires
```

### 3. Agent Filtering
Automatically excludes travel agents and booking service records based on:
- Known agent/OTA domains (booking.com, expedia, smartflyer, etc.)
- Email patterns indicating business accounts
- Missing or placeholder first names (TBC, ".", empty)

Skipped records are logged separately for tracking purposes.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Get Salesforce OAuth Credentials

```bash
node get-refresh-token.js
```

Set `SF_CLIENT_ID` and `SF_CLIENT_SECRET` in your environment or edit the file directly. The script opens a browser for Salesforce login and returns a refresh token.

### 3. Get Gmail OAuth Credentials (for email alerts)

```bash
node get-gmail-oauth-token.js
```

Set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` in your environment or edit the file directly. The script opens a browser for Google authorization and returns a refresh token.

### 4. Configure .env

```bash
cp .env.example .env
```

Required settings:

```bash
# Salesforce OAuth
SF_INSTANCE_URL=https://your-instance.my.salesforce.com
SF_CLIENT_ID=your-client-id
SF_CLIENT_SECRET=your-client-secret
SF_REFRESH_TOKEN=your-refresh-token

# OPERA export paths
EXPORT_DIR=D:\MICROS\opera\export\OPERA\vines
PROCESSED_DIR=D:\MICROS\opera\export\OPERA\vines\processed
FAILED_DIR=D:\MICROS\opera\export\OPERA\vines\failed

# Gmail OAuth (for error notifications)
SMTP_USER=your-email@gmail.com
GMAIL_CLIENT_ID=your-google-client-id
GMAIL_CLIENT_SECRET=your-google-client-secret
GMAIL_REFRESH_TOKEN=your-gmail-refresh-token
EMAIL_FROM=OPERA Sync <your-email@gmail.com>
EMAIL_TO=admin@example.com
```

**Additional Configuration (Optional):**

```bash
# Duplicate Detection
ENABLE_DUPLICATE_DETECTION=true
DUPLICATE_THRESHOLD=75              # Skip if probability >= 75%
DUPLICATE_CACHE_TTL=3600000         # 1 hour Salesforce cache

# Daily Summary Reports
ENABLE_DAILY_SUMMARY=true
DAILY_SUMMARY_TIME=9:00
DAILY_SUMMARY_TIMEZONE=America/Argentina/Buenos_Aires

# Oracle Database (for DB sync mode + phone/language fields)
ORACLE_USER=opera_user
ORACLE_PASSWORD=your_password
ORACLE_CONNECTION_STRING=host:port/servicename

# Feature Flags
SYNC_PHONE_FIELD=true
SYNC_LANGUAGE_FIELD=true

# Slack Notifications (optional)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

See `.env.example` for all available options including batch size, log level, and notification thresholds.

### 5. Test

```bash
# Test Salesforce connection
npm run test

# Test Oracle database connection (for DB sync mode)
npm run test:oracle

# Test email notifications
npm run test:notifications

# Test duplicate detection with known duplicates
node test-duplicate-detection.js

# Test phone and language field sync
node test-phone-language.js

# Test daily summary email
node test-daily-summary.js
```

### 6. Run

```bash
# File-based sync (CSV watching)
npm start

# Database-based sync (Oracle CQN)
npm run start:db
```

## Deployment (Windows Server)

### Build Executables

```bash
# Build file-based sync executable
npm run build:exe

# Build database-based sync executable
npm run build:exe:db

# Build both
npm run build:all
```

This creates:
- `dist/opera-sync-file.exe` — File-based sync (CSV watching)
- `dist/opera-sync-db.exe` — Database-based sync (Oracle CQN with phone/language)

Both are standalone Windows executables that do not require Node.js.

### Deploy to OPERA Server

**File-based sync:**
```
D:\opera-sync\
├── opera-sync-file.exe
└── .env
```

**Database-based sync:**
```
D:\opera-sync\
├── opera-sync-db.exe
└── .env  (must include ORACLE_* credentials)
```

### Run as Windows Service (Optional)

Use [NSSM](https://nssm.cc/) to run as a background service that starts automatically:

```powershell
nssm install OPERASync D:\opera-sync\opera-sync.exe
nssm set OPERASync AppDirectory D:\opera-sync
nssm start OPERASync
```

## Logging

| File | Contents |
|---|---|
| `logs/opera-sync.log` | All activity (10MB rotation, 5 files kept) |
| `logs/opera-sync-errors.log` | Errors only |
| Console | Real-time output when running manually |

Set `LOG_LEVEL` in `.env`: `error`, `warn` (default), `info`, `debug`

On the server, logs are at `D:\opera-sync\logs\`.

## Project Structure

```
opera-file-sync/
├── opera-file-sync.js              # File-based sync entry point
├── opera-db-sync.js                # Database-based sync entry point
├── src/
│   ├── salesforce-client.js        # Salesforce API (jsforce v3, OAuth2)
│   ├── notifier.js                 # Email/Slack notifications (Gmail OAuth2)
│   ├── logger.js                   # Winston logging
│   ├── file-tracker.js             # File processing tracking
│   ├── duplicate-detector.js       # Duplicate detection with probability scoring
│   ├── daily-stats.js              # Daily statistics tracking
│   ├── scheduler.js                # node-schedule for daily reports
│   ├── guest-utils.js              # Shared guest utilities (agent filtering, transformations)
│   ├── opera-db-query.js           # Oracle database queries (phone, language)
│   ├── oracle-client.js            # Oracle connection management
│   ├── sync-state.js               # Sync state tracking for DB mode
│   └── parsers/
│       ├── opera-parser.js         # OPERA CSV parser (customers + invoices join)
│       ├── csv-parser.js           # Generic CSV parser (fallback)
│       └── xml-parser.js           # XML parser (fallback)
├── get-refresh-token.js            # Salesforce OAuth token generator
├── get-gmail-oauth-token.js        # Gmail OAuth token generator
├── get-sf-schema.js                # Salesforce schema discovery tool
├── test-connection.js              # Test Salesforce connectivity
├── test-oracle-connection.js       # Test Oracle connectivity
├── test-notifications.js           # Test email/Slack alerts
├── test-duplicate-detection.js     # Test duplicate detection
├── test-phone-language.js          # Test phone/language field sync
├── test-daily-summary.js           # Test daily summary email
├── test-opera-parser.js            # Test OPERA CSV parsing
├── test-single-record.js           # Test single record upsert
├── compare-name-matches.js         # Compare Oracle vs Salesforce for duplicates
└── tvrs-guest-schema.json          # TVRS_Guest__c field schema (discovered via API)
```

## Troubleshooting

**"Cannot connect to Salesforce"** — Refresh token may have expired. Re-run `node get-refresh-token.js` and update `.env`.

**"Email notifications not working"** — Gmail refresh token may have expired. Re-run `node get-gmail-oauth-token.js` and update `.env`.

**"No files being processed"** — Verify `EXPORT_DIR` path is correct and files are named `customers*.csv`. Check `logs/opera-sync.log`.

**Files reprocessing** — The file tracker (`processed-files.json`) prevents this. Delete it to force reprocessing.
