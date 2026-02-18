#!/usr/bin/env node
/**
 * Find Name Conflicts
 *
 * Identifies Salesforce Contact records whose name may have been overwritten
 * by the shared-email bug: when multiple OPERA guests share one email address,
 * the last person's name was written to the Contact, corrupting it.
 *
 * Detection logic: flag a Contact if its FirstName+LastName does NOT match
 * any of the Guest_First_Name__c + Guest_Last_Name__c values on its linked
 * TVRS_Guest__c records.
 *
 * Output: console table + CSV at scripts/output/name-conflicts-<timestamp>.csv
 *
 * Usage: node scripts/find-name-conflicts.js
 */

require('dotenv').config();
const jsforce = require('jsforce');
const fs = require('fs');
const path = require('path');

const SF_CONFIG = {
  instanceUrl: process.env.SF_INSTANCE_URL,
  clientId: process.env.SF_CLIENT_ID,
  clientSecret: process.env.SF_CLIENT_SECRET,
  refreshToken: process.env.SF_REFRESH_TOKEN,
};

const GUEST_OBJECT = process.env.SF_OBJECT || 'TVRS_Guest__c';
const CONTACT_LOOKUP = process.env.SF_GUEST_CONTACT_LOOKUP || 'Contact__c';
const BATCH_SIZE = 200;

// ---------------------------------------------------------------------------

function normalizeName(first, last) {
  return `${(first || '').trim().toLowerCase()}|${(last || '').trim().toLowerCase()}`;
}

async function queryAll(conn, soql) {
  let result = await conn.query(soql);
  let records = result.records;
  while (!result.done) {
    result = await conn.queryMore(result.nextRecordsUrl);
    records = records.concat(result.records);
  }
  return records;
}

