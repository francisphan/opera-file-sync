const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
const logger = require('../logger');

/**
 * Parse XML file from OPERA export (OTA format)
 * @param {String} filePath - Path to XML file
 * @returns {Promise<Array>} Array of parsed records
 */
async function parseXML(filePath) {
  logger.info(`Parsing XML file: ${filePath}`);

  try {
    // Read XML file
    const xmlContent = fs.readFileSync(filePath, 'utf8');

    // Parse XML
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      parseAttributeValue: true,
      trimValues: true
    });

    const parsed = parser.parse(xmlContent);

    // Extract records from parsed XML
    const records = extractRecordsFromXML(parsed);

    logger.info(`XML parsing complete: ${records.length} records extracted`);
    return records;

  } catch (err) {
    logger.error('XML parsing failed:', err);
    throw err;
  }
}

/**
 * Extract records from parsed XML structure
 *
 * TODO: Update based on your actual OPERA XML format
 *
 * @param {Object} parsed - Parsed XML object
 * @returns {Array} Array of Salesforce records
 */
function extractRecordsFromXML(parsed) {
  const records = [];

  // TODO: Update this based on your OPERA XML structure
  // This handles OTA-style XML format (similar to OXI webhooks)

  try {
    // Example OTA structure:
    // <OTA_HotelResNotifRQ>
    //   <HotelReservations>
    //     <HotelReservation>...</HotelReservation>
    //   </HotelReservations>
    // </OTA_HotelResNotifRQ>

    let reservations = [];

    // Try different possible XML structures
    if (parsed.OTA_HotelResNotifRQ?.HotelReservations?.HotelReservation) {
      // Standard OTA format
      const resData = parsed.OTA_HotelResNotifRQ.HotelReservations.HotelReservation;
      reservations = Array.isArray(resData) ? resData : [resData];
    } else if (parsed.Reservations?.Reservation) {
      // Alternative format
      const resData = parsed.Reservations.Reservation;
      reservations = Array.isArray(resData) ? resData : [resData];
    } else if (parsed.HotelReservation) {
      // Single reservation
      reservations = Array.isArray(parsed.HotelReservation) ? parsed.HotelReservation : [parsed.HotelReservation];
    } else {
      logger.warn('Unknown XML structure, attempting to find reservations...');
      // Log structure for debugging
      logger.debug('XML structure:', JSON.stringify(parsed, null, 2).substring(0, 500));
    }

    // Transform each reservation
    reservations.forEach((reservation, idx) => {
      try {
        const record = transformXMLRecord(reservation);
        if (record) {
          records.push(record);
        }
      } catch (err) {
        logger.warn(`Error transforming XML record ${idx}:`, err);
      }
    });

    // Log first record for debugging
    if (reservations.length > 0 && !extractRecordsFromXML.logged) {
      logger.debug('Sample XML reservation:', JSON.stringify(reservations[0], null, 2).substring(0, 500));
      extractRecordsFromXML.logged = true;
    }

  } catch (err) {
    logger.error('Error extracting records from XML:', err);
  }

  return records;
}

/**
 * Transform OPERA XML record to Salesforce Person Account record
 *
 * Fields synced from OPERA:
 * - First name, Last name
 * - Check in date, Check out date
 * - Email address
 * - City, State/province, Country
 * - Language preference
 * - Telephone number
 *
 * @param {Object} reservation - XML reservation object
 * @returns {Object} Salesforce record
 */
function transformXMLRecord(reservation) {
  // Extract reservation ID
  const reservationId = extractReservationId(reservation);

  if (!reservationId) {
    logger.debug('Skipping XML record without reservation ID');
    return null;
  }

  // Navigate to guest information (OTA format)
  // Standard OTA paths - adjust if your XML structure differs
  const guest = reservation.ResGuests?.ResGuest?.[0]?.Profiles?.ProfileInfo?.Profile?.Customer ||
                reservation.Guest ||
                reservation.Profile?.Customer;

  const personName = guest?.PersonName || guest;
  const address = guest?.Address || guest?.Addresses?.Address?.[0];
  const roomStay = reservation.RoomStays?.RoomStay?.[0];

  // Build Salesforce Person Account record
  const record = {
    // External ID for upsert
    OPERA_Reservation_ID__c: reservationId,

    // ====================================================================
    // Standard Person Account Fields
    // ====================================================================

    // First Name
    FirstName: personName?.GivenName || personName?.FirstName || guest?.FirstName,

    // Last Name
    LastName: personName?.Surname || personName?.LastName || guest?.LastName,

    // Email Address
    PersonEmail: guest?.Email || guest?.Email?.['#text'] || guest?.EmailAddress,

    // Phone Number
    Phone: guest?.Telephone?.PhoneNumber ||
           guest?.Telephone?.['@_PhoneNumber'] ||
           guest?.Phone ||
           guest?.Telephones?.Telephone?.[0]?.PhoneNumber,

    // Mailing Address - City
    PersonMailingCity: address?.CityName || address?.City,

    // Mailing Address - State/Province
    PersonMailingState: address?.StateProv || address?.State || address?.Province,

    // Mailing Address - Country
    PersonMailingCountry: address?.CountryName || address?.Country,

    // ====================================================================
    // Custom Fields (create these in Salesforce if needed)
    // ====================================================================

    // Check In Date (Arrival Date)
    OPERA_Check_In_Date__c: roomStay?.TimeSpan?.Start ||
                            roomStay?.TimeSpan?.['@_Start'] ||
                            reservation.ArrivalDate ||
                            reservation.CheckInDate,

    // Check Out Date (Departure Date)
    OPERA_Check_Out_Date__c: roomStay?.TimeSpan?.End ||
                             roomStay?.TimeSpan?.['@_End'] ||
                             reservation.DepartureDate ||
                             reservation.CheckOutDate,

    // Language Preference
    OPERA_Language_Preference__c: guest?.Language ||
                                  guest?.LanguagePreference ||
                                  reservation.Language,

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
  if (!transformXMLRecord.logged) {
    logger.info('Sample XML record transformation:');
    logger.info('XML structure sample:', JSON.stringify({
      reservationId,
      guestPath: guest ? 'Found' : 'Not found',
      addressPath: address ? 'Found' : 'Not found',
      roomStayPath: roomStay ? 'Found' : 'Not found'
    }, null, 2));
    logger.info('Output Salesforce record:', record);
    transformXMLRecord.logged = true;
  }

  return record;
}

/**
 * Extract reservation ID from various possible XML structures
 */
function extractReservationId(reservation) {
  // Try different possible locations for reservation ID
  return (
    reservation.ResGlobalInfo?.HotelReservationIDs?.HotelReservationID ||
    reservation.ReservationID ||
    reservation['@_ReservationID'] ||
    reservation.UniqueID?.['@_ID'] ||
    null
  );
}

/**
 * Detect if file is XML format
 */
function isXML(filePath) {
  const ext = filePath.toLowerCase();
  return ext.endsWith('.xml') || ext.endsWith('.ota');
}

module.exports = {
  parseXML,
  isXML
};
