#!/usr/bin/env node
/**
 * Dry Run — Opera DB → Salesforce Preview
 *
 * Reads the last-sync timestamp from sync-state.json, queries the Opera Oracle
 * database for guests modified since that point (exactly what the live sync
 * would pick up), then queries Salesforce (read-only) to classify every record.
 *
 * Nothing is written to Oracle or Salesforce.
 *
 * Usage:
 *   node scripts/dry-run.js
 *   node scripts/dry-run.js --verbose          # show individual guest rows
 *   node scripts/dry-run.js --since 2026-02-01  # override the since timestamp
 */

'use strict';
require('dotenv').config();

const fs      = require('fs');
const jsforce = require('jsforce');
const OracleClient      = require('../src/oracle-client');
const { queryGuestsSince } = require('../src/opera-db-query');
const { transformToTVRSGuest } = require('../src/guest-utils');

// ── Config ────────────────────────────────────────────────────────────────────

const VERBOSE      = process.argv.includes('--verbose');
const SINCE_ARG    = (() => { const i = process.argv.indexOf('--since'); return i !== -1 ? process.argv[i + 1] : null; })();

const STATE_FILE   = '/mnt/y/opera-sf-sync/sync-state.json';
const GUEST_OBJECT = process.env.SF_OBJECT || 'TVRS_Guest__c';
const CONTACT_LOOKUP = process.env.SF_GUEST_CONTACT_LOOKUP || 'Contact__c';
const BATCH_SIZE   = parseInt(process.env.BATCH_SIZE) || 200;

// ── Helpers ───────────────────────────────────────────────────────────────────

function hr(char = '─', len = 68) { return char.repeat(len); }
function section(title) {
  console.log('\n' + hr());
  console.log('  ' + title);
  console.log(hr());
}
function row(label, value) {
  console.log(`  ${label.padEnd(38)}${value}`);
}
function guestLabel(entry) {
  const { firstName, lastName, email } = entry.customer;
  const checkIn = entry.invoice?.checkIn || '—';
  return `${firstName} ${lastName} <${email}>  check-in: ${checkIn}`;
}
function verboseList(title, entries, max = 30) {
  if (!entries.length) return;
  console.log(`\n    ${title}:`);
  entries.slice(0, max).forEach(e => console.log(`      · ${guestLabel(e)}`));
  if (entries.length > max) console.log(`      … and ${entries.length - max} more`);
}

// ── SF connection (read-only — only query() is called) ────────────────────────

function connectSF() {
  return new jsforce.Connection({
    oauth2: {
      loginUrl: 'https://login.salesforce.com',
      clientId: process.env.SF_CLIENT_ID,
      clientSecret: process.env.SF_CLIENT_SECRET,
      redirectUri: 'http://localhost:3000/oauth/callback',
    },
    instanceUrl: process.env.SF_INSTANCE_URL,
    refreshToken: process.env.SF_REFRESH_TOKEN,
    version: '59.0',
  });
}

