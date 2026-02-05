# Required Salesforce Fields

These fields need to be set up in your Salesforce Person Account for the OPERA sync to work.

---

## Standard Person Account Fields

These fields already exist in Salesforce Person Accounts - no setup needed:

- ✅ `FirstName`
- ✅ `LastName`
- ✅ `PersonEmail`
- ✅ `Phone`
- ✅ `PersonMailingCity`
- ✅ `PersonMailingState`
- ✅ `PersonMailingCountry`

---

## Custom Fields to Create

You need to create these custom fields on the **Account** object in Salesforce:

### 1. OPERA Reservation ID (External ID)

**Field Label:** OPERA Reservation ID
**API Name:** `OPERA_Reservation_ID__c`
**Data Type:** Text (50)
**Attributes:**
- ✅ External ID
- ✅ Unique
- ✅ Required

**Purpose:** Used for upsert operations to match OPERA reservations to Salesforce records

---

### 2. Check In Date

**Field Label:** OPERA Check In Date
**API Name:** `OPERA_Check_In_Date__c`
**Data Type:** Date
**Attributes:**
- Optional (not required)

---

### 3. Check Out Date

**Field Label:** OPERA Check Out Date
**API Name:** `OPERA_Check_Out_Date__c`
**Data Type:** Date
**Attributes:**
- Optional (not required)

---

### 4. Language Preference

**Field Label:** OPERA Language Preference
**API Name:** `OPERA_Language_Preference__c`
**Data Type:** Text (50) or Picklist
**Attributes:**
- Optional (not required)

**Picklist Values (if using Picklist):**
- English
- Spanish
- French
- German
- Italian
- Portuguese
- Japanese
- Chinese
- Other

---

### 5. Confirmation Number

**Field Label:** OPERA Confirmation Number
**API Name:** `OPERA_Confirmation_Number__c`
**Data Type:** Text (50)
**Attributes:**
- Optional (not required)

**Purpose:** Stores the confirmation number for reference

---

## How to Create Custom Fields in Salesforce

### Step 1: Navigate to Object Manager

1. Click **Setup** (gear icon)
2. In Quick Find, search for **Object Manager**
3. Click **Account**
4. Click **Fields & Relationships**

### Step 2: Create External ID Field

1. Click **New**
2. Select **Text** → Next
3. Settings:
   - Field Label: `OPERA Reservation ID`
   - Length: `50`
   - Field Name: `OPERA_Reservation_ID`
4. Check these boxes:
   - ✅ **Required**
   - ✅ **Unique** (Case insensitive)
   - ✅ **External ID**
5. Click **Next**
6. Field-Level Security: **Visible** for all profiles
7. Click **Next**
8. Page Layouts: Add to layouts as needed
9. Click **Save**

### Step 3: Create Date Fields

Repeat for Check In and Check Out dates:

1. Click **New**
2. Select **Date** → Next
3. Settings:
   - Field Label: `OPERA Check In Date` (or `OPERA Check Out Date`)
   - Field Name: Auto-populated
4. Click **Next**
5. Field-Level Security: **Visible** for all profiles
6. Click **Next**
7. Page Layouts: Add to layouts as needed
8. Click **Save**

### Step 4: Create Language Preference

**Option A: Text Field (simpler)**
1. Click **New**
2. Select **Text** → Next
3. Settings:
   - Field Label: `OPERA Language Preference`
   - Length: `50`
   - Field Name: Auto-populated
4. Click **Next** → **Next** → **Save**

**Option B: Picklist (better data quality)**
1. Click **New**
2. Select **Picklist** → Next
3. Settings:
   - Field Label: `OPERA Language Preference`
   - Field Name: Auto-populated
4. Enter values (one per line):
   ```
   English
   Spanish
   French
   German
   Italian
   Portuguese
   Japanese
   Chinese
   Other
   ```
5. Click **Next** → **Next** → **Save**

### Step 5: Create Confirmation Number

1. Click **New**
2. Select **Text** → Next
3. Settings:
   - Field Label: `OPERA Confirmation Number`
   - Length: `50`
   - Field Name: Auto-populated
