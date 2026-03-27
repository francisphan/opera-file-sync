#!/usr/bin/env node

/**
 * Unit tests for OPERA CSV Parser
 *
 * Run with: node --test tests/test-opera-parser-unit.js
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  convertDateFormat,
  parseCustomers,
  parseInvoices,
  parseOPERAFiles
} = require('../src/parsers/opera-parser');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute "today" the same way opera-parser.js does internally */
function getOperaToday() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })
  )
    .toISOString()
    .slice(0, 10);
}

/** Convert YYYY-MM-DD to DD-MM-YYYY (for building test CSVs) */
function toOperaDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${parseInt(d, 10)}-${parseInt(m, 10)}-${y}`;
}

let tmpDir;

function writeTmpCsv(name, content) {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opera-parser-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// convertDateFormat
// ===========================================================================
describe('convertDateFormat', () => {
  test('converts DD-MM-YYYY to YYYY-MM-DD', () => {
    assert.equal(convertDateFormat('25-03-2026'), '2026-03-25');
  });

  test('pads single-digit day and month', () => {
    assert.equal(convertDateFormat('1-3-2026'), '2026-03-01');
  });

  test('returns empty string for empty input', () => {
    assert.equal(convertDateFormat(''), '');
  });

  test('returns empty string for null', () => {
    assert.equal(convertDateFormat(null), '');
  });

  test('returns empty string for undefined', () => {
    assert.equal(convertDateFormat(undefined), '');
  });

  test('returns empty string for invalid format (missing parts)', () => {
    assert.equal(convertDateFormat('25-03'), '');
  });

  test('returns empty string for whitespace-only input', () => {
    assert.equal(convertDateFormat('   '), '');
  });

  test('handles leading/trailing whitespace around date', () => {
    assert.equal(convertDateFormat('  25-03-2026  '), '2026-03-25');
  });
});

// ===========================================================================
// parseCustomers
// ===========================================================================
describe('parseCustomers', () => {
  test('parses valid customer rows into a Map keyed by Opera ID', async () => {
    const csv = [
      'Opera Internal ID,First Name,Last Name,Email Address,Phone,BILLING_ADDRESS,Billing City,Billing State,Billing Country,Billing Zip',
      '1001,John,Doe,john@example.com,+1234,,Mendoza,Mendoza,AR,5500',
      '1002,Jane,Smith,jane@example.com,,,,,,'
    ].join('\n');

    const file = writeTmpCsv('customers.csv', csv);
    const map = await parseCustomers(file);

    assert.equal(map.size, 2);

    const john = map.get('1001');
    assert.equal(john.firstName, 'John');
    assert.equal(john.lastName, 'Doe');
    assert.equal(john.email, 'john@example.com');
    assert.equal(john.phone, '+1234');
    assert.equal(john.billingCountry, 'AR');

    const jane = map.get('1002');
    assert.equal(jane.firstName, 'Jane');
    assert.equal(jane.email, 'jane@example.com');
  });

  test('trims whitespace from Opera IDs', async () => {
    const csv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      '  2001  ,Alice,Wonder,alice@example.com'
    ].join('\n');

    const file = writeTmpCsv('customers.csv', csv);
    const map = await parseCustomers(file);

    assert.ok(map.has('2001'));
    assert.equal(map.get('2001').operaId, '2001');
  });

  test('skips rows with empty Opera ID', async () => {
    const csv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      ',Ghost,User,ghost@example.com',
      '3001,Valid,User,valid@example.com'
    ].join('\n');

    const file = writeTmpCsv('customers.csv', csv);
    const map = await parseCustomers(file);

    assert.equal(map.size, 1);
    assert.ok(map.has('3001'));
  });

  test('duplicate Opera IDs - last row wins', async () => {
    const csv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      '4001,First,Version,first@example.com',
      '4001,Second,Version,second@example.com'
    ].join('\n');

    const file = writeTmpCsv('customers.csv', csv);
    const map = await parseCustomers(file);

    assert.equal(map.size, 1);
    assert.equal(map.get('4001').email, 'second@example.com');
  });

  test('handles missing columns gracefully (empty defaults)', async () => {
    const csv = [
      'Opera Internal ID,First Name',
      '5001,Minimalist'
    ].join('\n');

    const file = writeTmpCsv('customers.csv', csv);
    const map = await parseCustomers(file);

    const rec = map.get('5001');
    assert.equal(rec.firstName, 'Minimalist');
    assert.equal(rec.lastName, '');
    assert.equal(rec.email, '');
    assert.equal(rec.phone, '');
  });

  test('handles headers-only CSV (no data rows)', async () => {
    const csv = 'Opera Internal ID,First Name,Last Name,Email Address\n';
    const file = writeTmpCsv('customers.csv', csv);
    const map = await parseCustomers(file);

    assert.equal(map.size, 0);
  });

  test('CSV with BOM character: stripBom handles it correctly', async () => {
    const bom = '\uFEFF';
    const csv = [
      bom + 'Opera Internal ID,First Name,Last Name,Email Address',
      '6001,Bom,Test,bom@example.com'
    ].join('\n');

    const file = writeTmpCsv('customers.csv', csv);
    const map = await parseCustomers(file);

    // stripBom() Transform strips the UTF-8 BOM before csv-parser sees it
    assert.equal(map.size, 1, 'BOM-prefixed CSV should parse correctly after stripBom fix');
    const rec = map.get('6001');
    assert.ok(rec, 'Opera ID should not be corrupted by BOM');
    assert.equal(rec.email, 'bom@example.com');
  });

  test('sanitizes email via sanitizeEmail (invalid email stays as raw trimmed)', async () => {
    // An email with non-ASCII chars will fail sanitizeEmail, fallback to raw trimmed
    const csv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      '7001,Intl,Guest,caf\u00E9@example.com'
    ].join('\n');

    const file = writeTmpCsv('customers.csv', csv);
    const map = await parseCustomers(file);

    const rec = map.get('7001');
    // sanitizeEmail returns null for non-ASCII, so fallback is rawEmail.trim()
    assert.equal(rec.email, 'caf\u00E9@example.com');
  });
});

// ===========================================================================
// parseInvoices
// ===========================================================================
describe('parseInvoices', () => {
  test('parses valid invoice rows', async () => {
    const csv = [
      'CUSTOMER_ID OPERA,Check in,Check out,Guest Name',
      '1001,25-03-2026,28-03-2026,John Doe',
      '1002,1-4-2026,5-4-2026,Jane Smith'
    ].join('\n');

    const file = writeTmpCsv('invoices.csv', csv);
    const map = await parseInvoices(file);

    assert.equal(map.size, 2);
    assert.equal(map.get('1001').checkIn, '25-03-2026');
    assert.equal(map.get('1001').checkOut, '28-03-2026');
    assert.equal(map.get('1002').guestName, 'Jane Smith');
  });

  test('duplicate customer IDs - first invoice wins', async () => {
    const csv = [
      'CUSTOMER_ID OPERA,Check in,Check out,Guest Name',
      '2001,10-03-2026,15-03-2026,First Stay',
      '2001,20-03-2026,25-03-2026,Second Stay'
    ].join('\n');

    const file = writeTmpCsv('invoices.csv', csv);
    const map = await parseInvoices(file);

    assert.equal(map.size, 1);
    assert.equal(map.get('2001').checkIn, '10-03-2026');
    assert.equal(map.get('2001').guestName, 'First Stay');
  });

  test('handles empty/missing date fields', async () => {
    const csv = [
      'CUSTOMER_ID OPERA,Check in,Check out,Guest Name',
      '3001,,,No Dates'
    ].join('\n');

    const file = writeTmpCsv('invoices.csv', csv);
    const map = await parseInvoices(file);

    assert.equal(map.get('3001').checkIn, '');
    assert.equal(map.get('3001').checkOut, '');
  });

  test('trims whitespace from customer IDs', async () => {
    const csv = [
      'CUSTOMER_ID OPERA,Check in,Check out,Guest Name',
      '  4001  ,1-1-2026,2-1-2026,Trimmed'
    ].join('\n');

    const file = writeTmpCsv('invoices.csv', csv);
    const map = await parseInvoices(file);

    assert.ok(map.has('4001'));
  });

  test('headers-only CSV returns empty map', async () => {
    const csv = 'CUSTOMER_ID OPERA,Check in,Check out,Guest Name\n';
    const file = writeTmpCsv('invoices.csv', csv);
    const map = await parseInvoices(file);

    assert.equal(map.size, 0);
  });
});

// ===========================================================================
// parseOPERAFiles - staff filtering
// ===========================================================================
describe('parseOPERAFiles - staff email filtering', () => {
  test('filters out @vinesofmendoza.com emails', async () => {
    const csv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      '1001,Staff,Member,staff@vinesofmendoza.com',
      '1002,Real,Guest,guest@gmail.com'
    ].join('\n');

    const custFile = writeTmpCsv('customers.csv', csv);
    const { records, frontDesk } = await parseOPERAFiles(custFile);

    assert.equal(records.length, 1);
    assert.equal(records[0].customer.operaId, '1002');
    // Staff should not appear in frontDesk either
    assert.equal(frontDesk.filter(f => f.operaId === '1001').length, 0);
  });

  test('filters out @the-vines.com emails (case insensitive)', async () => {
    const csv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      '2001,Admin,Person,admin@The-Vines.com',
      '2002,Guest,Person,guest@yahoo.com'
    ].join('\n');

    const custFile = writeTmpCsv('customers.csv', csv);
    const { records } = await parseOPERAFiles(custFile);

    assert.equal(records.length, 1);
    assert.equal(records[0].customer.operaId, '2002');
  });
});

// ===========================================================================
// parseOPERAFiles - agent emails and front desk
// ===========================================================================
describe('parseOPERAFiles - agent emails to frontDesk', () => {
  test('agent email checking in today goes to frontDesk', async () => {
    const today = getOperaToday();
    const operaToday = toOperaDate(today);

    const custCsv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      '3001,Agent,Booker,agent@guest.booking.com'
    ].join('\n');

    const invCsv = [
      'CUSTOMER_ID OPERA,Check in,Check out,Guest Name',
      `3001,${operaToday},28-12-2026,Agent Booker`
    ].join('\n');

    const custFile = writeTmpCsv('customers.csv', custCsv);
    const invFile = writeTmpCsv('invoices.csv', invCsv);
    const { records, frontDesk } = await parseOPERAFiles(custFile, invFile);

    assert.equal(records.length, 0, 'agent should not be in records');
    assert.equal(frontDesk.length, 1);
    assert.equal(frontDesk[0].operaId, '3001');
    assert.equal(frontDesk[0].reason, 'booking-proxy');
    assert.equal(frontDesk[0].checkIn, today);
  });

  test('agent email NOT checking in today is silently skipped', async () => {
    const custCsv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      '4001,Agent,Faraway,agent@guest.booking.com'
    ].join('\n');

    // Check-in far in the future
    const invCsv = [
      'CUSTOMER_ID OPERA,Check in,Check out,Guest Name',
      '4001,1-1-2099,5-1-2099,Agent Faraway'
    ].join('\n');

    const custFile = writeTmpCsv('customers.csv', custCsv);
    const invFile = writeTmpCsv('invoices.csv', invCsv);
    const { records, frontDesk } = await parseOPERAFiles(custFile, invFile);

    assert.equal(records.length, 0);
    assert.equal(frontDesk.length, 0, 'not checking in today, should not appear');
  });
});

// ===========================================================================
// parseOPERAFiles - no-email records
// ===========================================================================
describe('parseOPERAFiles - no-email records', () => {
  test('no-email guest checking in today goes to frontDesk with reason invalid-email', async () => {
    const today = getOperaToday();
    const operaToday = toOperaDate(today);

    const custCsv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      '5001,No,Email,'
    ].join('\n');

    const invCsv = [
      'CUSTOMER_ID OPERA,Check in,Check out,Guest Name',
      `5001,${operaToday},28-12-2026,No Email`
    ].join('\n');

    const custFile = writeTmpCsv('customers.csv', custCsv);
    const invFile = writeTmpCsv('invoices.csv', invCsv);
    const { records, frontDesk } = await parseOPERAFiles(custFile, invFile);

    assert.equal(records.length, 0);
    assert.equal(frontDesk.length, 1);
    assert.equal(frontDesk[0].reason, 'invalid-email');
    assert.equal(frontDesk[0].operaId, '5001');
  });

  test('no-email guest NOT checking in today is silently skipped', async () => {
    const custCsv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      '5002,No,Email,'
    ].join('\n');

    const invCsv = [
      'CUSTOMER_ID OPERA,Check in,Check out,Guest Name',
      '5002,1-1-2099,5-1-2099,No Email'
    ].join('\n');

    const custFile = writeTmpCsv('customers.csv', custCsv);
    const invFile = writeTmpCsv('invoices.csv', invCsv);
    const { records, frontDesk } = await parseOPERAFiles(custFile, invFile);

    assert.equal(records.length, 0);
    assert.equal(frontDesk.length, 0);
  });
});

// ===========================================================================
// parseOPERAFiles - valid guests to records
// ===========================================================================
describe('parseOPERAFiles - valid guests', () => {
  test('valid guest with email goes to records', async () => {
    const custCsv = [
      'Opera Internal ID,First Name,Last Name,Email Address,Phone',
      '6001,Valid,Guest,valid@example.com,+5551234'
    ].join('\n');

    const custFile = writeTmpCsv('customers.csv', custCsv);
    const { records } = await parseOPERAFiles(custFile);

    assert.equal(records.length, 1);
    assert.equal(records[0].customer.email, 'valid@example.com');
    assert.equal(records[0].customer.firstName, 'Valid');
    assert.equal(records[0].invoice, null, 'no invoices file provided');
  });

  test('valid guest without invoices file gets null invoice', async () => {
    const custCsv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      '6002,Solo,Guest,solo@example.com'
    ].join('\n');

    const custFile = writeTmpCsv('customers.csv', custCsv);
    const { records } = await parseOPERAFiles(custFile, null);

    assert.equal(records.length, 1);
    assert.equal(records[0].invoice, null);
  });
});

// ===========================================================================
// parseOPERAFiles - full integration (customers + invoices join)
// ===========================================================================
describe('parseOPERAFiles - full integration', () => {
  test('joins customer and invoice data on Opera ID with date conversion', async () => {
    const custCsv = [
      'Opera Internal ID,First Name,Last Name,Email Address,Billing City,Billing Country',
      '7001,Carlos,Garcia,carlos@example.com,Buenos Aires,AR',
      '7002,Maria,Lopez,maria@example.com,Mendoza,AR'
    ].join('\n');

    const invCsv = [
      'CUSTOMER_ID OPERA,Check in,Check out,Guest Name',
      '7001,15-6-2026,20-6-2026,Carlos Garcia',
      '7002,1-7-2026,5-7-2026,Maria Lopez'
    ].join('\n');

    const custFile = writeTmpCsv('customers.csv', custCsv);
    const invFile = writeTmpCsv('invoices.csv', invCsv);
    const { records, frontDesk } = await parseOPERAFiles(custFile, invFile);

    assert.equal(records.length, 2);
    assert.equal(frontDesk.length, 0);

    // Check dates were converted to YYYY-MM-DD
    const carlos = records.find(r => r.customer.operaId === '7001');
    assert.ok(carlos);
    assert.equal(carlos.invoice.checkIn, '2026-06-15');
    assert.equal(carlos.invoice.checkOut, '2026-06-20');
    assert.equal(carlos.customer.billingCity, 'Buenos Aires');

    const maria = records.find(r => r.customer.operaId === '7002');
    assert.ok(maria);
    assert.equal(maria.invoice.checkIn, '2026-07-01');
    assert.equal(maria.invoice.checkOut, '2026-07-05');
  });

  test('customer without matching invoice gets null invoice', async () => {
    const custCsv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      '8001,Unmatched,Guest,unmatched@example.com'
    ].join('\n');

    const invCsv = [
      'CUSTOMER_ID OPERA,Check in,Check out,Guest Name',
      '9999,1-1-2026,5-1-2026,Someone Else'
    ].join('\n');

    const custFile = writeTmpCsv('customers.csv', custCsv);
    const invFile = writeTmpCsv('invoices.csv', invCsv);
    const { records } = await parseOPERAFiles(custFile, invFile);

    assert.equal(records.length, 1);
    assert.equal(records[0].invoice, null);
  });

  test('frontDesk entries include resvStatus field', async () => {
    const today = getOperaToday();
    const operaToday = toOperaDate(today);

    const custCsv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      '9001,Booking,Agent,proxy@guest.booking.com'
    ].join('\n');

    const invCsv = [
      'CUSTOMER_ID OPERA,Check in,Check out,Guest Name',
      `9001,${operaToday},28-12-2026,Booking Agent`
    ].join('\n');

    const custFile = writeTmpCsv('customers.csv', custCsv);
    const invFile = writeTmpCsv('invoices.csv', invCsv);
    const { frontDesk } = await parseOPERAFiles(custFile, invFile);

    assert.equal(frontDesk.length, 1);
    assert.ok(
      'resvStatus' in frontDesk[0],
      'frontDesk entry should include resvStatus field'
    );
  });

  test('mixed scenario: valid guest, agent, no-email, staff', async () => {
    const today = getOperaToday();
    const operaToday = toOperaDate(today);

    const custCsv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      '101,Real,Guest,real@example.com',
      '102,Agent,Proxy,proxy@guest.booking.com',
      '103,No,Email,',
      '104,Staff,Member,staff@vinesofmendoza.com'
    ].join('\n');

    const invCsv = [
      'CUSTOMER_ID OPERA,Check in,Check out,Guest Name',
      `101,${operaToday},28-12-2026,Real Guest`,
      `102,${operaToday},28-12-2026,Agent Proxy`,
      `103,${operaToday},28-12-2026,No Email`,
      `104,${operaToday},28-12-2026,Staff Member`
    ].join('\n');

    const custFile = writeTmpCsv('customers.csv', custCsv);
    const invFile = writeTmpCsv('invoices.csv', invCsv);
    const { records, frontDesk } = await parseOPERAFiles(custFile, invFile);

    // Real guest -> records
    assert.equal(records.length, 1);
    assert.equal(records[0].customer.operaId, '101');

    // Agent + no-email -> frontDesk (staff is fully filtered)
    assert.equal(frontDesk.length, 2);
    const reasons = frontDesk.map(f => f.reason).sort();
    assert.deepEqual(reasons, ['booking-proxy', 'invalid-email']);
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================
describe('Edge cases', () => {
  test('empty CSV files (headers only) produce empty results', async () => {
    const custCsv = 'Opera Internal ID,First Name,Last Name,Email Address\n';
    const invCsv = 'CUSTOMER_ID OPERA,Check in,Check out,Guest Name\n';

    const custFile = writeTmpCsv('customers.csv', custCsv);
    const invFile = writeTmpCsv('invoices.csv', invCsv);
    const { records, frontDesk } = await parseOPERAFiles(custFile, invFile);

    assert.equal(records.length, 0);
    assert.equal(frontDesk.length, 0);
  });

  test('CSV with BOM characters: stripBom handles it correctly', async () => {
    const bom = '\uFEFF';
    const custCsv =
      bom +
      [
        'Opera Internal ID,First Name,Last Name,Email Address',
        '10001,Bom,Guest,bom@example.com'
      ].join('\n');

    const custFile = writeTmpCsv('customers.csv', custCsv);
    const { records } = await parseOPERAFiles(custFile);

    // stripBom() Transform strips the BOM, so parsing succeeds
    assert.equal(records.length, 1, 'BOM-prefixed CSV should parse correctly after stripBom fix');
    assert.equal(records[0].customer.email, 'bom@example.com');
  });

  test('whitespace in Opera IDs is trimmed for join', async () => {
    const custCsv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      '  11001  ,Spacy,Guest,spacy@example.com'
    ].join('\n');

    const invCsv = [
      'CUSTOMER_ID OPERA,Check in,Check out,Guest Name',
      '  11001  ,10-6-2026,15-6-2026,Spacy Guest'
    ].join('\n');

    const custFile = writeTmpCsv('customers.csv', custCsv);
    const invFile = writeTmpCsv('invoices.csv', invCsv);
    const { records } = await parseOPERAFiles(custFile, invFile);

    assert.equal(records.length, 1);
    assert.equal(records[0].invoice.checkIn, '2026-06-10');
  });

  test('non-existent invoices file path is handled gracefully', async () => {
    const custCsv = [
      'Opera Internal ID,First Name,Last Name,Email Address',
      '12001,Solo,Guest,solo@example.com'
    ].join('\n');

    const custFile = writeTmpCsv('customers.csv', custCsv);
    const fakePath = path.join(tmpDir, 'nonexistent.csv');
    const { records } = await parseOPERAFiles(custFile, fakePath);

    assert.equal(records.length, 1, 'should still parse customers without invoices');
  });
});
