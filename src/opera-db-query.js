/**
 * Opera Database Query Module
 *
 * Queries the Oracle database for guest data by NAME_IDs,
 * joining NAME + NAME_PHONE + NAME_ADDRESS + RESERVATION_NAME.
 * Returns Salesforce-ready records in the same shape as parseOPERAFiles().
 */

const logger = require('./logger');
const { sanitizeEmail, isAgentEmail, mapLanguageToSalesforce } = require('./guest-utils');

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

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
      // Skip staff/company/owner emails entirely — not guests
      const rawEmail = (row.EMAIL || '').trim();
      const emailLower = rawEmail.toLowerCase();
      if (emailLower.endsWith('@vinesofmendoza.com') || emailLower.endsWith('@the-vines.com')
          || emailLower === 'mallmannfrancis@gmail.com') {
        continue;
      }

      // Sanitize email (fix typos, transliterate international chars)
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
        checkOut: formatDate(row.CHECK_OUT),
        resvStatus: row.RESV_STATUS || ''
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
        -- Guests checking in within the next 2 months or checking out today:
        -- may have been booked before last sync with no recent UPDATE_DATE
        SELECT NAME_ID FROM OPERA.RESERVATION_NAME
        WHERE RESORT = 'VINES'
          AND RESV_STATUS IN ('RESERVED','CHECKED IN','CHECKED OUT')
          AND (TRUNC(BEGIN_DATE) BETWEEN TRUNC(SYSDATE) AND ADD_MONTHS(TRUNC(SYSDATE), 2)
               OR TRUNC(END_DATE) = TRUNC(SYSDATE))
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

/**
 * Check if a name looks like an Opera house/internal account rather than a real guest.
 * Catches payment methods, departments, internal postings, etc.
 */
function isHouseAccount(firstName, lastName) {
  const fn = (firstName || '').trim();
  const ln = (lastName || '').trim();

  // Empty or placeholder first names
  if (!fn || fn === '.' || fn.toUpperCase() === 'TBC') return true;

  // Single-character first names (e.g., "a", "E", "0")
  if (fn.length === 1) return true;

  // First name starts with a digit (e.g., "2025 VINESAPALOOZA", "0 MASTERCARD")
  if (/^\d/.test(fn)) return true;

  // First name is "PM" (payment method entries like "PM DINERS", "PM VISA CREDITO")
  if (fn.toUpperCase() === 'PM') return true;

  // First and last name are the same (doubled entries like "Maestro MAESTRO", "Oriunda Oriunda")
  if (fn.toUpperCase() === ln.toUpperCase()) return true;

  // Known internal keywords in full name
  const fullName = `${fn} ${ln}`.toUpperCase();
  const internalKeywords = [
    'RESTAURANT', 'CORPORATE', 'CORPORATIVO', 'INTERFACE', 'FINANZAS',
    'DINERS', 'EFECTIVO', 'INCLUSIONES', 'LEGALES', 'MASTERCARD',
    'VISA CREDITO', 'VINESAPALOOZA', 'FOUNDATION VINES', 'BODEGA THE VINES',
    'CLIENT SERVICES', 'CONSUMIDOR', 'CUENTAS CORRIENTES', 'EXPANSION',
    'COMPLAINTS', 'PUBLIC RELATIONS', 'PV SALES', 'RECURSOS',
    'SALES & PROMOTION', 'WINE EDUCATION', 'LOST POSTING',
    'THE VINES CORPORATE', 'DESAYUNOS', 'INTERNOS',
  ];
  for (const kw of internalKeywords) {
    if (fullName.includes(kw)) return true;
  }

  return false;
}

/**
 * Discover available columns on RESERVATION_NAME (logged, non-blocking)
 * @param {OracleClient} oracleClient
 * @returns {Promise<string[]>} Column names
 */
async function discoverReservationColumns(oracleClient) {
  const tables = ['RESERVATION_NAME', 'RESERVATION_DAILY_ELEMENTS', 'RESERVATION_DAILY_ELEMENT_NAME'];
  const results = [];
  for (const table of tables) {
    try {
      const rows = await oracleClient.query(`
        SELECT column_name FROM all_tab_columns
        WHERE owner = 'OPERA' AND table_name = :tableName
        ORDER BY column_id
      `, { tableName: table });
      const cols = rows.map(r => r.COLUMN_NAME);
      console.log(`\n${table} (${cols.length} columns):`);
      cols.forEach(c => console.log(`  ${c}`));
      results.push(...cols.map(c => `${table}.${c}`));
    } catch (err) {
      console.log(`\n${table}: query failed — ${err.message}`);
    }
  }
  return results;
}

