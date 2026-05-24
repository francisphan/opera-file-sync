# OPERA Sync → Salesforce

Syncs OPERA PMS guest records to the `TVRS_Guest__c` custom object in Salesforce by polling the OPERA Oracle database directly.

**Key Features:**
- Two-phase sync: Contact lookup/create, then `TVRS_Guest__c` upsert with diffing
- Automated daily summary and front desk reports (email + Slack)
- Phone and language field support from the Oracle database
- Google Sheets population for checkout-survey and check-in arrivals
- Andon cord kill switch to pause Salesforce writes without stopping the process

## How It Works

```
OPERA Oracle DB (OPERA.NAME_PHONE, OPERA.RESERVATION_NAME, ...)
    ↓ (poll for guests changed since last watermark)
opera-db-sync.js
    ↓ (transform Oracle rows via guest-utils)
    ↓ Phase 1: Contact lookup by Email__c → create only (never updates existing)
    ↓ Phase 2: TVRS_Guest__c query by Contact + Check_In_Date__c → diff → create/update
Salesforce
```

1. The poller queries the OPERA Oracle DB for guests with email or reservation changes since the last sync watermark (`sync-state.json`), plus upcoming arrivals.
2. Rows are transformed and split into two phases: Contacts are created (existing ones are left untouched), then `TVRS_Guest__c` records are upserted using a diff to avoid no-op writes.
3. Guests still missing a valid email are routed to the front desk report for manual collection.
4. Checkout-survey and check-in arrival rows are appended to the configured Google Sheets.

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
| Check in | `Check_In_Date__c` | |
| Check out | `Check_Out_Date__c` | |

**Language Mapping:** Oracle language codes → Salesforce picklist (English, Spanish, Portuguese, Unknown)

Records without a valid email address are skipped (and surfaced in the front desk report). All required boolean fields on `TVRS_Guest__c` are set to `false`.

## Key Features

### 1. Daily Summary & Front Desk Reports
Automated emails sent on a schedule (Argentina Time, configurable) showing records uploaded, skipped (agents/invalid), front-desk follow-ups, and errors.

```bash
ENABLE_DAILY_SUMMARY=true
DAILY_SUMMARY_TIME=9:00
DAILY_SUMMARY_TIMEZONE=America/Argentina/Buenos_Aires
FRONT_DESK_EMAIL_TO=frontdesk@yourcompany.com
FRONT_DESK_EMAIL_TIME=7:00
```

### 2. Agent Filtering
Automatically excludes travel agents and booking-service records based on:
- Known agent/OTA domains (booking.com, expedia, smartflyer, etc.)
- Email patterns indicating business accounts
- Missing or placeholder first names (TBC, ".", empty)

Skipped records are logged separately for tracking purposes.

### 3. Andon Cord (Kill Switch)
Set `ANDON_CORD=true` to pause **all** Salesforce activity without stopping the process. It skips the startup connection test (no error email, no crash-loop) and skips each poll's Salesforce write while holding the sync watermark, so the backlog replays to Salesforce once you unset it and restart. Oracle polling, front desk reports, daily summary, and Google Sheets sync keep running.

### 4. Duplicate Reporting
A standalone duplicate report (`npm run report:duplicates`) scores likely duplicate guests using name, location, check-in proximity, and email-domain signals. See `scripts/duplicate-report.js`.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Get Salesforce OAuth Credentials

```bash
node get-refresh-token.js
```

Set `SF_CLIENT_ID` and `SF_CLIENT_SECRET` in your environment first. The script opens a browser for Salesforce login and returns a refresh token.

### 3. Get Gmail OAuth Credentials (for email alerts)

```bash
node get-google-oauth-token.js
```

Set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` first. The script opens a browser for Google authorization and returns a refresh token.

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

# OPERA Oracle Database
ORACLE_HOST=your-oracle-host
ORACLE_PORT=1521
ORACLE_SID=OPERA
ORACLE_USER=opera_user
ORACLE_PASSWORD=your_password

# Gmail OAuth (for error notifications)
SMTP_USER=your-email@gmail.com
GMAIL_CLIENT_ID=your-google-client-id
GMAIL_CLIENT_SECRET=your-google-client-secret
GMAIL_REFRESH_TOKEN=your-gmail-refresh-token
EMAIL_FROM=OPERA Sync <your-email@gmail.com>
EMAIL_TO=admin@example.com
```

See `.env.example` for all available options including batch size, log level, notification thresholds, feature flags, and Google Sheets integration.

### 5. Test

```bash
npm test                  # Unit tests (guest-utils + core logic)
npm run test:integration  # Salesforce connectivity
npm run test:oracle       # Oracle connectivity
npm run test:notifications # Email/Slack alerts
```

### 6. Run

```bash
npm start                 # Start the Oracle polling sync
npm run dry-run           # Process without uploading to Salesforce
```

## Deployment (Windows Server)

### Build the Executable

```bash
npm run build
```

This produces `dist/opera-sync-db.exe` — a standalone Windows executable that does not require Node.js.

### Deploy to OPERA Server

```
D:\opera-sync\
├── opera-sync-db.exe
└── .env   (must include SF_* , ORACLE_* , and GMAIL_* credentials)
```

### Run as Windows Service

Use [NSSM](https://nssm.cc/) to run as a background service that starts automatically:

```powershell
nssm install OPERASync D:\opera-sync\opera-sync-db.exe
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
├── opera-db-sync.js                # Entry point — Oracle polling sync
├── src/
│   ├── salesforce-client.js        # Salesforce API (jsforce v3, OAuth2) + syncGuestCheckIns
│   ├── opera-db-query.js           # Oracle database queries (guests, phone, language, front desk)
│   ├── oracle-client.js            # Oracle connection management
│   ├── guest-utils.js              # Shared guest utilities (agent filtering, transforms, diffing)
│   ├── sync-state.js               # Sync watermark persistence (sync-state.json)
│   ├── notifier.js                 # Email/Slack notifications (Gmail OAuth2)
│   ├── sheets-client.js            # Google Sheets checkout/check-in population
│   ├── scheduler.js                # node-schedule for daily summary + front desk reports
│   ├── daily-stats.js              # Daily statistics tracking (daily-stats.json)
│   ├── duplicate-detector.js       # Duplicate scoring (used by the duplicate report)
│   └── logger.js                   # Winston logging
├── scripts/                        # Dry-run, duplicate report, and operational utilities
├── tests/                          # Connection, notification, and unit tests
├── get-refresh-token.js            # Salesforce OAuth token generator
├── get-google-oauth-token.js       # Gmail OAuth token generator
├── get-sf-schema.js                # Salesforce schema discovery tool
└── tvrs-guest-schema.json          # TVRS_Guest__c field schema (discovered via API)
```

## Troubleshooting

**"Cannot connect to Salesforce"** — Refresh token may have expired. Re-run `node get-refresh-token.js` and update `.env`. To keep the rest of the app running meanwhile, set `ANDON_CORD=true` and restart.

**"Email notifications not working"** — Gmail refresh token may have expired. Re-run `node get-google-oauth-token.js` and update `.env`.

**"No records syncing"** — Verify the `ORACLE_*` credentials and that the account can read the `OPERA.*` tables. Check `logs/opera-sync.log`.

**Records reprocessing / want a re-sync** — Sync progress is tracked in `sync-state.json`. Delete it (or edit the timestamp) to re-pull from an earlier point.
