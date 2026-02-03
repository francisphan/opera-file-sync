# OPERA File Export to Salesforce Sync

AWS Lambda integration to sync OPERA PMS **batch file exports** to Salesforce.

## Architecture

This solution is designed for OPERA on-premises installations **without OXI** that use scheduled file exports.

```
OPERA Server
    ↓ (scheduled export every 4 hours)
File Share / FTP / SFTP
    ↓ (AWS CLI sync or manual upload)
S3 Bucket (opera-exports)
    ↓ (S3 Event → EventBridge)
Lambda (FileProcessor)
    ↓ (parse CSV/XML, create events)
SQS Queue (opera-events-queue)
    ↓ (batch processing)
Lambda (SalesforceProcessor)
    ↓
Salesforce
```

## Key Differences from Webhook Integration

| Feature | Webhook (OXI) | File Export (This Repo) |
|---------|---------------|-------------------------|
| **Latency** | Real-time (seconds) | Batch (hours) |
| **OPERA License** | Requires OXI | Standard OPERA |
| **Cost** | OXI license $$$$ | AWS only (~$10/month) |
| **Complexity** | Simple | Moderate |
| **Use Case** | Real-time sync needed | Batch sync acceptable |

## Supported File Formats

- **CSV** - Comma-separated values
- **XML** - OTA format (same as OXI)
- **Fixed-width text** - Legacy OPERA exports
- **Custom delimited** - Configurable

## Components

### 1. S3 Bucket
- Receives OPERA export files
- EventBridge integration for automatic processing
- Lifecycle policies for archival

### 2. File Processor Lambda
- Triggered by S3 uploads
- Parses CSV/XML files
- Extracts individual records
- Sends to SQS queue

### 3. SQS Queue + Processor
- Same queue/processor as webhook integration
- Handles deduplication
- Syncs to Salesforce

### 4. File Upload Options

**Option A: AWS CLI Sync** (Recommended)
```bash
# Run on server with access to OPERA exports
aws s3 sync /path/to/opera-exports s3://opera-exports-bucket/ \
  --exclude "*.tmp" \
  --exclude "processed/*"
```

**Option B: AWS Transfer Family (SFTP)**
- OPERA uploads directly to AWS-managed SFTP
- Files automatically land in S3

**Option C: Manual Upload**
- Upload files via AWS Console or scripts

## Prerequisites

- OPERA on-premises with export interface configured
- AWS account with appropriate permissions
- AWS CLI installed (for file sync)
- Node.js 20+ (for local development)
- AWS SAM CLI (for deployment)

## Quick Start

### 1. Configure OPERA Exports

In OPERA, set up scheduled exports:
1. Navigate to **Configuration > Interfaces**
2. Create new interface:
   - Type: **Reservation Export**
   - Format: **CSV** or **XML (OTA)**
   - Schedule: **Every 4 hours** (or as needed)
   - Output: **Network share or FTP**

### 2. Deploy AWS Infrastructure

```bash
# Install dependencies
npm install

# Build Lambda functions
npm run build

# Deploy with SAM
sam build
sam deploy --guided
```

### 3. Set Up File Sync

**Option A: Scheduled AWS CLI sync**

Create a cron job on the server with OPERA export access:

```bash
# Edit crontab
crontab -e

# Add sync job (every 15 minutes)
*/15 * * * * aws s3 sync /opera/exports s3://YOUR-BUCKET-NAME/ --exclude "*.tmp"
```

**Option B: Use AWS Transfer Family**

1. Deploy SFTP endpoint (included in template)
2. Configure OPERA to export to SFTP
3. Files automatically process on arrival

### 4. Configure Salesforce Secrets

Same as webhook integration:

```bash
aws secretsmanager create-secret \
  --name opera-sync/salesforce \
  --secret-string '{
    "instanceUrl": "https://your-instance.salesforce.com",
    "clientId": "your-client-id",
    "clientSecret": "your-client-secret",
    "refreshToken": "your-refresh-token"
  }'
```

## File Format Examples

### CSV Format

```csv
ReservationID,GuestFirstName,GuestLastName,Email,Phone,ArrivalDate,DepartureDate,RoomType,Status
123456,John,Smith,john@example.com,555-1234,2026-02-10,2026-02-12,KING,RESERVED
123457,Jane,Doe,jane@example.com,555-5678,2026-02-11,2026-02-13,QUEEN,CONFIRMED
```

### XML Format (OTA)

```xml
<?xml version="1.0"?>
<OTA_HotelResNotifRQ>
  <HotelReservations>
    <HotelReservation>
      <ResGlobalInfo>
        <HotelReservationIDs>
          <HotelReservationID>123456</HotelReservationID>
        </HotelReservationIDs>
      </ResGlobalInfo>
      <ResGuests>
        <ResGuest>
          <Profiles>
            <ProfileInfo>
              <Profile>
                <Customer>
                  <PersonName>
                    <GivenName>John</GivenName>
                    <Surname>Smith</Surname>
                  </PersonName>
                  <Email>john@example.com</Email>
                  <Telephone>555-1234</Telephone>
                </Customer>
              </Profile>
            </ProfileInfo>
          </Profiles>
        </ResGuest>
      </ResGuests>
    </HotelReservation>
  </HotelReservations>
</OTA_HotelResNotifRQ>
```