/**
 * Query all guests with active reservations overlapping a target date
 * for the comprehensive daily front desk report.
 *
 * @param {OracleClient} oracleClient - Connected Oracle client
 * @param {string} dateStr - Target date as YYYY-MM-DD (default: today Argentina time)
 * @returns {Promise<Object>} Report data with sections: badEmails, inHouse, departures, arrivalsToday, arrivalsTomorrow
 */
async function queryFrontDeskReport(oracleClient, dateStr) {
  if (!dateStr) {
    dateStr = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })).toISOString().slice(0, 10);
  }

  // Compute tomorrow as a plain string — no Date objects, no timezone issues
  const [y, m, d] = dateStr.split('-').map(Number);
  const tmp = new Date(y, m - 1, d + 1); // local date math
  const tomorrowStr = `${tmp.getFullYear()}-${String(tmp.getMonth() + 1).padStart(2, '0')}-${String(tmp.getDate()).padStart(2, '0')}`;

  logger.info(`Front desk report: querying guests for ${dateStr} (tomorrow: ${tomorrowStr})`);

  // Oracle returns dates as YYYY-MM-DD strings via TO_CHAR — no JS Date timezone issues
  // Join through RESERVATION_DAILY_ELEMENT_NAME → RESERVATION_DAILY_ELEMENTS to get Room + Adults/Children
  // Join NAME_COMMENT for guest preferences, RESERVATION_COMMENT for reservation notes
  const rows = await oracleClient.query(`
    SELECT n.NAME_ID, n.FIRST, n.LAST, n.LANGUAGE,
           p.PHONE_NUMBER AS EMAIL,
           a.COUNTRY,
           TO_CHAR(TRUNC(rn.BEGIN_DATE), 'YYYY-MM-DD') AS CHECK_IN,
           TO_CHAR(TRUNC(rn.END_DATE), 'YYYY-MM-DD') AS CHECK_OUT,
           daily.ROOM,
           daily.ADULTS,
           daily.CHILDREN,
           TO_CHAR(rn.ARRIVAL_ESTIMATE_TIME, 'HH24:MI') AS ETA,
           prefs.NOTES AS PREF_NOTES,
           resv_notes.NOTES AS RESV_NOTES
    FROM OPERA.RESERVATION_NAME rn
    JOIN OPERA.NAME n ON rn.NAME_ID = n.NAME_ID
      AND n.NAME_TYPE = 'D'
    LEFT JOIN OPERA.NAME_PHONE p ON rn.NAME_ID = p.NAME_ID
      AND p.PHONE_ROLE = 'EMAIL' AND p.PRIMARY_YN = 'Y'
    LEFT JOIN OPERA.NAME_ADDRESS a ON n.NAME_ID = a.NAME_ID
      AND a.PRIMARY_YN = 'Y' AND a.INACTIVE_DATE IS NULL
    LEFT JOIN (
      SELECT rden.RESV_NAME_ID, rde.ROOM, rden.ADULTS, rden.CHILDREN,
             ROW_NUMBER() OVER (PARTITION BY rden.RESV_NAME_ID ORDER BY rden.RESERVATION_DATE) AS rn
      FROM OPERA.RESERVATION_DAILY_ELEMENT_NAME rden
      JOIN OPERA.RESERVATION_DAILY_ELEMENTS rde
        ON rden.RESORT = rde.RESORT
        AND rden.RESERVATION_DATE = rde.RESERVATION_DATE
        AND rden.RESV_DAILY_EL_SEQ = rde.RESV_DAILY_EL_SEQ
      WHERE rden.RESORT = 'VINES'
        AND rden.RESERVATION_DATE BETWEEN TO_DATE(:dateStr, 'YYYY-MM-DD') AND TO_DATE(:tomorrowStr, 'YYYY-MM-DD')
    ) daily ON rn.RESV_NAME_ID = daily.RESV_NAME_ID AND daily.rn = 1
    LEFT JOIN (
      SELECT NAME_ID,
             LISTAGG(COMMENTS, ' | ') WITHIN GROUP (ORDER BY LINE_NO) AS NOTES
      FROM OPERA.NAME_COMMENT
      WHERE COMMENT_TYPE = 'Preferencias'
        AND INACTIVE_DATE IS NULL
      GROUP BY NAME_ID
    ) prefs ON n.NAME_ID = prefs.NAME_ID
    LEFT JOIN (
      SELECT RESV_NAME_ID,
             LISTAGG(COMMENTS, ' | ') WITHIN GROUP (ORDER BY INSERT_DATE) AS NOTES
      FROM OPERA.RESERVATION_COMMENT
      WHERE COMMENT_TYPE = 'RESERVATION'
        AND RESORT = 'VINES'
      GROUP BY RESV_NAME_ID
    ) resv_notes ON rn.RESV_NAME_ID = resv_notes.RESV_NAME_ID
    WHERE rn.RESORT = 'VINES'
      AND rn.RESV_STATUS != 'CANCELLED'
      AND TRUNC(rn.BEGIN_DATE) <= TO_DATE(:tomorrowStr, 'YYYY-MM-DD')
      AND TRUNC(rn.END_DATE) >= TO_DATE(:dateStr, 'YYYY-MM-DD')
  `, { dateStr, tomorrowStr });

  logger.info(`Front desk report: ${rows.length} raw reservation rows returned`);

  // Build guest objects and categorize
  const badEmails = [];
  const inHouse = [];
  const departures = [];
  const arrivalsToday = [];
  const arrivalsTomorrow = [];

  for (const row of rows) {
    const rawEmail = (row.EMAIL || '').trim();
    const emailLower = rawEmail.toLowerCase();

    // Note: do NOT skip internal staff emails here — they may be real guests
    // (e.g., Bryan Driscoll uses a @vinesofmendoza.com email but is a guest).
    // The internal email filter only applies to the SF sync pipeline.

    const firstName = (row.FIRST || '').trim();
    const lastName = (row.LAST || '').trim();

    // Skip house accounts (payment methods, departments, internal postings)
    if (isHouseAccount(firstName, lastName)) {
      continue;
    }

    const checkInDate = row.CHECK_IN || '';
    const checkOutDate = row.CHECK_OUT || '';

    const villa = (row.ROOM || '').trim() || null;
    const adults = row.ADULTS != null ? Number(row.ADULTS) : null;
    const children = row.CHILDREN != null ? Number(row.CHILDREN) : null;

    // Skip entries without villa/PRS (secondary names on shared reservations)
    if (!villa && adults == null) continue;

    const guest = {
      firstName,
      lastName,
      email: rawEmail,
      country: (() => { const code = (row.COUNTRY || '').trim(); try { return code ? countryNames.of(code) || code : ''; } catch { return code; } })(),
      language: mapLanguageToSalesforce(row.LANGUAGE),
      villa,
      adults: adults || 0,
      children: children || 0,
      prs: adults != null ? `${adults}/${children || 0}` : null,
      checkIn: checkInDate,
      checkOut: checkOutDate,
      eta: (row.ETA || '').trim() || null,
      notes: [row.PREF_NOTES, row.RESV_NOTES].filter(Boolean).map(s => s.trim()).join(' | ') || null
    };

    // Check for bad/agent email
    const cleanedEmail = sanitizeEmail(rawEmail);
    let badReason = null;
    if (!cleanedEmail) {
      badReason = rawEmail ? 'invalid-email' : 'no-email';
    } else {
      const agentCat = isAgentEmail({ email: cleanedEmail, firstName });
      if (agentCat) badReason = agentCat;
    }

    // Categorize by date (plain string comparison — YYYY-MM-DD sorts lexicographically)
    const isCheckInToday = checkInDate === dateStr;
    const isCheckInTomorrow = checkInDate === tomorrowStr;
    const isCheckOutToday = checkOutDate === dateStr;
    const isInHouse = checkInDate < dateStr && checkOutDate > dateStr;
    const isOnProperty = checkInDate <= dateStr && checkOutDate >= dateStr;

    if (badReason && isOnProperty) {
      badEmails.push({ ...guest, reason: badReason });
    }

    if (isCheckOutToday) {
      departures.push({ ...guest, reason: badReason || undefined });
    } else if (isCheckInToday) {
      arrivalsToday.push({ ...guest, reason: badReason || undefined });
    } else if (isCheckInTomorrow) {
      arrivalsTomorrow.push({ ...guest, reason: badReason || undefined });
    } else if (isInHouse) {
      inHouse.push({ ...guest, reason: badReason || undefined });
    }
  }

  // Sort each section by last name
  const byName = (a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName);
  badEmails.sort(byName);
  inHouse.sort(byName);
  departures.sort(byName);
  arrivalsToday.sort(byName);
  arrivalsTomorrow.sort(byName);

  const report = {
    date: dateStr,
    badEmails,
    inHouse,
    departures,
    arrivalsToday,
    arrivalsTomorrow
  };

  logger.info(`Front desk report: ${badEmails.length} bad emails, ${inHouse.length} in-house, ${departures.length} departures, ${arrivalsToday.length} arrivals today, ${arrivalsTomorrow.length} arrivals tomorrow`);

  return report;
}

module.exports = {
  queryGuestsByIds,
  queryGuestsSince,
  queryFrontDeskReport,
  discoverReservationColumns,
  formatDate
};
