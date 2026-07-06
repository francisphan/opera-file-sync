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

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

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

/**
 * Fetch guest notes from the OPERA sources the front desk cares about, grouped
 * by NAME_ID and RESV_NAME_ID.
 *
 * Sources:
 *   1. NAME$NOTES (any active NOTE_CODE)          — profile-level free-form notes
 *      Common codes: PREF (allergies/preferences), INCONV (incidents), GUESTPROF (bio)
 *   2. RESERVATION_COMMENT (RESERVATION/IN HOUSE) — per-reservation comments
 *   3. RESERVATION_ALERTS                          — per-reservation action alerts
 *
 * NAME_COMMENT (PROF preferences) and CASHIER reservation comments are
 * deliberately excluded — front desk flagged them as notes-column bloat
 * (PROF duplicates the PREF notes; CASHIER is billing detail, not actionable).
 *
 * Each note is labeled with a short tag (e.g. "[PREF]", "[IN HOUSE]", "[Alert Check-Out]")
 * so the front desk can tell sources apart when they're merged into a single notes string.
 */
async function fetchGuestNotes(oracleClient, nameIds, resvIds) {
  const notesByNameId = new Map();
  const notesByResvId = new Map();
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

    // NAME$NOTES — free-form profile notes (includes PREF allergies, INCONV, GUESTPROF, etc.)
    // NOTES is a CLOB — set fetchAsString globally so we get a JS string back.
    const oracledb = require('oracledb');
    if (!oracledb.fetchAsString.includes(oracledb.CLOB)) oracledb.fetchAsString.push(oracledb.CLOB);
    const nn = await oracleClient.query(`
      SELECT NAME_ID, NOTE_CODE, NOTES
      FROM OPERA."NAME$NOTES"
      WHERE NAME_ID IN (${holders})
        AND INACTIVE_DATE IS NULL
      ORDER BY NAME_ID, INSERT_DATE
    `, binds);
    for (const r of nn) push(notesByNameId, r.NAME_ID, r.NOTE_CODE || 'Note', r.NOTES);
  }

  if (resvIds.length > 0) {
    const binds = Object.fromEntries(resvIds.map((id, i) => [`r${i}`, id]));
    const holders = resvIds.map((_, i) => `:r${i}`).join(',');

    // RESERVATION_COMMENT — guest-facing reservation comments. CASHIER (billing)
    // is excluded as notes-column bloat per front-desk feedback.
    const rc = await oracleClient.query(`
      SELECT RESV_NAME_ID, COMMENT_TYPE, COMMENTS, INSERT_DATE
      FROM OPERA.RESERVATION_COMMENT
      WHERE RESV_NAME_ID IN (${holders})
        AND RESORT = 'VINES'
        AND COMMENT_TYPE IN ('RESERVATION', 'IN HOUSE')
      ORDER BY RESV_NAME_ID, INSERT_DATE
    `, binds);
    for (const r of rc) push(notesByResvId, r.RESV_NAME_ID, r.COMMENT_TYPE, r.COMMENTS);

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

  return { notesByNameId, notesByResvId };
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

  // Staff/internal profiles front desk asked to keep out of the email-collection
  // section. They still appear in the regular report sections.
  const excludedGuests = parseExcludedGuestNames(process.env.FRONT_DESK_EXCLUDE_GUESTS);

  // Oracle returns dates as YYYY-MM-DD strings via TO_CHAR — no JS Date timezone issues
  // Join through RESERVATION_DAILY_ELEMENT_NAME → RESERVATION_DAILY_ELEMENTS to get Room + Adults/Children
  // Notes are fetched separately below from NAME_COMMENT, NAME$NOTES, RESERVATION_COMMENT,
  // and RESERVATION_ALERTS so we can label each by source and avoid LISTAGG on CLOBs.
  const rows = await oracleClient.query(`
    SELECT n.NAME_ID, n.FIRST, n.LAST, n.LANGUAGE,
           p.PHONE_NUMBER AS EMAIL,
           a.COUNTRY,
           TO_CHAR(TRUNC(rn.BEGIN_DATE), 'YYYY-MM-DD') AS CHECK_IN,
           TO_CHAR(TRUNC(rn.END_DATE), 'YYYY-MM-DD') AS CHECK_OUT,
           daily.ROOM,
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
    WHERE rn.RESORT = 'VINES'
      AND rn.RESV_STATUS != 'CANCELLED'
      AND TRUNC(rn.BEGIN_DATE) <= TO_DATE(:tomorrowStr, 'YYYY-MM-DD')
      AND TRUNC(rn.END_DATE) >= TO_DATE(:dateStr, 'YYYY-MM-DD')
  `, { dateStr, tomorrowStr });

  logger.info(`Front desk report: ${rows.length} raw reservation rows returned`);

  // Fetch notes from all four sources, keyed by NAME_ID / RESV_NAME_ID
  const nameIds = [...new Set(rows.map(r => r.NAME_ID).filter(Boolean))];
  const resvIds = [...new Set(rows.map(r => r.RESV_NAME_ID).filter(Boolean))];
  const { notesByNameId, notesByResvId } = await fetchGuestNotes(oracleClient, nameIds, resvIds);

  // Room by reservation — used so companions parked on a parent reservation
  // (e.g. a group leader / house account sitting on a Posting Master) can
  // inherit the parent's room when they have none of their own.
  const roomByResvId = new Map();
  for (const r of rows) {
    const rm = (r.ROOM || '').trim() || null;
    if (rm && !roomByResvId.has(r.RESV_NAME_ID)) roomByResvId.set(r.RESV_NAME_ID, rm);
  }

  // Build guest objects, group shared reservations, then categorize
  const allGuests = [];
  const badEmails = [];
  const inHouse = [];
  const departures = [];
  const arrivalsToday = [];
  const arrivalsTomorrow = [];
  const postingMasters = [];

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
      resvNameId,
      parentId,
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
      eta: (row.ETA || '').trim() || extractEstimatedTime(resvNoteText, 'arrival'),
      etd: extractEstimatedTime(resvNoteText, 'departure'),
      notes: (() => {
        // Profile-level notes accumulate across stays — strip dated entries
        // that fall outside this stay's window. Reservation-scoped notes are
        // already tied to this stay so we pass them through unfiltered.
        const profileNotes = (notesByNameId.get(row.NAME_ID) || [])
          .map(n => filterNoteByStayWindow(n, checkInDate, checkOutDate, dateStr))
          .filter(Boolean);
        const resvNotes = notesByResvId.get(row.RESV_NAME_ID) || [];
        return [...profileNotes, ...resvNotes].join(' | ') || null;
      })(),
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
      if (g.notes) {
        const prefLabel = `${g.firstName}: ${g.notes}`;
        parent.notes = parent.notes ? `${parent.notes} | ${prefLabel}` : prefLabel;
      }
    } else {
      primaryGuests.push(g);
    }
  }

  // Dedup repeated note pieces and cap length once the companion preferences
  // have been merged in (keeps the front-desk notes column from ballooning).
  for (const g of primaryGuests) {
    g.notes = tidyNotes(g.notes);
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

  // Categorize primary guests into sections
  for (const guest of primaryGuests) {
    const { checkIn: checkInDate, checkOut: checkOutDate, reason: badReason } = guest;

    const isCheckInToday = checkInDate === dateStr;
    const isCheckInTomorrow = checkInDate === tomorrowStr;
    const isCheckOutToday = checkOutDate === dateStr;
    const isInHouse = checkInDate < dateStr && checkOutDate > dateStr;
    // Email collection starts the day AFTER arrival — front desk can't collect
    // anything from a guest who hasn't checked in yet, so same-day arrivals
    // must not be flagged (they were the report's most common false positive).
    const arrivedBeforeToday = checkInDate < dateStr && checkOutDate >= dateStr;

    // Format companion names into display name
    if (guest.companions.length > 0) {
      guest.companionNames = guest.companions.join(', ');
    }

    // Clean up internal fields
    delete guest.resvNameId;
    delete guest.parentId;
    delete guest.companions;

    // Posting Masters (9000-series villas) are charge-tracking accounts, not
    // real stays — surface separately and skip badEmails/regular sections.
    if (isPostingMasterVilla(guest.villa)) {
      postingMasters.push({ ...guest });
      continue;
    }

    if (badReason && arrivedBeforeToday && !isExcludedGuest(guest, excludedGuests)) {
      badEmails.push({ ...guest });
    }

    if (isCheckOutToday) {
      departures.push({ ...guest });
    } else if (isCheckInToday) {
      arrivalsToday.push({ ...guest });
    } else if (isCheckInTomorrow) {
      arrivalsTomorrow.push({ ...guest });
    } else if (isInHouse) {
      inHouse.push({ ...guest });
    }
  }

  // Sort each section by last name
  const byName = (a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName);
  badEmails.sort(byName);
  inHouse.sort(byName);
  departures.sort(byName);
  arrivalsToday.sort(byName);
  arrivalsTomorrow.sort(byName);
  postingMasters.sort(byName);

  const report = {
    date: dateStr,
    badEmails,
    inHouse,
    departures,
    arrivalsToday,
    arrivalsTomorrow,
    postingMasters
  };

  logger.info(`Front desk report: ${badEmails.length} bad emails, ${inHouse.length} in-house, ${departures.length} departures, ${arrivalsToday.length} arrivals today, ${arrivalsTomorrow.length} arrivals tomorrow, ${postingMasters.length} posting masters`);

  return report;
}

