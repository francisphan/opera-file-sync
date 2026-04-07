/**
 * Shared guest utilities - agent filtering and Salesforce transformation
 *
 * Used by both opera-parser.js (CSV mode) and opera-db-query.js (DB mode)
 */

const dns = require('dns');
const net = require('net');
const logger = require('./logger');

/**
 * Agent/non-guest email detection keywords
 */
const AGENT_DOMAIN_KEYWORDS = [
  'reserv', 'travel', 'tour', 'viaje', 'incoming', 'operacion',
  'ventas', 'receptivo', 'mayorista', 'turismo', 'journey', 'experience',
  'expedition', '.tur.', 'dmc', 'mice', 'smartflyer', 'fora.travel',
  'traveledge', 'travelcorp', 'protravelinc', 'globaltravelcollection',
  'cadencetravel', 'dreamvacations', 'tbhtravel', 'foundluxury',
  'privateclients', 'hontravel', 'poptour', 'maintravel', 'kangaroo',
  'primetour', 'booking.com', 'expedia', 'aspirelifestyles',
  'centurioncard', 'vendor@'
];

/**
 * Validate email addresses - no auto-fixing, just validation
 * Any issues are flagged for manual review in the daily report
 * @param {string} email - Raw email from Opera database
 * @returns {string|null} Email if valid, null if invalid (will be tracked in daily report)
 */
function sanitizeEmail(email) {
  if (!email || typeof email !== 'string') return null;

  const cleaned = email.trim();

  // Must be ASCII-only (Salesforce requirement)
  if (!/^[\x00-\x7F]*$/.test(cleaned)) {
    return null;
  }

  // Must have exactly one @
  const parts = cleaned.split('@');
  if (parts.length !== 2) return null;

  const localPart = parts[0];
  const domain = parts[1];

  // Local part must not be empty
  if (localPart.length === 0) return null;

  // Domain must have at least one dot
  if (!domain.includes('.')) return null;

  // Domain must not have double dots, trailing/leading dots, or other obvious issues
  if (domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) {
    return null;
  }

  // Domain must not end with comma or other punctuation (common typo)
  if (/[,;.]$/.test(domain)) {
    return null;
  }

  // Must have valid TLD (2-6 alphanumeric chars after final dot)
  const domainParts = domain.split('.');
  const tld = domainParts[domainParts.length - 1];
  if (tld.length < 2 || tld.length > 6 || !/^[a-z0-9]+$/i.test(tld)) {
    return null;
  }

  // Suspicious: known email providers with short TLDs (likely typos)
  const secondLevel = domainParts[domainParts.length - 2];
  const knownProviders = ['gmail', 'yahoo', 'hotmail', 'outlook', 'aol', 'icloud', 'mail'];
  const suspiciousTLDs = ['co', 'me', 'tv', 'io', 'to'];

  if (domainParts.length === 2 &&
      knownProviders.includes(secondLevel?.toLowerCase()) &&
      suspiciousTLDs.includes(tld.toLowerCase())) {
    return null;
  }

  // Valid - return as-is (no modifications)
  return cleaned;
}

/**
 * Check if a customer record looks like a travel agent or non-guest
 * @param {Object} customer - Customer data with email and firstName fields
 * @returns {string|null} Category string if agent, null if guest
 */
function isAgentEmail(customer) {
  const email = (customer.email || '').toLowerCase();
  const firstName = (customer.firstName || '').trim();

  if (email.indexOf('guest.booking.com') !== -1) return 'booking-proxy';
  if (email.indexOf('expediapartnercentral.com') !== -1) return 'expedia-proxy';

  if (firstName === '' || firstName === '.' || firstName === 'TBC') return 'company';

  // Match keywords against domain part only to avoid false positives
  // (e.g., 'preserv@gmail.com' should NOT match 'reserv')
  // Keywords containing '@' (like 'vendor@') match the full email instead
  const atIndex = email.indexOf('@');
  const domain = atIndex !== -1 ? email.substring(atIndex + 1) : '';

  for (const keyword of AGENT_DOMAIN_KEYWORDS) {
    const kw = keyword.toLowerCase();
    const target = kw.includes('@') ? email : domain;
    if (target.indexOf(kw) !== -1) return 'agent-domain';
  }

  return null;
}

/**
 * Map Oracle language codes to Salesforce picklist values
 * @param {string} oracleLanguage - Language code from Oracle NAME.LANGUAGE
 * @returns {string} Salesforce Language__c picklist value (English, Spanish, Portuguese, Unknown)
 */
function mapLanguageToSalesforce(oracleLanguage) {
  if (!oracleLanguage || typeof oracleLanguage !== 'string') return 'Unknown';

  const lang = oracleLanguage.toUpperCase().trim();

  // Map Oracle codes to SF picklist: English, Spanish, Portuguese, Unknown
  if (lang.includes('ENG') || lang === 'E' || lang === 'EN') return 'English';
  if (lang.includes('SPA') || lang === 'SP' || lang === 'S' || lang === 'ES' || lang.includes('ESP')) return 'Spanish';
  if (lang.includes('POR') || lang === 'PR' || lang === 'P' || lang === 'PT' || lang.includes('PORTUG')) return 'Portuguese';

  // Default to Unknown for unrecognized codes
  return 'Unknown';
}

