#!/usr/bin/env node

/**
 * Unit tests for the villa-nights report core: outlook window computation
 * (scheduler), pure aggregation, and multi-window bucketing (opera-db-query).
 * No Oracle or email — the DB client is stubbed.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { computeOutlookWindows } = require('../src/scheduler');
const { aggregateVillaNights, queryVillaNightsOutlook } = require('../src/opera-db-query');

// ---------------------------------------------------------------------------
// computeOutlookWindows
// ---------------------------------------------------------------------------

describe('computeOutlookWindows', () => {
  test('mid-year anchor: three nested windows from the 1st of the current month', () => {
    const w = computeOutlookWindows('2026-07-21');
    assert.equal(w.length, 3);
    assert.deepEqual(w.map(x => x.key), ['twoMonth', 'threeMonth', 'sixMonth']);
    for (const x of w) assert.equal(x.startDate, '2026-07-01');
    assert.equal(w[0].endDate, '2026-09-01'); // Jul + Aug
    assert.equal(w[1].endDate, '2026-10-01'); // Jul..Sep
    assert.equal(w[2].endDate, '2027-01-01'); // Jul..Dec — wraps the year
  });

  test('November anchor wraps all windows across the year end', () => {
    const w = computeOutlookWindows('2026-11-15');
    for (const x of w) assert.equal(x.startDate, '2026-11-01');
    assert.equal(w[0].endDate, '2027-01-01');
    assert.equal(w[1].endDate, '2027-02-01');
    assert.equal(w[2].endDate, '2027-05-01');
  });

  test('December anchor', () => {
    const w = computeOutlookWindows('2026-12-31');
    for (const x of w) assert.equal(x.startDate, '2026-12-01');
    assert.equal(w[0].endDate, '2027-02-01');
    assert.equal(w[1].endDate, '2027-03-01');
    assert.equal(w[2].endDate, '2027-06-01');
  });

  test('first of month anchors to the same month', () => {
    const w = computeOutlookWindows('2026-08-01');
    assert.equal(w[0].startDate, '2026-08-01');
    assert.equal(w[0].endDate, '2026-10-01');
  });
});

// ---------------------------------------------------------------------------
// aggregateVillaNights
// ---------------------------------------------------------------------------

function row(room, night, rate, code) {
  return { ROOM: room, NIGHT: night, RATE_AMOUNT: rate, RATE_CODE: code };
}

describe('aggregateVillaNights', () => {
  const KNOWN = ['014', '025', '012'];

  test('splits comp (rate 0) vs paid and rolls up rate codes', () => {
    const rows = [
      row('025', '2026-07-01', 0, 'COMP'),
      row('025', '2026-07-02', 900, 'OWNER'),
      row('025', '2026-07-03', 900, 'OWNER'),
      row('014', '2026-07-01', 1200, 'BAR'),
    ];
    const agg = aggregateVillaNights(rows, KNOWN);

    assert.equal(agg.totals.nights, 4);
    assert.equal(agg.totals.compNights, 1);
    assert.equal(agg.totals.paidNights, 3);
    assert.equal(agg.totals.villas, 3);
    assert.equal(agg.totals.occupiedVillas, 2);

    const v025 = agg.villas.find(v => v.villa === '025');
    assert.equal(v025.nights, 3);
    assert.equal(v025.compNights, 1);
    assert.equal(v025.paidNights, 2);
    assert.deepEqual(v025.rateCodes, [{ code: 'OWNER', nights: 2 }, { code: 'COMP', nights: 1 }]);

    const owner = agg.rateCodes.find(rc => rc.code === 'OWNER');
    assert.deepEqual(owner, { code: 'OWNER', nights: 2, compNights: 0, paidNights: 2 });
  });

  test('every known villa gets a row; vacant ones show zeros', () => {
    const agg = aggregateVillaNights([row('025', '2026-07-01', 100, 'BAR')], KNOWN);
    assert.equal(agg.villas.length, 3);
    const v012 = agg.villas.find(v => v.villa === '012');
    assert.deepEqual(v012, { villa: '012', nights: 0, compNights: 0, paidNights: 0, rateCodes: [] });
  });

  test('rooms outside the allowlist (residences, PMs, legacy) are dropped', () => {
    const agg = aggregateVillaNights([
      row('100', '2026-07-01', 100, 'BAR'),  // residence
      row('9001', '2026-07-01', 0, 'PM'),    // posting master
      row('025', '2026-07-01', 100, 'BAR'),
    ], KNOWN);
    assert.equal(agg.totals.nights, 1);
    assert.equal(agg.rateCodes.length, 1);
  });

  test('normalizes unpadded room numbers to the stored 3-digit form', () => {
    const agg = aggregateVillaNights([row('25', '2026-07-01', 100, 'BAR')], KNOWN);
    assert.equal(agg.villas.find(v => v.villa === '025').nights, 1);
  });

  test('null rate counts as comp; blank rate code becomes "(none)"', () => {
    const agg = aggregateVillaNights([row('025', '2026-07-01', null, '  ')], KNOWN);
    assert.equal(agg.totals.compNights, 1);
    assert.equal(agg.rateCodes[0].code, '(none)');
  });

  test('villas sort by OPERA number ascending (AC block 001-012 first)', () => {
    const agg = aggregateVillaNights([], ['025', '012', '014']);
    assert.deepEqual(agg.villas.map(v => v.villa), ['012', '014', '025']);
  });
});

// ---------------------------------------------------------------------------
// queryVillaNightsOutlook — single fetch, per-window bucketing
// ---------------------------------------------------------------------------

describe('queryVillaNightsOutlook', () => {
  const windows = computeOutlookWindows('2026-07-21');

  test('fetches once over the widest span and buckets nights per window', async () => {
    const calls = [];
    const stubClient = {
      query: async (_sql, binds) => {
        calls.push(binds);
        return [
          row('025', '2026-07-10', 0, 'COMP'),    // in all three windows
          row('025', '2026-08-15', 500, 'OWNER'), // in all three windows
          row('025', '2026-09-05', 500, 'OWNER'), // 3- and 6-month only
          row('025', '2026-11-20', 500, 'BAR'),   // 6-month only
        ];
      }
    };

    const report = await queryVillaNightsOutlook(stubClient, windows);

    assert.equal(calls.length, 1, 'one Oracle round-trip for all windows');
    assert.deepEqual(calls[0], { startDate: '2026-07-01', endDate: '2027-01-01' });

    const nightsFor = (key) => report.windows.find(w => w.key === key).villas.find(v => v.villa === '025').nights;
    assert.equal(nightsFor('twoMonth'), 2);
    assert.equal(nightsFor('threeMonth'), 3);
    assert.equal(nightsFor('sixMonth'), 4);

    const six = report.windows.find(w => w.key === 'sixMonth');
    assert.equal(six.totals.compNights, 1);
    assert.equal(six.totals.paidNights, 3);
    assert.equal(six.label, '6 months');
    assert.equal(six.startDate, '2026-07-01');
  });

  test('rejects an empty window list', async () => {
    await assert.rejects(() => queryVillaNightsOutlook({ query: async () => [] }, []), /no windows/);
  });
});
