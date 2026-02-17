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
 * Sanitize email addresses to fix common typos and encoding issues
 * @param {string} email - Raw email from Opera database
 * @returns {string|null} Cleaned email, or null if unfixable
 */
function sanitizeEmail(email) {
  if (!email || typeof email !== 'string') return null;

  // Trim whitespace
  let cleaned = email.trim();

  // Remove trailing punctuation (common typo in Opera)
  cleaned = cleaned.replace(/[.,;]+$/, '');

  // Fix common domain typos: ,br → .br, ,com → .com, etc.
  cleaned = cleaned.replace(/,([a-z]{2,3})$/i, '.$1');

  // Transliterate common international characters to ASCII
  const transliterations = {
    'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u',
    'à': 'a', 'è': 'e', 'ì': 'i', 'ò': 'o', 'ù': 'u',
    'ä': 'a', 'ë': 'e', 'ï': 'i', 'ö': 'o', 'ü': 'u',
    'â': 'a', 'ê': 'e', 'î': 'i', 'ô': 'o', 'û': 'u',
    'ã': 'a', 'õ': 'o', 'ñ': 'n', 'ç': 'c',
    'Á': 'A', 'É': 'E', 'Í': 'I', 'Ó': 'O', 'Ú': 'U',
    'À': 'A', 'È': 'E', 'Ì': 'I', 'Ò': 'O', 'Ù': 'U',
    'Ä': 'A', 'Ë': 'E', 'Ï': 'I', 'Ö': 'O', 'Ü': 'U',
    'Â': 'A', 'Ê': 'E', 'Î': 'I', 'Ô': 'O', 'Û': 'U',
    'Ã': 'A', 'Õ': 'O', 'Ñ': 'N', 'Ç': 'C'
  };

  for (const [char, replacement] of Object.entries(transliterations)) {
    cleaned = cleaned.split(char).join(replacement);
  }

  // Basic validation: must have exactly one @ and a domain with at least one dot
  const parts = cleaned.split('@');
  if (parts.length !== 2) return null; // No @ or multiple @
  if (parts[0].length === 0) return null; // Empty local part
  if (parts[1].length === 0) return null; // Empty domain

  const domain = parts[1];

  // Domain must have at least one dot and valid TLD (2-6 chars after last dot)
  const domainParts = domain.split('.');
  if (domainParts.length < 2) return null; // No TLD

  const tld = domainParts[domainParts.length - 1];
  if (tld.length < 2 || tld.length > 6) return null; // Invalid TLD length
  if (!/^[a-z0-9]+$/i.test(tld)) return null; // TLD must be alphanumeric

  // Check for double dots (unfixable without guessing)
  if (cleaned.includes('..')) return null;

  // Check for trailing dot in domain (incomplete)
  if (domain.endsWith('.')) return null;

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
    Phone: customer.phone || null
    // Note: Contact object doesn't have standard Mailing address fields
    // Address data is stored on TVRS_Guest__c instead
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
