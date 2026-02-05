# Field Mapping Guide

How to configure the parsers to map OPERA fields to Salesforce fields.

---

## Overview

The parsers (`csv-parser.js` and `xml-parser.js`) have placeholder TODOs where you need to add your specific field mappings.

**You need to:**
1. Get a sample OPERA export file
2. Identify the field names/structure
3. Map to your Salesforce object fields
4. Update the parser code

---

## Step 1: Get Sample OPERA Export

### Option A: Request from OPERA Admin
Ask for a sample reservation export file.

### Option B: Configure Test Export in OPERA
1. Login to OPERA
2. Configuration → Interfaces → New Interface
3. Type: Reservation Export
4. Format: CSV or XML
5. Click "Execute Now" to get sample file

### What You Need:
- [ ] Sample export file
- [ ] List of available fields
- [ ] Data format documentation

---

## Step 2: Examine the File Structure

### For CSV Files:

Open the file and note the column names:

```csv
ReservationID,GuestFirstName,GuestLastName,Email,Phone,ArrivalDate,DepartureDate,RoomType,Status
123456,John,Smith,john@example.com,555-1234,2024-02-10,2024-02-12,KING,RESERVED
```

**Column names:**
- `ReservationID`
- `GuestFirstName`
- `GuestLastName`
- etc.

### For XML Files:

Open the file and note the structure:

```xml
<Reservation>
  <ReservationID>123456</ReservationID>
  <Guest>
    <FirstName>John</FirstName>
    <LastName>Smith</LastName>
    <Email>john@example.com</Email>
  </Guest>
  <Dates>
    <Arrival>2024-02-10</Arrival>
    <Departure>2024-02-12</Departure>
  </Dates>
</Reservation>
```

**XML paths:**
- `Reservation.ReservationID`
- `Reservation.Guest.FirstName`
- `Reservation.Guest.LastName`
- etc.

---

## Step 3: Identify Your Salesforce Fields

Determine which Salesforce object and fields you're syncing to:

### Common Options:

**Option 1: Person Account**
```
Object: Account (with Person Account enabled)
Fields:
  - FirstName
  - LastName
  - PersonEmail
  - Phone
  - OPERA_Reservation_ID__c (External ID - custom field)
```

**Option 2: Contact**
```
Object: Contact
Fields:
  - FirstName
  - LastName
  - Email
  - Phone
  - OPERA_Reservation_ID__c (External ID - custom field)
```

**Option 3: Custom Object**
```
Object: OPERA_Reservation__c
Fields:
  - Name
  - Guest_First_Name__c
  - Guest_Last_Name__c
  - Guest_Email__c
  - Reservation_ID__c (External ID)
  - Arrival_Date__c
  - Departure_Date__c
```

### Create External ID Field (if needed):

1. Setup → Object Manager → [Your Object] → Fields & Relationships
2. Click "New"
3. Field Type: Text or Number
4. Check "External ID"
5. Check "Unique"
6. API Name: `OPERA_Reservation_ID__c`

---

## Step 4: Update CSV Parser

Open `src/parsers/csv-parser.js` and find the `transformCSVRecord` function (around line 43).

### Example Mapping:

**Your OPERA CSV columns → Salesforce Person Account:**

```javascript
function transformCSVRecord(row) {
  // Skip rows without required fields
  if (!row.ReservationID) {
    logger.debug('Skipping row without ReservationID');
    return null;
  }

  // Build Salesforce record
  const record = {
    // External ID for upsert (must match SF_EXTERNAL_ID_FIELD in .env)
    OPERA_Reservation_ID__c: row.ReservationID,

    // Person Account standard fields
    FirstName: row.GuestFirstName,
    LastName: row.GuestLastName,
    PersonEmail: row.Email,
    Phone: row.Phone,

    // Custom fields (create these in Salesforce first)
    OPERA_Arrival_Date__c: row.ArrivalDate,
    OPERA_Departure_Date__c: row.DepartureDate,
    OPERA_Room_Type__c: row.RoomType,
    OPERA_Status__c: row.Status,
    OPERA_Confirmation_Number__c: row.ConfirmationNumber,
  };

  // Log first record for debugging
  if (!transformCSVRecord.logged) {
    logger.debug('Sample CSV record transformation:', { input: row, output: record });
    transformCSVRecord.logged = true;
  }

  return record;
}
```

### Common CSV Column Names (adjust to your export):

**OPERA might use:**
- `RESV_NAME_ID` instead of `ReservationID`
- `FIRST` instead of `GuestFirstName`
- `LAST` instead of `GuestLastName`
- `EMAIL_ADDRESS` instead of `Email`
- `PHONE_NUMBER` instead of `Phone`
- `BEGIN_DATE` instead of `ArrivalDate`
- `END_DATE` instead of `DepartureDate`

