/**
 * Shared guest utilities - agent filtering and Salesforce transformation
 *
 * Used by opera-db-query.js to transform Oracle rows before Salesforce upsert.
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

const KNOWN_PROVIDERS = ['gmail', 'yahoo', 'hotmail', 'outlook', 'aol', 'icloud', 'mail'];

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net',
  'sharklasers.com', 'tempmail.com', 'tempmail.io',
  '10minutemail.com', '10minutemail.net', '10minutemail.org',
  'throwawaymail.com', 'yopmail.com', 'yopmail.fr',
  'trashmail.com', 'dispostable.com', 'getnada.com',
  'mintemail.com', 'maildrop.cc', 'fakeinbox.com', 'tempr.email',
  'mailnesia.com', 'spamgourmet.com', 'meltmail.com',
  'spam4.me', 'mohmal.com', 'tempinbox.com'
]);

const ROLE_MAILBOX_LOCAL_PARTS = new Set([
  'info', 'admin', 'administrator', 'support', 'help', 'helpdesk',
  'hello', 'contact', 'contacts', 'inquiry', 'inquiries', 'enquiry', 'enquiries',
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'sales', 'marketing', 'office', 'team', 'staff',
  'postmaster', 'abuse', 'webmaster', 'hostmaster',
  'reservations', 'reservation', 'booking', 'bookings'
]);

/**
 * Returns true if strings a and b differ by exactly one Damerau-Levenshtein edit:
 * single substitute, single insert, single delete, or single adjacent transposition
 * (e.g. 'gmial' ↔ 'gmail' counts as one edit).
 */
function distanceOne(a, b) {
  if (a === b) return false;
  const la = a.length, lb = b.length;

  if (la === lb) {
    // Collect mismatch positions; either 1 (substitute) or 2 adjacent swapped (transpose)
    const diffs = [];
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) diffs.push(i);
      if (diffs.length > 2) return false;
    }
    if (diffs.length === 1) return true;
    if (diffs.length === 2 && diffs[1] === diffs[0] + 1 &&
        a[diffs[0]] === b[diffs[1]] && a[diffs[1]] === b[diffs[0]]) {
      return true;
    }
    return false;
  }

  if (Math.abs(la - lb) !== 1) return false;
  const longer = la > lb ? a : b;
  const shorter = la > lb ? b : a;
  let i = 0, j = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] !== longer[j]) {
      if (i !== j) return false;
      j++;                                // skip one char in the longer string
    } else { i++; j++; }
  }
  return true;
}

/**
 * Detect domains that look like distance-1 typos of well-known consumer providers
 * paired with a normal TLD (gmial.com, hotmial.com, yhoo.com, etc.). Conservative
 * by design — only matches when the TLD is .com/.net/.org so we don't false-positive
 * on real domains like `gmial.studio`.
 */
function isProviderTypo(domain) {
  const parts = domain.toLowerCase().split('.');
  if (parts.length !== 2) return null;
  const [sl, tld] = parts;
  if (!['com', 'net', 'org'].includes(tld)) return null;
  if (KNOWN_PROVIDERS.includes(sl)) return null;  // exact match — not a typo
  for (const p of KNOWN_PROVIDERS) {
    if (distanceOne(sl, p)) return `${p}.com`;
  }
  return null;
}

/**
 * Returns true if the local part is a generic role/system mailbox
 * (info@, noreply@, sales@, reservations@, etc.). These are deliverable
 * but rarely a real guest's personal address.
 */
function isRoleMailbox(email) {
  if (!email || typeof email !== 'string') return false;
  const at = email.indexOf('@');
  if (at <= 0) return false;
  const local = email.substring(0, at).toLowerCase();
  return ROLE_MAILBOX_LOCAL_PARTS.has(local);
}

/**
 * Returns true if the email's domain is a known disposable / temporary mail provider.
 */
function isDisposableDomain(email) {
  if (!email || typeof email !== 'string') return false;
  const at = email.indexOf('@');
  if (at <= 0) return false;
  return DISPOSABLE_DOMAINS.has(email.substring(at + 1).toLowerCase());
}

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
  const suspiciousTLDs = ['co', 'me', 'tv', 'io', 'to'];

  if (domainParts.length === 2 &&
      KNOWN_PROVIDERS.includes(secondLevel?.toLowerCase()) &&
      suspiciousTLDs.includes(tld.toLowerCase())) {
    return null;
  }

  // Distance-1 typos of well-known providers (gmial.com, hotmial.com, yhoo.com)
  if (isProviderTypo(domain)) return null;

  // Known disposable / temp-mail providers
  if (DISPOSABLE_DOMAINS.has(domain.toLowerCase())) return null;

  // Valid - return as-is (no modifications)
  return cleaned;
}

/**
 * Return a human-readable reason why an email is invalid, or null if valid.
 * Mirrors the checks in sanitizeEmail() but explains the failure.
 */
function emailInvalidReason(email) {
  if (!email || typeof email !== 'string') return 'no email';

  const cleaned = email.trim();
  if (!cleaned) return 'no email';

  if (!/^[\x00-\x7F]*$/.test(cleaned)) return 'non-ASCII characters';

  const parts = cleaned.split('@');
  if (parts.length !== 2) return parts.length === 1 ? 'missing @' : 'multiple @ signs';

  const localPart = parts[0];
  const domain = parts[1];

  if (localPart.length === 0) return 'empty local part';
  if (!domain.includes('.')) return 'domain has no dot';
  if (domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) return 'malformed domain';
  if (/[,;.]$/.test(domain)) return 'domain ends with punctuation';

  const domainParts = domain.split('.');
  const tld = domainParts[domainParts.length - 1];
  if (tld.length < 2 || tld.length > 6 || !/^[a-z0-9]+$/i.test(tld)) return `invalid TLD (.${tld})`;

  const secondLevel = domainParts[domainParts.length - 2];
  const suspiciousTLDs = ['co', 'me', 'tv', 'io', 'to'];

  if (domainParts.length === 2 &&
      KNOWN_PROVIDERS.includes(secondLevel?.toLowerCase()) &&
      suspiciousTLDs.includes(tld.toLowerCase())) {
    return `suspicious provider TLD (${domain})`;
  }

  const typoOf = isProviderTypo(domain);
  if (typoOf) return `likely typo of ${typoOf} (${domain})`;

  if (DISPOSABLE_DOMAINS.has(domain.toLowerCase())) return `disposable email domain (${domain})`;

  return null;
}

