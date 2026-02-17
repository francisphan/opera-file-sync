/**
 * Opera Database Query Module
 *
 * Queries the Oracle database for guest data by NAME_IDs,
 * joining NAME + NAME_PHONE + NAME_ADDRESS + RESERVATION_NAME.
 * Returns Salesforce-ready records in the same shape as parseOPERAFiles().
 */

const logger = require('./logger');
const { isAgentEmail } = require('./guest-utils');

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
 * @returns {Promise<{records: Array, filtered: Array}>}
 */
async function queryGuestsByIds(oracleClient, nameIds) {
  if (!nameIds || nameIds.length === 0) {
    return { records: [], filtered: [] };
  }

  const records = [];
  const filtered = [];
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
             rn.CHECK_IN, rn.CHECK_OUT
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
        SELECT NAME_ID, BEGIN_DATE AS CHECK_IN, END_DATE AS CHECK_OUT,
               ROW_NUMBER() OVER (PARTITION BY NAME_ID ORDER BY BEGIN_DATE DESC) AS rn
        FROM OPERA.RESERVATION_NAME
        WHERE RESORT = 'VINES' AND RESV_STATUS IN ('RESERVED','CHECKED IN','CHECKED OUT')
      ) rn ON n.NAME_ID = rn.NAME_ID AND rn.rn = 1
      WHERE n.NAME_ID IN (${placeholders.join(',')})
    `, binds);

    for (const row of rows) {
      const customer = {
        operaId: String(row.NAME_ID),
        firstName: (row.FIRST || '').trim(),
        lastName: (row.LAST || '').trim(),
        email: (row.EMAIL || '').trim(),
        phone: (row.PHONE || '').trim(),
        language: (row.LANGUAGE || '').trim(),
        billingCity: (row.CITY || '').trim(),
        billingState: (row.STATE || '').trim(),
        billingCountry: (row.COUNTRY || '').trim()
      };

      if (!customer.email || !customer.email.includes('@')) {
        logger.debug(`Skipping NAME_ID ${row.NAME_ID} - no valid email`);
        continue;
      }

      const agentCategory = isAgentEmail(customer);
      if (agentCategory) {
        filtered.push({
          email: customer.email,
          firstName: customer.firstName,
          lastName: customer.lastName,
          operaId: customer.operaId,
          category: agentCategory
        });
        continue;
      }

      const invoice = (row.CHECK_IN || row.CHECK_OUT) ? {
        checkIn: formatDate(row.CHECK_IN),
        checkOut: formatDate(row.CHECK_OUT)
      } : null;

      records.push({ customer, invoice });
    }
  }

  if (filtered.length > 0) {
    logger.info(`Filtered ${filtered.length} agent/company emails`);
  }
  logger.info(`Transformed ${records.length} guest records for Salesforce`);

  return { records, filtered };
}

/**
 * Query guests modified since a given timestamp (for catch-up on startup)
 * @param {OracleClient} oracleClient - Connected Oracle client
 * @param {string|null} sinceTimestamp - ISO timestamp, or null for initial sync
 * @returns {Promise<{records: Array, filtered: Array}>}
 */
async function queryGuestsSince(oracleClient, sinceTimestamp) {
  let nameIds;

  if (sinceTimestamp) {
    const rows = await oracleClient.query(`
      SELECT DISTINCT NAME_ID FROM OPERA.NAME_PHONE
      WHERE PHONE_ROLE = 'EMAIL'
        AND (INSERT_DATE >= :since OR UPDATE_DATE >= :since)
    `, { since: new Date(sinceTimestamp) });
    nameIds = rows.map(r => r.NAME_ID);
    logger.info(`Found ${nameIds.length} guests modified since ${sinceTimestamp}`);
  } else {
    // Initial sync: get all guests with emails at VINES resort
    const rows = await oracleClient.query(`
      SELECT DISTINCT p.NAME_ID
      FROM OPERA.NAME_PHONE p
      JOIN OPERA.RESERVATION_NAME rn ON p.NAME_ID = rn.NAME_ID
      WHERE p.PHONE_ROLE = 'EMAIL'
        AND rn.RESORT = 'VINES'
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
