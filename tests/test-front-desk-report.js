'use strict';

/**
 * Unit tests for queryFrontDeskReport categorization — section routing and
 * the "Need Email Collection" (badEmails) eligibility rules, driven through
 * a mocked Oracle client. The SQL itself is exercised by
 * scripts/dry-run-front-desk-report.js against the real DB.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.SMTP_VERIFY = 'false';

const { queryFrontDeskReport } = require('../src/opera-db-query');

const DATE = '2026-07-06';

function mockClient(rows) {
  return {
    query: async (sql) => {
      if (sql.includes('FROM OPERA.RESERVATION_NAME rn')) return rows;
      return []; // note/alert queries
    },
  };
}

let nextId = 1;
function row(overrides) {
  const id = nextId++;
  return {
    NAME_ID: id,
    FIRST: 'Jane',
    LAST: `Doe${id}`,
    LANGUAGE: 'E',
    EMAIL: '',
    COUNTRY: 'US',
    CHECK_IN: '2026-07-05',
    CHECK_OUT: '2026-07-08',
    ROOM: '020',
    ADULTS: 2,
    CHILDREN: 0,
    RESV_NAME_ID: 100 + id,
    PARENT_RESV_NAME_ID: null,
    ETA: null,
    ...overrides,
  };
}

const names = (list) => list.map((g) => `${g.firstName} ${g.lastName}`);

test('guest without email who arrived before today is flagged for collection', async () => {
  const report = await queryFrontDeskReport(
    mockClient([row({ FIRST: 'Ana', LAST: 'InHouse', CHECK_IN: '2026-07-04' })]),
    DATE
  );
  assert.deepEqual(names(report.badEmails), ['Ana InHouse']);
  assert.deepEqual(names(report.inHouse), ['Ana InHouse']);
});

test('same-day arrival without email is NOT flagged, still listed under arrivals', async () => {
  const report = await queryFrontDeskReport(
    mockClient([row({ FIRST: 'Pat', LAST: 'Arriving', CHECK_IN: DATE })]),
    DATE
  );
  assert.equal(report.badEmails.length, 0);
  assert.deepEqual(names(report.arrivalsToday), ['Pat Arriving']);
});

test('tomorrow arrival without email is NOT flagged', async () => {
  const report = await queryFrontDeskReport(
    mockClient([row({ FIRST: 'Tom', LAST: 'Morrow', CHECK_IN: '2026-07-07', CHECK_OUT: '2026-07-10' })]),
    DATE
  );
  assert.equal(report.badEmails.length, 0);
  assert.deepEqual(names(report.arrivalsTomorrow), ['Tom Morrow']);
});

test('guest departing today without email is still flagged (last chance to collect)', async () => {
  const report = await queryFrontDeskReport(
    mockClient([row({ FIRST: 'Dee', LAST: 'Parting', CHECK_IN: '2026-07-03', CHECK_OUT: DATE })]),
    DATE
  );
  assert.deepEqual(names(report.badEmails), ['Dee Parting']);
  assert.deepEqual(names(report.departures), ['Dee Parting']);
});

test('guest with a valid email is not flagged', async () => {
  const report = await queryFrontDeskReport(
    mockClient([row({ FIRST: 'Val', LAST: 'Id', EMAIL: 'val.id@example.com', CHECK_IN: '2026-07-04' })]),
    DATE
  );
  assert.equal(report.badEmails.length, 0);
  assert.deepEqual(names(report.inHouse), ['Val Id']);
});

test('FRONT_DESK_EXCLUDE_GUESTS keeps staff out of collection but not the report', async () => {
  process.env.FRONT_DESK_EXCLUDE_GUESTS = 'Brenda Carrion';
  try {
    const report = await queryFrontDeskReport(
      mockClient([
        row({ FIRST: 'Brenda', LAST: 'Carrion', CHECK_IN: '2026-07-04' }),
        row({ FIRST: 'Gus', LAST: 'Guest', CHECK_IN: '2026-07-04' }),
      ]),
      DATE
    );
    assert.deepEqual(names(report.badEmails), ['Gus Guest']);
    assert.deepEqual(names(report.inHouse).sort(), ['Brenda Carrion', 'Gus Guest']);
  } finally {
    delete process.env.FRONT_DESK_EXCLUDE_GUESTS;
  }
});

test('posting-master villas skip the collection list entirely', async () => {
  const report = await queryFrontDeskReport(
    mockClient([row({ FIRST: 'Post', LAST: 'Master', ROOM: '9041', CHECK_IN: '2026-07-04' })]),
    DATE
  );
  assert.equal(report.badEmails.length, 0);
  assert.deepEqual(names(report.postingMasters), ['Post Master']);
});
