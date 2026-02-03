# OPERA to Salesforce Integration Options

Comprehensive comparison of all available integration approaches for syncing OPERA PMS data to Salesforce.

---

## Executive Summary

| Option | Real-time? | Cost/Month | Complexity | Licenses Required |
|--------|------------|------------|------------|-------------------|
| **1. Direct Database Access** | ✅ Yes | $0 | Low | None |
| **2. OPERA Web Services (OWSM)** | ✅ Yes | $0 AWS + License | Medium | OWSM Module |
| **3. File Exports (Standalone Script)** | ❌ Batch | $0 | Low | None |
| **4. File Exports (AWS)** | ❌ Batch | ~$10 | Medium | None |
| **5. OXI Webhooks (AWS)** | ✅ Yes | ~$5 | Low | OXI Module |

---

## Option 1: Direct Database Access

### Architecture
```
OPERA Database (Oracle/SQL Server)
    ↓ (SQL queries every 5 minutes)
Node.js Script (on OPERA server)
    ↓ (Salesforce API calls)
Salesforce
```

### How It Works
1. Script runs on OPERA server (or any server with database access)
2. Queries OPERA database for new/modified reservations since last sync
3. Transforms data to Salesforce format
4. Calls Salesforce API directly
5. Tracks last sync timestamp in local file or SQLite

### Sample Code
```javascript
// opera-db-sync.js
const oracledb = require('oracledb');
const jsforce = require('jsforce');
const fs = require('fs');

async function sync() {
  // Get last sync time
  const lastSync = fs.readFileSync('last-sync.txt', 'utf8');

  // Connect to OPERA database
  const connection = await oracledb.getConnection({
    user: "opera_readonly",
    password: process.env.OPERA_DB_PASSWORD,
    connectString: "localhost:1521/OPERA"
  });

  // Query new/modified reservations
  const result = await connection.execute(`
    SELECT
      r.RESV_NAME_ID,
      n.FIRST_NAME,
      n.LAST_NAME,
      n.EMAIL,
      n.PHONE,
      r.ARRIVAL_DATE,
      r.DEPARTURE_DATE,
      r.ROOM_TYPE,
      r.RESV_STATUS
    FROM RESERVATIONS r
    JOIN NAME n ON r.RESV_NAME_ID = n.NAME_ID
    WHERE r.UPDATE_DATE > TO_TIMESTAMP(:lastSync, 'YYYY-MM-DD HH24:MI:SS')
    ORDER BY r.UPDATE_DATE
  `, { lastSync });

  // Connect to Salesforce
  const sfConn = new jsforce.Connection({
    oauth2: {
      clientId: process.env.SF_CLIENT_ID,
      clientSecret: process.env.SF_CLIENT_SECRET,
      redirectUri: 'http://localhost:3000/callback'
    },
    instanceUrl: process.env.SF_INSTANCE_URL,
    refreshToken: process.env.SF_REFRESH_TOKEN
  });

  // Sync each reservation
  for (const row of result.rows) {
    const account = {
      FirstName: row.FIRST_NAME,
      LastName: row.LAST_NAME,
      PersonEmail: row.EMAIL,
      Phone: row.PHONE,
      OPERA_Reservation_ID__c: row.RESV_NAME_ID
    };

    await sfConn.sobject('Account').upsert(account, 'OPERA_Reservation_ID__c');
    console.log(`Synced reservation ${row.RESV_NAME_ID}`);
  }

  // Update last sync time
  fs.writeFileSync('last-sync.txt', new Date().toISOString());
}

// Run every 5 minutes
setInterval(sync, 5 * 60 * 1000);
sync(); // Initial run
```

### Deployment
```bash
# On OPERA server
npm install oracledb jsforce

# Create systemd service or Windows Task Scheduler
# Run: node opera-db-sync.js
```

### Pros
- ✅ **Real-time** - Query as frequently as needed (every minute if desired)
- ✅ **Zero cost** - No AWS, no additional licenses
- ✅ **Complete control** - Access all OPERA data
- ✅ **Simple** - One script, minimal dependencies
- ✅ **Fast** - Direct database queries, no file I/O
- ✅ **Flexible** - Query exactly what you need

### Cons
- ❌ **Database access required** - May violate Oracle support agreements
- ❌ **Schema knowledge needed** - Must understand OPERA database structure
- ❌ **Performance risk** - Queries could impact OPERA performance
- ❌ **Unsupported by Oracle** - Not an official integration method
- ❌ **Security concerns** - Direct database credentials
- ❌ **Version sensitivity** - OPERA schema changes could break queries

