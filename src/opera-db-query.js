/**
 * Opera Database Query Module
 *
 * Queries the Oracle database for guest data by NAME_IDs,
 * joining NAME + NAME_PHONE + NAME_ADDRESS + RESERVATION_NAME.
 * Returns Salesforce-ready records in the same shape as parseOPERAFiles().
 */

const logger = require('./logger');
const { sanitizeEmail, isAgentEmail } = require('./guest-utils');

/**
 * Format a JS Date as YYYY-MM-DD for Salesforce
 */
function formatDate(date) {
  if (!date || !(date instanceof Date)) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Query guest data for a list of NAME_IDs
 * @param {OracleClient} oracleClient - Connected Oracle client
 * @param {number[]} nameIds - Array of Opera NAME_IDs
 * @returns {Promise<{records: Array, frontDesk: Array}>}
 */
async function queryGuestsByIds(oracleClient, nameIds) {
  if (!nameIds || nameIds.length === 0) {
    return { records: [], frontDesk: [] };
  }

  const records = [];
  const frontDesk = [];
  const todayArg = process.env.OVERRIDE_TODAY || new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })).toISOString().slice(0, 10);
  const batchSize = 50;

  for (let i = 0; i < nameIds.length; i += batchSize) {
    const batch = nameIds.slice(i, i + batchSize);
    const binds = {};
    const placeholders = batch.map((id, idx) => {
      binds[`id${idx}`] = id;
      return `:id${idx}`;
    });

    const rows = await oracleClient.query(`
      SELECT n.NAME_ID, n.FIRST, n.LAST,
             p.PHONE_NUMBER AS EMAIL,
             phone.PHONE_NUMBER AS PHONE,
             n.LANGUAGE,
             a.CITY, a.STATE, a.COUNTRY,
             rn.CHECK_IN, rn.CHECK_OUT, rn.RESV_STATUS
      FROM OPERA.NAME n
      JOIN OPERA.NAME_PHONE p ON n.NAME_ID = p.NAME_ID
        AND p.PHONE_ROLE = 'EMAIL' AND p.PRIMARY_YN = 'Y'
      LEFT JOIN (
        SELECT NAME_ID, PHONE_NUMBER,
               ROW_NUMBER() OVER (PARTITION BY NAME_ID ORDER BY
                 CASE PHONE_ROLE
                   WHEN 'MOBILE' THEN 1
                   WHEN 'PHONE' THEN 2
                   ELSE 3
                 END) AS rn
        FROM OPERA.NAME_PHONE
        WHERE PHONE_ROLE IN ('PHONE', 'MOBILE') AND PRIMARY_YN = 'Y'
      ) phone ON n.NAME_ID = phone.NAME_ID AND phone.rn = 1
      LEFT JOIN OPERA.NAME_ADDRESS a ON n.NAME_ID = a.NAME_ID
        AND a.PRIMARY_YN = 'Y' AND a.INACTIVE_DATE IS NULL
      LEFT JOIN (
        SELECT NAME_ID, BEGIN_DATE AS CHECK_IN, END_DATE AS CHECK_OUT, RESV_STATUS,
               ROW_NUMBER() OVER (PARTITION BY NAME_ID ORDER BY BEGIN_DATE DESC) AS rn
        FROM OPERA.RESERVATION_NAME
        WHERE RESORT = 'VINES'
          AND RESV_STATUS IN ('RESERVED','CHECKED IN','CHECKED OUT')
          AND BEGIN_DATE <= ADD_MONTHS(TRUNC(SYSDATE), 2)
      ) rn ON n.NAME_ID = rn.NAME_ID AND rn.rn = 1
      WHERE n.NAME_ID IN (${placeholders.join(',')})
    `, binds);

    for (const row of rows) {
      // Sanitize email (fix typos, transliterate international chars)
      const rawEmail = (row.EMAIL || '').trim();
      const cleanedEmail = sanitizeEmail(rawEmail);

      if (!cleanedEmail) {
        // Checking in today → front desk list; otherwise → skip silently
        const checkInStr = row.CHECK_IN ? formatDate(row.CHECK_IN) : '';
        const checkOutStr = row.CHECK_OUT ? formatDate(row.CHECK_OUT) : '';
        const isCheckingInToday = checkInStr === todayArg;
        if (isCheckingInToday) {
          logger.debug(`Front desk: NAME_ID ${row.NAME_ID} - invalid email (checking in today)`);
          frontDesk.push({
            email: rawEmail,
            firstName: (row.FIRST || '').trim(),
            lastName: (row.LAST || '').trim(),
            operaId: String(row.NAME_ID),
            reason: 'invalid-email',
            checkIn: checkInStr,
            checkOut: checkOutStr
          });
        }
        continue;
      }

      const customer = {
        operaId: String(row.NAME_ID),
        firstName: (row.FIRST || '').trim(),
        lastName: (row.LAST || '').trim(),
        email: cleanedEmail,
        phone: (row.PHONE || '').trim(),
        language: (row.LANGUAGE || '').trim(),
        billingCity: (row.CITY || '').trim(),
        billingState: (row.STATE || '').trim(),
        billingCountry: (row.COUNTRY || '').trim()
      };

      const agentCategory = isAgentEmail(customer);
      if (agentCategory) {
        const checkInStr = row.CHECK_IN ? formatDate(row.CHECK_IN) : '';
        const checkOutStr = row.CHECK_OUT ? formatDate(row.CHECK_OUT) : '';
        const isCheckingInToday = checkInStr === todayArg;

        if (!isCheckingInToday) {
          continue;
        }

        frontDesk.push({
          email: customer.email,
          firstName: customer.firstName,
          lastName: customer.lastName,
          operaId: customer.operaId,
          reason: agentCategory,
          checkIn: checkInStr,
          checkOut: checkOutStr
        });
        continue;
      }

      const invoice = (row.CHECK_IN || row.CHECK_OUT) ? {
        checkIn: formatDate(row.CHECK_IN),
        checkOut: formatDate(row.CHECK_OUT)
      } : null;

      if (!invoice) {
        // Guest has no past or current check-in — skip silently (not on-property)
        continue;
      }

      records.push({ customer, invoice });
    }
  }

  if (frontDesk.length > 0) {
    logger.info(`Front desk: ${frontDesk.length} on-property guests need email collection`);
  }
  logger.info(`Transformed ${records.length} guest records for Salesforce`);

  return { records, frontDesk };
}

