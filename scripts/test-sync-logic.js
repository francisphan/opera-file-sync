#!/usr/bin/env node
/**
 * Test Sync Logic
 *
 * Unit tests for syncGuestCheckIns() using a mocked Salesforce connection.
 * No test framework required — plain Node, same pattern as test-connection.js.
 *
 * Usage: node scripts/test-sync-logic.js
 */

const SalesforceClient = require('../src/salesforce-client');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

/**
 * Build a mock jsforce connection driven by per-scenario fixtures.
 * fixture shape:
 *   contactQueryResult  - array of {Id, Email} returned by Contact query
 *   guestQueryResult    - array of {Id, Contact__c, Check_In_Date__c} returned by guest query
 *   contactCreateResults - per-record override array (default: success + generated Id)
 *   guestCreateResults   - per-record override array
 *   guestUpdateResults   - per-record override array
 *   guestObject          - defaults to 'TVRS_Guest__c'
 */
function makeMockConnection(fixture) {
  const calls = {
    queries: [],
    contactCreates: [],
    guestCreates: [],
    guestUpdates: []
  };

  const guestObject = fixture.guestObject || 'TVRS_Guest__c';

  const connection = {
    calls,
    query(soql) {
      calls.queries.push(soql);
      if (soql.includes('FROM Contact')) {
        return Promise.resolve({ records: fixture.contactQueryResult || [], done: true });
      }
      if (soql.includes(`FROM ${guestObject}`)) {
        return Promise.resolve({ records: fixture.guestQueryResult || [], done: true });
      }
      return Promise.resolve({ records: [], done: true });
    },
    sobject(name) {
      return {
        create(records) {
          const arr = Array.isArray(records) ? records : [records];
          if (name === 'Contact') {
            calls.contactCreates.push(...arr);
            const overrides = fixture.contactCreateResults || [];
            return Promise.resolve(
              arr.map((_, i) => overrides[i] || { success: true, id: `Contact${Date.now()}${i}` })
            );
          }
          // Guest object
          calls.guestCreates.push(...arr);
          const overrides = fixture.guestCreateResults || [];
          return Promise.resolve(
            arr.map((_, i) => overrides[i] || { success: true, id: `Guest${Date.now()}${i}` })
          );
        },
        update(records) {
          const arr = Array.isArray(records) ? records : [records];
          calls.guestUpdates.push(...arr);
          const overrides = fixture.guestUpdateResults || [];
          return Promise.resolve(
            arr.map((_, i) => overrides[i] || { success: true, id: `Guest${Date.now()}${i}` })
          );
        }
      };
    }
  };

  return connection;
}

function makeEntry(email, firstName, lastName, checkIn = '2026-02-01') {
  return {
    customer: { email, firstName, lastName },
    invoice: { checkIn, checkOut: '2026-02-03' }
  };
}

async function runScenario(name, fixture, guestDataList, assertions) {
  console.log(`\nScenario: ${name}`);
  const client = new SalesforceClient({});
  client.ensureConnected = async () => {};
  client.connection = makeMockConnection(fixture);

  const results = await client.syncGuestCheckIns(guestDataList);
  await assertions(results, client.connection.calls);
}

// ---------------------------------------------------------------------------
// Scenario 1: New guest — email not in SF → Contact.create + TVRS.create called
// ---------------------------------------------------------------------------
async function scenario1() {
  await runScenario(
    'New guest — email not in SF',
    {
      contactQueryResult: [],
      guestQueryResult: []
    },
    [makeEntry('new@example.com', 'Alice', 'Smith', '2026-02-01')],
    (results, calls) => {
      assert(calls.contactCreates.length === 1, 'Contact.create called once');
      assert(calls.contactCreates[0].Email === 'new@example.com', 'Contact email is correct');
      assert(calls.guestCreates.length === 1, 'TVRS_Guest__c.create called once');
      assert(calls.guestUpdates.length === 0, 'TVRS_Guest__c.update NOT called');
      assert(results.contacts.created === 1, 'contacts.created = 1');
      assert(results.contacts.failed === 0, 'contacts.failed = 0');
      assert(results.guests.created === 1, 'guests.created = 1');
      assert(results.needsReview.length === 0, 'no needsReview items');
      assert(results.success === 1, 'success alias = 1');
      assert(results.failed === 0, 'failed alias = 0');
    }
  );
}

// ---------------------------------------------------------------------------
// Scenario 2: Existing guest — email has 1 SF contact → Contact NOT created, TVRS created
// ---------------------------------------------------------------------------
async function scenario2() {
  await runScenario(
    'Existing guest — 1 matching SF Contact',
    {
      contactQueryResult: [{ Id: 'Existing001', Email: 'existing@example.com' }],
      guestQueryResult: []
    },
    [makeEntry('existing@example.com', 'Bob', 'Jones', '2026-02-05')],
    (results, calls) => {
      assert(calls.contactCreates.length === 0, 'Contact.create NOT called');
      assert(calls.guestCreates.length === 1, 'TVRS_Guest__c.create called once');
      assert(results.contacts.created === 0, 'contacts.created = 0');
      assert(results.guests.created === 1, 'guests.created = 1');
      assert(results.needsReview.length === 0, 'no needsReview items');
    }
  );
}

