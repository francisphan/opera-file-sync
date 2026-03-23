#!/usr/bin/env node

/**
 * Dry-run script for the Daily Front Desk Report
 *
 * Usage:
 *   node scripts/dry-run-front-desk-report.js [options]
 *
 * Options:
 *   --date YYYY-MM-DD    Simulate report for a specific date (default: today Argentina time)
 *   --to email@addr      Send email to this address instead of FRONT_DESK_EMAIL_TO
 *   --no-email           Print to console only, don't send email
 *   --discover           Run schema discovery and print RESERVATION_NAME columns
 */

require('dotenv').config();

const OracleClient = require('../src/oracle-client');
const Notifier = require('../src/notifier');
const { queryFrontDeskReport, discoverReservationColumns } = require('../src/opera-db-query');
const logger = require('../src/logger');

// Parse CLI args
const args = process.argv.slice(2);
const flags = {
  date: null,
  to: null,
  noEmail: false,
  discover: false
};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--date' && args[i + 1]) {
    flags.date = args[++i];
  } else if (args[i] === '--to' && args[i + 1]) {
    flags.to = args[++i];
  } else if (args[i] === '--no-email') {
    flags.noEmail = true;
  } else if (args[i] === '--discover') {
    flags.discover = true;
  } else {
    console.error(`Unknown option: ${args[i]}`);
    console.error('Usage: node scripts/dry-run-front-desk-report.js [--date YYYY-MM-DD] [--to email] [--no-email] [--discover]');
    process.exit(1);
  }
}

async function main() {
  // Validate Oracle config
  const required = ['ORACLE_HOST', 'ORACLE_USER', 'ORACLE_PASSWORD'];
  const missing = required.filter(k => !process.env[k]);
  if (!process.env.ORACLE_SID && !process.env.ORACLE_SERVICE) {
    missing.push('ORACLE_SID or ORACLE_SERVICE');
  }
  if (missing.length > 0) {
    console.error('Missing env vars:', missing.join(', '));
    process.exit(1);
  }

  const oracleClient = new OracleClient({
    host: process.env.ORACLE_HOST,
    port: process.env.ORACLE_PORT || '1521',
    sid: process.env.ORACLE_SID,
    service: process.env.ORACLE_SERVICE,
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD
  });

  try {
    await oracleClient.connect();

    // Schema discovery mode
    if (flags.discover) {
      console.log('\n=== RESERVATION_NAME Schema Discovery ===\n');
      const cols = await discoverReservationColumns(oracleClient);
      if (cols.length > 0) {
        cols.forEach(c => console.log(`  ${c}`));
        console.log(`\n  Total: ${cols.length} columns`);
      } else {
        console.log('  No columns returned (check permissions)');
      }
      await oracleClient.close();
      return;
    }

    // Determine target date
    const dateStr = flags.date || new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })).toISOString().slice(0, 10);
    console.log(`\n=== Front Desk Report for ${dateStr} ===\n`);

    // Query
    const report = await queryFrontDeskReport(oracleClient, dateStr);

    // Print summary
    const sections = [
      { label: 'BAD EMAILS (priority)', data: report.badEmails, color: '\x1b[31m' },
      { label: 'IN HOUSE', data: report.inHouse, color: '\x1b[34m' },
      { label: 'DEPARTURES', data: report.departures, color: '\x1b[90m' },
      { label: 'ARRIVALS TODAY', data: report.arrivalsToday, color: '\x1b[32m' },
      { label: 'ARRIVALS TOMORROW', data: report.arrivalsTomorrow, color: '\x1b[92m' }
    ];

    for (const s of sections) {
      if (s.data.length === 0) continue;
      const prs = s.data.reduce((sum, g) => sum + (g.adults || 0) + (g.children || 0), 0);
      console.log(`${s.color}--- ${s.label} (${prs} guests) ---\x1b[0m`);
      for (const g of s.data) {
        const reason = g.reason ? ` [${g.reason}]` : '';
        const notes = g.notes ? ` | \x1b[33m${g.notes}\x1b[0m` : '';
        const eta = g.eta ? ` | ETA: ${g.eta}` : '';
        const companions = g.companionNames ? `\n    \x1b[36m+${g.companionNames}\x1b[0m` : '';
        if (s.label.startsWith('BAD')) {
          console.log(`  ${g.firstName} ${g.lastName} | ${g.email || '(none)'} | Villa: ${g.villa || '—'} | PRS: ${g.prs || '—'} | ${g.checkIn}→${g.checkOut}${reason}${notes}${companions}`);
        } else if (s.label.startsWith('ARRIVAL')) {
          console.log(`  ${g.firstName} ${g.lastName} | Villa: ${g.villa || '—'} | PRS: ${g.prs || '—'}${eta} | →${g.checkOut} | ${g.country} | ${g.language}${notes}${companions}`);
        } else {
          console.log(`  ${g.firstName} ${g.lastName} | Villa: ${g.villa || '—'} | PRS: ${g.prs || '—'} | ${g.checkIn}→${g.checkOut} | ${g.country} | ${g.language}${notes}${companions}`);
        }
      }
      console.log('');
    }

    const prsSum = (arr) => arr.reduce((sum, g) => sum + (g.adults || 0) + (g.children || 0), 0);
    const total = prsSum(report.inHouse) + prsSum(report.departures) + prsSum(report.arrivalsToday) + prsSum(report.arrivalsTomorrow);
    console.log(`Total: ${total} guests, ${report.badEmails.length} need email collection\n`);

    // Send email
    if (!flags.noEmail) {
      // Override recipient if --to specified
      if (flags.to) {
        process.env.FRONT_DESK_EMAIL_TO = flags.to;
      }

      if (!process.env.FRONT_DESK_EMAIL_TO) {
        console.log('No FRONT_DESK_EMAIL_TO set and no --to provided. Use --to or --no-email.');
        await oracleClient.close();
        return;
      }

      const notifier = new Notifier();
      console.log(`Sending email to ${process.env.FRONT_DESK_EMAIL_TO}...`);
      await notifier.sendDailyFrontDeskReport(report);
      console.log('Email sent!');
    }

    await oracleClient.close();
  } catch (err) {
    console.error('Error:', err.message);
    if (err.stack) console.error(err.stack);
    try { await oracleClient.close(); } catch (_) {}
    process.exit(1);
  }
}

main();