## Deduplication

The file processor tracks processed files to prevent duplicate records:
- **DynamoDB table** stores file checksums
- Files with same checksum are skipped
- Configurable retention (default: 30 days)

## Monitoring

### CloudWatch Alarms

- **File Processing Errors** - Alert when Lambda fails to process files
- **Large File Warnings** - Alert for files >100MB
- **Processing Lag** - Alert when files aren't processed within SLA
- **DLQ Messages** - Alert when records fail Salesforce sync

### Metrics

- Files processed per hour
- Records extracted per file
- Processing duration
- Salesforce sync success rate

## Cost Estimate

**Typical monthly costs for 1000 reservations/day:**

- S3 storage (10 GB): $0.23
- S3 requests: $0.05
- Lambda (file processor): $0.50
- Lambda (Salesforce processor): $1.00
- SQS: $0.10
- DynamoDB (deduplication): $0.25
- EventBridge: $0.05
- **Total: ~$2.20/month**

Add ~$15/month for AWS Transfer Family if using SFTP option.

## Comparison to Webhook Integration

**Use File Export When:**
- ✅ No OXI license available
- ✅ Batch sync is acceptable (hourly/daily)
- ✅ Lower cost is priority
- ✅ Existing export processes in place

**Use Webhook Integration When:**
- ✅ Real-time sync required
- ✅ OXI license available
- ✅ Simpler architecture preferred
- ✅ Event-driven processing needed

## Migration Path

Start with file exports, migrate to webhooks later:

1. **Deploy this solution** for immediate integration
2. **Measure pain points** (delays, complexity)
3. **Build business case** for OXI
4. **Purchase OXI license** when justified
5. **Switch to webhook integration** (same Salesforce processor)

## Configuration

### SAM Parameters

```bash
sam deploy --parameter-overrides \
  SalesforceSecretName=opera-sync/salesforce \
  AlertEmails=admin@example.com \
  SlackWebhookUrl=https://hooks.slack.com/... \
  FileProcessingTimeout=300 \
  MaxFileSizeMB=100
```

### Environment Variables

- `SALESFORCE_SECRET_NAME` - Secrets Manager secret name
- `SQS_QUEUE_URL` - Target SQS queue
- `FILE_FORMAT` - Default format (csv, xml, auto)
- `DEDUP_TABLE_NAME` - DynamoDB table for deduplication

## Troubleshooting

### Files not processing

1. Check S3 bucket EventBridge configuration
2. Verify Lambda has S3 read permissions
3. Check CloudWatch logs for errors

### Duplicate records in Salesforce

1. Verify deduplication table is working
2. Check file naming patterns (should be unique)
3. Ensure checksum calculation is consistent

### Large files timing out

1. Increase Lambda timeout (max 15 minutes)
2. Consider splitting large files
3. Use Lambda with more memory (faster processing)

### Files stuck in S3

1. Check Lambda execution role permissions
2. Verify file format is supported
3. Check for malformed data in files

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Local development
sam local invoke FileProcessorFunction --event events/s3-event.json

# Watch for changes
npm run watch
```

## Project Structure

```
opera-file-sync/
├── src/
│   ├── file-processor/
│   │   ├── handler.ts          # S3 event handler
│   │   ├── parsers/
│   │   │   ├── csv-parser.ts   # CSV file parser
│   │   │   ├── xml-parser.ts   # XML file parser
│   │   │   └── fixed-width.ts  # Fixed-width parser
│   │   └── deduplication.ts    # File dedup logic
│   ├── salesforce-processor/   # Same as webhook integration
│   └── shared/                 # Shared utilities
├── template.yaml               # SAM infrastructure
├── scripts/
│   ├── sync-files.sh          # Sync script for cron
│   └── test-upload.sh         # Test file upload
└── docs/
    ├── OPERA_EXPORT_CONFIG.md  # OPERA configuration guide
    └── FILE_FORMATS.md         # Supported formats
```

## Security

- S3 bucket encryption at rest (SSE-S3)
- Files automatically deleted after processing (configurable retention)
- Secrets stored in AWS Secrets Manager
- Lambda functions run with least privilege IAM roles
- VPC support available for database access

## Limitations

- **Not real-time** - Delays based on export frequency
- **File size limits** - Lambda has 15-minute timeout
- **Format dependencies** - Requires consistent OPERA export format
- **Manual setup** - File sync requires configuration

## Support

For issues or questions:
- GitHub Issues: [Link to repo]
- Documentation: See `/docs` folder
- Related: [opera-to-salesforce-sync](../opera-to-salesforce-sync) - Webhook version

## License

MIT