/**
 * Aggregate villa occupancy for a date window: nights per villa, split into
 * comp (rate 0) vs paid, plus a per-rate-code breakdown.
 *
 * Grain: one row per (ROOM, night). The DB join from RESERVATION_DAILY_ELEMENTS
 * (room side, carries RATE_AMOUNT) to RESERVATION_DAILY_ELEMENT_NAME (guest side,
 * carries RATE_CODE) fans out per guest on a shared reservation, so we collapse
 * back to (ROOM, RESERVATION_DATE) with GROUP BY — a villa hosts one reservation
 * per night, so this is true occupancy, not guest-nights.
 *
 * Comp vs paid is read straight from RATE_AMOUNT (0 = comp). OPERA's dedicated
 * discount/comp columns are unused at VINES (verified empty across the whole
 * dataset), and there is no stored rack rate, so "discounted-but-paid" is left to
 * the rate-code table rather than computed.
 *
 * Output is restricted to the mapped villa set (villaMap.knownVillas) — this is
 * an allowlist, so residences (100-series), Posting Masters, and legacy/old room
 * numbers are excluded — and every mapped villa gets a row, so a vacant villa
 * surfaces as 0 nights (the signal that matters for distributing guests).
 *
 * @param {OracleClient} oracleClient
 * @param {string} startDate - inclusive YYYY-MM-DD
 * @param {string} endDate   - exclusive YYYY-MM-DD
 * @returns {Promise<Object>} { startDate, endDate, villas, rateCodes, totals }
 */
