#!/usr/bin/env node

/**
 * Villa Nights Report — standalone runner
 *
 * Emails the nights-per-villa report (comp vs paid + rate-code breakdown) for a
 * date window. Used for the bi-weekly schedule's manual/ad-hoc sends; the
 * recurring job lives in src/scheduler.js (setupVillaNightsReport).
 *
 * Usage:
 *   node scripts/villa-nights-report.js                         # prior 14 nights → VILLA_REPORT_EMAIL_TO
 *   node scripts/villa-nights-report.js --to a@b.com            # override recipient
 *   node scripts/villa-nights-report.js --to a@b.com --cc c@d.com   # add CC (comma-separated for multiple)
 *   node scripts/villa-nights-report.js --days 30               # prior N nights
 *   node scripts/villa-nights-report.js --start 2026-05-01 --end 2026-05-15
 *
 * --end is exclusive (the night before --end is the last one counted).
 */

require('dotenv').config();

const OracleClient = require('../src/oracle-client');
const Notifier = require('../src/notifier');
const logger = require('../src/logger');
const villaMap = require('../src/villa-map');
const { queryVillaNightsReport } = require('../src/opera-db-query');
const { triggerVillaNightsReport } = require('../src/scheduler');

function parseArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') opts.to = argv[++i];
    else if (a === '--cc') opts.cc = argv[++i];
    else if (a === '--days') opts.days = parseInt(argv[++i], 10);
    else if (a === '--start') opts.startDate = argv[++i];
    else if (a === '--end') opts.endDate = argv[++i];
  }
  return opts;
}

async function main() {
  logger.level = 'info';
  const opts = parseArgs(process.argv);

  const required = ['ORACLE_HOST', 'ORACLE_USER', 'ORACLE_PASSWORD'];
  const missing = required.filter(k => !process.env[k]);
  if (!process.env.ORACLE_SID && !process.env.ORACLE_SERVICE) missing.push('ORACLE_SID or ORACLE_SERVICE');
  if (missing.length) {
    logger.error(`Missing required env vars: ${missing.join(', ')}`);
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

  const notifier = new Notifier();

  // Load the cached villa map so the allowlist matches the running service.
  villaMap.load();

  try {
    await oracleClient.connect();
    const sent = await triggerVillaNightsReport(
      notifier,
      (startDate, endDate) => queryVillaNightsReport(oracleClient, startDate, endDate),
      opts
    );
    if (sent) {
      logger.info('Villa nights report sent.');
    } else {
      logger.warn('Villa nights report was not sent (check EMAIL_ENABLED and recipient).');
      process.exitCode = 1;
    }
  } catch (err) {
    logger.error('Failed to run villa nights report:', err.message);
    if (err.stack) logger.error(err.stack);
    process.exitCode = 1;
  } finally {
    await oracleClient.close();
  }
}

main();
