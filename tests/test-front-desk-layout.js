'use strict';

/**
 * Unit tests for the daily front-desk report layout (buildDailyFrontDeskReport).
 * The layout is print-oriented: notes render as a full-width row under each
 * guest instead of a narrow trailing column (which used to stretch printouts
 * to 9-10 pages), and each guest lives in its own tbody so the guest row and
 * its notes never split across a printed page.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.EMAIL_ENABLED = 'false';

const Notifier = require('../src/notifier');

const guest = (over = {}) => ({
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
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
  inHouse: [],
  departures: [],
  arrivalsToday: [],
  arrivalsTomorrow: [],
  arrivalsDayAfter: [],
  postingMasters: [],
  ...over,
});

const build = (data) => new Notifier().buildDailyFrontDeskReport(data);

test('returns null when there is nothing to report', () => {
  assert.equal(build(report()), null);
});

test('notes render as a full-width colspan row, not a trailing column', () => {
  const built = build(report({ inHouse: [guest({ notes: '[CASHIER] USD 660 upsell pending' })] }));
  assert.match(built.htmlBody, /<td colspan="7"[^>]*>\[CASHIER\] USD 660 upsell pending<\/td>/);
  // No Notes header cell in any guest table
  assert.ok(!built.htmlBody.includes('>Notes</th>'));
});

test('guest row and notes row share a page-break-avoiding tbody', () => {
  const built = build(report({ inHouse: [guest({ notes: 'short note' })] }));
  const tbody = built.htmlBody.match(/<tbody style="page-break-inside:avoid">[\s\S]*?<\/tbody>/);
  assert.ok(tbody, 'expected per-guest tbody');
  assert.ok(tbody[0].includes('Jane Doe'));
  assert.ok(tbody[0].includes('short note'));
});

test('guests without notes get no notes row', () => {
  const built = build(report({ inHouse: [guest()] }));
  assert.ok(!built.htmlBody.match(/<td colspan="7"[^>]*font-size:11px/));
});

test('table headers are wrapped in thead so they repeat on printed pages', () => {
  const built = build(report({
    inHouse: [guest()],
    arrivalsToday: [guest({ checkIn: '2026-07-06', eta: '15:00' })],
  }));
  assert.ok((built.htmlBody.match(/<thead>/g) || []).length >= 2);
});

test('all five guest sections render', () => {
  const built = build(report({
    inHouse: [guest()],
    departures: [guest({ checkOut: '2026-07-06', etd: '10:00' })],
    arrivalsToday: [guest({ checkIn: '2026-07-06' })],
    arrivalsTomorrow: [guest({ checkIn: '2026-07-07' })],
    arrivalsDayAfter: [guest({ checkIn: '2026-07-08' })],
  }));
  for (const title of ['Guests In House', 'Departures', 'Arrivals Today', 'Arrivals Tomorrow', 'Arrivals (2 Days Out)']) {
    assert.ok(built.htmlBody.includes(title), `expected section ${title}`);
  }
});

test('CSV attachment still carries notes as a column', () => {
  const built = build(report({ inHouse: [guest({ notes: 'csv note text' })] }));
  assert.ok(built.csv.split('\n')[0].endsWith('Notes'));
  assert.ok(built.csv.includes('csv note text'));
});

test('posting masters no longer appear in the daily report (split to their own email)', () => {
  const built = build(report({
    inHouse: [guest()],
    postingMasters: [guest({ villa: '9041', firstName: 'PM', lastName: 'Group' })],
  }));
  assert.ok(!built.htmlBody.includes('Posting Masters'));
  assert.ok(!built.htmlBody.includes('PM Group'));
  // A report holding ONLY posting masters has nothing left to send.
  assert.equal(build(report({ postingMasters: [guest({ villa: '9041' })] })), null);
});

test('plain-text body and subject are unchanged in shape', () => {
  const built = build(report({ inHouse: [guest()] }));
  assert.equal(built.subject, 'Daily Front Desk Report — 2026-07-06');
  assert.ok(built.textBody.includes('IN HOUSE (1):'));
});
