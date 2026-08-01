/**
 * Opera Database Query Module
 *
 * Queries the Oracle database for guest data by NAME_IDs,
 * joining NAME + NAME_PHONE + NAME_ADDRESS + RESERVATION_NAME.
 * Returns Salesforce-ready records in the same shape as parseOPERAFiles().
 */

const logger = require('./logger');
const villaMap = require('./villa-map');
const { sanitizeEmail, emailInvalidReason, isAgentEmail, isRoleMailbox, mapLanguageToSalesforce, verifyEmailsSMTP, parseExcludedGuestNames, isExcludedGuest } = require('./guest-utils');
const { expandCountry } = require('./country-names');

// Internal/excluded email domains and addresses — these are skipped during sync
const EXCLUDED_DOMAINS = (process.env.EXCLUDED_EMAIL_DOMAINS || '')
  .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
const EXCLUDED_EMAILS = (process.env.EXCLUDED_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Room prefixes to exclude (e.g. Posting Masters: "PM")
const EXCLUDED_ROOM_PREFIXES = (process.env.EXCLUDED_ROOM_PREFIXES || 'PM')
  .split(',').map(p => p.trim().toUpperCase()).filter(Boolean);

// Posting Masters also appear as numeric "villas" in the 9000s (e.g. 9041).
// They are charge-tracking accounts, not real guest stays — no email needed.
function isPostingMasterVilla(villa) {
  if (!villa) return false;
  return /^9\d{3}$/.test(String(villa).trim());
}

// A reservation can also sit on a Posting Master with NO room number at all
// (e.g. group members parked on a PM block before rooming) — there the pseudo
// room CATEGORY ("PM") is the only tell. Exact match against the excluded
// prefixes: categories are codes, not numbered rooms like "PM01".
function isPostingMasterStay(villa, roomCategory) {
  if (isPostingMasterVilla(villa)) return true;
  if (villa && EXCLUDED_ROOM_PREFIXES.some(p => String(villa).trim().toUpperCase().startsWith(p))) return true;
  if (roomCategory && EXCLUDED_ROOM_PREFIXES.includes(String(roomCategory).trim().toUpperCase())) return true;
  return false;
}

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
async function queryGuestsByIds(oracleClient, nameIds, { skipSmtpVerify = false } = {}) {
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
             rn.CHECK_IN, rn.CHECK_OUT, rn.RESV_STATUS, rn.ROOM
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
        SELECT rnx.NAME_ID, rnx.BEGIN_DATE AS CHECK_IN, rnx.END_DATE AS CHECK_OUT,
               rnx.RESV_STATUS, rm.ROOM,
               ROW_NUMBER() OVER (PARTITION BY rnx.NAME_ID ORDER BY rnx.BEGIN_DATE DESC) AS rn
        FROM OPERA.RESERVATION_NAME rnx
        LEFT JOIN (
          SELECT rden.RESV_NAME_ID, rde.ROOM,
                 ROW_NUMBER() OVER (PARTITION BY rden.RESV_NAME_ID ORDER BY rden.RESERVATION_DATE) AS rn
          FROM OPERA.RESERVATION_DAILY_ELEMENT_NAME rden
          JOIN OPERA.RESERVATION_DAILY_ELEMENTS rde
            ON rden.RESORT = rde.RESORT
            AND rden.RESERVATION_DATE = rde.RESERVATION_DATE
            AND rden.RESV_DAILY_EL_SEQ = rde.RESV_DAILY_EL_SEQ
          WHERE rden.RESORT = 'VINES'
        ) rm ON rnx.RESV_NAME_ID = rm.RESV_NAME_ID AND rm.rn = 1
        WHERE rnx.RESORT = 'VINES'
          AND rnx.RESV_STATUS IN ('RESERVED','CHECKED IN','CHECKED OUT')
          AND rnx.BEGIN_DATE <= ADD_MONTHS(TRUNC(SYSDATE), 2)
      ) rn ON n.NAME_ID = rn.NAME_ID AND rn.rn = 1
      WHERE n.NAME_ID IN (${placeholders.join(',')})
    `, binds);

    for (const row of rows) {
      // Skip Posting Master rooms (e.g. "PM01") — not real guest rooms
      const room = (row.ROOM || '').trim().toUpperCase();
      if (room && EXCLUDED_ROOM_PREFIXES.some(p => room.startsWith(p))) {
        continue;
      }

      // Skip staff/company/owner emails entirely — not guests
      const rawEmail = (row.EMAIL || '').trim();
      const emailLower = rawEmail.toLowerCase();
      if (EXCLUDED_EMAILS.includes(emailLower)
          || EXCLUDED_DOMAINS.some(d => emailLower.endsWith(`@${d}`))) {
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
            reason: emailInvalidReason(rawEmail) || 'invalid-email',
            checkIn: checkInStr,
            checkOut: checkOutStr,
            resvStatus: row.RESV_STATUS || ''
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
      // 'missing-first-name' is a soft signal: surface it for review but let
      // the record continue to SF sync. Other categories are hard non-guest
      // records and get skipped from sync entirely.
      if (agentCategory && agentCategory !== 'missing-first-name') {
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
          checkOut: checkOutStr,
          resvStatus: row.RESV_STATUS || ''
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

  // SMTP mailbox verification — catch invalid addresses before they hit Salesforce/Pardot
  // Skipped on initial sync (thousands of emails would timeout/get rate-limited)
  if (records.length > 0 && !skipSmtpVerify && process.env.SMTP_VERIFY !== 'false') {
    const emails = [...new Set(records.map(r => r.customer.email))];
    logger.info(`Verifying ${emails.length} email(s) via SMTP...`);
    try {
      const smtpResults = await verifyEmailsSMTP(emails);
      const invalidEmails = new Set();
      for (const [email, status] of smtpResults) {
        if (status === 'invalid') {
          invalidEmails.add(email);
          logger.warn(`SMTP rejected: ${email} — mailbox does not exist`);
        }
      }
      if (invalidEmails.size > 0) {
        // Move invalid-mailbox records to frontDesk for manual review
        const kept = [];
        for (const entry of records) {
          if (invalidEmails.has(entry.customer.email)) {
            frontDesk.push({
              email: entry.customer.email,
              firstName: entry.customer.firstName,
              lastName: entry.customer.lastName,
              operaId: entry.customer.operaId,
              reason: 'invalid-mailbox',
              checkIn: entry.invoice ? entry.invoice.checkIn : '',
              checkOut: entry.invoice ? entry.invoice.checkOut : ''
            });
          } else {
            kept.push(entry);
          }
        }
        logger.info(`SMTP verification: ${invalidEmails.size} invalid mailbox(es) moved to front desk review`);
        records.length = 0;
        records.push(...kept);
      }
    } catch (err) {
      // Fail open — don't block sync if SMTP verification has issues
      logger.warn(`SMTP verification failed (proceeding without): ${err.message}`);
    }
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

  return queryGuestsByIds(oracleClient, nameIds, { skipSmtpVerify: !sinceTimestamp });
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
 * Discover the distinct profile note codes in use (NAME$NOTES.NOTE_CODE) with
 * counts and a sample, so the property's real codes can be mapped to the
 * front-desk note categories (FRONT_DESK_NOTE_CODES). Console-logged; non-fatal.
 */
async function discoverNoteCodes(oracleClient) {
  console.log('\n=== Profile note codes (NAME$NOTES) ===');
  const oracledb = require('oracledb');
  if (!oracledb.fetchAsString.includes(oracledb.CLOB)) oracledb.fetchAsString.push(oracledb.CLOB);
  try {
    const rows = await oracleClient.query(`
      SELECT NOTE_CODE, COUNT(*) AS CNT, MAX(SUBSTR(NOTES, 1, 60)) AS SAMPLE
      FROM OPERA."NAME$NOTES"
      WHERE INACTIVE_DATE IS NULL
      GROUP BY NOTE_CODE
      ORDER BY CNT DESC
    `);
    for (const r of rows) {
      console.log(`  ${String(r.NOTE_CODE || '(null)').padEnd(20)} ${String(r.CNT).padStart(7)}   e.g. ${(r.SAMPLE || '').replace(/\s+/g, ' ').trim()}`);
    }
    console.log(`\n  ${rows.length} distinct note codes`);
    return rows;
  } catch (err) {
    console.log(`  query failed — ${err.message}`);
    return [];
  }
}

/**
 * Discover the shapes behind the data-quality fields (DOB / phone / passport):
 * NAME columns mentioning birth/passport, the NAME_PHONE roles in use, and any
 * candidate document tables. Console-logged; non-fatal. Use this to confirm or
 * correct fetchGuestCompleteness for this property's OPERA config.
 */
async function discoverGuestFieldShapes(oracleClient) {
  const probes = [
    {
      title: 'NAME columns mentioning BIRTH / PASSPORT / DOC / ID',
      sql: `SELECT column_name, data_type FROM all_tab_columns
            WHERE owner = 'OPERA' AND table_name = 'NAME'
              AND (column_name LIKE '%BIRTH%' OR column_name LIKE '%PASSPORT%'
                   OR column_name LIKE '%DOC%' OR column_name LIKE '%ID%')
            ORDER BY column_name`,
      fmt: r => `  ${r.COLUMN_NAME} (${r.DATA_TYPE})`,
    },
    {
      title: 'NAME_PHONE roles in use',
      sql: `SELECT PHONE_ROLE, COUNT(*) AS CNT FROM OPERA.NAME_PHONE
            GROUP BY PHONE_ROLE ORDER BY CNT DESC`,
      fmt: r => `  ${String(r.PHONE_ROLE || '(null)').padEnd(16)} ${r.CNT}`,
    },
    {
      title: 'Candidate document tables (OPERA tables with DOC in the name)',
      sql: `SELECT table_name FROM all_tables
            WHERE owner = 'OPERA' AND table_name LIKE '%DOC%' ORDER BY table_name`,
      fmt: r => `  ${r.TABLE_NAME}`,
    },
    {
      title: 'NAME_DOCUMENTS ID_TYPE values (if the table exists)',
      sql: `SELECT ID_TYPE, COUNT(*) AS CNT FROM OPERA.NAME_DOCUMENTS
            GROUP BY ID_TYPE ORDER BY CNT DESC`,
      fmt: r => `  ${String(r.ID_TYPE || '(null)').padEnd(16)} ${r.CNT}`,
    },
  ];
  for (const p of probes) {
    console.log(`\n=== ${p.title} ===`);
    try {
      const rows = await oracleClient.query(p.sql);
      if (rows.length === 0) console.log('  (no rows)');
      else rows.forEach(r => console.log(p.fmt(r)));
    } catch (err) {
      console.log(`  query failed — ${err.message}`);
    }
  }
}

// Grace buffer (days) applied on each side of the stay window / today before a
// dated note chunk is dropped — the leading dates are hand-typed and imprecise.
const NOTE_DATE_BUFFER_DAYS = 7;

// Cap on the merged notes string per guest in the front-desk report. The notes
// column aggregates several OPERA sources and used to render as a wall of text;
// front desk asked to trim the bloat. Beyond this many characters we truncate
// with an ellipsis (on a piece boundary when possible).
const MAX_NOTES_LEN = 300;

/**
 * Tidy a merged notes string for the front-desk report: drop empty/duplicate
 * pieces (the same line often shows up across several OPERA sources) and cap
 * the total length. Pieces are the ` | `-joined segments produced upstream;
 * source tags like "[PREF]" are preserved. Dedup is case-insensitive on the
 * trimmed text (tag included) and keeps first occurrence / original order.
 */
function tidyNotes(notes) {
  if (!notes) return null;
  const seen = new Set();
  const pieces = [];
  for (const raw of notes.split(' | ')) {
    const piece = raw.trim();
    if (!piece) continue;
    const key = piece.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pieces.push(piece);
  }
  if (pieces.length === 0) return null;

  // Add pieces until the next one would overflow the cap; truncate cleanly on a
  // piece boundary. If even the first piece overflows, hard-cut it.
  let out = '';
  for (const piece of pieces) {
    const candidate = out ? `${out} | ${piece}` : piece;
    if (candidate.length > MAX_NOTES_LEN) {
      if (!out) out = piece.slice(0, MAX_NOTES_LEN - 1).trimEnd();
      out += '…';
      return out;
    }
    out = candidate;
  }
  return out;
}

// Estimated arrival/departure times at The Vines are never entered into OPERA's
// structured fields (ARRIVAL_ESTIMATE_TIME et al. are all empty). When known at
// all, they live as free text inside reservation comments — flight itineraries
// ("landing ... at 3:15pm"), check-in requests ("check-in ... 13:00 - 14:00"),
// pickup notes ("pick up para irse ... a las 7am"). The functions below make a
// best-effort scrape of those, keyword-anchored so we don't grab activity times
// or prices. Bilingual (es/en/pt) since front-desk staff mix languages.
//
// This is deliberately conservative: it returns a time ONLY when one sits next
// to an arrival/departure keyword. Missing a time is preferred to guessing wrong.

const ARRIVAL_KEYWORDS = /\b(lleg\w*|arrib\w*|aterriz\w*|landing|arrival|arriving|check.?in|eta)\b/gi;
const DEPARTURE_KEYWORDS = /\b(salid\w*|sa[ií]d\w*|partir\w*|partir[aá]\w*|irse|regreso|check.?out|departure|departing|pick.?up)\b/gi;

// Normalize a parsed clock time to 24h "HH:MM", or null if out of range.
function normalizeClockTime(hh, mm, ampm) {
  let h = parseInt(hh, 10);
  const m = mm == null ? 0 : parseInt(mm, 10);
  if (Number.isNaN(h) || m > 59) return null;
  if (ampm) {
    const ap = ampm.replace(/[^apAP]/g, '').toLowerCase()[0];
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
  }
  if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Find every clock-time token in the text, returning {index, end, time}.
// Recognized: "13:00", "3:15pm", "19.30 hs", "11hs", "7am", "3:00 PM".
function findTimeTokens(text) {
  const tokens = [];
  // Group sets: (1)(2)(3) HH[:.]MM + opt am/pm ; (4)(5) H am/pm ; (6) H hs/hrs
  const re = /(\d{1,2})\s*[:.]\s*(\d{2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)?|(\d{1,2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)|(\d{1,2})\s*(?:hs|hrs)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    // Price guard: skip a token immediately preceded by a currency marker
    // ("USD 1.028", "U$ 1.350") — those read as bogus "01:02"/"01:35" times.
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    if (/(usd|u\$|ar\$|\$|€)\s*$/i.test(before)) continue;
    let time = null;
    if (m[1] != null) time = normalizeClockTime(m[1], m[2], m[3]);
    else if (m[4] != null) time = normalizeClockTime(m[4], 0, m[5]);
    else if (m[6] != null) time = normalizeClockTime(m[6], 0, null);
    if (time) tokens.push({ index: m.index, end: re.lastIndex, time });
  }
  return tokens;
}

/**
 * Best-effort extraction of an estimated arrival or departure time from free-text
 * reservation notes. Returns "HH:MM" (24h) or null.
 *
 * @param {string} text - raw reservation note text (RESERVATION/IN HOUSE/alerts)
 * @param {'arrival'|'departure'} kind
 */
function extractEstimatedTime(text, kind) {
  if (!text) return null;
  const tokens = findTimeTokens(text);
  if (tokens.length === 0) return null;

  const kw = kind === 'departure' ? DEPARTURE_KEYWORDS : ARRIVAL_KEYWORDS;
  kw.lastIndex = 0;
  let best = null;
  let bestDist = Infinity;
  let m;
  while ((m = kw.exec(text)) !== null) {
    const kwStart = m.index;
    const kwEnd = kw.lastIndex;
    for (const t of tokens) {
      let dist;
      if (t.index >= kwEnd && t.index - kwEnd <= 60) {
        dist = t.index - kwEnd;                 // time after keyword (preferred)
      } else if (kwStart >= t.end && kwStart - t.end <= 12) {
        dist = (kwStart - t.end) + 100;         // time just before keyword (penalized)
      } else {
        continue;
      }
      if (dist < bestDist) {
        bestDist = dist;
        best = t.time;
      }
    }
  }
  return best;
}

// Shift a YYYY-MM-DD date string by `days` (may be negative), returning YYYY-MM-DD.
function shiftIsoDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Three-letter month abbreviations, English + Spanish (the property is in
// Argentina, so staff mix both). Maps to a 1-based month number.
const MONTH_ABBR = {
  JAN: 1, ENE: 1, FEB: 2, MAR: 3, APR: 4, ABR: 4, MAY: 5, JUN: 6, JUL: 7,
  AUG: 8, AGO: 8, SEP: 9, SET: 9, OCT: 10, NOV: 11, DEC: 12, DIC: 12,
};

/**
 * Parse a date written at the very start of a free-text note line and return
 * it as a `YYYY-MM-DD` string, or null when the line does not begin with a
 * recognizable date.
 *
 * These dates are hand-typed by front-desk staff, so the parsing is permissive
 * about separators and spacing but still validates the day/month ranges so that
 * non-date text (room counts, pax, prices) isn't mistaken for a date boundary:
 *   - Numeric day-first, spaces allowed:  21/04/26, 21-04-2026, 21 / 04 / 26
 *   - Month-name day-first:               21FEB, 21 FEB 26, 21-FEB-2026
 *
 * Argentine/Oracle convention is day-first (DD-MM / DD-MON), so the first field
 * is always the day. When a month-name entry omits the year (e.g. "21FEB"), the
 * year defaults to `today`'s year — these are log entries staff expect to read
 * against the current year. A trailing clock time ("21FEB 09:38") is not
 * misread as a 2-digit year.
 */
function parseLeadingDate(line, today) {
  const s = String(line).replace(/^\s+/, '');
  const toIso = (year, mon, day) => {
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };

  // Numeric day-first: DD<sep>MM<sep>YY[YY], with optional spaces around seps.
  let m = s.match(/^(\d{1,2})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{2,4})\b/);
  if (m) {
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    return toIso(year, parseInt(m[2], 10), parseInt(m[1], 10));
  }

  // Month-name day-first: DD MON [YY|YYYY], e.g. "21FEB", "21 FEB 26".
  m = s.match(/^(\d{1,2})[-.\s]*([A-Za-z]{3})/);
  if (m) {
    const mon = MONTH_ABBR[m[2].toUpperCase()];
    if (!mon) return null; // three letters that aren't a month → not a date
    const day = parseInt(m[1], 10);
    // Optional trailing year: separators then 2-4 digits NOT followed by ":"
    // (which would make it a clock time, not a year).
    const ym = s.slice(m[0].length).match(/^[-.,\s]*(\d{2,4})(?!\s*:)\b/);
    let year;
    if (ym) {
      year = parseInt(ym[1], 10);
      if (year < 100) year += 2000;
    } else {
      year = today ? parseInt(today.slice(0, 4), 10) : new Date().getFullYear();
    }
    return toIso(year, mon, day);
  }

  return null;
}

/**
 * Drop dated entries that fall outside the [checkIn, checkOut] window.
 *
 * Profile-level notes (NAME$NOTES / NAME_COMMENT) accumulate over many years of
 * stays and often contain timestamped logs (incidents, welcome-amenity history)
 * tagged with leading dates. See parseLeadingDate for the recognized formats.
 *
 * Algorithm: split the note text into chunks where each chunk starts at a line
 * whose first token is a date. Lines without a leading date attach to the
 * preceding chunk (or to a leading "header" chunk if before any dated line).
 * Drop chunks whose date is outside the stay window; keep undated chunks.
 * When `today` is given, also drop dated chunks whose date has already passed
 * (before today), even if they fall within the current stay window.
 *
 * Reservation-scoped sources are not passed through this — they apply by
 * definition to the current stay regardless of any dates in their text.
 */
function filterNoteByStayWindow(labeledNote, checkIn, checkOut, today) {
  if (!labeledNote || !checkIn || !checkOut) return labeledNote || null;

  const labelMatch = labeledNote.match(/^(\[[^\]]+\]\s*)/);
  const prefix = labelMatch ? labelMatch[0] : '';
  const content = labeledNote.slice(prefix.length);

  const lines = content.split('\n');
  const chunks = [];
  let current = { date: null, lines: [] };

  for (const line of lines) {
    const date = parseLeadingDate(line, today);
    if (date) {
      if (current.lines.length > 0 || current.date) chunks.push(current);
      current = { date, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0 || current.date) chunks.push(current);

  // Because the leading dates are hand-typed (typos, off-by-a-day, loose
  // notions of which stay a note belongs to), widen every boundary by a
  // one-week grace buffer before omitting a chunk.
  const lo = shiftIsoDate(checkIn, -NOTE_DATE_BUFFER_DAYS);
  const hi = shiftIsoDate(checkOut, NOTE_DATE_BUFFER_DAYS);
  const cutoff = today ? shiftIsoDate(today, -NOTE_DATE_BUFFER_DAYS) : null;

  const kept = chunks.filter(c => {
    if (!c.date) return true;
    if (c.date < lo || c.date > hi) return false;
    // Omit entries that passed more than a week ago, even though they fall
    // within the (buffered) stay window.
    if (cutoff && c.date < cutoff) return false;
    return true;
  });

  if (kept.length === 0) return null;
  const filtered = kept.map(c => c.lines.join('\n')).join('\n').trim();
  return filtered ? prefix + filtered : null;
}

// Profile note codes (NAME$NOTES.NOTE_CODE) surfaced in the front-desk report's
// Notes column. The desk wants only these three OPERA note categories; every
// other code is omitted simply by being absent from this list — which keeps out
// both INCONV (incident logs, "notes-column bloat") and, importantly, CCARDINF
// ("Credit Card Information", raw card numbers) that must never reach an email.
// Codes verified against OPERA NOTE$TYPES.DESCRIPTION on 2026-06-22:
//   HISTORY → "PVO Information"
//   PALBE   → "Preferencias Alimentos y Bebidas"
//   PREF    → "Preferencias"
const FRONT_DESK_NOTE_CODES = ['HISTORY', 'PALBE', 'PREF'];

/**
 * Fetch guest notes from the OPERA sources the front desk cares about, grouped
 * by NAME_ID and RESV_NAME_ID.
 *
 * Sources:
 *   1. NAME$NOTES (NOTE_CODE in FRONT_DESK_NOTE_CODES) — profile-level notes,
 *      restricted to the desk's categories: HISTORY (PVO Information), PALBE
 *      (Preferencias Alimentos y Bebidas), PREF (Preferencias).
 *   2. RESERVATION_COMMENT (RESERVATION/IN HOUSE) — per-reservation comments
 *   3. RESERVATION_ALERTS                          — per-reservation action alerts
 *   4. RESERVATION_COMMENT (CASHIER)               — billing comments, returned in a
 *      separate map so callers can surface them only for departures/arrivals.
 *
 * NAME_COMMENT (PROF preferences) is deliberately excluded — it duplicates the
 * PREF notes. CASHIER comments are returned separately (cashierByResvId) rather
 * than merged, because they are only actionable at check-in/check-out.
 *
 * Each note is labeled with a short tag (e.g. "[PREF]", "[IN HOUSE]", "[CASHIER]")
 * so the front desk can tell sources apart when they're merged into a single notes string.
 */
async function fetchGuestNotes(oracleClient, nameIds, resvIds) {
  const notesByNameId = new Map();
  const notesByResvId = new Map();
  const cashierByResvId = new Map();
  const push = (map, key, label, text) => {
    if (!text) return;
    const trimmed = String(text).trim();
    if (!trimmed) return;
    const arr = map.get(key) || [];
    arr.push(label ? `[${label}] ${trimmed}` : trimmed);
    map.set(key, arr);
  };

  if (nameIds.length > 0) {
    const binds = Object.fromEntries(nameIds.map((id, i) => [`n${i}`, id]));
    const holders = nameIds.map((_, i) => `:n${i}`).join(',');

    // Keep only the front-desk note categories (FRONT_DESK_NOTE_CODES allow-list).
    const ph = FRONT_DESK_NOTE_CODES.map((_, i) => `:ac${i}`).join(',');
    FRONT_DESK_NOTE_CODES.forEach((c, i) => { binds[`ac${i}`] = c; });
    const codeFilter = ` AND UPPER(NOTE_CODE) IN (${ph})`;

    // NAME$NOTES — free-form profile notes (PREF allergies, GUESTPROF, etc.)
    // NOTES is a CLOB — set fetchAsString globally so we get a JS string back.
    const oracledb = require('oracledb');
    if (!oracledb.fetchAsString.includes(oracledb.CLOB)) oracledb.fetchAsString.push(oracledb.CLOB);
    const nn = await oracleClient.query(`
      SELECT NAME_ID, NOTE_CODE, NOTES
      FROM OPERA."NAME$NOTES"
      WHERE NAME_ID IN (${holders})
        AND INACTIVE_DATE IS NULL${codeFilter}
      ORDER BY NAME_ID, INSERT_DATE
    `, binds);
    for (const r of nn) push(notesByNameId, r.NAME_ID, r.NOTE_CODE || 'Note', r.NOTES);
  }

  if (resvIds.length > 0) {
    const binds = Object.fromEntries(resvIds.map((id, i) => [`r${i}`, id]));
    const holders = resvIds.map((_, i) => `:r${i}`).join(',');

    // RESERVATION_COMMENT — guest-facing reservation comments plus CASHIER
    // (billing). CASHIER is split into its own map so it can be shown only for
    // departures/arrivals, where settlement/payment detail is actionable.
    const rc = await oracleClient.query(`
      SELECT RESV_NAME_ID, COMMENT_TYPE, COMMENTS, INSERT_DATE
      FROM OPERA.RESERVATION_COMMENT
      WHERE RESV_NAME_ID IN (${holders})
        AND RESORT = 'VINES'
        AND COMMENT_TYPE IN ('RESERVATION', 'IN HOUSE', 'CASHIER')
      ORDER BY RESV_NAME_ID, INSERT_DATE
    `, binds);
    for (const r of rc) {
      if (r.COMMENT_TYPE === 'CASHIER') push(cashierByResvId, r.RESV_NAME_ID, 'CASHIER', r.COMMENTS);
      else push(notesByResvId, r.RESV_NAME_ID, r.COMMENT_TYPE, r.COMMENTS);
    }

    // RESERVATION_ALERTS — front-desk action alerts (Check-In/Check-Out/etc.)
    const ra = await oracleClient.query(`
      SELECT RESV_NAME_ID, AREA, DESCRIPTION
      FROM OPERA.RESERVATION_ALERTS
      WHERE RESV_NAME_ID IN (${holders})
        AND RESORT = 'VINES'
      ORDER BY RESV_NAME_ID, INSERT_DATE
    `, binds);
    for (const r of ra) push(notesByResvId, r.RESV_NAME_ID, `Alert ${r.AREA || ''}`.trim(), r.DESCRIPTION);
  }

  return { notesByNameId, notesByResvId, cashierByResvId };
}

/**
 * Best-effort completeness lookup for the data-quality report: which guests have
 * a date of birth, a phone number, and a passport on their OPERA profile.
 *
 * OPERA stores DOB and document numbers ENCRYPTED, so we can only verify that a
 * value is present, not read it. Two property-specific facts (verified against
 * the live DB 2026-06-22) drive the queries below:
 *   - DOB lives in NAME.BIRTH_DATE_STR (encrypted); the plain NAME.BIRTH_DATE
 *     column is never populated here. Presence of BIRTH_DATE_STR = DOB on file.
 *   - Passport type codes were renumbered in Oct 2024 (old 'PAS' retired to
 *     "NO USAR", new '94' = "Pasaporte"), so passport types are resolved from
 *     DOCUMENT_TYPES by role/description rather than a fixed ID_TYPE pattern.
 *
 * Each source is queried independently and fails open — if a table/column name
 * is wrong for this property's OPERA config the lookup is simply marked
 * unchecked, so the report never flags a field it could not actually verify
 * (and the rest of the front-desk report is unaffected). Confirm the real
 * shapes with `dry-run-front-desk-report --discover`.
 *
 * @returns {Promise<{dobNameIds: Set, phoneNameIds: Set, passportNameIds: Set,
 *                     dobChecked: boolean, phoneChecked: boolean, passportChecked: boolean}>}
 */
async function fetchGuestCompleteness(oracleClient, nameIds) {
  const out = {
    dobNameIds: new Set(),
    phoneNameIds: new Set(),
    passportNameIds: new Set(),
    dobChecked: false,
    phoneChecked: false,
    passportChecked: false,
  };
  if (!nameIds.length) return out;

  const binds = Object.fromEntries(nameIds.map((id, i) => [`n${i}`, id]));
  const holders = nameIds.map((_, i) => `:n${i}`).join(',');

  // Date of birth — OPERA encrypts it into NAME.BIRTH_DATE_STR and leaves the
  // structured NAME.BIRTH_DATE empty (verified: 0 of ~50k D-profiles populate
  // BIRTH_DATE). We can't decrypt it, but a non-null value in either column
  // means a DOB is on file, which is all the data-quality report needs.
  try {
    const rows = await oracleClient.query(`
      SELECT NAME_ID
      FROM OPERA.NAME
      WHERE NAME_ID IN (${holders})
        AND (BIRTH_DATE IS NOT NULL OR BIRTH_DATE_STR IS NOT NULL)
    `, binds);
    for (const r of rows) out.dobNameIds.add(r.NAME_ID);
    out.dobChecked = true;
  } catch (err) {
    logger.warn(`Completeness: DOB lookup failed, skipping DOB flag — ${err.message}`);
  }

  // Phone — any NAME_PHONE role other than EMAIL/FAX (email lives in NAME_PHONE
  // under PHONE_ROLE='EMAIL' at this property, so it must be excluded here).
  try {
    const rows = await oracleClient.query(`
      SELECT DISTINCT NAME_ID
      FROM OPERA.NAME_PHONE
      WHERE NAME_ID IN (${holders})
        AND PHONE_NUMBER IS NOT NULL
        AND PHONE_ROLE NOT IN ('EMAIL', 'FAX')
    `, binds);
    for (const r of rows) out.phoneNameIds.add(r.NAME_ID);
    out.phoneChecked = true;
  } catch (err) {
    logger.warn(`Completeness: phone lookup failed, skipping Phone flag — ${err.message}`);
  }

  // Passport — NAME_DOCUMENTS rows keyed by a property-specific ID_TYPE code.
  // The codes were renumbered in Oct 2024 (old 'PAS' -> "NO USAR", new '94' =
  // "Pasaporte"), so resolve the passport type codes dynamically from
  // DOCUMENT_TYPES (by PASSPORT role or a Pasaporte/Passport description)
  // instead of a fixed ID_TYPE pattern. A non-null ID_NUMBER of such a type
  // means a passport is on file (the number itself is encrypted).
  try {
    const rows = await oracleClient.query(`
      SELECT DISTINCT d.NAME_ID
      FROM OPERA.NAME_DOCUMENTS d
      WHERE d.NAME_ID IN (${holders})
        AND d.ID_NUMBER IS NOT NULL
        AND UPPER(d.ID_TYPE) IN (
          SELECT UPPER(DOCUMENT_TYPE) FROM OPERA.DOCUMENT_TYPES
          WHERE UPPER(DOCUMENT_ROLE) = 'PASSPORT'
             OR UPPER(DESCRIPTION) LIKE '%PASAPORTE%'
             OR UPPER(DESCRIPTION) LIKE '%PASSPORT%'
        )
    `, binds);
    for (const r of rows) out.passportNameIds.add(r.NAME_ID);
    out.passportChecked = true;
  } catch (err) {
    logger.warn(`Completeness: passport lookup failed, skipping Passport flag — ${err.message}`);
  }

  return out;
}

// A DOB is "valid" when it is a real past date with a plausible year. Hand-entry
// junk (0001, future years) is treated as missing so front desk re-collects it.
function isValidDob(dob, todayStr) {
  if (!dob) return false;
  const m = String(dob).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = parseInt(m[1], 10);
  const currentYear = todayStr ? parseInt(todayStr.slice(0, 4), 10) : new Date().getFullYear();
  return year >= 1900 && year <= currentYear;
}

/**
 * Query all guests with active reservations overlapping a target date
 * for the comprehensive daily front desk report.
 *
 * @param {OracleClient} oracleClient - Connected Oracle client
 * @param {string} dateStr - Target date as YYYY-MM-DD (default: today Argentina time)
 * @returns {Promise<Object>} Report data with sections: inHouse, departures,
 *   arrivalsToday, arrivalsTomorrow, arrivalsDayAfter, postingMasters, and a
 *   separate dataQuality list (email/DOB/phone/passport gaps).
 */
async function queryFrontDeskReport(oracleClient, dateStr) {
  if (!dateStr) {
    dateStr = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })).toISOString().slice(0, 10);
  }

  // Compute tomorrow / day-after as plain strings — no Date objects, no timezone issues
  const [y, m, d] = dateStr.split('-').map(Number);
  const tmp1 = new Date(y, m - 1, d + 1); // local date math
  const tomorrowStr = `${tmp1.getFullYear()}-${String(tmp1.getMonth() + 1).padStart(2, '0')}-${String(tmp1.getDate()).padStart(2, '0')}`;
  const tmp2 = new Date(y, m - 1, d + 2);
  const dayAfterStr = `${tmp2.getFullYear()}-${String(tmp2.getMonth() + 1).padStart(2, '0')}-${String(tmp2.getDate()).padStart(2, '0')}`;

  logger.info(`Front desk report: querying guests for ${dateStr} (tomorrow: ${tomorrowStr}, day-after: ${dayAfterStr})`);

  // Staff/internal profiles front desk asked to keep out of the data-quality
  // report (e.g. staff parked on villas). They still appear in the regular
  // report sections.
  const excludedGuests = parseExcludedGuestNames(process.env.FRONT_DESK_EXCLUDE_GUESTS);

  // Oracle returns dates as YYYY-MM-DD strings via TO_CHAR — no JS Date timezone issues
  // Join through RESERVATION_DAILY_ELEMENT_NAME → RESERVATION_DAILY_ELEMENTS to get Room + Adults/Children
  // Notes are fetched separately below from NAME_COMMENT, NAME$NOTES, RESERVATION_COMMENT,
  // and RESERVATION_ALERTS so we can label each by source and avoid LISTAGG on CLOBs.
  const rows = await oracleClient.query(`
    SELECT n.NAME_ID, n.FIRST, n.LAST, n.LANGUAGE,
           p.PHONE_NUMBER AS EMAIL,
           a.CITY,
           a.COUNTRY,
           TO_CHAR(TRUNC(rn.BEGIN_DATE), 'YYYY-MM-DD') AS CHECK_IN,
           TO_CHAR(TRUNC(rn.END_DATE), 'YYYY-MM-DD') AS CHECK_OUT,
           daily.ROOM,
           daily.ROOM_CATEGORY,
           daily.ADULTS,
           daily.CHILDREN,
           rn.RESV_NAME_ID,
           rn.PARENT_RESV_NAME_ID,
           TO_CHAR(rn.ARRIVAL_ESTIMATE_TIME, 'HH24:MI') AS ETA
    FROM OPERA.RESERVATION_NAME rn
    JOIN OPERA.NAME n ON rn.NAME_ID = n.NAME_ID
      AND n.NAME_TYPE = 'D'
    LEFT JOIN (
      -- Best email per guest: primary EMAIL row first, then any EMAIL row,
      -- then any phone row holding an address (front desk sometimes types the
      -- email under a phone type like HOME — it must not read as "no email").
      SELECT NAME_ID, PHONE_NUMBER,
             ROW_NUMBER() OVER (
               PARTITION BY NAME_ID
               ORDER BY CASE
                          WHEN PHONE_ROLE = 'EMAIL' AND PRIMARY_YN = 'Y' THEN 0
                          WHEN PHONE_ROLE = 'EMAIL' THEN 1
                          ELSE 2
                        END,
                        UPDATE_DATE DESC NULLS LAST, INSERT_DATE DESC NULLS LAST
             ) AS RNK
      FROM OPERA.NAME_PHONE
      WHERE PHONE_ROLE = 'EMAIL' OR PHONE_NUMBER LIKE '%@%'
    ) p ON rn.NAME_ID = p.NAME_ID AND p.RNK = 1
    LEFT JOIN OPERA.NAME_ADDRESS a ON n.NAME_ID = a.NAME_ID
      AND a.PRIMARY_YN = 'Y' AND a.INACTIVE_DATE IS NULL
    LEFT JOIN (
      SELECT rden.RESV_NAME_ID, rde.ROOM, rde.ROOM_CATEGORY, rden.ADULTS, rden.CHILDREN,
             ROW_NUMBER() OVER (PARTITION BY rden.RESV_NAME_ID ORDER BY rden.RESERVATION_DATE) AS rn
      FROM OPERA.RESERVATION_DAILY_ELEMENT_NAME rden
      JOIN OPERA.RESERVATION_DAILY_ELEMENTS rde
        ON rden.RESORT = rde.RESORT
        AND rden.RESERVATION_DATE = rde.RESERVATION_DATE
        AND rden.RESV_DAILY_EL_SEQ = rde.RESV_DAILY_EL_SEQ
      WHERE rden.RESORT = 'VINES'
        AND rden.RESERVATION_DATE BETWEEN TO_DATE(:dateStr, 'YYYY-MM-DD') AND TO_DATE(:dayAfterStr, 'YYYY-MM-DD')
    ) daily ON rn.RESV_NAME_ID = daily.RESV_NAME_ID AND daily.rn = 1
    WHERE rn.RESORT = 'VINES'
      AND rn.RESV_STATUS != 'CANCELLED'
      AND TRUNC(rn.BEGIN_DATE) <= TO_DATE(:dayAfterStr, 'YYYY-MM-DD')
      AND TRUNC(rn.END_DATE) >= TO_DATE(:dateStr, 'YYYY-MM-DD')
  `, { dateStr, dayAfterStr });

  logger.info(`Front desk report: ${rows.length} raw reservation rows returned`);

  // Fetch notes (and CASHIER comments separately), keyed by NAME_ID / RESV_NAME_ID
  const nameIds = [...new Set(rows.map(r => r.NAME_ID).filter(Boolean))];
  const resvIds = [...new Set(rows.map(r => r.RESV_NAME_ID).filter(Boolean))];
  const { notesByNameId, notesByResvId, cashierByResvId } = await fetchGuestNotes(oracleClient, nameIds, resvIds);

  // Best-effort DOB / phone / passport presence for the data-quality report.
  const completeness = await fetchGuestCompleteness(oracleClient, nameIds);

  // Room (and room category) by reservation — used so companions parked on a
  // parent reservation (e.g. a group leader / house account sitting on a
  // Posting Master) can inherit the parent's room when they have none of their own.
  const roomByResvId = new Map();
  const categoryByResvId = new Map();
  for (const r of rows) {
    const rm = (r.ROOM || '').trim() || null;
    if (rm && !roomByResvId.has(r.RESV_NAME_ID)) roomByResvId.set(r.RESV_NAME_ID, rm);
    const rc = (r.ROOM_CATEGORY || '').trim() || null;
    if (rc && !categoryByResvId.has(r.RESV_NAME_ID)) categoryByResvId.set(r.RESV_NAME_ID, rc);
  }

  // Build guest objects, group shared reservations, then categorize
  const allGuests = [];
  const inHouse = [];
  const departures = [];
  const arrivalsToday = [];
  const arrivalsTomorrow = [];
  const arrivalsDayAfter = [];
  const postingMasters = [];
  const dataQuality = [];

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

    const ownVilla = (row.ROOM || '').trim() || null;

    // Skip Posting Master rooms (e.g. "PM01", "PM02") — not real guest rooms
    if (ownVilla && EXCLUDED_ROOM_PREFIXES.some(p => ownVilla.toUpperCase().startsWith(p))) {
      continue;
    }

    // A companion whose own reservation has no room inherits its parent's room,
    // so a party parked on a Posting Master (group leader / house account) lands
    // in the PM section rather than slipping into In House with a blank villa.
    const parentVilla = row.PARENT_RESV_NAME_ID ? (roomByResvId.get(row.PARENT_RESV_NAME_ID) || null) : null;
    const villa = ownVilla || parentVilla;

    // Room category rides along the same way — a roomless reservation on the
    // PM pseudo category is a Posting Master even without a room number.
    const ownCategory = (row.ROOM_CATEGORY || '').trim() || null;
    const parentCategory = row.PARENT_RESV_NAME_ID ? (categoryByResvId.get(row.PARENT_RESV_NAME_ID) || null) : null;
    const roomCategory = ownCategory || parentCategory;

    const checkInDate = row.CHECK_IN || '';
    const checkOutDate = row.CHECK_OUT || '';
    const resvNameId = row.RESV_NAME_ID;
    const parentId = row.PARENT_RESV_NAME_ID;
    const adults = row.ADULTS != null ? Number(row.ADULTS) : null;
    const children = row.CHILDREN != null ? Number(row.CHILDREN) : null;

    // OPERA's structured arrival/departure time fields are never filled at The
    // Vines, so scrape an estimate from the reservation comment free text
    // (flight itineraries, check-in requests, pickup notes). Best-effort.
    const resvNoteText = (notesByResvId.get(row.RESV_NAME_ID) || []).join('\n');

    const guest = {
      nameId: row.NAME_ID,
      resvNameId,
      parentId,
      firstName,
      lastName,
      email: rawEmail,
      city: (row.CITY || '').trim() || null,
      country: expandCountry(row.COUNTRY),
      language: mapLanguageToSalesforce(row.LANGUAGE),
      villa,
      roomCategory,
      adults: adults || 0,
      children: children || 0,
      prs: adults != null ? `${adults}/${children || 0}` : null,
      checkIn: checkInDate,
      checkOut: checkOutDate,
      eta: (row.ETA || '').trim() || extractEstimatedTime(resvNoteText, 'arrival'),
      etd: extractEstimatedTime(resvNoteText, 'departure'),
      // Profile-level notes accumulate across stays — strip dated entries that
      // fall outside this stay's window. Reservation-scoped notes are already
      // tied to this stay so we pass them through unfiltered. CASHIER comments
      // are kept apart (cashierRaw) and merged in later only for departures/arrivals.
      notesRaw: (() => {
        const profileNotes = (notesByNameId.get(row.NAME_ID) || [])
          .map(n => filterNoteByStayWindow(n, checkInDate, checkOutDate, dateStr))
          .filter(Boolean);
        const resvNotes = notesByResvId.get(row.RESV_NAME_ID) || [];
        return [...profileNotes, ...resvNotes].join(' | ') || null;
      })(),
      cashierRaw: (cashierByResvId.get(row.RESV_NAME_ID) || []).join(' | ') || null,
      companions: []
    };

    // Check for bad/agent email
    const cleanedEmail = sanitizeEmail(rawEmail);
    let badReason = null;
    if (!cleanedEmail) {
      badReason = emailInvalidReason(rawEmail) || 'invalid-email';
    } else {
      const agentCat = isAgentEmail({ email: cleanedEmail, firstName });
      if (agentCat) badReason = agentCat;
      else if (isRoleMailbox(cleanedEmail)) badReason = 'role-mailbox';
    }
    guest.reason = badReason || undefined;

    allGuests.push(guest);
  }

  // Group secondary guests under their parent reservation
  const byResvNameId = new Map();
  for (const g of allGuests) {
    byResvNameId.set(g.resvNameId, g);
  }
  const primaryGuests = [];
  for (const g of allGuests) {
    if (g.parentId && byResvNameId.has(g.parentId)) {
      // Secondary guest — attach to parent
      const parent = byResvNameId.get(g.parentId);
      parent.companions.push(`${g.firstName} ${g.lastName}`);
      // Merge individual preferences from secondary guest into parent notes
      if (g.notesRaw) {
        const prefLabel = `${g.firstName}: ${g.notesRaw}`;
        parent.notesRaw = parent.notesRaw ? `${parent.notesRaw} | ${prefLabel}` : prefLabel;
      }
      if (g.cashierRaw) {
        parent.cashierRaw = parent.cashierRaw ? `${parent.cashierRaw} | ${g.cashierRaw}` : g.cashierRaw;
      }
    } else {
      primaryGuests.push(g);
    }
  }

  // SMTP/MX verification on the survivors — distinguishes unreachable domains
  // (no MX) and rejected mailboxes (550) from generally-deliverable addresses.
  // Skipped when SMTP_VERIFY=false. Fails open: network errors leave reason
  // untouched so the email still flows through normally.
  if (process.env.SMTP_VERIFY !== 'false') {
    const eligible = primaryGuests.filter(g => !g.reason && g.email && sanitizeEmail(g.email));
    const emails = [...new Set(eligible.map(g => g.email.toLowerCase()))];
    if (emails.length > 0) {
      logger.info(`Front desk SMTP verify: probing ${emails.length} address(es)...`);
      try {
        const results = await verifyEmailsSMTP(emails);
        let invalidCount = 0, noMxCount = 0;
        for (const g of eligible) {
          const status = results.get(g.email.toLowerCase());
          if (status === 'invalid') { g.reason = 'invalid-mailbox'; invalidCount++; }
          else if (status === 'no-mx') { g.reason = 'domain-unreachable'; noMxCount++; }
        }
        logger.info(`Front desk SMTP verify: ${invalidCount} invalid mailbox(es), ${noMxCount} unreachable domain(s)`);
      } catch (err) {
        logger.warn(`Front desk SMTP verify failed (proceeding without): ${err.message}`);
      }
    }
  }

  // Drop the internal-only fields once a guest's notes/completeness are computed.
  const cleanupGuest = (g) => {
    delete g.nameId; delete g.resvNameId; delete g.parentId;
    delete g.companions; delete g.notesRaw; delete g.cashierRaw;
    delete g.roomCategory;
  };

  // Categorize primary guests into sections (and collect data-quality gaps).
  for (const guest of primaryGuests) {
    const { checkIn: checkInDate, checkOut: checkOutDate, reason: badReason, nameId } = guest;

    const isCheckInToday = checkInDate === dateStr;
    const isCheckInTomorrow = checkInDate === tomorrowStr;
    const isCheckInDayAfter = checkInDate === dayAfterStr;
    const isCheckOutToday = checkOutDate === dateStr;
    const isInHouse = checkInDate < dateStr && checkOutDate > dateStr;
    const isArrival = isCheckInToday || isCheckInTomorrow || isCheckInDayAfter;

    // Format companion names into display name
    if (guest.companions.length > 0) {
      guest.companionNames = guest.companions.join(', ');
    }

    // CASHIER (billing) comments are only actionable at the desk for departures
    // and arrivals — merge them into the notes column only there.
    const showCashier = isCheckOutToday || isArrival;
    const combinedNotes = showCashier && guest.cashierRaw
      ? [guest.notesRaw, guest.cashierRaw].filter(Boolean).join(' | ')
      : guest.notesRaw;
    guest.notes = tidyNotes(combinedNotes);

    // Posting Masters — 9000-series villas, PM-prefixed rooms inherited from a
    // parent reservation, or roomless reservations on the PM pseudo room
    // category — are charge-tracking accounts, not real stays. Surface
    // separately, skip data-quality / regular sections.
    if (isPostingMasterStay(guest.villa, guest.roomCategory)) {
      cleanupGuest(guest);
      postingMasters.push(guest);
      continue;
    }

    // Data-quality gaps: invalid/missing email plus best-effort DOB/phone/passport.
    const missing = [];
    if (badReason) missing.push('Email');
    if (completeness.dobChecked && !completeness.dobNameIds.has(nameId)) missing.push('DOB');
    if (completeness.phoneChecked && !completeness.phoneNameIds.has(nameId)) missing.push('Phone');
    if (completeness.passportChecked && !completeness.passportNameIds.has(nameId)) missing.push('Passport');
    if (!guest.city) missing.push('City');
    // The DOB itself is encrypted in OPERA, so we can confirm presence but not
    // display a value (the report's DOB column is left blank by design).
    const dob = null;

    cleanupGuest(guest);

    let section = null;
    if (isCheckOutToday) { section = 'Departures'; departures.push(guest); }
    else if (isCheckInToday) { section = 'Arrivals Today'; arrivalsToday.push(guest); }
    else if (isCheckInTomorrow) { section = 'Arrivals Tomorrow'; arrivalsTomorrow.push(guest); }
    else if (isCheckInDayAfter) { section = 'Arrivals (2 days out)'; arrivalsDayAfter.push(guest); }
    else if (isInHouse) { section = 'In House'; inHouse.push(guest); }

    if (section && missing.length > 0 && !isExcludedGuest(guest, excludedGuests)) {
      dataQuality.push({
        firstName: guest.firstName,
        lastName: guest.lastName,
        companionNames: guest.companionNames || null,
        villa: guest.villa,
        email: guest.email,
        reason: guest.reason || null,
        dob,
        checkIn: checkInDate,
        checkOut: checkOutDate,
        section,
        missing,
      });
    }
  }

  // Sort each section by villa number (front-desk ordering); ties break by name.
  const byVilla = (a, b) => {
    const ka = villaMap.villaSortKey(a.villa);
    const kb = villaMap.villaSortKey(b.villa);
    if (ka !== kb) return ka - kb;
    return (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName);
  };
  inHouse.sort(byVilla);
  departures.sort(byVilla);
  arrivalsToday.sort(byVilla);
  arrivalsTomorrow.sort(byVilla);
  arrivalsDayAfter.sort(byVilla);
  postingMasters.sort(byVilla);
  dataQuality.sort(byVilla);

  const report = {
    date: dateStr,
    inHouse,
    departures,
    arrivalsToday,
    arrivalsTomorrow,
    arrivalsDayAfter,
    postingMasters,
    dataQuality
  };

  logger.info(`Front desk report: ${inHouse.length} in-house, ${departures.length} departures, ${arrivalsToday.length} arrivals today, ${arrivalsTomorrow.length} arrivals tomorrow, ${arrivalsDayAfter.length} arrivals day-after, ${postingMasters.length} posting masters, ${dataQuality.length} data-quality flags`);

  return report;
}

/**
 * Fetch villa occupancy rows for a date window at (ROOM, night) grain.
 *
 * The DB join from RESERVATION_DAILY_ELEMENTS (room side, carries RATE_AMOUNT)
 * to RESERVATION_DAILY_ELEMENT_NAME (guest side, carries RATE_CODE) fans out
 * per guest on a shared reservation, so we collapse back to
 * (ROOM, RESERVATION_DATE) with GROUP BY — a villa hosts one reservation per
 * night, so this is true occupancy, not guest-nights.
 *
 * Works for past and future windows alike: OPERA creates daily elements at
 * booking time, so nights of RESERVED stays months out are present. WAITLIST
 * and PROSPECT bookings are excluded — they hold no villa (a past one that
 * materialized would carry a CHECKED OUT status instead).
 *
 * @returns {Promise<Array>} rows of { ROOM, NIGHT, RATE_AMOUNT, RATE_CODE }
 */
async function fetchVillaNightRows(oracleClient, startDate, endDate) {
  return oracleClient.query(`
    SELECT de.ROOM,
           TO_CHAR(de.RESERVATION_DATE, 'YYYY-MM-DD') AS NIGHT,
           MAX(de.RATE_AMOUNT) AS RATE_AMOUNT,
           MAX(den.RATE_CODE)  AS RATE_CODE
    FROM OPERA.RESERVATION_DAILY_ELEMENTS de
    JOIN OPERA.RESERVATION_DAILY_ELEMENT_NAME den
      ON den.RESORT = de.RESORT
      AND den.RESERVATION_DATE = de.RESERVATION_DATE
      AND den.RESV_DAILY_EL_SEQ = de.RESV_DAILY_EL_SEQ
    JOIN OPERA.RESERVATION_NAME rn
      ON den.RESV_NAME_ID = rn.RESV_NAME_ID
    WHERE de.RESORT = 'VINES'
      AND de.RESERVATION_DATE >= TO_DATE(:startDate, 'YYYY-MM-DD')
      AND de.RESERVATION_DATE <  TO_DATE(:endDate, 'YYYY-MM-DD')
      AND rn.RESV_STATUS NOT IN ('CANCELLED', 'NO SHOW', 'WAITLIST', 'PROSPECT')
      -- A reservation's real nights are [check-in, check-out); this drops the
      -- spurious checkout-day daily element a departing guest can leave behind,
      -- so a turnover night attributes to the arriving guest, not the departing.
      AND de.RESERVATION_DATE >= TRUNC(rn.BEGIN_DATE)
      AND de.RESERVATION_DATE <  TRUNC(rn.END_DATE)
    GROUP BY de.ROOM, de.RESERVATION_DATE
  `, { startDate, endDate });
}

/**
 * Aggregate (ROOM, night) rows into nights per villa, split into comp (rate 0)
 * vs paid, plus a per-rate-code breakdown. Pure — no DB access.
 *
 * Comp vs paid is read straight from RATE_AMOUNT (0 = comp). OPERA's dedicated
 * discount/comp columns are unused at VINES (verified empty across the whole
 * dataset), and there is no stored rack rate, so "discounted-but-paid" is left to
 * the rate-code table rather than computed.
 *
 * Output is restricted to the mapped villa set (`known`) — this is an
 * allowlist, so residences (100-series), Posting Masters, and legacy/old room
 * numbers are excluded — and every mapped villa gets a row, so a vacant villa
 * surfaces as 0 nights (the signal that matters for distributing guests).
 *
 * @param {Array} rows - { ROOM, NIGHT, RATE_AMOUNT, RATE_CODE } rows
 * @param {string[]} known - canonical villa allowlist (villaMap.knownVillas())
 * @returns {Object} { villas, rateCodes, totals }
 */
function aggregateVillaNights(rows, known) {
  const knownSet = new Set(known);

  const occupied = new Map();    // normalized room -> { nights, compNights, paidNights, rateCodes:Map }
  const rateCodes = new Map();   // code -> { code, nights, compNights, paidNights }
  let totalNights = 0, compNights = 0, paidNights = 0;

  for (const row of rows) {
    const room = (row.ROOM || '').trim();
    if (!room) continue;
    const villa = villaMap.normalizeRoom(room);
    if (!knownSet.has(villa)) continue; // not a current mapped villa (residence / PM / legacy)

    const rate = row.RATE_AMOUNT != null ? Number(row.RATE_AMOUNT) : 0;
    const code = (row.RATE_CODE || '').trim() || '(none)';
    const isComp = rate === 0;

    let v = occupied.get(villa);
    if (!v) {
      v = { nights: 0, compNights: 0, paidNights: 0, rateCodes: new Map() };
      occupied.set(villa, v);
    }
    v.nights++;
    if (isComp) v.compNights++; else v.paidNights++;
    v.rateCodes.set(code, (v.rateCodes.get(code) || 0) + 1);

    let rc = rateCodes.get(code);
    if (!rc) { rc = { code, nights: 0, compNights: 0, paidNights: 0 }; rateCodes.set(code, rc); }
    rc.nights++;
    if (isComp) rc.compNights++; else rc.paidNights++;

    totalNights++;
    if (isComp) compNights++; else paidNights++;
  }

  // Sort by OPERA room number ascending — reads cleanly: AC 1–12 first, then
  // villas in physical order 1–30.
  const villaNum = (s) => { const n = parseInt(String(s).replace(/\D/g, ''), 10); return Number.isNaN(n) ? Infinity : n; };

  // One row per mapped villa; vacant villas (no occupied nights) show zeros.
  const villaList = known
    .slice()
    .sort((a, b) => villaNum(a) - villaNum(b) || a.localeCompare(b))
    .map(villa => {
      const v = occupied.get(villa);
      return {
        villa,
        nights: v ? v.nights : 0,
        compNights: v ? v.compNights : 0,
        paidNights: v ? v.paidNights : 0,
        rateCodes: v
          ? [...v.rateCodes.entries()].map(([code, nights]) => ({ code, nights })).sort((a, b) => b.nights - a.nights)
          : []
      };
    });

  const rateCodeList = [...rateCodes.values()].sort((a, b) => b.nights - a.nights);

  return {
    villas: villaList,
    rateCodes: rateCodeList,
    totals: { villas: villaList.length, occupiedVillas: occupied.size, nights: totalNights, compNights, paidNights }
  };
}

/**
 * Villa occupancy report for a single date window.
 *
 * @param {OracleClient} oracleClient
 * @param {string} startDate - inclusive YYYY-MM-DD
 * @param {string} endDate   - exclusive YYYY-MM-DD
 * @returns {Promise<Object>} { startDate, endDate, villas, rateCodes, totals }
 */
async function queryVillaNightsReport(oracleClient, startDate, endDate) {
  const rows = await fetchVillaNightRows(oracleClient, startDate, endDate);
  const agg = aggregateVillaNights(rows, villaMap.knownVillas());

  logger.info(`Villa nights report ${startDate}..${endDate}: ${agg.totals.occupiedVillas}/${agg.totals.villas} villas occupied, ${agg.totals.nights} nights (${agg.totals.compNights} comp, ${agg.totals.paidNights} paid)`);

  return { startDate, endDate, ...agg };
}

/**
 * Villa occupancy across several date windows (the weekly rotation outlook:
 * current month + next / 3 months / 6 months). One fetch over the widest span,
 * then each window aggregates the rows whose night falls inside it — windows
 * may nest or overlap freely.
 *
 * @param {OracleClient} oracleClient
 * @param {Array} windows - [{ key, label, startDate, endDate }] (endDate exclusive)
 * @returns {Promise<Object>} { windows: [{ key, label, startDate, endDate, villas, rateCodes, totals }] }
 */
async function queryVillaNightsOutlook(oracleClient, windows) {
  if (!windows || !windows.length) throw new Error('queryVillaNightsOutlook: no windows given');

  const spanStart = windows.map(w => w.startDate).sort()[0];
  const spanEnd = windows.map(w => w.endDate).sort().pop();
  const rows = await fetchVillaNightRows(oracleClient, spanStart, spanEnd);
  const known = villaMap.knownVillas();

  const result = windows.map(w => {
    const inWindow = rows.filter(r => r.NIGHT >= w.startDate && r.NIGHT < w.endDate);
    const agg = aggregateVillaNights(inWindow, known);
    logger.info(`Villa outlook ${w.label} (${w.startDate}..${w.endDate}): ${agg.totals.occupiedVillas}/${agg.totals.villas} villas with nights, ${agg.totals.nights} nights (${agg.totals.compNights} comp)`);
    return { key: w.key, label: w.label, startDate: w.startDate, endDate: w.endDate, ...agg };
  });

  return { windows: result };
}

module.exports = {
  queryGuestsByIds,
  queryGuestsSince,
  queryFrontDeskReport,
  queryVillaNightsReport,
  queryVillaNightsOutlook,
  aggregateVillaNights,
  discoverReservationColumns,
  discoverNoteCodes,
  discoverGuestFieldShapes,
  filterNoteByStayWindow,
  parseLeadingDate,
  tidyNotes,
  extractEstimatedTime,
  isValidDob,
  formatDate
};
