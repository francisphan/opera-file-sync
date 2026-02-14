# OPERA File Sync → Salesforce

Watches for OPERA PMS CSV exports and syncs guest records to the `TVRS_Guest__c` custom object in Salesforce. Designed for OPERA installations **without OXI license** that use scheduled file exports.

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

| OPERA Export Column | Salesforce Field |
|---|---|
| Email Address | `Email__c` (external ID for upsert) |
| First Name | `Guest_First_Name__c` |
| Last Name | `Guest_Last_Name__c` |
| Billing City | `City__c` |
| Billing State | `State_Province__c` |
| Billing Country | `Country__c` |
| Check in (from invoices) | `Check_In_Date__c` |
| Check out (from invoices) | `Check_Out_Date__c` |

Records without a valid email address are skipped. All required boolean fields on TVRS_Guest__c are set to `false`.

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

See `.env.example` for all available options including batch size, log level, and notification thresholds.

### 5. Test

```bash
# Test Salesforce connection
npm run test

# Test email notifications
npm run test:notifications
```

### 6. Run

```bash
npm start
```

## Deployment (Windows Server)

### Build Executable

```bash
npm run build:exe
```

This creates `dist/opera-sync.exe` — a standalone Windows executable that does not require Node.js.

### Deploy to OPERA Server

Copy to the server:
```
D:\opera-sync\
├── opera-sync.exe
└── .env
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
├── opera-file-sync.js              # Main entry point & file watcher
├── src/
│   ├── salesforce-client.js        # Salesforce API (jsforce v3, OAuth2)
│   ├── notifier.js                 # Email notifications (Gmail API OAuth2)
│   ├── logger.js                   # Winston logging
│   ├── file-tracker.js             # Deduplication tracking
│   └── parsers/
│       ├── opera-parser.js         # OPERA CSV parser (customers + invoices join)
│       ├── csv-parser.js           # Generic CSV parser (fallback)
│       └── xml-parser.js           # XML parser (fallback)
├── get-refresh-token.js            # Salesforce OAuth token generator
├── get-gmail-oauth-token.js        # Gmail OAuth token generator
├── get-sf-schema.js                # Salesforce schema discovery tool
├── test-connection.js              # Test Salesforce connectivity
├── test-notifications.js           # Test email alerts
├── test-opera-parser.js            # Test OPERA CSV parsing
├── test-single-record.js           # Test single record upsert
└── tvrs-guest-schema.json          # TVRS_Guest__c field schema (discovered via API)
```

## Troubleshooting

**"Cannot connect to Salesforce"** — Refresh token may have expired. Re-run `node get-refresh-token.js` and update `.env`.

**"Email notifications not working"** — Gmail refresh token may have expired. Re-run `node get-gmail-oauth-token.js` and update `.env`.

**"No files being processed"** — Verify `EXPORT_DIR` path is correct and files are named `customers*.csv`. Check `logs/opera-sync.log`.

**Files reprocessing** — The file tracker (`processed-files.json`) prevents this. Delete it to force reprocessing.
