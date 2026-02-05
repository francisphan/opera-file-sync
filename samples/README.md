# Sample Files

These are example OPERA export files for testing the sync script.

---

## Files

### sample-export.csv
Sample CSV export with common fields:
- ReservationID
- Guest name (first/last)
- Email, Phone
- Arrival/Departure dates
- Room type, Status

### sample-export.xml
Sample XML export in OTA format with:
- Hotel reservation structure
- Guest profiles
- Room stay information
- Standard OTA schema

---

## Using Sample Files

### Test CSV Parser:

1. **Update field mappings** in `src/parsers/csv-parser.js` to match these columns
2. **Copy file to export directory:**
   ```bash
   cp samples/sample-export.csv exports/
   ```
3. **Run sync script:**
   ```bash
   node opera-file-sync.js
   ```
4. **Check results:**
   - Logs: `logs/opera-sync.log`
   - Salesforce: Should see 3 new/updated records
   - Processed file: Moved to `exports/processed/`

### Test XML Parser:

1. **Update field mappings** in `src/parsers/xml-parser.js` to match this structure
2. **Copy file to export directory:**
   ```bash
   cp samples/sample-export.xml exports/
   ```
3. **Run sync script:**
   ```bash
   node opera-file-sync.js
   ```
4. **Check results:**
   - Logs: `logs/opera-sync.log`
   - Salesforce: Should see 2 new/updated records
   - Processed file: Moved to `exports/processed/`

---

## Customizing for Your OPERA Format

These samples use common field names, but your OPERA export might be different.

**Once you get a real OPERA export:**

1. Compare your file to these samples
2. Note any differences in:
   - Column names (CSV)
   - XML tag names and structure
   - Date formats
   - Field values
3. Update the parsers accordingly
4. Replace these sample files with your real samples for testing

---

## Creating Test Exports

If you don't have a real OPERA export yet:

### In OPERA:

1. **Configuration → Interfaces**
2. **New Interface**
3. **Type:** Reservation Export
4. **Format:** CSV or XML
5. **Include fields:**
   - Reservation ID
   - Guest name
   - Contact info (email, phone)
   - Stay dates
   - Room info
6. **Execute Now** → Download result
7. **Use as your real sample**

---

## Testing Scenarios

### Test 1: Successful Processing
```bash
cp samples/sample-export.csv exports/test-success.csv
# Watch logs - should process successfully
```

### Test 2: Duplicate Detection
```bash
cp samples/sample-export.csv exports/test1.csv
# Wait for processing
cp samples/sample-export.csv exports/test2.csv
# Should skip as already processed (same checksum)
```

### Test 3: Invalid Format
```bash
echo "invalid,data,format" > exports/test-error.csv
# Should move to Failed directory
# Should send error notification (after threshold)
```

### Test 4: XML vs CSV
```bash
# Process both formats to test both parsers
cp samples/sample-export.csv exports/
cp samples/sample-export.xml exports/
```

---

## Expected Salesforce Records

After processing `sample-export.csv`, you should see 3 Account records:

**Record 1:**
- External ID: 123456
- Name: John Smith
- Email: john.smith@example.com
- Phone: 555-1234

**Record 2:**
- External ID: 123457
- Name: Jane Doe
- Email: jane.doe@example.com
- Phone: 555-5678

**Record 3:**
- External ID: 123458
- Name: Bob Johnson
- Email: bob.j@example.com
- Phone: 555-9012

---

## Notes

- **These are test records** - Feel free to modify
- **Email addresses are fake** - Use example.com domain
- **Phone numbers are fake** - Use 555 prefix
- **Reservation IDs are sequential** - Real OPERA IDs will vary

Once you're confident with testing, replace these with real OPERA exports!