### When to Use
- You have read-only database access
- Your Oracle support agreement allows it
- You need real-time sync without OXI cost
- You're comfortable with database queries
- You have a DBA who can help with schema

### Cost
- **Infrastructure:** $0 (runs on existing OPERA server)
- **Licenses:** $0
- **Total:** $0/month

---

## Option 2: OPERA Web Services (OWSM)

### Architecture
```
Node.js Script (anywhere)
    ↓ (SOAP/REST API calls)
OPERA Web Services Module (OWSM)
    ↓ (queries OPERA securely)
OPERA Database

Node.js Script
    ↓ (Salesforce API calls)
Salesforce
```

### How It Works
1. OPERA Web Services Module must be licensed and installed
2. Script calls OWSM APIs to fetch reservation data
3. OWSM returns XML/JSON responses
4. Script transforms and sends to Salesforce

### Sample Code
```javascript
// Using OPERA SOAP API
const soap = require('soap');

const wsdlUrl = 'https://opera-server/OWS/Reservation.wsdl';
const client = await soap.createClientAsync(wsdlUrl);

// Authenticate
client.setSecurity(new soap.BasicAuthSecurity('username', 'password'));

// Fetch reservations
const result = await client.FetchReservationsAsync({
  HotelReference: { HotelCode: 'HOTEL1' },
  DateRange: {
    StartDate: '2026-02-01',
    EndDate: '2026-02-03'
  }
});

// Process and sync to Salesforce
for (const reservation of result.Reservations) {
  await syncToSalesforce(reservation);
}
```

### Pros
- ✅ **Officially supported** - Oracle-endorsed integration method
- ✅ **Real-time** - Query data on-demand
- ✅ **No database access needed** - Uses official APIs
- ✅ **Safe** - Won't impact database performance
- ✅ **Documented** - Official API documentation available
- ✅ **Secure** - Proper authentication/authorization

### Cons
- ❌ **Requires OWSM license** - Additional cost (similar to OXI pricing)
- ❌ **API limitations** - May not expose all fields
- ❌ **Complex** - SOAP/XML parsing can be tedious
- ❌ **Version dependent** - APIs change between OPERA versions
- ❌ **Setup overhead** - OWSM configuration required

### When to Use
- You already have OWSM licensed
- You need real-time data without database access
- You want Oracle-supported integration
- Your organization prefers official APIs

### Cost
- **Infrastructure:** $0 (runs on any server)
- **Licenses:** OWSM Module (contact Oracle for pricing)
- **Total:** License cost only

---

## Option 3: File Exports (Standalone Script)

### Architecture
```
OPERA Server
    ↓ (scheduled export every 4 hours)
    ↓ (writes to C:\OPERA\Exports\)
Node.js Script (on OPERA server)
    ↓ (watches directory, parses CSV/XML)
    ↓ (Salesforce API calls)
Salesforce
```

### How It Works
1. Configure OPERA to export reservations to local directory
2. Script watches directory for new files
3. When file appears, parse CSV/XML
4. Extract individual records
5. Sync each record to Salesforce
6. Move file to /processed/ folder
7. Track processed files to prevent duplicates

### Sample Code
```javascript
// opera-file-sync.js
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const jsforce = require('jsforce');

const EXPORT_DIR = 'C:\\OPERA\\Exports\\Reservations';
const PROCESSED_DIR = 'C:\\OPERA\\Exports\\Processed';
const PROCESSED_LOG = 'processed-files.json';

// Load processed files log
let processedFiles = new Set();
if (fs.existsSync(PROCESSED_LOG)) {
  processedFiles = new Set(JSON.parse(fs.readFileSync(PROCESSED_LOG)));
}

// Watch for new files
fs.watch(EXPORT_DIR, async (eventType, filename) => {
  if (!filename || !filename.endsWith('.csv')) return;
  if (processedFiles.has(filename)) return;

  const filePath = path.join(EXPORT_DIR, filename);

  // Wait for file to be fully written
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log(`Processing ${filename}...`);

  // Connect to Salesforce
  const sfConn = new jsforce.Connection({
    oauth2: { /* ... */ },
    instanceUrl: process.env.SF_INSTANCE_URL,
    refreshToken: process.env.SF_REFRESH_TOKEN
  });

  // Parse CSV
  const records = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => records.push(row))
      .on('end', resolve)
      .on('error', reject);
  });

  // Sync to Salesforce
  for (const record of records) {
    const account = {
      FirstName: record.GuestFirstName,
      LastName: record.GuestLastName,
      PersonEmail: record.Email,
      Phone: record.Phone,
      OPERA_Reservation_ID__c: record.ReservationID
    };

    await sfConn.sobject('Account').upsert(account, 'OPERA_Reservation_ID__c');
  }

  // Mark as processed
  processedFiles.add(filename);
  fs.writeFileSync(PROCESSED_LOG, JSON.stringify([...processedFiles], null, 2));

  // Move to processed folder
  fs.renameSync(filePath, path.join(PROCESSED_DIR, filename));

  console.log(`✓ Processed ${records.length} records from ${filename}`);
});

console.log(`Watching ${EXPORT_DIR} for new files...`);
```

