#!/usr/bin/env node

/**
 * Discover Language field location in Oracle OPERA schema
 */

require('dotenv').config();
const logger = require('./src/logger');
const OracleClient = require('./src/oracle-client');

logger.level = 'info';

async function main() {
  logger.info('='.repeat(70));
  logger.info('Oracle Schema Discovery: Language Field');
  logger.info('='.repeat(70));

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

    // Query 1: Find columns with LANGUAGE or LANG in name
    logger.info('\nQuery 1: Searching for LANGUAGE/LANG columns...\n');

    const columns = await oracleClient.query(`
      SELECT owner, table_name, column_name, data_type, data_length
      FROM all_tab_columns
      WHERE (UPPER(column_name) LIKE '%LANGUAGE%' OR UPPER(column_name) LIKE '%LANG%')
        AND owner = 'OPERA'
        AND table_name IN ('NAME', 'RESERVATION_NAME', 'NAME_PHONE', 'NAME_ADDRESS', 'GUEST', 'GUEST_PROFILE')
      ORDER BY table_name, column_name
    `);

    if (columns.length > 0) {
      logger.info('Found columns:');
      columns.forEach(col => {
        logger.info(`  - ${col.OWNER}.${col.TABLE_NAME}.${col.COLUMN_NAME} (${col.DATA_TYPE}${col.DATA_LENGTH ? '(' + col.DATA_LENGTH + ')' : ''})`);
      });
    } else {
      logger.info('No LANGUAGE/LANG columns found in primary tables.');
    }

    // Query 2: Try NAME table specifically (most likely location)
    logger.info('\nQuery 2: Checking NAME table columns...\n');

    const nameColumns = await oracleClient.query(`
      SELECT column_name, data_type, data_length, nullable
      FROM all_tab_columns
      WHERE owner = 'OPERA' AND table_name = 'NAME'
      ORDER BY column_name
    `);

    logger.info(`NAME table has ${nameColumns.length} columns. Showing relevant ones:`);
    const relevantCols = nameColumns.filter(col => {
      const name = col.COLUMN_NAME.toUpperCase();
      return name.includes('LANG') || name.includes('PREF') || name.includes('COMM');
    });

    if (relevantCols.length > 0) {
      relevantCols.forEach(col => {
        logger.info(`  - ${col.COLUMN_NAME} (${col.DATA_TYPE}, nullable: ${col.NULLABLE})`);
      });
    } else {
      logger.info('  No language/preference columns found.');
    }

    // Query 3: Sample data from NAME table to see what columns have data
    logger.info('\nQuery 3: Sampling NAME table data...\n');

    const sample = await oracleClient.query(`
      SELECT n.NAME_ID, n.FIRST, n.LAST, n.NAME_TYPE,
             n.LANGUAGE, n.NATIONALITY, n.GUEST_PRIVILEGE_CODE
      FROM OPERA.NAME n
      WHERE ROWNUM <= 5
        AND EXISTS (
          SELECT 1 FROM OPERA.RESERVATION_NAME r
          WHERE r.NAME_ID = n.NAME_ID AND r.RESORT = 'VINES'
        )
    `);

    if (sample.length > 0) {
      logger.info('Sample records (first 5 VINES guests):');
      sample.forEach((rec, idx) => {
        logger.info(`  ${idx + 1}. ${rec.FIRST} ${rec.LAST}`);
        logger.info(`     NAME_TYPE: ${rec.NAME_TYPE || '(null)'}`);
        logger.info(`     LANGUAGE: ${rec.LANGUAGE || '(null)'}`);
        logger.info(`     NATIONALITY: ${rec.NATIONALITY || '(null)'}`);
        logger.info(`     GUEST_PRIVILEGE_CODE: ${rec.GUEST_PRIVILEGE_CODE || '(null)'}`);
      });
    } else {
      logger.info('No sample data found (LANGUAGE column might not exist).');

      // Query 4: Fallback - try without LANGUAGE column
      logger.info('\nQuery 4: Trying NAME table without LANGUAGE column...\n');

      const sampleNoLang = await oracleClient.query(`
        SELECT n.NAME_ID, n.FIRST, n.LAST
        FROM OPERA.NAME n
        WHERE ROWNUM <= 3
          AND EXISTS (
            SELECT 1 FROM OPERA.RESERVATION_NAME r
            WHERE r.NAME_ID = n.NAME_ID AND r.RESORT = 'VINES'
          )
      `);

      logger.info(`Successfully queried ${sampleNoLang.length} records without LANGUAGE column.`);
      logger.info('This suggests LANGUAGE column does not exist in NAME table.');
    }

  } catch (err) {
    if (err.message && err.message.includes('invalid identifier')) {
      logger.warn('\nColumn not found error - this helps narrow down which columns exist.');
      logger.warn('Error details:', err.message);
    } else {
      logger.error('Query error:', err.message);
      if (err.stack) logger.error(err.stack);
    }
  } finally {
    await oracleClient.close();
  }

  logger.info('\n' + '='.repeat(70));
  logger.info('Discovery complete');
  logger.info('='.repeat(70));
}

main().catch(err => {
  logger.error('Fatal error:', err.message);
  if (err.stack) logger.error(err.stack);
  process.exit(1);
});