async function queryVillaNightsReport(oracleClient, startDate, endDate) {
  const rows = await oracleClient.query(`
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
      AND rn.RESV_STATUS NOT IN ('CANCELLED', 'NO SHOW')
      -- A reservation's real nights are [check-in, check-out); this drops the
      -- spurious checkout-day daily element a departing guest can leave behind,
      -- so a turnover night attributes to the arriving guest, not the departing.
      AND de.RESERVATION_DATE >= TRUNC(rn.BEGIN_DATE)
      AND de.RESERVATION_DATE <  TRUNC(rn.END_DATE)
    GROUP BY de.ROOM, de.RESERVATION_DATE
  `, { startDate, endDate });

  // Canonical villa set — only the mapped villas count, and every one gets a row.
  const known = villaMap.knownVillas();
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

  logger.info(`Villa nights report ${startDate}..${endDate}: ${occupied.size}/${villaList.length} villas occupied, ${totalNights} nights (${compNights} comp, ${paidNights} paid)`);

  return {
    startDate,
    endDate,
    villas: villaList,
    rateCodes: rateCodeList,
    totals: { villas: villaList.length, occupiedVillas: occupied.size, nights: totalNights, compNights, paidNights }
  };
}

module.exports = {
  queryGuestsByIds,
  queryGuestsSince,
  queryFrontDeskReport,
  queryVillaNightsReport,
  discoverReservationColumns,
  filterNoteByStayWindow,
  parseLeadingDate,
  tidyNotes,
  extractEstimatedTime,
  formatDate
};