**Update your mappings accordingly!**

---

## Step 5: Update XML Parser

Open `src/parsers/xml-parser.js` and find the `transformXMLRecord` function (around line 101).

### Example Mapping:

**Your OPERA XML structure → Salesforce Person Account:**

```javascript
function transformXMLRecord(reservation) {
  // Extract reservation ID (try different possible locations)
  const reservationId =
    reservation.ReservationID ||
    reservation.ResGlobalInfo?.HotelReservationIDs?.HotelReservationID ||
    reservation['@_ReservationID'];

  if (!reservationId) {
    logger.debug('Skipping XML record without reservation ID');
    return null;
  }

  // Navigate XML structure to get guest info
  const guest = reservation.Guest ||
                reservation.ResGuests?.ResGuest?.[0]?.Profiles?.ProfileInfo?.Profile?.Customer;

  // Build Salesforce record
  const record = {
    // External ID for upsert
    OPERA_Reservation_ID__c: reservationId,

    // Person Account standard fields
    FirstName: guest?.FirstName || guest?.PersonName?.GivenName,
    LastName: guest?.LastName || guest?.PersonName?.Surname,
    PersonEmail: guest?.Email || guest?.Email?.['#text'],
    Phone: guest?.Phone || guest?.Telephone?.PhoneNumber,

    // Custom fields
    OPERA_Arrival_Date__c: reservation.ArrivalDate || reservation.Dates?.Arrival,
    OPERA_Departure_Date__c: reservation.DepartureDate || reservation.Dates?.Departure,
    OPERA_Room_Type__c: reservation.RoomType || reservation.RoomStays?.RoomStay?.[0]?.RoomTypes?.RoomType?.RoomTypeCode,
    OPERA_Status__c: reservation.Status || reservation.ResStatus,
  };

  // Log first record for debugging
  if (!transformXMLRecord.logged) {
    logger.debug('Sample XML record transformation:', {
      reservationId,
      output: record
    });
    transformXMLRecord.logged = true;
  }

  return record;
}
```

### Common OTA/XML Paths:

**Standard OTA format:**
```
Reservation ID:
  - ResGlobalInfo.HotelReservationIDs.HotelReservationID

Guest Info:
  - ResGuests.ResGuest[0].Profiles.ProfileInfo.Profile.Customer.PersonName.GivenName
  - ResGuests.ResGuest[0].Profiles.ProfileInfo.Profile.Customer.PersonName.Surname

Dates:
  - RoomStays.RoomStay[0].TimeSpan.Start
  - RoomStays.RoomStay[0].TimeSpan.End

Room Type:
  - RoomStays.RoomStay[0].RoomTypes.RoomType.RoomTypeCode
```

**Use `?.` (optional chaining) to handle missing fields!**

---

## Step 6: Handle Data Transformations

Sometimes you need to transform data formats.

### Date Formatting:

```javascript
// If OPERA uses MM/DD/YYYY but Salesforce needs YYYY-MM-DD
function transformDate(operaDate) {
  if (!operaDate) return null;

  // Parse MM/DD/YYYY
  const [month, day, year] = operaDate.split('/');

  // Return YYYY-MM-DD
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// Use in record:
OPERA_Arrival_Date__c: transformDate(row.ArrivalDate),
```

### Phone Formatting:

```javascript
// Remove non-numeric characters
function cleanPhone(phone) {
  if (!phone) return null;
  return phone.replace(/[^0-9]/g, '');
}

// Use in record:
Phone: cleanPhone(row.Phone),
```

### Status Mapping:

```javascript
// Map OPERA status codes to readable values
function mapStatus(operaStatus) {
  const statusMap = {
    'RES': 'Reserved',
    'IH': 'In House',
    'CO': 'Checked Out',
    'CXL': 'Cancelled',
    'NS': 'No Show'
  };
  return statusMap[operaStatus] || operaStatus;
}

// Use in record:
OPERA_Status__c: mapStatus(row.Status),
```

### Default Values:

```javascript
// Provide default if field is empty
const record = {
  FirstName: row.GuestFirstName || 'Unknown',
  LastName: row.GuestLastName || 'Guest',
  PersonEmail: row.Email || null,  // null if not provided
  OPERA_Source__c: 'File Import',  // Static value
};
```

---

## Step 7: Test Your Mappings

### Test with Sample File:

1. Place sample file in export directory
2. Run script:
   ```bash
   node opera-file-sync.js
   ```

3. Check logs:
   ```bash
   cat logs/opera-sync.log
   ```

