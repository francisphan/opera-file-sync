#!/usr/bin/env node

/**
 * Unit tests for guest-utils.js
 * Run with: node --test tests/test-guest-utils.js
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeEmail,
  isAgentEmail,
  mapLanguageToSalesforce,
  transformToContact,
  transformToTVRSGuest,
  diffGuestRecord,
  AGENT_DOMAIN_KEYWORDS,
  GUEST_DIFF_FIELDS,
  GUEST_DIFF_SOQL_FIELDS,
} = require('../src/guest-utils');

// ---------------------------------------------------------------------------
// sanitizeEmail
// ---------------------------------------------------------------------------
describe('sanitizeEmail', () => {
  describe('valid emails pass through unchanged', () => {
    test('simple email', () => {
      assert.equal(sanitizeEmail('user@example.com'), 'user@example.com');
    });

    test('email with subdomain', () => {
      assert.equal(sanitizeEmail('user@mail.example.com'), 'user@mail.example.com');
    });

    test('plus addressing', () => {
      assert.equal(sanitizeEmail('user+tag@gmail.com'), 'user+tag@gmail.com');
    });

    test('dots in local part', () => {
      assert.equal(sanitizeEmail('first.last@example.com'), 'first.last@example.com');
    });

    test('long TLD (.museum)', () => {
      assert.equal(sanitizeEmail('user@example.museum'), 'user@example.museum');
    });

    test('numeric local part', () => {
      assert.equal(sanitizeEmail('12345@example.com'), '12345@example.com');
    });

    test('preserves case (does NOT lowercase)', () => {
      assert.equal(sanitizeEmail('John.Doe@Example.COM'), 'John.Doe@Example.COM');
    });

    test('trims whitespace but preserves content', () => {
      assert.equal(sanitizeEmail('  user@example.com  '), 'user@example.com');
    });
  });

  describe('null / undefined / empty / non-string returns null', () => {
    test('null', () => {
      assert.equal(sanitizeEmail(null), null);
    });

    test('undefined', () => {
      assert.equal(sanitizeEmail(undefined), null);
    });

    test('empty string', () => {
      assert.equal(sanitizeEmail(''), null);
    });

    test('number', () => {
      assert.equal(sanitizeEmail(123), null);
    });

    test('boolean', () => {
      assert.equal(sanitizeEmail(true), null);
    });

    test('object', () => {
      assert.equal(sanitizeEmail({}), null);
    });
  });

  describe('non-ASCII characters return null', () => {
    test('accented characters', () => {
      assert.equal(sanitizeEmail('usér@example.com'), null);
    });

    test('unicode in domain', () => {
      assert.equal(sanitizeEmail('user@exämple.com'), null);
    });

    test('emoji', () => {
      assert.equal(sanitizeEmail('user😀@example.com'), null);
    });
  });

  describe('multiple @ signs return null', () => {
    test('two @ signs', () => {
      assert.equal(sanitizeEmail('user@@example.com'), null);
    });

    test('@ in local and domain', () => {
      assert.equal(sanitizeEmail('us@er@example.com'), null);
    });
  });

  describe('missing local part returns null', () => {
    test('empty local part', () => {
      assert.equal(sanitizeEmail('@example.com'), null);
    });
  });

  describe('domain without dot returns null', () => {
    test('no dot in domain', () => {
      assert.equal(sanitizeEmail('user@localhost'), null);
    });
  });

  describe('domain with double dots returns null', () => {
    test('double dot in domain', () => {
      assert.equal(sanitizeEmail('user@example..com'), null);
    });
  });

  describe('domain with leading/trailing dots returns null', () => {
    test('leading dot', () => {
      assert.equal(sanitizeEmail('user@.example.com'), null);
    });

    test('trailing dot', () => {
      assert.equal(sanitizeEmail('user@example.com.'), null);
    });
  });

  describe('domain ending with comma or semicolon returns null', () => {
    test('trailing comma', () => {
      assert.equal(sanitizeEmail('user@example.com,'), null);
    });

    test('trailing semicolon', () => {
      assert.equal(sanitizeEmail('user@example.com;'), null);
    });
  });

  describe('TLD too short (1 char) or too long (7+ chars) returns null', () => {
    test('TLD 1 char', () => {
      assert.equal(sanitizeEmail('user@example.c'), null);
    });

    test('TLD 7 chars', () => {
      assert.equal(sanitizeEmail('user@example.abcdefg'), null);
    });

    test('TLD exactly 6 chars is valid', () => {
      assert.equal(sanitizeEmail('user@example.abcdef'), 'user@example.abcdef');
    });

    test('TLD exactly 2 chars is valid', () => {
      assert.equal(sanitizeEmail('user@example.uk'), 'user@example.uk');
    });
  });

  describe('TLD with special characters returns null', () => {
    test('TLD with hyphen', () => {
      assert.equal(sanitizeEmail('user@example.c-m'), null);
    });

    test('TLD with underscore', () => {
      assert.equal(sanitizeEmail('user@example.c_m'), null);
    });

    test('TLD with space', () => {
      assert.equal(sanitizeEmail('user@example.c m'), null);
    });
  });

  describe('suspicious provider+TLD combos return null', () => {
    test('gmail.co', () => {
      assert.equal(sanitizeEmail('user@gmail.co'), null);
    });

    test('yahoo.me', () => {
      assert.equal(sanitizeEmail('user@yahoo.me'), null);
    });

    test('hotmail.io', () => {
      assert.equal(sanitizeEmail('user@hotmail.io'), null);
    });

    test('outlook.tv', () => {
      assert.equal(sanitizeEmail('user@outlook.tv'), null);
    });

    test('aol.to', () => {
      assert.equal(sanitizeEmail('user@aol.to'), null);
    });

    test('icloud.co', () => {
      assert.equal(sanitizeEmail('user@icloud.co'), null);
    });

    test('mail.io', () => {
      assert.equal(sanitizeEmail('user@mail.io'), null);
    });

    test('gmail.com is NOT suspicious (normal)', () => {
      assert.equal(sanitizeEmail('user@gmail.com'), 'user@gmail.com');
    });

    test('subdomain gmail does NOT trigger suspicious check (3+ domain parts)', () => {
      assert.equal(sanitizeEmail('user@gmail.co.uk'), 'user@gmail.co.uk');
    });
  });
});

// ---------------------------------------------------------------------------
// isAgentEmail
// ---------------------------------------------------------------------------
describe('isAgentEmail', () => {
  test('returns null for regular guest email', () => {
    assert.equal(isAgentEmail({ email: 'john@gmail.com', firstName: 'John' }), null);
  });

  test('returns booking-proxy for guest.booking.com', () => {
    assert.equal(
      isAgentEmail({ email: 'abc123@guest.booking.com', firstName: 'Jane' }),
      'booking-proxy'
    );
  });

  test('returns expedia-proxy for expediapartnercentral.com', () => {
    assert.equal(
      isAgentEmail({ email: 'res@expediapartnercentral.com', firstName: 'Exp' }),
      'expedia-proxy'
    );
  });

  describe('returns company for empty/placeholder firstName', () => {
    test('empty firstName', () => {
      assert.equal(isAgentEmail({ email: 'info@hotel.com', firstName: '' }), 'company');
    });

    test('dot firstName', () => {
      assert.equal(isAgentEmail({ email: 'info@hotel.com', firstName: '.' }), 'company');
    });

    test('TBC firstName', () => {
      assert.equal(isAgentEmail({ email: 'info@hotel.com', firstName: 'TBC' }), 'company');
    });

    test('whitespace-only firstName is treated as empty', () => {
      assert.equal(isAgentEmail({ email: 'info@hotel.com', firstName: '   ' }), 'company');
    });
  });

  describe('returns agent-domain for AGENT_DOMAIN_KEYWORDS matches', () => {
    test('reserv keyword', () => {
      assert.equal(
        isAgentEmail({ email: 'info@reservations.com', firstName: 'Agent' }),
        'agent-domain'
      );
    });

    test('travel keyword', () => {
      assert.equal(
        isAgentEmail({ email: 'info@travel-agency.com', firstName: 'Agent' }),
        'agent-domain'
      );
    });

    test('tour keyword', () => {
      assert.equal(
        isAgentEmail({ email: 'info@besttour.com', firstName: 'Agent' }),
        'agent-domain'
      );
    });

    test('vendor@ keyword', () => {
      assert.equal(
        isAgentEmail({ email: 'vendor@anycompany.com', firstName: 'Agent' }),
        'agent-domain'
      );
    });

    test('expedia keyword (via domain keywords)', () => {
      assert.equal(
        isAgentEmail({ email: 'info@expedia.com', firstName: 'Agent' }),
        'agent-domain'
      );
    });
  });

  describe('domain-only matching (no false positives on local part)', () => {
    test('keyword in local part only does NOT match', () => {
      // 'preserv@gmail.com' should NOT match 'reserv' — keyword is in local part, not domain
      assert.equal(
        isAgentEmail({ email: 'preserv@gmail.com', firstName: 'John' }),
        null
      );
    });

    test('keyword in domain still matches', () => {
      assert.equal(
        isAgentEmail({ email: 'info@reservations.com', firstName: 'John' }),
        'agent-domain'
      );
    });

    test('vendor@ keyword matches full email (local part keyword)', () => {
      // 'vendor@' is a special keyword containing @ — matches full email
      assert.equal(
        isAgentEmail({ email: 'vendor@anycompany.com', firstName: 'John' }),
        'agent-domain'
      );
    });
  });

  describe('case insensitive matching', () => {
    test('uppercase booking proxy', () => {
      assert.equal(
        isAgentEmail({ email: 'ABC@GUEST.BOOKING.COM', firstName: 'Jane' }),
        'booking-proxy'
      );
    });

    test('mixed case agent domain keyword', () => {
      assert.equal(
        isAgentEmail({ email: 'info@BigTravelCo.com', firstName: 'Agent' }),
        'agent-domain'
      );
    });
  });

  describe('null/undefined email and firstName handling', () => {
    test('null email', () => {
      assert.equal(isAgentEmail({ email: null, firstName: 'John' }), null);
    });

    test('undefined email', () => {
      assert.equal(isAgentEmail({ email: undefined, firstName: 'John' }), null);
    });

    test('null firstName treated as empty → company', () => {
      assert.equal(isAgentEmail({ email: 'info@hotel.com', firstName: null }), 'company');
    });

    test('undefined firstName treated as empty → company', () => {
      assert.equal(isAgentEmail({ email: 'info@hotel.com', firstName: undefined }), 'company');
    });

    test('missing both fields', () => {
      assert.equal(isAgentEmail({}), 'company');
    });
  });
});

// ---------------------------------------------------------------------------
// mapLanguageToSalesforce
// ---------------------------------------------------------------------------
describe('mapLanguageToSalesforce', () => {
  describe('null / undefined / empty / non-string returns Unknown', () => {
    test('null', () => {
      assert.equal(mapLanguageToSalesforce(null), 'Unknown');
    });

    test('undefined', () => {
      assert.equal(mapLanguageToSalesforce(undefined), 'Unknown');
    });

    test('empty string', () => {
      assert.equal(mapLanguageToSalesforce(''), 'Unknown');
    });

    test('number', () => {
      assert.equal(mapLanguageToSalesforce(42), 'Unknown');
    });
  });

  describe('English codes', () => {
    for (const code of ['ENG', 'E', 'EN', 'ENGLISH']) {
      test(`'${code}' maps to English`, () => {
        assert.equal(mapLanguageToSalesforce(code), 'English');
      });
    }
  });

  describe('Spanish codes', () => {
    for (const code of ['SPA', 'SP', 'S', 'ES', 'ESP', 'ESPANOL']) {
      test(`'${code}' maps to Spanish`, () => {
        assert.equal(mapLanguageToSalesforce(code), 'Spanish');
      });
    }
  });

  describe('Portuguese codes', () => {
    for (const code of ['POR', 'PR', 'P', 'PT', 'PORTUG', 'PORTUGUESE']) {
      test(`'${code}' maps to Portuguese`, () => {
        assert.equal(mapLanguageToSalesforce(code), 'Portuguese');
      });
    }
  });

  describe('unknown codes return Unknown', () => {
    for (const code of ['FR', 'DE', 'JP', 'XX', 'FRENCH', 'ZZ']) {
      test(`'${code}' maps to Unknown`, () => {
        assert.equal(mapLanguageToSalesforce(code), 'Unknown');
      });
    }
  });

  describe('whitespace handling', () => {
    test('leading/trailing spaces', () => {
      assert.equal(mapLanguageToSalesforce('  ENG  '), 'English');
    });

    test('tabs', () => {
      assert.equal(mapLanguageToSalesforce('\tSPA\t'), 'Spanish');
    });
  });

  describe('case insensitive', () => {
    test('lowercase eng', () => {
      assert.equal(mapLanguageToSalesforce('eng'), 'English');
    });

    test('mixed case Eng', () => {
      assert.equal(mapLanguageToSalesforce('Eng'), 'English');
    });

    test('uppercase ENG', () => {
      assert.equal(mapLanguageToSalesforce('ENG'), 'English');
    });

    test('lowercase spa', () => {
      assert.equal(mapLanguageToSalesforce('spa'), 'Spanish');
    });

    test('lowercase por', () => {
      assert.equal(mapLanguageToSalesforce('por'), 'Portuguese');
    });
  });
});

// ---------------------------------------------------------------------------
// transformToContact
// ---------------------------------------------------------------------------
describe('transformToContact', () => {
  test('maps fields correctly', () => {
    const customer = {
      email: 'john@example.com',
      firstName: 'John',
      lastName: 'Doe',
      phone: '+1234567890',
      language: 'ENG',
      billingCity: 'Santiago',
      billingState: 'RM',
      billingCountry: 'Chile',
    };
    const result = transformToContact(customer);

    assert.equal(result.Email, 'john@example.com');
    assert.equal(result.FirstName, 'John');
    assert.equal(result.LastName, 'Doe');
    assert.equal(result.Phone, '+1234567890');
    assert.equal(result.Has_TVRS_Guest_Record__c, true);
  });

  test('Phone is null when empty string', () => {
    const customer = { email: 'a@b.com', firstName: 'A', lastName: 'B', phone: '' };
    const result = transformToContact(customer);
    assert.equal(result.Phone, null);
  });

  test('Phone is null when undefined', () => {
    const customer = { email: 'a@b.com', firstName: 'A', lastName: 'B' };
    const result = transformToContact(customer);
    assert.equal(result.Phone, null);
  });

  test('Has_TVRS_Guest_Record__c is always true', () => {
    const result = transformToContact({ email: 'a@b.com', firstName: 'A', lastName: 'B' });
    assert.equal(result.Has_TVRS_Guest_Record__c, true);
  });
});

// ---------------------------------------------------------------------------
// transformToTVRSGuest
// ---------------------------------------------------------------------------
describe('transformToTVRSGuest', () => {
  const baseCustomer = {
    email: 'guest@example.com',
    firstName: 'Jane',
    lastName: 'Smith',
    billingCity: 'Napa',
    billingState: 'CA',
    billingCountry: 'US',
    phone: '+5551234',
    language: 'SPA',
  };

  test('maps all fields correctly', () => {
    const result = transformToTVRSGuest(baseCustomer, null, null);

    assert.equal(result.Email__c, 'guest@example.com');
    assert.equal(result.Guest_First_Name__c, 'Jane');
    assert.equal(result.Guest_Last_Name__c, 'Smith');
    assert.equal(result.City__c, 'Napa');
    assert.equal(result.State_Province__c, 'CA');
    assert.equal(result.Country__c, 'US');
    assert.equal(result.Telephone__c, '+5551234');
    assert.equal(result.Language__c, 'Spanish');
  });

  test('boolean fields all default to false', () => {
    const result = transformToTVRSGuest(baseCustomer, null, null);

    const booleanFields = [
      'Future_Sales_Prospect__c', 'TVG__c', 'Greeted_at_Check_In__c',
      'Received_PV_Explanation__c', 'Vineyard_Tour__c',
      'Did_TVG_Tasting_With_Sales_Rep__c', 'Did_TVG_Tasting_with_Sommelier__c',
      'Villa_Tour__c', 'Attended_Happy_Hour__c', 'Brochure_Clicked__c',
      'Replied_to_Mkt_campaign_2025__c', 'In_Conversation__c',
      'Not_interested__c', 'Ready_for_pardot_email_list__c',
      'In_Conversation_PV__c', 'Follow_up__c', 'Ready_for_PV_mail__c',
    ];
    for (const field of booleanFields) {
      assert.equal(result[field], false, `${field} should be false`);
    }
  });

  test('Phone null when empty string', () => {
    const customer = { ...baseCustomer, phone: '' };
    const result = transformToTVRSGuest(customer, null, null);
    assert.equal(result.Telephone__c, null);
  });

  test('Contact lookup set when contactId provided', () => {
    const result = transformToTVRSGuest(baseCustomer, null, '003XXXXXXXXXXXX');
    assert.equal(result.Contact__c, '003XXXXXXXXXXXX');
  });

  test('Contact lookup uses SF_GUEST_CONTACT_LOOKUP env var', () => {
    const orig = process.env.SF_GUEST_CONTACT_LOOKUP;
    process.env.SF_GUEST_CONTACT_LOOKUP = 'Custom_Contact__c';
    try {
      const result = transformToTVRSGuest(baseCustomer, null, '003XXXXXXXXXXXX');
      assert.equal(result.Custom_Contact__c, '003XXXXXXXXXXXX');
      assert.equal(result.Contact__c, undefined);
    } finally {
      if (orig === undefined) {
        delete process.env.SF_GUEST_CONTACT_LOOKUP;
      } else {
        process.env.SF_GUEST_CONTACT_LOOKUP = orig;
      }
    }
  });

  test('no contact lookup key when contactId is falsy', () => {
    const result = transformToTVRSGuest(baseCustomer, null, null);
    assert.equal(result.Contact__c, undefined);
  });

  test('check-in/out dates set from invoice', () => {
    const invoice = { checkIn: '2026-03-20', checkOut: '2026-03-25' };
    const result = transformToTVRSGuest(baseCustomer, invoice, null);
    assert.equal(result.Check_In_Date__c, '2026-03-20');
    assert.equal(result.Check_Out_Date__c, '2026-03-25');
  });

  test('missing invoice produces no date fields', () => {
    const result = transformToTVRSGuest(baseCustomer, null, null);
    assert.equal(result.Check_In_Date__c, undefined);
    assert.equal(result.Check_Out_Date__c, undefined);
  });

  test('invoice with only checkIn', () => {
    const invoice = { checkIn: '2026-03-20' };
    const result = transformToTVRSGuest(baseCustomer, invoice, null);
    assert.equal(result.Check_In_Date__c, '2026-03-20');
    assert.equal(result.Check_Out_Date__c, undefined);
  });

  test('invoice with only checkOut', () => {
    const invoice = { checkOut: '2026-03-25' };
    const result = transformToTVRSGuest(baseCustomer, invoice, null);
    assert.equal(result.Check_In_Date__c, undefined);
    assert.equal(result.Check_Out_Date__c, '2026-03-25');
  });
});

// ---------------------------------------------------------------------------
// diffGuestRecord
// ---------------------------------------------------------------------------
describe('diffGuestRecord', () => {
  test('no changes returns empty array', () => {
    const record = {
      Guest_First_Name__c: 'Jane',
      Guest_Last_Name__c: 'Smith',
      City__c: 'Napa',
      State_Province__c: 'CA',
      Country__c: 'US',
      Telephone__c: '+555',
      Language__c: 'English',
      Check_Out_Date__c: '2026-03-25',
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
      Ready_for_PV_mail__c: false,
    };
    const changes = diffGuestRecord(record, { ...record });
    assert.equal(changes.length, 0);
  });

  test('text field change detected', () => {
    const current = { Guest_First_Name__c: 'Jane' };
    const proposed = { Guest_First_Name__c: 'Janet' };
    const changes = diffGuestRecord(current, proposed);
    const nameChange = changes.find(c => c.key === 'Guest_First_Name__c');
    assert.ok(nameChange, 'should detect first name change');
    assert.equal(nameChange.from, 'Jane');
    assert.equal(nameChange.to, 'Janet');
    assert.equal(nameChange.label, 'First Name');
  });

  test('boolean field: null/undefined vs false produces no change', () => {
    const current = { TVG__c: null };
    const proposed = { TVG__c: false };
    const changes = diffGuestRecord(current, proposed);
    const tvgChange = changes.find(c => c.key === 'TVG__c');
    assert.equal(tvgChange, undefined, 'null and false should be treated as equal for booleans');
  });

  test('boolean field: undefined vs false produces no change', () => {
    const current = {};
    const proposed = { TVG__c: false };
    const changes = diffGuestRecord(current, proposed);
    const tvgChange = changes.find(c => c.key === 'TVG__c');
    assert.equal(tvgChange, undefined);
  });

  test('boolean field: false vs true produces change', () => {
    const current = { TVG__c: false };
    const proposed = { TVG__c: true };
    const changes = diffGuestRecord(current, proposed);
    const tvgChange = changes.find(c => c.key === 'TVG__c');
    assert.ok(tvgChange, 'should detect boolean change');
    assert.equal(tvgChange.from, false);
    assert.equal(tvgChange.to, true);
  });

  test('text field: null vs empty string produces no change', () => {
    const current = { Guest_First_Name__c: null };
    const proposed = { Guest_First_Name__c: '' };
    const changes = diffGuestRecord(current, proposed);
    const nameChange = changes.find(c => c.key === 'Guest_First_Name__c');
    assert.equal(nameChange, undefined, 'null and empty string should be treated as equal for text');
  });

  test('text field: undefined vs null produces no change', () => {
    const current = {};
    const proposed = { City__c: null };
    const changes = diffGuestRecord(current, proposed);
    const cityChange = changes.find(c => c.key === 'City__c');
    assert.equal(cityChange, undefined);
  });

  test('multiple changes detected', () => {
    const current = {
      Guest_First_Name__c: 'Jane',
      City__c: 'Napa',
      TVG__c: false,
    };
    const proposed = {
      Guest_First_Name__c: 'Janet',
      City__c: 'Sonoma',
      TVG__c: true,
    };
    const changes = diffGuestRecord(current, proposed);
    const changedKeys = changes.map(c => c.key);
    assert.ok(changedKeys.includes('Guest_First_Name__c'));
    assert.ok(changedKeys.includes('City__c'));
    assert.ok(changedKeys.includes('TVG__c'));
  });

  test('returns field metadata (key, label, from, to)', () => {
    const current = { Language__c: 'English' };
    const proposed = { Language__c: 'Spanish' };
    const changes = diffGuestRecord(current, proposed);
    const langChange = changes.find(c => c.key === 'Language__c');
    assert.ok(langChange);
    assert.equal(langChange.key, 'Language__c');
    assert.equal(langChange.label, 'Language');
    assert.equal(langChange.from, 'English');
    assert.equal(langChange.to, 'Spanish');
  });

  test('boolean fields include boolean flag in metadata', () => {
    const current = { TVG__c: false };
    const proposed = { TVG__c: true };
    const changes = diffGuestRecord(current, proposed);
    const tvgChange = changes.find(c => c.key === 'TVG__c');
    assert.equal(tvgChange.boolean, true);
  });
});

// ---------------------------------------------------------------------------
// Exports sanity checks
// ---------------------------------------------------------------------------
describe('module exports', () => {
  test('AGENT_DOMAIN_KEYWORDS is a non-empty array', () => {
    assert.ok(Array.isArray(AGENT_DOMAIN_KEYWORDS));
    assert.ok(AGENT_DOMAIN_KEYWORDS.length > 0);
  });

  test('GUEST_DIFF_FIELDS is a non-empty array with key and label', () => {
    assert.ok(Array.isArray(GUEST_DIFF_FIELDS));
    assert.ok(GUEST_DIFF_FIELDS.length > 0);
    for (const field of GUEST_DIFF_FIELDS) {
      assert.ok(field.key, `field missing key: ${JSON.stringify(field)}`);
      assert.ok(field.label, `field missing label: ${JSON.stringify(field)}`);
    }
  });

  test('GUEST_DIFF_SOQL_FIELDS is a comma-separated string of keys', () => {
    assert.equal(typeof GUEST_DIFF_SOQL_FIELDS, 'string');
    assert.ok(GUEST_DIFF_SOQL_FIELDS.includes('Guest_First_Name__c'));
    assert.ok(GUEST_DIFF_SOQL_FIELDS.includes('TVG__c'));
  });
});