/**
 * Check if a customer record looks like a travel agent, non-guest, or
 * incomplete profile.
 *
 * Returns one of: 'booking-proxy', 'expedia-proxy', 'agent-domain',
 * 'missing-first-name', or null.
 *
 * NOTE: 'missing-first-name' is a *soft* signal — surface it in the front
 * desk report but don't block SF sync on it. The other three are hard
 * signals (not real guest records).
 *
 * @param {Object} customer - Customer data with email and firstName fields
 * @returns {string|null} Category string if agent / incomplete, null if normal guest
 */
function isAgentEmail(customer) {
  const email = (customer.email || '').toLowerCase();
  const firstName = (customer.firstName || '').trim();

  if (email.indexOf('guest.booking.com') !== -1) return 'booking-proxy';
  if (email.indexOf('expediapartnercentral.com') !== -1) return 'expedia-proxy';

  if (firstName === '' || firstName === '.' || firstName === 'TBC') return 'missing-first-name';

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
 * Parse a comma-separated list of full guest names (FRONT_DESK_EXCLUDE_GUESTS)
 * into a Set of normalized "first last" keys for case-insensitive matching.
 * Used to keep staff profiles out of the front-desk email-collection section.
 * @param {string} envValue - e.g. "Brenda Carrion, Camila Rosi"
 * @returns {Set<string>} Normalized name keys
 */
function parseExcludedGuestNames(envValue) {
  return new Set(
    (envValue || '')
      .split(',')
      .map(s => s.trim().toLowerCase().replace(/\s+/g, ' '))
      .filter(Boolean)
  );
}

/**
 * Check whether a guest's full name is in the exclusion set from
 * parseExcludedGuestNames().
 * @param {Object} guest - Object with firstName and lastName
 * @param {Set<string>} excludedNames - From parseExcludedGuestNames()
 * @returns {boolean}
 */
function isExcludedGuest(guest, excludedNames) {
  if (!excludedNames || excludedNames.size === 0) return false;
  const key = `${guest.firstName || ''} ${guest.lastName || ''}`
    .trim().toLowerCase().replace(/\s+/g, ' ');
  return excludedNames.has(key);
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
 * Classify a 5xx RCPT TO rejection: 'invalid' only when the server clearly says
 * the recipient/mailbox doesn't exist; 'unknown' (fail open) for IP-reputation,
 * blocklist, greylisting, and other policy rejections — those say nothing about
 * whether the mailbox exists. Example we must NOT treat as invalid:
 *   "550 5.7.1 Mail from IP x was rejected due to listing in Spamhaus SBL"
 * (iCloud/Apple returns this for every address when the sending IP is listed.)
 */
function classifyRcptReject(reply) {
  const r = (reply || '').toLowerCase();
  // Policy / IP-reputation / blocklist / rate-limit — not a mailbox signal.
  const policy = /5\.7\.\d|spamhaus|\bsbl\b|block ?list|black ?list|\bblocked\b|reputation|rejected due to|policy|\bspam\b|grey ?list|rate ?limit|try again|temporar|access denied|not authoriz|relay/;
  if (policy.test(r)) return 'unknown';
  // Clear "no such recipient" signals.
  const badMailbox = /5\.1\.[012]|5\.2\.1|no such (?:user|recipient|mailbox)|unknown user|user unknown|user not found|mailbox (?:unavailable|not found|is disabled|does(?:n'?t| not) exist)|(?:email )?account[^.\n]*disabled|recipient (?:rejected|not found|unknown|address rejected)|invalid (?:recipient|mailbox|address)|address (?:unknown|rejected)|does not exist|no mailbox/;
  if (badMailbox.test(r)) return 'invalid';
  // Ambiguous 5xx — be conservative; don't falsely flag a guest.
  return 'unknown';
}

/**
 * Check a single email via SMTP RCPT TO. Returns 'valid', 'invalid', or 'unknown'.
 * - 'invalid' = server clearly rejected the recipient — mailbox does not exist
 * - 'unknown' = network error, timeout, policy/blocklist 5xx, or ambiguous (fail open)
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
        else if (code >= 550 && code <= 559) resolve(classifyRcptReject(buf));
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
      // No MX record — mail to this domain will bounce
      for (const e of domainEmails) results.set(e, 'no-mx');
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
  DISPOSABLE_DOMAINS,
  ROLE_MAILBOX_LOCAL_PARTS,
  sanitizeEmail,
  emailInvalidReason,
  isAgentEmail,
  isRoleMailbox,
  isDisposableDomain,
  isProviderTypo,
  parseExcludedGuestNames,
  isExcludedGuest,
  transformToContact,
  transformToTVRSGuest,
  mapLanguageToSalesforce,
  GUEST_DIFF_FIELDS,
  GUEST_DIFF_SOQL_FIELDS,
  diffGuestRecord,
  verifyEmailsSMTP,
  classifyRcptReject,
};
