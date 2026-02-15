#!/usr/bin/env node

/**
 * Test Oracle database connection and discover Opera schema
 *
 * Run: node test-oracle-connection.js
 */

require('dotenv').config();
const OracleClient = require('./src/oracle-client');
const logger = require('./src/logger');

// Force info level for this script
logger.level = 'info';

async function main() {
  logger.info('='.repeat(70));
  logger.info('Testing Oracle Database Connection');
  logger.info('='.repeat(70));

  const required = ['ORACLE_HOST', 'ORACLE_USER', 'ORACLE_PASSWORD'];
  const missing = required.filter(key => !process.env[key]);

  if (!process.env.ORACLE_SID && !process.env.ORACLE_SERVICE) {
    missing.push('ORACLE_SID or ORACLE_SERVICE');
  }

  if (missing.length > 0) {
    logger.error('Missing required environment variables:');
    missing.forEach(key => logger.error(`  - ${key}`));
    logger.error('\nAdd these to your .env file.');
    process.exit(1);
  }

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
    logger.info('Connection successful!\n');

    // Discover tables related to guest/name data
    logger.info('='.repeat(70));
    logger.info('Discovering guest-related tables...');
    logger.info('='.repeat(70));

    const tables = await client.query(`
      SELECT owner, table_name
      FROM all_tables
      WHERE UPPER(table_name) LIKE '%NAME%'
         OR UPPER(table_name) LIKE '%GUEST%'
         OR UPPER(table_name) LIKE '%PROFILE%'
         OR UPPER(table_name) LIKE '%EMAIL%'
      ORDER BY owner, table_name
    `);

    if (tables.length === 0) {
      logger.warn('No guest-related tables found. Listing all accessible tables:');
      const allTables = await client.query(`
        SELECT owner, table_name FROM all_tables
        WHERE owner NOT IN ('SYS','SYSTEM','MDSYS','CTXSYS','XDB','WMSYS','ORDSYS','ORDDATA','DBSNMP')
        ORDER BY owner, table_name
      `);
      allTables.forEach(t => logger.info(`  ${t.OWNER}.${t.TABLE_NAME}`));
    } else {
      tables.forEach(t => logger.info(`  ${t.OWNER}.${t.TABLE_NAME}`));
    }

    // For each likely table, show columns
    const likelyTables = tables.filter(t =>
      /^NAME$/i.test(t.TABLE_NAME) ||
      /^NAME_PHONE$/i.test(t.TABLE_NAME) ||
      /^NAME_EMAIL$/i.test(t.TABLE_NAME) ||
      /^GUEST$/i.test(t.TABLE_NAME)
    );

    for (const t of likelyTables) {
      logger.info(`\n${'='.repeat(70)}`);
      logger.info(`Columns in ${t.OWNER}.${t.TABLE_NAME}:`);
      logger.info('='.repeat(70));

      const cols = await client.query(`
        SELECT column_name, data_type, data_length
        FROM all_tab_columns
        WHERE owner = :owner AND table_name = :tbl
        ORDER BY column_id
      `, [t.OWNER, t.TABLE_NAME]);

      cols.forEach(c => logger.info(`  ${c.COLUMN_NAME} (${c.DATA_TYPE}, ${c.DATA_LENGTH})`));

      // Sample row
      logger.info(`\nSample row from ${t.OWNER}.${t.TABLE_NAME}:`);
      const sample = await client.query(
        `SELECT * FROM ${t.OWNER}.${t.TABLE_NAME} WHERE ROWNUM <= 1`
      );
      if (sample.length > 0) {
        Object.entries(sample[0]).forEach(([k, v]) => {
          if (v !== null) logger.info(`  ${k}: ${v}`);
        });
      }
    }

    // Try to find a record by a known Opera Internal ID from the report
    logger.info(`\n${'='.repeat(70)}`);
    logger.info('Attempting lookup by Opera Internal ID (322488)...');
    logger.info('='.repeat(70));

    const testRows = await client.query(`
      SELECT n.NAME_ID, n.FIRST, n.LAST, n.SNAME, n.NAME_TYPE,
             p.PHONE_NUMBER AS EMAIL, p.PHONE_TYPE, p.PHONE_ROLE
      FROM OPERA.NAME n
      LEFT JOIN OPERA.NAME_PHONE p ON n.NAME_ID = p.NAME_ID AND p.PHONE_ROLE = 'EMAIL'
      WHERE n.NAME_ID = :id
    `, [322488]);

    if (testRows.length > 0) {
      testRows.forEach(row => {
        Object.entries(row).forEach(([k, v]) => {
          if (v !== null) logger.info(`  ${k}: ${v}`);
        });
      });
    } else {
      logger.warn('No record found for NAME_ID 322488');
    }

    logger.info('\n' + '='.repeat(70));
    logger.info('Schema discovery complete');
    logger.info('='.repeat(70));

  } catch (err) {
    logger.error('Error:', err.message || err);
    if (err.stack) logger.error(err.stack);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
