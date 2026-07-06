'use strict';

/**
 * Unit tests for the operational-control report (missing guest data + open
 * posting masters) and for the daily report's section gating when the control
 * email owns the collection/PM content.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.EMAIL_ENABLED = 'false';

const Notifier = require('../src/notifier');

const guest = (over = {}) => ({
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  phone: '+1 555 0100',
  city: 'Austin',
  country: 'United States',
  language: 'English',
  villa: '020',
  adults: 2,
  children: 0,
  prs: '2/0',
  checkIn: '2026-07-04',
  checkOut: '2026-07-09',
  eta: null,
  etd: null,
  notes: null,
  ...over,
});

const report = (over = {}) => ({
  date: '2026-07-06',
  badEmails: [],
  inHouse: [],
  departures: [],
  arrivalsToday: [],
  arrivalsTomorrow: [],
  postingMasters: [],
  ...over,
});

const build = (data) => new Notifier().buildOperationalControlReport(data);

test('returns null when all profiles are complete and no posting masters', () => {
  assert.equal(build(report({ inHouse: [guest()] })), null);
});

test('flags each missing critical field as a chip', () => {
  const built = build(report({
    inHouse: [guest({ firstName: 'Max', lastName: 'Missing', email: '', reason: 'no email', phone: null, city: null })],
  }));
  assert.ok(built.htmlBody.includes('Max Missing'));
  for (const field of ['Email', 'Phone', 'City']) {
    assert.ok(built.htmlBody.includes(`>${field}</span>`), `expected ${field} chip`);
  }
  assert.ok(built.htmlBody.includes('No email on file'));
});

test('guest with agent email but full phone/city is flagged for email only', () => {
  const built = build(report({
    inHouse: [guest({ email: 'ops@travelagency.com', reason: 'agent-domain' })],
  }));
  assert.ok(built.htmlBody.includes('>Email</span>'));
  assert.ok(!built.htmlBody.includes('>Phone</span>'));
  assert.ok(built.htmlBody.includes('Travel agent / company domain: ops@travelagency.com'));
});

test('departing-today guests are included in the missing-data check', () => {
  const built = build(report({
    departures: [guest({ firstName: 'Dee', lastName: 'Parting', phone: null, checkOut: '2026-07-06' })],
  }));
  assert.ok(built.htmlBody.includes('Dee Parting'));
});

test('arrivals are NOT included in the missing-data check', () => {
  assert.equal(build(report({
    arrivalsToday: [guest({ phone: null })],
    arrivalsTomorrow: [guest({ city: null })],
  })), null);
});

test('posting masters render with notes sub-row', () => {
  const built = build(report({
    postingMasters: [guest({ firstName: 'Grupo', lastName: 'Bodega', villa: '9041', notes: 'group charges' })],
  }));
  assert.ok(built.subject.includes('Front Desk Control'));
  assert.ok(built.htmlBody.includes('Open Posting Masters — 1'));
  assert.match(built.htmlBody, /<td colspan="4"[^>]*>group charges<\/td>/);
});

test('plain-text fallback lists missing fields', () => {
  const built = build(report({
    inHouse: [guest({ phone: null, city: null })],
  }));
  assert.ok(built.textBody.includes('MISSING GUEST DATA (1):'));
  assert.ok(built.textBody.includes('Missing: Phone, City'));
});

test('daily report keeps collection + PM sections by default', () => {
  const n = new Notifier();
  const built = n.buildDailyFrontDeskReport(report({
    inHouse: [guest()],
    badEmails: [guest({ email: '', reason: 'no email' })],
    postingMasters: [guest({ villa: '9041' })],
  }));
  assert.ok(built.htmlBody.includes('Need Email Collection'));
  assert.ok(built.htmlBody.includes('Posting Masters'));
});

test('daily report drops collection + PM sections when options disable them', () => {
  const n = new Notifier();
  const built = n.buildDailyFrontDeskReport(report({
    inHouse: [guest()],
    badEmails: [guest({ email: '', reason: 'no email' })],
    postingMasters: [guest({ villa: '9041' })],
  }), { includeCollection: false, includePostingMasters: false });
  assert.ok(!built.htmlBody.includes('Need Email Collection'));
  assert.ok(!built.htmlBody.includes('Posting Masters'));
  assert.ok(!built.csv.includes('Bad Email'));
  assert.ok(built.htmlBody.includes('Guests In House'));
});

test('gated daily report is null when only gated sections have content', () => {
  const n = new Notifier();
  assert.equal(n.buildDailyFrontDeskReport(report({
    badEmails: [guest({ email: '', reason: 'no email' })],
    postingMasters: [guest({ villa: '9041' })],
  }), { includeCollection: false, includePostingMasters: false }), null);
});