### Deployment
```bash
# On OPERA server (or any server with access to export directory)
npm install csv-parser jsforce

# Create Windows Service
nssm install OperaSalesforceSync "C:\Program Files\nodejs\node.exe" "C:\opera-sync\opera-file-sync.js"
nssm start OperaSalesforceSync

# Or use Task Scheduler to run on startup
```

### Pros
- ✅ **Zero cost** - No AWS, no licenses
- ✅ **Simple** - Just a Node.js script
- ✅ **No database access** - Uses OPERA's export interface
- ✅ **Officially supported** - OPERA exports are standard
- ✅ **Reliable** - File-based, easy to debug
- ✅ **Manual trigger** - Operators can export on-demand

### Cons
- ❌ **Not real-time** - Delayed by export schedule
- ❌ **File management** - Need to handle file cleanup
- ❌ **Single point of failure** - If script crashes, no sync
- ❌ **Local deployment** - Must install on OPERA network

### When to Use
- You don't have OXI or OWSM licenses
- Batch sync (every few hours) is acceptable
- You want the simplest, cheapest solution
- You have access to OPERA server to install scripts

### Cost
- **Infrastructure:** $0 (runs on existing OPERA server)
- **Licenses:** $0
- **Total:** $0/month

---

## Option 4: File Exports (AWS Lambda)

### Architecture
```
OPERA Server
    ↓ (scheduled export every 4 hours)
    ↓ (aws s3 sync to S3 bucket)
S3 Bucket
    ↓ (EventBridge trigger)
Lambda Function (File Processor)
    ↓ (parse CSV/XML, send to SQS)
SQS Queue
    ↓ (batch)
Lambda Function (Salesforce Processor)
    ↓
Salesforce
```

### How It Works
1. OPERA exports files to local directory
2. Cron job syncs files to S3: `aws s3 sync /exports s3://bucket/`
3. S3 triggers Lambda via EventBridge
4. Lambda parses file, extracts records
5. Lambda sends individual records to SQS
6. Second Lambda processes SQS, syncs to Salesforce

### Deployment
```bash
cd opera-file-sync
npm install
npm run build
sam build
sam deploy --guided
```

### Pros
- ✅ **Managed infrastructure** - No server maintenance
- ✅ **Scalable** - Handles large files automatically
- ✅ **Monitoring** - CloudWatch logs and alarms
- ✅ **Dead letter queue** - Handles failures gracefully
- ✅ **Separate from OPERA** - Doesn't run on production server

### Cons
- ❌ **Not real-time** - Delayed by export + sync schedule
- ❌ **Cost** - AWS charges (~$10/month)
- ❌ **Complexity** - Multiple AWS services
- ❌ **File transfer overhead** - Must sync files to S3
- ❌ **Debugging harder** - CloudWatch logs vs local logs

### When to Use
- You want managed infrastructure
- You prefer AWS ecosystem
- You need scalability for large volumes
- You want separation from OPERA server

### Cost
- **S3 storage (10 GB):** $0.23/month
- **Lambda invocations:** $0.50/month
- **SQS:** $0.10/month
- **DynamoDB (dedup):** $0.25/month
- **Total:** ~$10/month

---

## Option 5: OXI Webhooks (AWS Lambda) - CURRENT IMPLEMENTATION

### Architecture
```
OPERA Cloud/On-premises + OXI
    ↓ (real-time webhook POST)
Lambda Function URL (Receiver)
    ↓ (validate signature, queue)
SQS Queue
    ↓ (batch)
Lambda Function (Processor)
    ↓
Salesforce
```

