#!/usr/bin/env node

/**
 * Posting Masters Report — standalone runner
 *
 * Emails the posting-masters report (9000-series charge accounts, not real
 * stays) for a given date. Posting Masters were split out of the daily front
 * desk report onto a reduced twice-a-week cadence; the recurring job lives in
 * src/scheduler.js (setupPostingMastersReport).
 *
 * Usage:
 *   node scripts/posting-masters-report.js                       # today → POSTING_MASTERS_EMAIL_TO / FRONT_DESK_EMAIL_TO
 *   node scripts/posting-masters-report.js --to a@b.com          # override recipient
 *   node scripts/posting-masters-report.js --to a@b.com --cc c@d.com   # add CC (comma-separated for multiple)
 *   node scripts/posting-masters-report.js --date 2026-06-23     # specific date
 */

require('dotenv').config();

const OracleClient = require('../src/oracle-client');
const Notifier = require('../src/notifier');
const logger = require('../src/logger');
const villaMap = require('../src/villa-map');
const { queryFrontDeskReport } = require('../src/opera-db-query');
const { triggerPostingMastersReport } = require('../src/scheduler');

function parseArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') opts.to = argv[++i];
    else if (a === '--cc') opts.cc = argv[++i];
    else if (a === '--date') opts.date = argv[++i];
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
    const sent = await triggerPostingMastersReport(
      notifier,
      (dateStr) => queryFrontDeskReport(oracleClient, dateStr),
      opts
    );
    if (sent) {
      logger.info('Posting masters report sent.');
    } else {
      logger.warn('Posting masters report was not sent (no posting masters, email disabled, or no recipient).');
      process.exitCode = 1;
    }
  } catch (err) {
    logger.error('Failed to run posting masters report:', err.message);
    if (err.stack) logger.error(err.stack);
    process.exitCode = 1;
  } finally {
    await oracleClient.close();
  }
}

main();