async function queryAll(conn, soql) {
  let res = await conn.query(soql);
  const records = [...res.records];
  while (!res.done) {
    res = await conn.queryMore(res.nextRecordsUrl);
    records.push(...res.records);
  }
  return records;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();

  console.log('\n' + hr('═'));
  console.log('  DRY RUN — Opera DB → Salesforce Preview');
  console.log(`  Run at: ${now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })} (ART)`);
  console.log(hr('═'));

  // ── 1. Determine the "since" timestamp ───────────────────────────────────

  section('Sync State');

  let lastSyncTimestamp = null;

  if (SINCE_ARG) {
    lastSyncTimestamp = new Date(SINCE_ARG).toISOString();
    console.log(`  Using --since override: ${lastSyncTimestamp}`);
  } else {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      lastSyncTimestamp = state.lastSyncTimestamp || null;
      console.log(`  State file  : ${STATE_FILE}`);
      console.log(`  Last sync   : ${lastSyncTimestamp || 'never (initial sync)'}`);
      console.log(`  Last status : ${state.lastSyncStatus || '—'}`);
      console.log(`  Last count  : ${state.lastSyncRecordCount ?? '—'} records`);
    } catch (err) {
      console.warn(`  WARNING: Could not read ${STATE_FILE}: ${err.message}`);
      console.warn('  Proceeding as if no previous sync (will query last 24 months).');
    }
  }

  console.log(`\n  Oracle will be queried for changes since: ${lastSyncTimestamp || '(none — initial sync)'}`);

  // ── 2. Query Opera Oracle ─────────────────────────────────────────────────

  section('Opera Database Query');

  const oracleClient = new OracleClient({
    host    : process.env.ORACLE_HOST,
    port    : process.env.ORACLE_PORT || '1521',
    sid     : process.env.ORACLE_SID,
    service : process.env.ORACLE_SERVICE,
    user    : process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
  });

  console.log('  Connecting to Oracle...');
  await oracleClient.connect();
  console.log('  Connected.\n');

  const { records: allRecords, filtered: allFiltered, invalid: allInvalid } =
    await queryGuestsSince(oracleClient, lastSyncTimestamp);

  await oracleClient.close();

  const totalRaw = allRecords.length + allFiltered.length + allInvalid.length;
  row('Guests found in Oracle:',     String(totalRaw));
  row('  Filtered — agent/proxy:',   String(allFiltered.length));
  row('  Invalid email:',            String(allInvalid.length));
  row('Eligible for Salesforce sync:', String(allRecords.length));

  if (VERBOSE && allFiltered.length) {
    console.log('\n    Filtered (agent/proxy):');
    allFiltered.slice(0, 20).forEach(e => {
      console.log(`      · ${e.firstName} ${e.lastName} <${e.email}> [${e.category}]`);
    });
    if (allFiltered.length > 20) console.log(`      … and ${allFiltered.length - 20} more`);
  }

  if (VERBOSE && allInvalid.length) {
    console.log('\n    Invalid email:');
    allInvalid.slice(0, 20).forEach(e => {
      console.log(`      · ${e.firstName} ${e.lastName} <${e.email}>`);
    });
    if (allInvalid.length > 20) console.log(`      … and ${allInvalid.length - 20} more`);
  }

  if (allRecords.length === 0) {
    console.log('\n  No eligible records. Nothing would be synced.');
    process.exit(0);
  }

  // ── 3. Pre-flight: within-batch conflict detection ────────────────────────

  section('Pre-flight: Shared Email Conflicts');

  const emailGroups = new Map();
  for (const entry of allRecords) {
    const email = (entry.customer.email || '').toLowerCase();
    if (!email) continue;
    if (!emailGroups.has(email)) emailGroups.set(email, []);
    emailGroups.get(email).push(entry);
  }

  const batchConflictEmails  = new Set();
  const batchConflictEntries = [];

  for (const [email, entries] of emailGroups) {
    if (entries.length < 2) continue;
    const names = new Set(
      entries.map(e =>
        `${(e.customer.firstName || '').toLowerCase()}|${(e.customer.lastName || '').toLowerCase()}`
      )
    );
    if (names.size > 1) {
      batchConflictEmails.add(email);
      batchConflictEntries.push(...entries);
    }
  }

  if (batchConflictEmails.size === 0) {
    console.log('  None.');
  } else {
    row('Emails with conflicting names:', String(batchConflictEmails.size));
    row('Entries → needsReview:',         String(batchConflictEntries.length));
    for (const email of batchConflictEmails) {
      const entries = emailGroups.get(email);
      const names = entries.map(e => `${e.customer.firstName} ${e.customer.lastName}`).join(' / ');
      console.log(`\n    ${email}`);
      console.log(`      Names: ${names}`);
    }
  }

  const eligibleEntries = allRecords.filter(entry => {
    const email = (entry.customer.email || '').toLowerCase();
    return email && !batchConflictEmails.has(email);
  });

  const uniqueEmails = [
    ...new Set(eligibleEntries.map(e => (e.customer.email || '').toLowerCase()))
  ];

  // ── 4. Salesforce: Contact lookup ─────────────────────────────────────────

  section('Salesforce — Contact Lookup (read-only)');

  console.log('  Connecting to Salesforce...');
  const sfConn = connectSF();
  await sfConn.identity();
  console.log(`  Connected.\n  Querying ${uniqueEmails.length} unique email${uniqueEmails.length !== 1 ? 's' : ''}...`);

  const emailStatus = new Map();
  for (const email of uniqueEmails) emailStatus.set(email, { status: 'new' });

  for (let i = 0; i < uniqueEmails.length; i += BATCH_SIZE) {
    const batch   = uniqueEmails.slice(i, i + BATCH_SIZE);
    const escaped = batch.map(e => `'${e.replace(/'/g, "\\'")}'`).join(',');
    const result  = await sfConn.query(`SELECT Id, Email FROM Contact WHERE Email IN (${escaped})`);

    const sfByEmail = new Map();
    for (const rec of result.records) {
      const email = rec.Email.toLowerCase();
      if (!sfByEmail.has(email)) sfByEmail.set(email, []);
      sfByEmail.get(email).push(rec.Id);
    }
    for (const [email, ids] of sfByEmail) {
      emailStatus.set(email, ids.length === 1
        ? { status: 'exists', contactId: ids[0] }
        : { status: 'ambiguous' }
      );
    }
  }

  const newEmailSet       = new Set([...emailStatus.entries()].filter(([, s]) => s.status === 'new').map(([e]) => e));
  const existsEmailSet    = new Set([...emailStatus.entries()].filter(([, s]) => s.status === 'exists').map(([e]) => e));
  const ambiguousEmailSet = new Set([...emailStatus.entries()].filter(([, s]) => s.status === 'ambiguous').map(([e]) => e));

  const newContactEntries       = eligibleEntries.filter(e => newEmailSet.has((e.customer.email||'').toLowerCase()));
  const existingContactEntries  = eligibleEntries.filter(e => existsEmailSet.has((e.customer.email||'').toLowerCase()));
  const ambiguousContactEntries = eligibleEntries.filter(e => ambiguousEmailSet.has((e.customer.email||'').toLowerCase()));

  row('NEW   — Contact would be created:',    `${newEmailSet.size} unique email${newEmailSet.size !== 1 ? 's' : ''}`);
  row('EXISTS — Contact already in SF:',      `${existsEmailSet.size} unique email${existsEmailSet.size !== 1 ? 's' : ''}`);
  row('AMBIGUOUS — 2+ SF Contacts for email:', `${ambiguousEmailSet.size} → needsReview`);

  if (VERBOSE) {
    verboseList('Contacts that WOULD BE CREATED', newContactEntries);
    verboseList('Ambiguous — needsReview', ambiguousContactEntries);
  } else {
    if (newEmailSet.size)       console.log(`\n  (pass --verbose to list the ${newEmailSet.size} new-contact guest${newEmailSet.size !== 1 ? 's' : ''})`);
    if (ambiguousEmailSet.size) console.log(`  (pass --verbose to list the ${ambiguousEmailSet.size} ambiguous guest${ambiguousEmailSet.size !== 1 ? 's' : ''})`);
  }

  // Assign placeholder IDs for new emails so Phase 3 can classify them
  for (const email of newEmailSet) {
    emailStatus.set(email, { status: 'exists', contactId: `__NEW__:${email}` });
  }

  // ── 5. Salesforce: TVRS_Guest__c lookup ───────────────────────────────────

  section(`Salesforce — ${GUEST_OBJECT} Lookup (read-only)`);

  const realContactIds = [...emailStatus.values()]
    .filter(s => s.status === 'exists' && s.contactId && !s.contactId.startsWith('__NEW__'))
    .map(s => s.contactId);

  const existingGuestMap = new Map(); // "contactId|checkInDate" → guestRecordId

  if (realContactIds.length > 0) {
    console.log(`  Querying ${GUEST_OBJECT} for ${realContactIds.length} existing Contact${realContactIds.length !== 1 ? 's' : ''}...`);
    for (let i = 0; i < realContactIds.length; i += BATCH_SIZE) {
      const idBatch = realContactIds.slice(i, i + BATCH_SIZE);
      const escaped = idBatch.map(id => `'${id}'`).join(',');
      try {
        let result = await sfConn.query(
          `SELECT Id, ${CONTACT_LOOKUP}, Check_In_Date__c FROM ${GUEST_OBJECT} ` +
          `WHERE ${CONTACT_LOOKUP} IN (${escaped})`
        );
        let allRecs = result.records;
        while (!result.done) {
          result = await sfConn.queryMore(result.nextRecordsUrl);
          allRecs = allRecs.concat(result.records);
        }
        for (const rec of allRecs) {
          if (rec[CONTACT_LOOKUP] && rec.Check_In_Date__c) {
            existingGuestMap.set(`${rec[CONTACT_LOOKUP]}|${rec.Check_In_Date__c}`, rec.Id);
          }
        }
      } catch (err) {
        console.warn(`  WARNING: could not query ${GUEST_OBJECT}: ${err.message}`);
      }
    }
    console.log(`  Found ${existingGuestMap.size} existing check-in record${existingGuestMap.size !== 1 ? 's' : ''}.`);
  } else {
    console.log('  No existing Contacts to check — all guest records would be new.');
  }

  const guestsToCreate = [];
  const guestsToUpdate = [];
  const seenGuestKeys  = new Set();

  for (const entry of allRecords) {
    const email = (entry.customer.email || '').toLowerCase();
    if (!email) continue;
    const status = emailStatus.get(email);
    if (!status || status.status !== 'exists' || !status.contactId) continue;

    const guestRecord = transformToTVRSGuest(entry.customer, entry.invoice, status.contactId);
    const checkInDate = guestRecord.Check_In_Date__c || null;
    const matchKey    = checkInDate ? `${status.contactId}|${checkInDate}` : null;

    if (matchKey && seenGuestKeys.has(matchKey)) continue;
    if (matchKey) seenGuestKeys.add(matchKey);

    if (matchKey && existingGuestMap.has(matchKey)) {
      guestsToUpdate.push(entry);
    } else {
      guestsToCreate.push(entry);
    }
  }

  row(`${GUEST_OBJECT} would be CREATED:`, String(guestsToCreate.length));
  row(`${GUEST_OBJECT} would be UPDATED:`, String(guestsToUpdate.length));

  if (VERBOSE) {
    verboseList('Guest records that WOULD BE CREATED', guestsToCreate);
    verboseList('Guest records that WOULD BE UPDATED', guestsToUpdate);
  }

  // ── 6. Summary ────────────────────────────────────────────────────────────

  section('Summary');

  const totalNeedsReview = batchConflictEntries.length + ambiguousContactEntries.length;

  row('Since timestamp:',              lastSyncTimestamp || '(initial sync)');
  row('Guests found in Oracle:',        String(totalRaw));
  console.log('');
  row('  Filtered (agent/proxy):',      String(allFiltered.length));
  row('  Invalid email:',               String(allInvalid.length));
  row('  Shared-email conflict:',       `${batchConflictEntries.length} entries → needsReview`);
  row('  Ambiguous SF Contacts:',       `${ambiguousContactEntries.length} entries → needsReview`);
  console.log('');
  row('Contacts would be CREATED:',     String(newEmailSet.size));
  row('Contacts left unchanged:',       String(existsEmailSet.size));
  console.log('');
  row(`${GUEST_OBJECT} would be CREATED:`, String(guestsToCreate.length));
  row(`${GUEST_OBJECT} would be UPDATED:`, String(guestsToUpdate.length));
  console.log('');
  row('Total needsReview:',             String(totalNeedsReview));

  console.log('\n' + hr());
  console.log('  Nothing was written to Oracle or Salesforce.');
  if (!VERBOSE && (newEmailSet.size + guestsToCreate.length + guestsToUpdate.length + totalNeedsReview) > 0) {
    console.log('  Re-run with --verbose to see individual guest rows per category.');
  }
  console.log(hr() + '\n');
}

main().catch(err => {
  console.error('\nFatal error:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