// ---------------------------------------------------------------------------
// Scenario 3: Shared email in batch — same email, 2 different names
//             → both entries flagged needsReview, nothing written to SF
// ---------------------------------------------------------------------------
async function scenario3() {
  await runScenario(
    'Shared email in batch — 2 distinct names',
    {
      contactQueryResult: [],
      guestQueryResult: []
    },
    [
      makeEntry('shared@example.com', 'Carol', 'Adams', '2026-02-01'),
      makeEntry('shared@example.com', 'David', 'Brown', '2026-02-02')
    ],
    (results, calls) => {
      assert(calls.contactCreates.length === 0, 'Contact.create NOT called');
      assert(calls.guestCreates.length === 0, 'TVRS_Guest__c.create NOT called');
      assert(results.needsReview.length === 2, 'both entries in needsReview');
      assert(
        results.needsReview.every(r => r.reason === 'shared-email-in-batch'),
        'all reasons are shared-email-in-batch'
      );
      assert(results.needsReview[0].email === 'shared@example.com', 'email recorded correctly');
      assert(results.contacts.created === 0, 'contacts.created = 0');
      assert(results.guests.created === 0, 'guests.created = 0');
    }
  );
}

// ---------------------------------------------------------------------------
// Scenario 4: Duplicate SF contacts — email returns 2 SF records
//             → needsReview('multiple-sf-contacts'), nothing written
// ---------------------------------------------------------------------------
async function scenario4() {
  await runScenario(
    'Duplicate SF contacts — email returns 2 SF records',
    {
      contactQueryResult: [
        { Id: 'Contact001', Email: 'dup@example.com' },
        { Id: 'Contact002', Email: 'dup@example.com' }
      ],
      guestQueryResult: []
    },
    [makeEntry('dup@example.com', 'Eve', 'Green', '2026-02-10')],
    (results, calls) => {
      assert(calls.contactCreates.length === 0, 'Contact.create NOT called');
      assert(calls.guestCreates.length === 0, 'TVRS_Guest__c.create NOT called');
      assert(results.needsReview.length === 1, '1 entry in needsReview');
      assert(results.needsReview[0].reason === 'multiple-sf-contacts', 'reason is multiple-sf-contacts');
      assert(results.needsReview[0].email === 'dup@example.com', 'email recorded correctly');
      assert(results.contacts.created === 0, 'contacts.created = 0');
    }
  );
}

// ---------------------------------------------------------------------------
// Scenario 5: Existing TVRS_Guest__c record — guest.update called, not create
// ---------------------------------------------------------------------------
async function scenario5() {
  await runScenario(
    'Existing TVRS_Guest__c — update called, not create',
    {
      contactQueryResult: [{ Id: 'Contact123', Email: 'update@example.com' }],
      guestQueryResult: [
        { Id: 'Guest999', Contact__c: 'Contact123', Check_In_Date__c: '2026-02-15' }
      ]
    },
    [makeEntry('update@example.com', 'Frank', 'Hill', '2026-02-15')],
    (results, calls) => {
      assert(calls.contactCreates.length === 0, 'Contact.create NOT called');
      assert(calls.guestCreates.length === 0, 'TVRS_Guest__c.create NOT called');
      assert(calls.guestUpdates.length === 1, 'TVRS_Guest__c.update called once');
      assert(calls.guestUpdates[0].Id === 'Guest999', 'correct guest record updated');
      assert(results.guests.updated === 1, 'guests.updated = 1');
      assert(results.guests.created === 0, 'guests.created = 0');
      assert(results.needsReview.length === 0, 'no needsReview items');
    }
  );
}

// ---------------------------------------------------------------------------
// Scenario 6: Same email, same name repeated → only one Contact/Guest created
// ---------------------------------------------------------------------------
async function scenario6() {
  await runScenario(
    'Same email, same name repeated — deduplicated correctly',
    {
      contactQueryResult: [],
      guestQueryResult: []
    },
    [
      makeEntry('repeat@example.com', 'Grace', 'Lee', '2026-02-01'),
      makeEntry('repeat@example.com', 'Grace', 'Lee', '2026-02-01') // exact duplicate
    ],
    (results, calls) => {
      assert(calls.contactCreates.length === 1, 'Contact.create called exactly once');
      assert(calls.guestCreates.length === 1, 'TVRS_Guest__c.create called exactly once');
      assert(results.needsReview.length === 0, 'no needsReview items (same name = not a conflict)');
    }
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('Running syncGuestCheckIns() unit tests...');

  try {
    await scenario1();
    await scenario2();
    await scenario3();
    await scenario4();
    await scenario5();
    await scenario6();
  } catch (err) {
    console.error('\nUnexpected error during test run:', err.message);
    console.error(err.stack);
    failed++;
  }

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);

  if (failed > 0) {
    process.exit(1);
  }
}

main();
