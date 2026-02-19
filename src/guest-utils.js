/**
 * Shared guest utilities - agent filtering and Salesforce transformation
 *
 * Used by both opera-parser.js (CSV mode) and opera-db-query.js (DB mode)
 */

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

  for (const keyword of AGENT_DOMAIN_KEYWORDS) {
    if (email.indexOf(keyword.toLowerCase()) !== -1) return 'agent-domain';
  }

  return null;
}

/**
 * Map Oracle language codes to Salesforce picklist values
 * @param {string} oracleLanguage - Language code from Oracle NAME.LANGUAGE
 * @returns {string} Salesforce Language__c picklist value (English, Spanish, Portuguese, Unknown)
 */
function mapLanguageToSalesforce(oracleLanguage) {
  if (!oracleLanguage) return 'Unknown';

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

module.exports = {
  AGENT_DOMAIN_KEYWORDS,
  sanitizeEmail,
  isAgentEmail,
  transformToContact,
  transformToTVRSGuest,
  mapLanguageToSalesforce
};