4. Click **Next** → **Next** → **Save**

---

## Verify Fields in .env

After creating the fields, verify your `.env` configuration:

```bash
# External ID field for upsert operations
SF_EXTERNAL_ID_FIELD=OPERA_Reservation_ID__c
```

This must match the API name of your External ID field exactly.

---

## Testing Field Creation

After creating the fields, test that they work:

### Test 1: Manual Record Creation

1. Go to **Accounts** tab
2. Click **New**
3. Select **Person Account**
4. Fill in:
   - First Name: Test
   - Last Name: Guest
   - OPERA Reservation ID: TEST123
   - Check In Date: Today's date
5. Click **Save**
6. Verify all fields appear correctly

### Test 2: API Access

Run the test script with sample data:

```bash
npm run test
```

Should show no field-related errors.

### Test 3: Sync Test

Process a sample file and verify all fields populate:

```bash
cp samples/sample-export.csv exports/
npm start
```

Check the created/updated Account record in Salesforce.

---

## Field Mapping Reference

**OPERA → Salesforce**

| OPERA Field | Salesforce Field | Type |
|-------------|------------------|------|
| First Name | `FirstName` | Standard |
| Last Name | `LastName` | Standard |
| Email Address | `PersonEmail` | Standard |
| Telephone Number | `Phone` | Standard |
| City | `PersonMailingCity` | Standard |
| State/Province | `PersonMailingState` | Standard |
| Country | `PersonMailingCountry` | Standard |
| Reservation ID | `OPERA_Reservation_ID__c` | Custom (External ID) |
| Check In Date | `OPERA_Check_In_Date__c` | Custom |
| Check Out Date | `OPERA_Check_Out_Date__c` | Custom |
| Language Preference | `OPERA_Language_Preference__c` | Custom |
| Confirmation Number | `OPERA_Confirmation_Number__c` | Custom |

---

## Alternative: Using Contact Object

If you prefer to use **Contact** instead of **Person Account**:

### Update parser to use Contact fields:

```javascript
const record = {
  // Contact standard fields (no "Person" prefix)
  FirstName: row.FirstName,
  LastName: row.LastName,
  Email: row.Email,              // Note: Email not PersonEmail
  Phone: row.Phone,
  MailingCity: row.City,         // Note: MailingCity not PersonMailingCity
  MailingState: row.State,
  MailingCountry: row.Country,

  // Same custom fields
  OPERA_Reservation_ID__c: row.ReservationID,
  OPERA_Check_In_Date__c: row.CheckInDate,
  OPERA_Check_Out_Date__c: row.CheckOutDate,
  OPERA_Language_Preference__c: row.Language,
};
```

**Also update:**
- `opera-file-sync.js` line 280: Change `'Account'` to `'Contact'`

---

## Troubleshooting

### "Field does not exist" error

**Cause:** Field API name doesn't match

**Fix:**
1. Go to Setup → Object Manager → Account → Fields & Relationships
2. Find your field
3. Note the exact **API Name** (includes `__c` at the end)
4. Update parser code to match exactly

### "Required field missing" error

**Cause:** Salesforce requires a field that OPERA isn't providing

**Fix:**
1. Check which field is required in Salesforce
2. Either:
   - Make it optional in Salesforce, or
   - Provide a default value in the parser:
     ```javascript
     FirstName: row.FirstName || 'Guest',
     ```

### External ID not working for upsert

**Cause:** Field not marked as External ID

**Fix:**
1. Go to the field settings in Salesforce
2. Edit field
3. Check **External ID**
4. Check **Unique**
5. Save

---

## Summary

**To complete setup:**

1. ✅ Create 5 custom fields on Account object (see instructions above)
2. ✅ Mark `OPERA_Reservation_ID__c` as External ID
3. ✅ Test field creation by creating a test Account record
4. ✅ Run sync test with sample file

**Total time:** ~15-30 minutes

Once these fields are created, the sync script will be able to populate all the OPERA data into Salesforce! 🎉
