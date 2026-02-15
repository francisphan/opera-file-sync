#!/usr/bin/env node

/**
 * Verify email addresses from the missing-from-salesforce report
 * against the Opera Oracle database.
 *
 * Run: node verify-emails.js [report-file]
 *
 * Default report: reports/missing-from-salesforce-20260214.csv
 * Output: reports/email-verification-YYYYMMDD.csv
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const csvParser = require('csv-parser');
const OracleClient = require('./src/oracle-client');
const logger = require('./src/logger');

// Force info level
logger.level = 'info';

// Opera schema: emails are in NAME_PHONE with PHONE_ROLE='EMAIL'
// Guest names are in NAME table, joined by NAME_ID

async function readReport(filePath) {
  return new Promise((resolve, reject) => {
    const records = [];
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (row) => {
        records.push({
          email: (row['Email'] || '').trim(),
          firstName: (row['First Name'] || '').trim(),
          lastName: (row['Last Name'] || '').trim(),
          operaId: (row['Opera Internal ID'] || '').trim(),
          lastFile: (row['Last Seen In File'] || '').trim()
        });
      })
      .on('end', () => resolve(records))
      .on('error', reject);
  });
}

async function main() {
  const reportFile = process.argv[2] || 'reports/missing-from-salesforce-20260214.csv';
  const reportPath = path.resolve(reportFile);

  if (!fs.existsSync(reportPath)) {
    logger.error(`Report file not found: ${reportPath}`);
    process.exit(1);
  }

  const required = ['ORACLE_HOST', 'ORACLE_USER', 'ORACLE_PASSWORD'];
  const missing = required.filter(key => !process.env[key]);
  if (!process.env.ORACLE_SID && !process.env.ORACLE_SERVICE) {
    missing.push('ORACLE_SID or ORACLE_SERVICE');
  }
  if (missing.length > 0) {
    logger.error('Missing env vars: ' + missing.join(', '));
    process.exit(1);
  }

  logger.info('='.repeat(70));
  logger.info('Email Verification Against Opera Database');
  logger.info('='.repeat(70));

  const records = await readReport(reportPath);
  logger.info(`Loaded ${records.length} records from report`);

  const client = new OracleClient({
    host: process.env.ORACLE_HOST,
    port: process.env.ORACLE_PORT || '1521',
    sid: process.env.ORACLE_SID,
    service: process.env.ORACLE_SERVICE,
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD
  });

  try {
    await client.connect();

    const results = [];
    const batchSize = 50;

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const ids = batch.map(r => r.operaId).filter(Boolean);

      if (ids.length === 0) continue;

      // Build IN clause with bind variables
      const binds = {};
      const placeholders = ids.map((id, idx) => {
        binds[`id${idx}`] = parseInt(id);
        return `:id${idx}`;
      });

      const rows = await client.query(`
        SELECT n.NAME_ID, n.FIRST, n.LAST,
               p.PHONE_NUMBER AS EMAIL
        FROM OPERA.NAME n
        LEFT JOIN OPERA.NAME_PHONE p ON n.NAME_ID = p.NAME_ID AND p.PHONE_ROLE = 'EMAIL'
        WHERE n.NAME_ID IN (${placeholders.join(',')})
      `, binds);

      // Index DB results by Opera ID (may have multiple emails per NAME_ID)
      const dbMap = new Map();
      for (const row of rows) {
        const id = String(row.NAME_ID);
        if (!dbMap.has(id)) {
          dbMap.set(id, row);
        } else {
          // If we already have a row, prefer the one with an email
          const existing = dbMap.get(id);
          if (!existing.EMAIL && row.EMAIL) {
            dbMap.set(id, row);
          }
        }
      }

      for (const rec of batch) {
        const dbRow = dbMap.get(rec.operaId);
        const dbEmail = dbRow ? (dbRow.EMAIL || '').trim() : '';
        const match = !dbRow ? 'NOT_FOUND'
          : dbEmail.toLowerCase() === rec.email.toLowerCase() ? 'MATCH'
          : 'MISMATCH';

        results.push({
          operaId: rec.operaId,
          csvName: `${rec.firstName} ${rec.lastName}`.trim(),
          csvEmail: rec.email,
          dbEmail: dbEmail,
          dbName: dbRow ? `${(dbRow.FIRST || '').trim()} ${(dbRow.LAST || '').trim()}`.trim() : '',
          match,
          lastFile: rec.lastFile
        });
      }

      logger.info(`Processed ${Math.min(i + batchSize, records.length)}/${records.length}`);
    }

    // Write output CSV
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const outPath = path.resolve(`reports/email-verification-${today}.csv`);

    const header = 'Opera Internal ID,CSV Name,CSV Email,DB Email,DB Name,Match,Last Seen In File';
    const csvLines = results.map(r =>
      [r.operaId, `"${r.csvName}"`, `"${r.csvEmail}"`, `"${r.dbEmail}"`, `"${r.dbName}"`, r.match, r.lastFile].join(',')
    );

    fs.writeFileSync(outPath, [header, ...csvLines].join('\n'));

    // Summary
    const matches = results.filter(r => r.match === 'MATCH').length;
    const mismatches = results.filter(r => r.match === 'MISMATCH').length;
    const notFound = results.filter(r => r.match === 'NOT_FOUND').length;

    logger.info('\n' + '='.repeat(70));
    logger.info('Results Summary');
    logger.info('='.repeat(70));
    logger.info(`  Total records:  ${results.length}`);
    logger.info(`  Email matches:  ${matches}`);
    logger.info(`  Mismatches:     ${mismatches}`);
    logger.info(`  Not found in DB: ${notFound}`);
    logger.info(`\nOutput saved to: ${outPath}`);

    if (mismatches > 0) {
      logger.info('\nMismatched emails:');
      results.filter(r => r.match === 'MISMATCH').forEach(r => {
        logger.info(`  ID ${r.operaId}: CSV="${r.csvEmail}" DB="${r.dbEmail}"`);
      });
    }

  } finally {
    await client.close();
  }
}

main();