async function main() {
  console.log('='.repeat(70));
  console.log('  Contact Name Conflict Finder');
  console.log('  Detects Contacts overwritten by shared-email bug');
  console.log('='.repeat(70));

  // --- Connect ---
  const conn = new jsforce.Connection({
    oauth2: {
      loginUrl: 'https://login.salesforce.com',
      clientId: SF_CONFIG.clientId,
      clientSecret: SF_CONFIG.clientSecret,
      redirectUri: 'http://localhost:3000/oauth/callback',
    },
    instanceUrl: SF_CONFIG.instanceUrl,
    refreshToken: SF_CONFIG.refreshToken,
    version: '59.0',
  });

  console.log('\nConnecting to Salesforce...');
  const identity = await conn.identity();
  console.log(`Connected as: ${identity.username}`);

  // --- Step 1: Get all Contact IDs that have at least one guest record ---
  console.log(`\nQuerying ${GUEST_OBJECT} for linked Contact IDs...`);
  const guestContactIdQuery = `SELECT ${CONTACT_LOOKUP} FROM ${GUEST_OBJECT} WHERE ${CONTACT_LOOKUP} != null`;
  const guestRefs = await queryAll(conn, guestContactIdQuery);

  const contactIdSet = new Set(guestRefs.map(r => r[CONTACT_LOOKUP]));
  const allContactIds = [...contactIdSet];
  console.log(`Found ${allContactIds.length} unique Contacts with guest records`);

  // --- Step 2: Fetch Contact details in batches ---
  console.log('\nFetching Contact details...');
  const contactMap = new Map(); // Id → {FirstName, LastName, Email}

  for (let i = 0; i < allContactIds.length; i += BATCH_SIZE) {
    const batch = allContactIds.slice(i, i + BATCH_SIZE);
    const escaped = batch.map(id => `'${id}'`).join(',');
    const query = `SELECT Id, FirstName, LastName, Email FROM Contact WHERE Id IN (${escaped})`;
    try {
      const records = await queryAll(conn, query);
      for (const r of records) {
        contactMap.set(r.Id, { firstName: r.FirstName || '', lastName: r.LastName || '', email: r.Email || '' });
      }
    } catch (err) {
      console.error(`  Error fetching Contact batch at offset ${i}:`, err.message);
    }
  }

  console.log(`Loaded ${contactMap.size} Contacts`);

  // --- Step 3: Fetch guest name data in batches ---
  console.log(`\nFetching guest names from ${GUEST_OBJECT}...`);
  // guestNameMap: contactId → Set of "firstname|lastname" strings
  const guestNameMap = new Map();
  // guestDateMap: contactId → sorted check-in dates
  const guestDateMap = new Map();

  for (let i = 0; i < allContactIds.length; i += BATCH_SIZE) {
    const batch = allContactIds.slice(i, i + BATCH_SIZE);
    const escaped = batch.map(id => `'${id}'`).join(',');
    const query = `SELECT ${CONTACT_LOOKUP}, Guest_First_Name__c, Guest_Last_Name__c, Check_In_Date__c FROM ${GUEST_OBJECT} WHERE ${CONTACT_LOOKUP} IN (${escaped})`;
    try {
      const records = await queryAll(conn, query);
      for (const r of records) {
        const cid = r[CONTACT_LOOKUP];
        if (!guestNameMap.has(cid)) {
          guestNameMap.set(cid, new Set());
          guestDateMap.set(cid, []);
        }
        guestNameMap.get(cid).add(normalizeName(r.Guest_First_Name__c, r.Guest_Last_Name__c));
        if (r.Check_In_Date__c) guestDateMap.get(cid).push(r.Check_In_Date__c);
      }
    } catch (err) {
      console.error(`  Error fetching guest batch at offset ${i}:`, err.message);
    }
  }

  // --- Step 4: Compare and flag mismatches ---
  console.log('\nComparing names...');
  const conflicts = [];

  for (const [contactId, contact] of contactMap) {
    const guestNames = guestNameMap.get(contactId);
    if (!guestNames) continue; // no guest records (shouldn't happen, but safe)

    const contactNorm = normalizeName(contact.firstName, contact.lastName);
    if (!guestNames.has(contactNorm)) {
      const dates = (guestDateMap.get(contactId) || []).sort().join('|');
      const guestNamesDisplay = [...guestNames]
        .map(n => n.split('|').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' '))
        .join(' / ');

      conflicts.push({
        contactId,
        email: contact.email,
        contactName: `${contact.firstName} ${contact.lastName}`.trim(),
        guestNames: guestNamesDisplay,
        checkInDates: dates,
      });
    }
  }

  // --- Step 5: Print results ---
  console.log('\n' + '='.repeat(70));
  if (conflicts.length === 0) {
    console.log('  No name conflicts found.');
  } else {
    console.log(`  Found ${conflicts.length} potentially affected Contact(s):\n`);
    console.log(
      `${'Contact ID'.padEnd(20)} ${'Email'.padEnd(35)} ${'Contact Name'.padEnd(25)} Guest Name(s)`
    );
    console.log('-'.repeat(120));
    for (const c of conflicts) {
      console.log(
        `${c.contactId.padEnd(20)} ${c.email.padEnd(35)} ${c.contactName.padEnd(25)} ${c.guestNames}`
      );
    }
  }
  console.log('='.repeat(70));
  console.log(`\nSummary: ${contactMap.size} contacts checked, ${conflicts.length} flagged`);

  // --- Step 6: Write CSV ---
  if (conflicts.length > 0) {
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const csvPath = path.join(outputDir, `name-conflicts-${timestamp}.csv`);

    const header = 'ContactId,ContactEmail,ContactName,GuestNames,CheckInDates\n';
    const rows = conflicts.map(c =>
      [c.contactId, c.email, c.contactName, c.guestNames, c.checkInDates]
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );
    fs.writeFileSync(csvPath, header + rows.join('\n') + '\n');
    console.log(`\nCSV written to: ${csvPath}`);
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message || err);
  process.exit(1);
});