### How It Works
1. OXI module sends real-time webhook when events occur
2. Lambda Function URL receives POST (JSON or XML)
3. Validates webhook signature
4. Sends to SQS queue
5. Processor Lambda syncs to Salesforce
6. CloudWatch alarms monitor failures

### Deployment
```bash
cd opera-to-salesforce-sync
npm install
npm run build
sam build
sam deploy --guided \
  --parameter-overrides \
    AlertEmails=admin@example.com \
    SlackWebhookUrl=https://hooks.slack.com/...
```

### Pros
- ✅ **Real-time** - Events sent within seconds
- ✅ **Event-driven** - Only sends changes, not full exports
- ✅ **Simple architecture** - Webhook → Queue → Processor
- ✅ **Managed infrastructure** - AWS handles scaling
- ✅ **Officially supported** - Oracle-approved integration

### Cons
- ❌ **Requires OXI license** - Significant cost (contact Oracle)
- ❌ **AWS cost** - ~$5/month (minimal)
- ❌ **OPERA Cloud focused** - OXI may not be available for older on-premises versions

### When to Use
- You need real-time sync
- You have OXI license (or budget for it)
- You're using OPERA Cloud or OPERA 5.6+
- You want the official integration method

### Cost
- **Lambda invocations:** $0.50/month
- **SQS:** $0.10/month
- **OXI license:** Contact Oracle (likely $5K-$50K depending on property size)
- **Total AWS:** ~$5/month + OXI license

---

## Comparison Matrix

### By Latency
| Option | Latency | Notes |
|--------|---------|-------|
| Direct DB | ~5 minutes | Query frequency configurable |
| OWSM | ~5 minutes | Query frequency configurable |
| **OXI Webhooks** | **< 1 minute** | Real-time event stream |
| File + Standalone | 2-4 hours | Depends on export schedule |
| File + AWS | 2-4 hours | Depends on export schedule |

### By Cost (Monthly)
| Option | Infrastructure | Licenses | Total |
|--------|----------------|----------|-------|
| **Direct DB** | **$0** | **$0** | **$0** |
| **File + Standalone** | **$0** | **$0** | **$0** |
| OWSM | $0 | $$$$ | $$$$ |
| File + AWS | $10 | $0 | $10 |
| OXI Webhooks | $5 | $$$$$ | $$$$$ |

### By Complexity
| Option | Setup | Maintenance | Debugging |
|--------|-------|-------------|-----------|
| **File + Standalone** | **Easy** | **Easy** | **Easy** |
| Direct DB | Medium | Easy | Easy |
| File + AWS | Medium | Easy | Medium |
| OWSM | Hard | Medium | Medium |
| OXI Webhooks | Easy | Easy | Medium |

### By Support
| Option | Oracle Supported? | Database Access Required? |
|--------|-------------------|---------------------------|
| Direct DB | ❌ No | ✅ Yes |
| OWSM | ✅ Yes | ❌ No |
| **File Exports** | **✅ Yes** | **❌ No** |
| OXI Webhooks | ✅ Yes | ❌ No |

---

## Decision Framework

### Choose **Direct Database Access** if:
- ✅ You have read-only database access
- ✅ Your support agreement allows it
- ✅ You need real-time sync without licensing costs
- ✅ You're comfortable with SQL queries

### Choose **OPERA Web Services (OWSM)** if:
- ✅ You already have OWSM licensed
- ✅ You need real-time sync with official support
- ✅ Database access is restricted

### Choose **File Exports + Standalone Script** if:
- ✅ Batch sync is acceptable (every few hours)
- ✅ You want zero cost
- ✅ You want the simplest solution
- ✅ You have access to install scripts on OPERA network

### Choose **File Exports + AWS** if:
- ✅ Batch sync is acceptable
- ✅ You want managed infrastructure
- ✅ You need scalability
- ✅ You prefer AWS ecosystem

### Choose **OXI Webhooks** if:
- ✅ You need real-time sync
- ✅ You have budget for OXI license
- ✅ You're using OPERA Cloud or 5.6+
- ✅ You want the official real-time integration

---

## Recommended Approach

### Phase 1: Start Simple (File + Standalone Script)
**Why:**
- Zero cost
- No licensing required
- Proves the integration works
- Can be deployed immediately

