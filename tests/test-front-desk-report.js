'use strict';

/**
 * Unit tests for queryFrontDeskReport's data-quality gating, driven through a
 * mocked Oracle client. The completeness lookups (DOB/phone/passport) run
 * against the mock's empty result sets, so every guest carries those flags —
 * assertions here target the Email/City flags, the staff exclusion list, and
 * section routing. The SQL itself is exercised by
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
      return []; // notes, cashier, completeness lookups
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
    EMAIL: 'jane@example.com',
    CITY: 'Mendoza',
    COUNTRY: 'US',
    CHECK_IN: '2026-07-04',
    CHECK_OUT: '2026-07-09',
    ROOM: '020',
    ADULTS: 2,
    CHILDREN: 0,
    RESV_NAME_ID: 100 + id,
    PARENT_RESV_NAME_ID: null,
    ETA: null,
    ...overrides,
  };
}

const dqNames = (report) => report.dataQuality.map((g) => `${g.firstName} ${g.lastName}`);
const dqEntry = (report, last) => report.dataQuality.find((g) => g.lastName === last);

test('guest with valid email and city is not flagged for Email or City', async () => {
  const report = await queryFrontDeskReport(mockClient([row({ LAST: 'Complete' })]), DATE);
  const entry = dqEntry(report, 'Complete');
  // DOB/Phone/Passport flags come from the empty completeness mock — expected.
  assert.ok(entry, 'expected guest in dataQuality via completeness flags');
  assert.ok(!entry.missing.includes('Email'));
  assert.ok(!entry.missing.includes('City'));
});

test('missing email and city are flagged', async () => {
  const report = await queryFrontDeskReport(
    mockClient([row({ LAST: 'Empty', EMAIL: '', CITY: null })]),
    DATE
  );
  const entry = dqEntry(report, 'Empty');
  assert.ok(entry.missing.includes('Email'));
  assert.ok(entry.missing.includes('City'));
});

test('FRONT_DESK_EXCLUDE_GUESTS keeps staff out of dataQuality but not the report', async () => {
  process.env.FRONT_DESK_EXCLUDE_GUESTS = 'Brenda Carrion';
  try {
    const report = await queryFrontDeskReport(
      mockClient([
        row({ FIRST: 'Brenda', LAST: 'Carrion', EMAIL: '' }),
        row({ FIRST: 'Gus', LAST: 'Guest', EMAIL: '' }),
      ]),
      DATE
    );
    assert.deepEqual(dqNames(report), ['Gus Guest']);
    const inHouseNames = report.inHouse.map((g) => `${g.firstName} ${g.lastName}`).sort();
    assert.deepEqual(inHouseNames, ['Brenda Carrion', 'Gus Guest']);
  } finally {
    delete process.env.FRONT_DESK_EXCLUDE_GUESTS;
  }
});

test('same-day arrivals are currently included in dataQuality (design under discussion, see #8)', async () => {
  const report = await queryFrontDeskReport(
    mockClient([row({ LAST: 'Arriving', EMAIL: '', CHECK_IN: DATE })]),
    DATE
  );
  const entry = dqEntry(report, 'Arriving');
  assert.ok(entry);
  assert.equal(entry.section, 'Arrivals Today');
});

test('posting-master villas skip dataQuality entirely', async () => {
  const report = await queryFrontDeskReport(
    mockClient([row({ LAST: 'Master', ROOM: '9041', EMAIL: '' })]),
    DATE
  );
  assert.equal(report.dataQuality.length, 0);
  assert.equal(report.postingMasters.length, 1);
});

test('roomless reservation on the PM pseudo category goes to postingMasters, not dataQuality', async () => {
  const report = await queryFrontDeskReport(
    mockClient([row({ LAST: 'Parked', ROOM: null, ROOM_CATEGORY: 'PM', EMAIL: '', CHECK_IN: DATE })]),
    DATE
  );
  assert.equal(report.dataQuality.length, 0);
  assert.equal(report.arrivalsToday.length, 0);
  assert.equal(report.postingMasters.length, 1);
  assert.equal(report.postingMasters[0].lastName, 'Parked');
});

test('roomless reservation with a real room category is still flagged', async () => {
  const report = await queryFrontDeskReport(
    mockClient([row({ LAST: 'Unroomed', ROOM: null, ROOM_CATEGORY: 'DVIL', EMAIL: '', CHECK_IN: DATE })]),
    DATE
  );
  assert.equal(report.postingMasters.length, 0);
  const entry = dqEntry(report, 'Unroomed');
  assert.ok(entry, 'expected roomless real guest in dataQuality');
  assert.equal(entry.section, 'Arrivals Today');
});

test('guest inheriting a PM-prefixed room from a skipped parent is diverted to postingMasters', async () => {
  const parent = row({ FIRST: 'PM', LAST: 'GROUP', ROOM: 'PM01', EMAIL: '' });
  const child = row({
    LAST: 'OnMaster', ROOM: null, ROOM_CATEGORY: null, EMAIL: '',
    PARENT_RESV_NAME_ID: parent.RESV_NAME_ID, CHECK_IN: DATE,
  });
  const report = await queryFrontDeskReport(mockClient([parent, child]), DATE);
  // Parent ("PM GROUP" on room PM01) is dropped as a house account / PM room;
  // the child must not surface in Arrivals with the inherited PM01 room.
  assert.equal(report.dataQuality.length, 0);
  assert.equal(report.arrivalsToday.length, 0);
  assert.equal(report.postingMasters.length, 1);
  assert.equal(report.postingMasters[0].lastName, 'OnMaster');
});
