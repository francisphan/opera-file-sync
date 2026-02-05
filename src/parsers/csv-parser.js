const fs = require('fs');
const csv = require('csv-parser');
const logger = require('../logger');

/**
 * Parse CSV file from OPERA export
 * @param {String} filePath - Path to CSV file
 * @returns {Promise<Array>} Array of parsed records
 */
async function parseCSV(filePath) {
  logger.info(`Parsing CSV file: ${filePath}`);

  return new Promise((resolve, reject) => {
    const records = [];
    const errors = [];

    fs.createReadStream(filePath)
      .pipe(csv({
        // CSV parser options
        skipEmptyLines: true,
        trim: true,
        // Customize headers if needed
        // mapHeaders: ({ header }) => header.trim().toLowerCase()
      }))
      .on('data', (row) => {
        try {
          // Transform OPERA CSV row to Salesforce record
          const salesforceRecord = transformCSVRecord(row);
          if (salesforceRecord) {
            records.push(salesforceRecord);
          }
        } catch (err) {
          logger.warn(`Error parsing CSV row:`, err);
          errors.push({ row, error: err.message });
        }
      })
      .on('end', () => {
        logger.info(`CSV parsing complete: ${records.length} records extracted`);
        if (errors.length > 0) {
          logger.warn(`Encountered ${errors.length} parsing errors`);
        }
        resolve(records);
      })
      .on('error', (err) => {
        logger.error('CSV parsing failed:', err);
        reject(err);
      });
  });
}

/**
 * Transform OPERA CSV row to Salesforce Person Account record
 *
 * Fields synced from OPERA:
 * - First name, Last name
 * - Check in date, Check out date
 * - Email address
 * - City, State/province, Country
 * - Language preference
 * - Telephone number
 *
 * @param {Object} row - CSV row object
 * @returns {Object} Salesforce record
 */
function transformCSVRecord(row) {
  // TODO: Verify the exact column names in your OPERA CSV export
  // Common variations are listed below - adjust as needed

  // Skip rows without required fields
  const reservationId = row.ReservationID || row.RESV_NAME_ID || row.ConfirmationNumber;
  if (!reservationId) {
    logger.debug('Skipping row without ReservationID');
    return null;
  }

  // Build Salesforce Person Account record
  const record = {
    // External ID for upsert (matches SF_EXTERNAL_ID_FIELD in .env)
    OPERA_Reservation_ID__c: reservationId,

    // ====================================================================
    // Standard Person Account Fields
    // ====================================================================

    // First Name
    // Common OPERA column names: FirstName, GuestFirstName, FIRST, FIRST_NAME
    FirstName: row.FirstName || row.GuestFirstName || row.FIRST || row.FIRST_NAME,

    // Last Name
    // Common OPERA column names: LastName, GuestLastName, LAST, LAST_NAME
    LastName: row.LastName || row.GuestLastName || row.LAST || row.LAST_NAME,

    // Email Address
    // Common OPERA column names: Email, EmailAddress, EMAIL, EMAIL_ADDRESS
    PersonEmail: row.Email || row.EmailAddress || row.EMAIL || row.EMAIL_ADDRESS,

    // Phone Number
    // Common OPERA column names: Phone, PhoneNumber, PHONE, PHONE_NUMBER, Telephone
    Phone: row.Phone || row.PhoneNumber || row.PHONE || row.PHONE_NUMBER || row.Telephone,

    // Mailing Address - City
    // Common OPERA column names: City, CITY, MailingCity
    PersonMailingCity: row.City || row.CITY || row.MailingCity,

    // Mailing Address - State/Province
    // Common OPERA column names: State, STATE, StateProvince, PROVINCE
    PersonMailingState: row.State || row.STATE || row.StateProvince || row.PROVINCE,

    // Mailing Address - Country
    // Common OPERA column names: Country, COUNTRY
    PersonMailingCountry: row.Country || row.COUNTRY,

    // ====================================================================
    // Custom Fields (create these in Salesforce if needed)
    // ====================================================================

    // Check In Date (Arrival Date)
    // Common OPERA column names: CheckInDate, ArrivalDate, BEGIN_DATE, ARRIVAL
    OPERA_Check_In_Date__c: row.CheckInDate || row.ArrivalDate || row.BEGIN_DATE || row.ARRIVAL,

    // Check Out Date (Departure Date)
    // Common OPERA column names: CheckOutDate, DepartureDate, END_DATE, DEPARTURE
    OPERA_Check_Out_Date__c: row.CheckOutDate || row.DepartureDate || row.END_DATE || row.DEPARTURE,

    // Language Preference
    // Common OPERA column names: Language, LanguagePreference, LANGUAGE, LANG
    OPERA_Language_Preference__c: row.Language || row.LanguagePreference || row.LANGUAGE || row.LANG,

    // Store the reservation ID in a custom field too (for reference)
    OPERA_Confirmation_Number__c: reservationId,
  };

  // Clean up the record - remove undefined fields
  Object.keys(record).forEach(key => {
    if (record[key] === undefined) {
      delete record[key];
    }
  });

  // Log first record for debugging
  if (!transformCSVRecord.logged) {
    logger.info('Sample CSV record transformation:');
    logger.info('Input columns available:', Object.keys(row));
    logger.info('Output Salesforce record:', record);
    transformCSVRecord.logged = true;
  }

  return record;
}

/**
 * Detect if file is CSV format
 */
function isCSV(filePath) {
  return filePath.toLowerCase().endsWith('.csv');
}

module.exports = {
  parseCSV,
  isCSV
};