**Implementation:**
1. Configure OPERA exports (30 minutes)
2. Deploy Node.js script on OPERA server (1 hour)
3. Test with sample data (1 hour)
4. Monitor for 1 week

**Result:** Working integration for $0 and ~3 hours of work

### Phase 2: Measure Pain Points
**Track:**
- Is batch delay acceptable? (e.g., 4-hour lag)
- Are file sizes manageable?
- Is reliability sufficient?
- Are manual exports needed frequently?

**Evaluate:**
- If delays are painful → Consider OXI
- If file management is messy → Consider Direct DB
- If failures are frequent → Consider AWS

### Phase 3: Upgrade if Justified
**If real-time is needed:**
- Get OXI pricing quote
- Calculate ROI of real-time data
- Deploy webhook integration (already built!)

**If batch is fine but want better reliability:**
- Move to AWS file processing (~$10/month)
- Get managed infrastructure benefits

**If need real-time but no OXI budget:**
- Explore direct database access (if allowed)
- Or use OWSM (if already licensed)

---

## Getting Started

### Quickest Path to Production

**Step 1: Configure OPERA Export (Day 1)**
```
1. Login to OPERA
2. Configuration → Interfaces → New Interface
3. Type: Reservation Export
4. Format: CSV
5. Schedule: Every 4 hours
6. Output: C:\OPERA\Exports\Reservations\
7. Test with "Execute Now"
```

**Step 2: Deploy Standalone Script (Day 1)**
```bash
# On OPERA server
git clone <repo-url> opera-salesforce-sync
cd opera-salesforce-sync
npm install

# Configure
cp .env.example .env
# Edit .env with Salesforce credentials

# Test
node opera-file-sync.js

# Deploy as Windows Service
nssm install OperaSalesforceSync node opera-file-sync.js
nssm start OperaSalesforceSync
```

**Step 3: Monitor (Week 1)**
- Check CloudWatch logs (if using AWS) or local logs
- Verify Salesforce records are created
- Test manual export trigger

**Step 4: Evaluate (Week 2)**
- Is the delay acceptable?
- Are there any failures?
- Do you need real-time?

**Step 5: Decide Next Steps**
- Stay with file exports? Done!
- Need real-time? Get OXI pricing
- Want AWS benefits? Migrate to Lambda

---

## Questions to Answer

Before choosing an approach, determine:

1. **Do you have OPERA database access?**
   - Yes → Consider Direct DB
   - No → File exports or OWSM

2. **What's your latency requirement?**
   - Real-time (< 1 min) → OXI or Direct DB
   - Near real-time (< 5 min) → Direct DB or OWSM
   - Batch (hours) → File exports

3. **What's your budget?**
   - $0/month → Direct DB or File + Standalone
   - $10/month → File + AWS
   - $$$$/month → OWSM or OXI

4. **What OPERA version do you have?**
   - OPERA Cloud → OXI available
   - OPERA 5.6+ → OXI available
   - Older versions → File exports or Direct DB

5. **Can you install software on OPERA server?**
   - Yes → Standalone script (simplest)
   - No → AWS Lambda approach

6. **What's your risk tolerance?**
   - Low (want Oracle support) → OWSM or OXI
   - Medium (comfortable with scripts) → File exports
   - High (comfortable with DB queries) → Direct DB

---

## Next Steps

1. **Answer the questions above**
2. **Choose an approach** from the decision framework
3. **If choosing file exports (recommended to start):**
   - See `OPERA_EXPORT_CONFIG.md` for OPERA setup
   - Deploy standalone script (simplest) or
   - Deploy AWS version (if you prefer managed infrastructure)
4. **If choosing OXI webhooks:**
   - Get OXI pricing from Oracle
   - Current implementation is ready to deploy
5. **If choosing direct database:**
   - Get database access approved
   - Request read-only credentials
   - Study OPERA schema documentation

---

## Summary

**Simplest & Cheapest:** File Exports + Standalone Script ($0/month, 3 hours setup)

**Most Scalable:** File Exports + AWS Lambda ($10/month, managed)

**Most Real-time (No License):** Direct Database Access ($0/month, unsupported)

**Most Real-time (Supported):** OXI Webhooks ($$$$+$5/month, supported)

**Best Official API:** OWSM ($$$$+$0 infrastructure, supported)

---

**Start with File Exports + Standalone Script. Upgrade later if needed.**