/**
 * Transform guest data to Salesforce Contact format
 * @param {Object} customer - Customer data (email, firstName, lastName, phone, language, billingCity, billingState, billingCountry)
 * @returns {Object} Salesforce Contact record
 */
function transformToContact(customer) {
  return {
    Email: customer.email,
    FirstName: customer.firstName,
    LastName: customer.lastName,
    Phone: customer.phone || null,
    // Note: Contact object doesn't have standard Mailing address fields
    // Address data is stored on TVRS_Guest__c instead
    Has_TVRS_Guest_Record__c: true
  };
}

/**
 * Transform guest data to TVRS_Guest__c format
 * @param {Object} customer - Customer data (email, firstName, lastName, phone, language, billingCity, billingState, billingCountry)
 * @param {Object} invoice - Invoice/reservation data with checkIn/checkOut (optional)
 * @param {string} [contactId] - Salesforce Contact ID to link via lookup
 * @returns {Object} Salesforce TVRS_Guest__c record
 */
function transformToTVRSGuest(customer, invoice, contactId) {
  const contactLookup = process.env.SF_GUEST_CONTACT_LOOKUP || 'Contact__c';

  const record = {
    // External ID
    Email__c: customer.email,

    // Guest information
    Guest_First_Name__c: customer.firstName,
    Guest_Last_Name__c: customer.lastName,

    // Address information
    City__c: customer.billingCity,
    State_Province__c: customer.billingState,
    Country__c: customer.billingCountry,

    // Contact information
    Telephone__c: customer.phone || null,
    Language__c: mapLanguageToSalesforce(customer.language),

    // Required boolean fields (all default to false)
    Future_Sales_Prospect__c: false,
    TVG__c: false,
    Greeted_at_Check_In__c: false,
    Received_PV_Explanation__c: false,
    Vineyard_Tour__c: false,
    Did_TVG_Tasting_With_Sales_Rep__c: false,
    Did_TVG_Tasting_with_Sommelier__c: false,
    Villa_Tour__c: false,
    Attended_Happy_Hour__c: false,
    Brochure_Clicked__c: false,
    Replied_to_Mkt_campaign_2025__c: false,
    In_Conversation__c: false,
    Not_interested__c: false,
    Ready_for_pardot_email_list__c: false,
    In_Conversation_PV__c: false,
    Follow_up__c: false,
    Ready_for_PV_mail__c: false
  };

  // Link to Contact if provided
  if (contactId) {
    record[contactLookup] = contactId;
  }

  // Add check-in/out dates if available
  if (invoice) {
    if (invoice.checkIn) {
      record.Check_In_Date__c = invoice.checkIn;
    }
    if (invoice.checkOut) {
      record.Check_Out_Date__c = invoice.checkOut;
    }
  }

  return record;
}

/**
 * All fields written by transformToTVRSGuest — used for SOQL fetches and field diffing.
 */
const GUEST_DIFF_FIELDS = [
  { key: 'Guest_First_Name__c',               label: 'First Name' },
  { key: 'Guest_Last_Name__c',                label: 'Last Name' },
  { key: 'City__c',                           label: 'City' },
  { key: 'State_Province__c',                 label: 'State/Province' },
  { key: 'Country__c',                        label: 'Country' },
  { key: 'Telephone__c',                      label: 'Phone' },
  { key: 'Language__c',                       label: 'Language' },
  { key: 'Check_In_Date__c',                  label: 'Check-in Date' },
  { key: 'Check_Out_Date__c',                 label: 'Check-out Date' },
  { key: 'Future_Sales_Prospect__c',          label: 'Future Sales Prospect',         boolean: true },
  { key: 'TVG__c',                            label: 'TVG',                           boolean: true },
  { key: 'Greeted_at_Check_In__c',            label: 'Greeted at Check-in',           boolean: true },
  { key: 'Received_PV_Explanation__c',        label: 'Received PV Explanation',       boolean: true },
  { key: 'Vineyard_Tour__c',                  label: 'Vineyard Tour',                 boolean: true },
  { key: 'Did_TVG_Tasting_With_Sales_Rep__c', label: 'TVG Tasting (Sales Rep)',       boolean: true },
  { key: 'Did_TVG_Tasting_with_Sommelier__c', label: 'TVG Tasting (Sommelier)',       boolean: true },
  { key: 'Villa_Tour__c',                     label: 'Villa Tour',                    boolean: true },
  { key: 'Attended_Happy_Hour__c',            label: 'Attended Happy Hour',           boolean: true },
  { key: 'Brochure_Clicked__c',               label: 'Brochure Clicked',              boolean: true },
  { key: 'Replied_to_Mkt_campaign_2025__c',   label: 'Replied to Mkt Campaign 2025', boolean: true },
  { key: 'In_Conversation__c',                label: 'In Conversation',               boolean: true },
  { key: 'Not_interested__c',                 label: 'Not Interested',                boolean: true },
  { key: 'Ready_for_pardot_email_list__c',    label: 'Ready for Pardot Email List',   boolean: true },
  { key: 'In_Conversation_PV__c',             label: 'In Conversation (PV)',          boolean: true },
  { key: 'Follow_up__c',                      label: 'Follow Up',                     boolean: true },
  { key: 'Ready_for_PV_mail__c',              label: 'Ready for PV Mail',             boolean: true },
];

