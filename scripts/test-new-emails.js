#!/usr/bin/env node
/**
 * Test New Email Features — Dry Run
 *
 * Queries real Oracle data, classifies guests (read-only SF queries),
 * then sends the daily summary (with CSV attachment) and front desk report
 * to a single test recipient.
 *
 * Usage:
 *   node scripts/test-new-emails.js francis.phan@vinesofmendoza.com
 *   node scripts/test-new-emails.js francis.phan@vinesofmendoza.com --mock
 *
 * --mock  Skip Oracle/SF and use synthetic data (useful if DB is unreachable)
 */

'use strict';
require('dotenv').config();

const fs = require('fs');
const logger = require('../src/logger');
const Notifier = require('../src/notifier');
const DailyStats = require('../src/daily-stats');

logger.level = 'info';

const EMAIL_TO = process.argv[2];
const USE_MOCK = process.argv.includes('--mock');

if (!EMAIL_TO || EMAIL_TO.startsWith('--')) {
  console.error('Usage: node scripts/test-new-emails.js <email> [--mock]');
  process.exit(1);
}

// ── Mock data for --mock mode ───────────────────────────────────────────────

function buildMockData() {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const frontDeskDetails = [
    { firstName: 'Carlos', lastName: 'Booking', email: 'reservas@agencia.com.ar', reason: 'agent-domain', checkIn: yesterday, checkOut: tomorrow },
    { firstName: 'María', lastName: 'García', email: '', reason: 'invalid-email', checkIn: yesterday, checkOut: tomorrow },
    { firstName: 'Jean', lastName: 'Dupont', email: 'noemail', reason: 'invalid-email', checkIn: today, checkOut: tomorrow },
    { firstName: 'Silvia', lastName: 'Expedia', email: 'silvia@expedia.com', reason: 'expedia-proxy', checkIn: today, checkOut: tomorrow },
  ];

  const needsReviewDetails = [
    {
      email: 'shared@example.com', firstName: 'John', lastName: 'Smith',
      phone: '+1-555-0101', billingCity: 'New York', billingState: 'NY',
      billingCountry: 'US', language: 'E',
      checkInDate: today, checkOutDate: tomorrow,
      reason: 'shared-email-no-name-match',
      details: 'SF Contact: Jane Doe; Opera names: John Smith, Mary Smith'
    },
    {
      email: 'shared@example.com', firstName: 'Mary', lastName: 'Smith',
      phone: '', billingCity: 'New York', billingState: 'NY',
      billingCountry: 'US', language: 'E',
      checkInDate: today, checkOutDate: tomorrow,
      reason: 'shared-email-no-name-match',
      details: 'SF Contact: Jane Doe; Opera names: John Smith, Mary Smith'
    },
    {
      email: 'couple@gmail.com', firstName: 'Roberto', lastName: 'Alonso',
      phone: '+54-261-555-0102', billingCity: 'Buenos Aires', billingState: '',
      billingCountry: 'AR', language: 'S',
      checkInDate: yesterday, checkOutDate: tomorrow,
      reason: 'shared-email-new-contact',
      details: 'Opera names: Roberto Alonso, Laura Alonso'
    },
    {
      email: 'couple@gmail.com', firstName: 'Laura', lastName: 'Alonso',
      phone: '', billingCity: 'Buenos Aires', billingState: '',
      billingCountry: 'AR', language: 'S',
      checkInDate: yesterday, checkOutDate: tomorrow,
      reason: 'shared-email-new-contact',
      details: 'Opera names: Roberto Alonso, Laura Alonso'
    },
    {
      email: 'ambiguous@corp.com', firstName: 'David', lastName: 'Lee',
      phone: '+44-20-555-0103', billingCity: 'London', billingState: '',
      billingCountry: 'GB', language: 'E',
      checkInDate: today, checkOutDate: tomorrow,
      reason: 'multiple-sf-contacts'
    },
  ];

  return {
    date: today,
    uploaded: 47,
    frontDesk: frontDeskDetails.length,
    frontDeskDetails,
    skippedDuplicates: 1,
    skippedDuplicateDetails: [],
    needsReview: needsReviewDetails.length,
    needsReviewDetails,
    errors: 0,
    errorDetails: [],
  };
}

// ── Live data: query Oracle + classify via SF ───────────────────────────────