/**
 * Query guests modified since a given timestamp (for catch-up on startup)
 * @param {OracleClient} oracleClient - Connected Oracle client
 * @param {string|null} sinceTimestamp - ISO timestamp, or null for initial sync
 * @returns {Promise<{records: Array, frontDesk: Array}>}
 */
async function queryGuestsSince(oracleClient, sinceTimestamp) {
  let nameIds;

  if (sinceTimestamp) {
    // Find guests with email OR reservation changes since last sync
    const rows = await oracleClient.query(`
      SELECT DISTINCT NAME_ID FROM (
        -- Email changes (new guests or email updates)
        SELECT NAME_ID FROM OPERA.NAME_PHONE
        WHERE PHONE_ROLE = 'EMAIL'
          AND (INSERT_DATE >= :since OR UPDATE_DATE >= :since)
        UNION
        -- Reservation changes (check-ins, check-outs, status updates)
        SELECT NAME_ID FROM OPERA.RESERVATION_NAME
        WHERE RESORT = 'VINES'
          AND (INSERT_DATE >= :since OR UPDATE_DATE >= :since)
        UNION
        -- Guests checking in within the next 2 months: may have been booked before
        -- last sync with no recent UPDATE_DATE, but their check-in window is now open
        SELECT NAME_ID FROM OPERA.RESERVATION_NAME
        WHERE RESORT = 'VINES'
          AND RESV_STATUS IN ('RESERVED','CHECKED IN','CHECKED OUT')
          AND TRUNC(BEGIN_DATE) BETWEEN TRUNC(SYSDATE) AND ADD_MONTHS(TRUNC(SYSDATE), 2)
      )
    `, { since: new Date(sinceTimestamp) });
    nameIds = rows.map(r => r.NAME_ID);
    logger.info(`Found ${nameIds.length} guests with email or reservation changes since ${sinceTimestamp}`);
  } else {
    // Initial sync: get all guests with emails at VINES resort (last 2 years to reduce RAM usage)
    const initialSyncMonths = parseInt(process.env.INITIAL_SYNC_MONTHS) || 24;
    logger.info(`Initial sync: querying guests with reservations in last ${initialSyncMonths} months`);

    const rows = await oracleClient.query(`
      SELECT DISTINCT p.NAME_ID
      FROM OPERA.NAME_PHONE p
      JOIN OPERA.RESERVATION_NAME rn ON p.NAME_ID = rn.NAME_ID
      WHERE p.PHONE_ROLE = 'EMAIL'
        AND rn.RESORT = 'VINES'
        AND rn.BEGIN_DATE >= ADD_MONTHS(SYSDATE, -${initialSyncMonths})
    `);
    nameIds = rows.map(r => r.NAME_ID);
    logger.info(`Found ${nameIds.length} guests for initial sync`);
  }

  return queryGuestsByIds(oracleClient, nameIds);
}

module.exports = {
  queryGuestsByIds,
  queryGuestsSince,
  formatDate
};