const GUEST_DIFF_SOQL_FIELDS = GUEST_DIFF_FIELDS.map(f => f.key).join(', ');

/**
 * Diff a current Salesforce TVRS_Guest__c record against a proposed incoming record.
 * Returns only the fields that would actually change.
 * Boolean fields: null/undefined treated as false.
 * Text fields: null/undefined treated as empty string.
 */
function diffGuestRecord(current, proposed) {
  const changes = [];
  for (const field of GUEST_DIFF_FIELDS) {
    const cur = field.boolean ? (current[field.key] ?? false) : (current[field.key] ?? null);
    const pro = field.boolean ? (proposed[field.key] ?? false) : (proposed[field.key] ?? null);
    const curStr = cur === null ? '' : String(cur);
    const proStr = pro === null ? '' : String(pro);
    if (curStr !== proStr) {
      changes.push({ ...field, from: cur, to: pro });
    }
  }
  return changes;
}

/**
 * Resolve MX host for a domain. Returns the lowest-priority MX hostname, or null on failure.
 */
function resolveMx(domain) {
  return new Promise((resolve) => {
    dns.resolveMx(domain, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) return resolve(null);
      addresses.sort((a, b) => a.priority - b.priority);
      resolve(addresses[0].exchange);
    });
  });
}

/**
 * Check a single email via SMTP RCPT TO. Returns 'valid', 'invalid', or 'unknown'.
 * - 'invalid' = server explicitly rejected (550) — mailbox does not exist
 * - 'unknown' = network error, timeout, or ambiguous response (fail open)
 * - 'valid' = server accepted the recipient (250)
 */
function smtpCheck(mxHost, email, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(25, mxHost);
    let step = 'connect';
    let buf = '';
    const timer = setTimeout(() => { socket.destroy(); resolve('unknown'); }, timeoutMs);

    function send(cmd, nextStep) {
      step = nextStep;
      buf = '';
      socket.write(cmd + '\r\n');
    }

    socket.setEncoding('utf8');
    socket.on('data', (data) => {
      buf += data;
      // Wait for a complete reply line (ends with \r\n and starts with a 3-digit code)
      if (!/^\d{3}[ ]/m.test(buf)) return;
      const code = parseInt(buf.substring(0, 3), 10);

      if (step === 'connect') {
        if (code === 220) send('EHLO verify.local', 'ehlo');
        else { clearTimeout(timer); socket.destroy(); resolve('unknown'); }
      } else if (step === 'ehlo') {
        if (code === 250) send('MAIL FROM:<>', 'mail');
        else { clearTimeout(timer); socket.destroy(); resolve('unknown'); }
      } else if (step === 'mail') {
        if (code === 250) send(`RCPT TO:<${email}>`, 'rcpt');
        else { clearTimeout(timer); socket.destroy(); resolve('unknown'); }
      } else if (step === 'rcpt') {
        clearTimeout(timer);
        socket.write('QUIT\r\n');
        socket.destroy();
        if (code === 250) resolve('valid');
        else if (code >= 550 && code <= 559) resolve('invalid');
        else resolve('unknown');
      }
    });

    socket.on('error', () => { clearTimeout(timer); resolve('unknown'); });
    socket.on('timeout', () => { clearTimeout(timer); socket.destroy(); resolve('unknown'); });
  });
}

/**
 * Verify a batch of emails via SMTP. Groups by domain to reuse MX lookups.
 * Returns a Map<email, 'valid'|'invalid'|'unknown'>.
 * Fails open: network errors → 'unknown' (email proceeds normally).
 */
async function verifyEmailsSMTP(emails) {
  const results = new Map();
  if (!emails || emails.length === 0) return results;

  // Group emails by domain
  const byDomain = new Map();
  for (const email of emails) {
    const domain = email.split('@')[1].toLowerCase();
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(email);
  }

  // Process each domain in parallel
  const domainChecks = [...byDomain.entries()].map(async ([domain, domainEmails]) => {
    const mxHost = await resolveMx(domain);
    if (!mxHost) {
      // Can't resolve MX — mark all as unknown (fail open)
      for (const e of domainEmails) results.set(e, 'unknown');
      return;
    }

    // Check each email for this domain sequentially (avoid overwhelming the server)
    for (const email of domainEmails) {
      const result = await smtpCheck(mxHost, email);
      results.set(email, result);
    }
  });

  await Promise.all(domainChecks);
  return results;
}

module.exports = {
  AGENT_DOMAIN_KEYWORDS,
  sanitizeEmail,
  isAgentEmail,
  transformToContact,
  transformToTVRSGuest,
  mapLanguageToSalesforce,
  GUEST_DIFF_FIELDS,
  GUEST_DIFF_SOQL_FIELDS,
  diffGuestRecord,
  verifyEmailsSMTP,
};