4. Look for:
   - "Sample CSV/XML record transformation" (shows your mapping)
   - "✓ File processed successfully"
   - Any field errors

5. Check Salesforce:
   - Record was created/updated
   - All fields populated correctly
   - No data quality issues

### Common Issues:

**"Required field missing"**
- Make sure you're mapping all required Salesforce fields
- Check field is in OPERA export

**"Invalid date format"**
- Add date transformation function
- Check Salesforce field type (Date vs DateTime)

**"Duplicate external ID"**
- Check OPERA export has unique reservation IDs
- Verify External ID field is unique in Salesforce

**"Field not found"**
- Typo in field API name
- Field doesn't exist on Salesforce object
- Need to create custom field first

---

## Complete Examples

### Example 1: Simple Person Account Mapping

**OPERA CSV:**
```csv
ResvID,FirstName,LastName,Email,Phone
12345,John,Smith,john@test.com,5551234
```

**Parser (csv-parser.js):**
```javascript
function transformCSVRecord(row) {
  if (!row.ResvID) return null;

  return {
    OPERA_Reservation_ID__c: row.ResvID,
    FirstName: row.FirstName,
    LastName: row.LastName,
    PersonEmail: row.Email,
    Phone: row.Phone
  };
}
```

**Salesforce Object:** Account (Person Account)

---

### Example 2: Custom Object with Dates

**OPERA CSV:**
```csv
ConfNum,GuestName,Email,CheckIn,CheckOut,RoomNum
ABC123,John Smith,john@test.com,02/10/2024,02/12/2024,101
```

**Parser (csv-parser.js):**
```javascript
function transformCSVRecord(row) {
  if (!row.ConfNum) return null;

  // Split guest name
  const [firstName, ...lastNameParts] = row.GuestName.split(' ');
  const lastName = lastNameParts.join(' ');

  return {
    Name: row.ConfNum,  // Custom object "Name" field
    OPERA_Confirmation_Number__c: row.ConfNum,  // External ID
    Guest_First_Name__c: firstName,
    Guest_Last_Name__c: lastName,
    Guest_Email__c: row.Email,
    Check_In_Date__c: transformDate(row.CheckIn),
    Check_Out_Date__c: transformDate(row.CheckOut),
    Room_Number__c: row.RoomNum
  };
}

function transformDate(mmddyyyy) {
  const [month, day, year] = mmddyyyy.split('/');
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
```

**Salesforce Object:** `OPERA_Reservation__c` (custom object)

---

### Example 3: OTA XML Format

**OPERA XML:**
```xml
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
                  <Email>john@test.com</Email>
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

**Parser (xml-parser.js):**
```javascript
function transformXMLRecord(reservation) {
  const resId = reservation.ResGlobalInfo?.HotelReservationIDs?.HotelReservationID;
  if (!resId) return null;

  const customer = reservation.ResGuests?.ResGuest?.[0]?.Profiles?.ProfileInfo?.Profile?.Customer;

  return {
    OPERA_Reservation_ID__c: resId,
    FirstName: customer?.PersonName?.GivenName,
    LastName: customer?.PersonName?.Surname,
    PersonEmail: customer?.Email
  };
}
```

---

## Checklist

Before deploying:

- [ ] Sample OPERA export file obtained
- [ ] All column names / XML paths identified
- [ ] Salesforce object and fields identified
- [ ] External ID field created in Salesforce
- [ ] Parser function updated with field mappings
- [ ] Data transformations added (dates, phones, etc.)
- [ ] Test file processed successfully
- [ ] Record appears correctly in Salesforce
- [ ] All required fields populated
- [ ] No errors in logs

---

## Tips

**Start Simple:**
- Map just 2-3 essential fields first
- Test to make sure it works
- Add more fields incrementally

**Use Optional Chaining:**
```javascript
// Good - handles missing fields gracefully
FirstName: row?.FirstName || 'Unknown'

// Bad - will error if row is undefined
FirstName: row.FirstName
```

**Log Everything (at first):**
```javascript
logger.debug('Raw row:', row);
logger.debug('Transformed record:', record);
```

**Test with Bad Data:**
- Empty fields
- Missing required fields
- Invalid date formats
- Special characters

**Document Your Mappings:**
Add comments in the code:
```javascript
// OPERA "BEGIN_DATE" → Salesforce "OPERA_Arrival_Date__c"
// Format: MM/DD/YYYY → YYYY-MM-DD
OPERA_Arrival_Date__c: transformDate(row.BEGIN_DATE),
```

---

## Next Steps

1. Get sample OPERA export
2. Update parser(s) with field mappings
3. Test with sample file
4. Verify in Salesforce
5. Deploy! 🚀