async function buildLiveData() {
  const OracleClient = require('../src/oracle-client');
  const jsforce = require('jsforce');
  const { queryGuestsSince } = require('../src/opera-db-query');
  const { isAgentEmail } = require('../src/guest-utils');

  const SINCE_IDX = process.argv.indexOf('--since');
  let lastSync = null;
  if (SINCE_IDX !== -1 && process.argv[SINCE_IDX + 1]) {
    lastSync = new Date(process.argv[SINCE_IDX + 1]).toISOString();
    console.log(`  Using --since override: ${lastSync}`);
  } else {
    const STATE_FILE = '/mnt/y/opera-sf-sync/sync-state.json';
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      lastSync = state.lastSyncTimestamp || null;
      console.log(`  Sync state: since ${lastSync || '(initial)'}`);
    } catch { console.log('  No sync-state file — querying last 24 months'); }
  }

  // Oracle
  console.log('  Connecting to Oracle...');
  const oracleClient = new OracleClient({
    host: process.env.ORACLE_HOST,
    port: process.env.ORACLE_PORT || '1521',
    sid: process.env.ORACLE_SID,
    service: process.env.ORACLE_SERVICE,
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
  });
  await oracleClient.connect();
  console.log('  Connected to Oracle.');

  const { records, frontDesk } = await queryGuestsSince(oracleClient, lastSync);
  await oracleClient.close();
  console.log(`  Oracle: ${records.length} eligible, ${frontDesk.length} front desk`);

  // Salesforce (read-only)
  console.log('  Connecting to Salesforce...');
  const sfConn = new jsforce.Connection({
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
  await sfConn.identity();
  console.log('  Connected to Salesforce.');

  // Classify emails
  const emailGroups = new Map();
  for (const entry of records) {
    const email = (entry.customer.email || '').toLowerCase();
    if (!email) continue;
    if (!emailGroups.has(email)) emailGroups.set(email, []);
    emailGroups.get(email).push(entry);
  }

  // Detect shared emails
  const sharedEmailGroups = new Map();
  for (const [email, entries] of emailGroups) {
    if (entries.length < 2) continue;
    const names = new Set(entries.map(e =>
      `${(e.customer.firstName || '').toLowerCase()}|${(e.customer.lastName || '').toLowerCase()}`
    ));
    if (names.size > 1) sharedEmailGroups.set(email, entries);
  }

  // Query SF Contacts
  const uniqueEmails = [...new Set(records.map(e => (e.customer.email || '').toLowerCase()).filter(Boolean))];
  const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 200;
  const emailStatus = new Map();
  for (const email of uniqueEmails) emailStatus.set(email, { status: 'new' });

  for (let i = 0; i < uniqueEmails.length; i += BATCH_SIZE) {
    const batch = uniqueEmails.slice(i, i + BATCH_SIZE);
    const escaped = batch.map(e => `'${e.replace(/'/g, "\\'")}'`).join(',');
    const result = await sfConn.query(`SELECT Id, Email, FirstName, LastName FROM Contact WHERE Email IN (${escaped})`);
    const sfByEmail = new Map();
    for (const rec of result.records) {
      const email = rec.Email.toLowerCase();
      if (!sfByEmail.has(email)) sfByEmail.set(email, []);
      sfByEmail.get(email).push({ id: rec.Id, firstName: rec.FirstName || '', lastName: rec.LastName || '' });
    }
    for (const [email, contacts] of sfByEmail) {
      if (contacts.length === 1) {
        emailStatus.set(email, {
          status: 'exists', contactId: contacts[0].id,
          sfFirstName: contacts[0].firstName, sfLastName: contacts[0].lastName
        });
      } else {
        emailStatus.set(email, { status: 'ambiguous' });
      }
    }
  }

  // Resolve shared-email groups and build needsReview
  const needsReviewDetails = [];
  const excludedEntries = new Set();

  for (const [email, entries] of sharedEmailGroups) {
    const status = emailStatus.get(email);
    if (!status) continue;

    if (status.status === 'exists') {
      const sfFirst = (status.sfFirstName || '').toLowerCase();
      const sfLast = (status.sfLastName || '').toLowerCase();
      let matchedEntry = null;
      for (const entry of entries) {
        if ((entry.customer.firstName || '').toLowerCase() === sfFirst &&
            (entry.customer.lastName || '').toLowerCase() === sfLast) {
          matchedEntry = entry;
          break;
        }
      }
      if (matchedEntry) {
        for (const entry of entries) {
          if (entry !== matchedEntry) excludedEntries.add(entry);
        }
      } else {
        const nameList = entries.map(e => `${e.customer.firstName} ${e.customer.lastName}`).join(', ');
        for (const entry of entries) {
          needsReviewDetails.push({
            email, firstName: entry.customer.firstName, lastName: entry.customer.lastName,
            phone: entry.customer.phone || '', billingCity: entry.customer.billingCity || '',
            billingState: entry.customer.billingState || '', billingCountry: entry.customer.billingCountry || '',
            language: entry.customer.language || '',
            checkInDate: entry.invoice?.checkIn || '', checkOutDate: entry.invoice?.checkOut || '',
            reason: 'shared-email-no-name-match',
            details: `SF Contact: ${status.sfFirstName} ${status.sfLastName}; Opera names: ${nameList}`
          });
        }
      }
    } else if (status.status === 'new') {
      const nameList = entries.map(e => `${e.customer.firstName} ${e.customer.lastName}`).join(', ');
      for (const entry of entries) {
        needsReviewDetails.push({
          email, firstName: entry.customer.firstName, lastName: entry.customer.lastName,
          phone: entry.customer.phone || '', billingCity: entry.customer.billingCity || '',
          billingState: entry.customer.billingState || '', billingCountry: entry.customer.billingCountry || '',
          language: entry.customer.language || '',
          checkInDate: entry.invoice?.checkIn || '', checkOutDate: entry.invoice?.checkOut || '',
          reason: 'shared-email-new-contact', details: `Opera names: ${nameList}`
        });
      }
    }
  }

  // Add ambiguous
  for (const entry of records) {
    const email = (entry.customer.email || '').toLowerCase();
    const status = emailStatus.get(email);
    if (status && status.status === 'ambiguous') {
      needsReviewDetails.push({
        email, firstName: entry.customer.firstName, lastName: entry.customer.lastName,
        phone: entry.customer.phone || '', billingCity: entry.customer.billingCity || '',
        billingState: entry.customer.billingState || '', billingCountry: entry.customer.billingCountry || '',
        language: entry.customer.language || '',
        checkInDate: entry.invoice?.checkIn || '', checkOutDate: entry.invoice?.checkOut || '',
        reason: 'multiple-sf-contacts'
      });
    }
  }

  const eligible = records.filter(e => !excludedEntries.has(e));
  const today = new Date().toISOString().slice(0, 10);

  console.log(`  Classified: ${eligible.length} eligible (${excludedEntries.size} excluded), ${needsReviewDetails.length} needs review, ${frontDesk.length} front desk`);

  return {
    date: today,
    uploaded: eligible.length,
    frontDesk: frontDesk.length,
    frontDeskDetails: frontDesk,
    skippedDuplicates: 0,
    skippedDuplicateDetails: [],
    needsReview: needsReviewDetails.length,
    needsReviewDetails,
    errors: 0,
    errorDetails: [],
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('  Test New Emails — Dry Run');
  console.log(`  All emails → ${EMAIL_TO}`);
  console.log(`  Mode: ${USE_MOCK ? 'MOCK data' : 'LIVE Oracle + SF (read-only)'}`);
  console.log('='.repeat(70));

  // Override email recipients
  process.env.EMAIL_TO = EMAIL_TO;
  process.env.FRONT_DESK_EMAIL_TO = EMAIL_TO;

  const notifier = new Notifier();
  if (!notifier.emailEnabled) {
    console.error('\n  ERROR: EMAIL_ENABLED is not set. Set EMAIL_ENABLED=true in .env');
    process.exit(1);
  }

  console.log(`\n  From: ${notifier.emailFrom}`);
  console.log(`  To:   ${EMAIL_TO}\n`);

  // Build stats
  let stats;
  if (USE_MOCK) {
    stats = buildMockData();
    console.log('  Using mock data:');
  } else {
    stats = await buildLiveData();
    console.log('\n  Live data summary:');
  }

  console.log(`    Uploaded:     ${stats.uploaded}`);
  console.log(`    Front desk:   ${stats.frontDesk}`);
  console.log(`    Needs review: ${stats.needsReview}`);
  console.log(`    Errors:       ${stats.errors}`);

  // 1. Send daily summary (with CSV attachment)
  console.log('\n  Sending daily summary email (with CSV attachment)...');
  await notifier.sendDailySummary(stats);
  console.log('  ✓ Daily summary sent');

  // 2. Send front desk report
  if (stats.frontDeskDetails.length > 0) {
    console.log('  Sending front desk report email...');
    await notifier.sendFrontDeskReport(stats);
    console.log('  ✓ Front desk report sent');
  } else {
    console.log('  (No front desk entries — skipping front desk report)');
  }

  console.log('\n' + '='.repeat(70));
  console.log('  Done! Check your inbox at:');
  console.log(`    ${EMAIL_TO}`);
  console.log('');
  console.log('  You should receive:');
  console.log('    1. Daily Summary — with updated layout + CSV attachment');
  if (stats.frontDeskDetails.length > 0)
    console.log('    2. Front Desk Report — on-property guests needing email');
  console.log('='.repeat(70) + '\n');
}

main().catch(err => {
  console.error('\nFatal error:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
