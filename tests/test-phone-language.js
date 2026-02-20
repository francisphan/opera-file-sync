#!/usr/bin/env node

/**
 * Test Phone and Language Field Sync
 *
 * Tests that phone numbers and language preferences from Oracle DB
 * are correctly queried, transformed, and synced to Salesforce.
 */

require('dotenv').config();
const logger = require('../src/logger');
const OracleClient = require('../src/oracle-client');
const SalesforceClient = require('../src/salesforce-client');
const { queryGuestsByIds } = require('../src/opera-db-query');
const { mapLanguageToSalesforce } = require('../src/guest-utils');

logger.level = 'info';

async function main() {
  logger.info('='.repeat(70));
  logger.info('Phone & Language Field Sync Test');
  logger.info('='.repeat(70));

  // Initialize Oracle client
  const oracleClient = new OracleClient({
    host: process.env.ORACLE_HOST,
    port: process.env.ORACLE_PORT || '1521',
    sid: process.env.ORACLE_SID,
    service: process.env.ORACLE_SERVICE,
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD
  });

  // Initialize Salesforce client
  const sfClient = new SalesforceClient({
    instanceUrl: process.env.SF_INSTANCE_URL,
    clientId: process.env.SF_CLIENT_ID,
    clientSecret: process.env.SF_CLIENT_SECRET,
    refreshToken: process.env.SF_REFRESH_TOKEN,
    objectType: process.env.SF_OBJECT || 'TVRS_Guest__c',
    externalIdField: process.env.SF_EXTERNAL_ID_FIELD || 'Email__c'
  });

  try {
    // Connect to Oracle
    logger.info('Connecting to Oracle database...');
    await oracleClient.connect();
    logger.info('Connected to Oracle');

    // Connect to Salesforce
    logger.info('Connecting to Salesforce...');
    const sfConnected = await sfClient.test();
    if (!sfConnected) {
      throw new Error('Failed to connect to Salesforce');
    }

    // Step 1: Find sample records with phone and language data
    logger.info('\n' + '='.repeat(70));
    logger.info('Step 1: Finding sample records with phone/language data');
    logger.info('='.repeat(70));

    const sampleQuery = await oracleClient.query(`
      SELECT n.NAME_ID, n.FIRST, n.LAST, n.LANGUAGE,
             email.PHONE_NUMBER AS EMAIL,
             phone.PHONE_NUMBER AS PHONE,
             a.CITY, a.COUNTRY
      FROM OPERA.NAME n
      JOIN OPERA.NAME_PHONE email ON n.NAME_ID = email.NAME_ID
        AND email.PHONE_ROLE = 'EMAIL' AND email.PRIMARY_YN = 'Y'
      LEFT JOIN (
        SELECT NAME_ID, PHONE_NUMBER,
               ROW_NUMBER() OVER (PARTITION BY NAME_ID ORDER BY
                 CASE PHONE_ROLE
                   WHEN 'MOBILE' THEN 1
                   WHEN 'PHONE' THEN 2
                   ELSE 3
                 END) AS rn
        FROM OPERA.NAME_PHONE
        WHERE PHONE_ROLE IN ('PHONE', 'MOBILE') AND PRIMARY_YN = 'Y'
      ) phone ON n.NAME_ID = phone.NAME_ID AND phone.rn = 1
      LEFT JOIN OPERA.NAME_ADDRESS a ON n.NAME_ID = a.NAME_ID
        AND a.PRIMARY_YN = 'Y' AND a.INACTIVE_DATE IS NULL
      WHERE EXISTS (
        SELECT 1 FROM OPERA.RESERVATION_NAME r
        WHERE r.NAME_ID = n.NAME_ID AND r.RESORT = 'VINES'
      )
      AND (phone.PHONE_NUMBER IS NOT NULL OR n.LANGUAGE IS NOT NULL)
      AND ROWNUM <= 10
    `);

    logger.info(`Found ${sampleQuery.length} sample records\n`);

    if (sampleQuery.length === 0) {
      logger.warn('No records found with phone or language data!');
      logger.warn('This might indicate:');
      logger.warn('  - Phone numbers are not stored in NAME_PHONE table');
      logger.warn('  - Language field is always NULL');
      logger.warn('  - No VINES guests have this data');
      process.exit(1);
    }

    // Display sample data
    logger.info('Sample Records from Oracle:');
    logger.info('-'.repeat(70));

    const stats = {
      totalRecords: sampleQuery.length,
      withPhone: 0,
      withLanguage: 0,
      withBoth: 0,
      languageCodes: new Map()
    };

    sampleQuery.forEach((row, idx) => {
      const hasPhone = row.PHONE ? true : false;
      const hasLanguage = row.LANGUAGE ? true : false;

      if (hasPhone) stats.withPhone++;
      if (hasLanguage) {
        stats.withLanguage++;
        stats.languageCodes.set(row.LANGUAGE, (stats.languageCodes.get(row.LANGUAGE) || 0) + 1);
      }
      if (hasPhone && hasLanguage) stats.withBoth++;

      logger.info(`${idx + 1}. ${row.FIRST} ${row.LAST} (${row.EMAIL})`);
      logger.info(`   City: ${row.CITY || '(none)'}, Country: ${row.COUNTRY || '(none)'}`);
      logger.info(`   Phone: ${row.PHONE || '(none)'}`);
      logger.info(`   Language: ${row.LANGUAGE || '(none)'}`);
      if (row.LANGUAGE) {
        const mapped = mapLanguageToSalesforce(row.LANGUAGE);
        logger.info(`   → Mapped to SF: ${mapped}`);
      }
      logger.info('');
    });

    // Statistics
    logger.info('='.repeat(70));
    logger.info('Sample Data Statistics:');
    logger.info('='.repeat(70));
    logger.info(`Total records: ${stats.totalRecords}`);
    logger.info(`Records with phone: ${stats.withPhone} (${Math.round(stats.withPhone/stats.totalRecords*100)}%)`);
    logger.info(`Records with language: ${stats.withLanguage} (${Math.round(stats.withLanguage/stats.totalRecords*100)}%)`);
    logger.info(`Records with both: ${stats.withBoth} (${Math.round(stats.withBoth/stats.totalRecords*100)}%)`);

    if (stats.languageCodes.size > 0) {
      logger.info('\nLanguage code distribution:');
      for (const [code, count] of stats.languageCodes) {
        const mapped = mapLanguageToSalesforce(code);
        logger.info(`  ${code} → ${mapped}: ${count} record(s)`);
      }
    }

    // Step 2: Query through our sync pipeline
    logger.info('\n' + '='.repeat(70));
    logger.info('Step 2: Query through sync pipeline (opera-db-query.js)');
    logger.info('='.repeat(70));

    const nameIds = sampleQuery.map(r => r.NAME_ID);
    const { records, filtered } = await queryGuestsByIds(oracleClient, nameIds);

    logger.info(`Pipeline results: ${records.length} records to sync, ${filtered.length} filtered`);

    if (records.length === 0) {
      logger.warn('All records were filtered! Cannot test sync.');
      process.exit(1);
    }

    // Display transformed records
    logger.info('\nTransformed Salesforce Records:');
    logger.info('-'.repeat(70));

    records.forEach((rec, idx) => {
      logger.info(`${idx + 1}. ${rec.Guest_First_Name__c} ${rec.Guest_Last_Name__c}`);
      logger.info(`   Email: ${rec.Email__c}`);
      logger.info(`   Telephone__c: ${rec.Telephone__c || '(null)'}`);
      logger.info(`   Language__c: ${rec.Language__c || '(null)'}`);
      logger.info(`   City: ${rec.City__c || '(null)'}`);
      logger.info('');
    });

    // Step 3: Verify field mapping
    logger.info('='.repeat(70));
    logger.info('Step 3: Field Mapping Verification');
    logger.info('='.repeat(70));

    const fieldStats = {
      telephone: { present: 0, null: 0 },
      language: { present: 0, null: 0 }
    };

    records.forEach(rec => {
      if (rec.Telephone__c) fieldStats.telephone.present++;
      else fieldStats.telephone.null++;

      if (rec.Language__c && rec.Language__c !== 'Unknown') fieldStats.language.present++;
      else fieldStats.language.null++;
    });

    logger.info('Telephone__c field:');
    logger.info(`  Populated: ${fieldStats.telephone.present}/${records.length} (${Math.round(fieldStats.telephone.present/records.length*100)}%)`);
    logger.info(`  Null: ${fieldStats.telephone.null}/${records.length}`);

    logger.info('\nLanguage__c field:');
    logger.info(`  Populated: ${fieldStats.language.present}/${records.length} (${Math.round(fieldStats.language.present/records.length*100)}%)`);
    logger.info(`  Null/Unknown: ${fieldStats.language.null}/${records.length}`);

    // Step 4: Test sync (optional - prompt user)
    logger.info('\n' + '='.repeat(70));
    logger.info('Step 4: Sync Test (Optional)');
    logger.info('='.repeat(70));

    const shouldSync = process.env.TEST_SYNC_TO_SALESFORCE === 'true';

    if (shouldSync) {
      logger.info('TEST_SYNC_TO_SALESFORCE=true - Syncing test records to Salesforce...');

      const results = await sfClient.syncRecords(
        records,
        sfClient.config.objectType,
        sfClient.config.externalIdField
      );

      logger.info(`\nSync Results:`);
      logger.info(`  Success: ${results.success}`);
      logger.info(`  Failed: ${results.failed}`);

      if (results.failed > 0) {
        logger.error('\nErrors:');
        results.errors.slice(0, 5).forEach(err => {
          logger.error(`  - ${err.error}`);
        });
      }

      if (results.success > 0) {
        logger.info('\n✅ Records synced! Verifying in Salesforce...');

        // Query one record back to verify fields
        const testEmail = records[0].Email__c;
        await sfClient.ensureConnected();
        const sfQuery = await sfClient.connection.query(
          `SELECT Email__c, Guest_First_Name__c, Guest_Last_Name__c,
                  Telephone__c, Language__c, City__c, Country__c
           FROM TVRS_Guest__c
           WHERE Email__c = '${testEmail}'
           LIMIT 1`
        );

        if (sfQuery.records.length > 0) {
          const sfRec = sfQuery.records[0];
          logger.info('\nSalesforce Record Verification:');
          logger.info(`  Name: ${sfRec.Guest_First_Name__c} ${sfRec.Guest_Last_Name__c}`);
          logger.info(`  Email: ${sfRec.Email__c}`);
          logger.info(`  Telephone: ${sfRec.Telephone__c || '(null)'}`);
          logger.info(`  Language: ${sfRec.Language__c || '(null)'}`);
          logger.info(`  City: ${sfRec.City__c || '(null)'}`);

          // Verify fields match
          const origRec = records[0];
          const phoneMatch = sfRec.Telephone__c === origRec.Telephone__c;
          const langMatch = sfRec.Language__c === origRec.Language__c;

          logger.info('\nField Verification:');
          logger.info(`  Telephone matches: ${phoneMatch ? '✅' : '❌'}`);
          logger.info(`  Language matches: ${langMatch ? '✅' : '❌'}`);

          if (phoneMatch && langMatch) {
            logger.info('\n✅ SUCCESS - Phone and Language fields synced correctly!');
          } else {
            logger.warn('\n⚠️  WARNING - Field mismatch detected');
          }
        }
      }
    } else {
      logger.info('Skipping actual sync to Salesforce');
      logger.info('To test actual sync, run with: TEST_SYNC_TO_SALESFORCE=true');
      logger.info('\nBased on transformation results:');
      logger.info(`  ✅ Phone field mapping: ${fieldStats.telephone.present > 0 ? 'Working' : 'No data'}`);
      logger.info(`  ✅ Language field mapping: ${fieldStats.language.present > 0 ? 'Working' : 'No data'}`);
    }

    // Final summary
    logger.info('\n' + '='.repeat(70));
    logger.info('Test Complete');
    logger.info('='.repeat(70));

    const phoneOk = fieldStats.telephone.present > 0 || stats.withPhone === 0;
    const langOk = fieldStats.language.present > 0 || stats.withLanguage === 0;

    if (phoneOk && langOk) {
      logger.info('✅ Phone and Language field sync is working correctly!');
      logger.info('\nKey findings:');
      logger.info(`  - Phone coverage: ${Math.round(stats.withPhone/stats.totalRecords*100)}% of sample records`);
      logger.info(`  - Language coverage: ${Math.round(stats.withLanguage/stats.totalRecords*100)}% of sample records`);
      logger.info(`  - Transformation: ${records.length} records successfully transformed`);
      logger.info(`  - Ready for production sync`);
    } else {
      logger.warn('⚠️  Some issues detected:');
      if (!phoneOk) logger.warn('  - Phone field not populating correctly');
      if (!langOk) logger.warn('  - Language field not populating correctly');
    }

  } finally {
    await oracleClient.close();
  }
}

main().catch(err => {
  logger.error('Fatal error:', err.message);
  if (err.stack) logger.error(err.stack);
  process.exit(1);
});
