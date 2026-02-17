#!/usr/bin/env node
/**
 * Audit Missing Check-ins
 *
 * Compares recent check-ins in Opera DB vs Salesforce to find gaps
 * during the downtime/crash loop period.
 */

require('dotenv').config();
const OracleClient = require('../src/oracle-client');
const SalesforceClient = require('../src/salesforce-client');

const CONFIG = {
  oracle: {
    host: process.env.ORACLE_HOST,
    port: process.env.ORACLE_PORT || '1521',
    sid: process.env.ORACLE_SID,
    service: process.env.ORACLE_SERVICE,
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD
  },
  salesforce: {
    instanceUrl: process.env.SF_INSTANCE_URL,
    clientId: process.env.SF_CLIENT_ID,
    clientSecret: process.env.SF_CLIENT_SECRET,
    refreshToken: process.env.SF_REFRESH_TOKEN,
    objectType: process.env.SF_OBJECT || 'TVRS_Guest__c'
  }
};

function formatDate(date) {
  if (!date || !(date instanceof Date)) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function main() {
  console.log('='.repeat(70));
  console.log('Check-in Audit: Opera DB vs Salesforce');
  console.log('='.repeat(70));
  console.log();

  const oracleClient = new OracleClient(CONFIG.oracle);
  const sfClient = new SalesforceClient(CONFIG.salesforce);

  try {
    // Connect
    console.log('Connecting to Oracle...');
    await oracleClient.connect();
    console.log('✓ Connected to Oracle\n');

    console.log('Connecting to Salesforce...');
    await sfClient.connect();
    console.log('✓ Connected to Salesforce\n');

    // Query Opera DB for recent check-ins (last 2 weeks)
    console.log('Querying Opera DB for check-ins in last 14 days...');
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    const operaResult = await oracleClient.query(`
      SELECT
        n.NAME_ID,
        n.FIRST,
        n.LAST,
        p.PHONE_NUMBER as EMAIL,
        rn.BEGIN_DATE as CHECK_IN,
        rn.END_DATE as CHECK_OUT,
        rn.RESV_NAME_ID,
        rn.RESV_STATUS
      FROM OPERA.NAME n
      JOIN OPERA.NAME_PHONE p ON n.NAME_ID = p.NAME_ID
        AND p.PHONE_ROLE = 'EMAIL' AND p.PRIMARY_YN = 'Y'
      JOIN OPERA.RESERVATION_NAME rn ON n.NAME_ID = rn.NAME_ID
      WHERE rn.RESORT = 'VINES'
        AND rn.BEGIN_DATE >= :since
        AND rn.RESV_STATUS IN ('RESERVED', 'CHECKED IN', 'CHECKED OUT')
      ORDER BY rn.BEGIN_DATE DESC
    `, { since: twoWeeksAgo });

    console.log(`✓ Found ${operaResult.length} check-ins in Opera DB\n`);

    // Build lookup: email + check-in date
    const operaCheckins = new Map();
    operaResult.forEach(row => {
      const email = (row.EMAIL || '').trim().toLowerCase();
      const checkIn = formatDate(row.CHECK_IN);
      const key = `${email}|${checkIn}`;

      operaCheckins.set(key, {
        nameId: row.NAME_ID,
        firstName: row.FIRST,
        lastName: row.LAST,
        email: email,
        checkIn: checkIn,
        checkOut: formatDate(row.CHECK_OUT),
        resvNameId: row.RESV_NAME_ID,
        resvStatus: row.RESV_STATUS
      });
    });

    console.log(`Unique check-ins (by email + date): ${operaCheckins.size}\n`);

    // Query Salesforce for recent check-ins
    console.log('Querying Salesforce for recent TVRS_Guest__c records...');

    const sfResult = await sfClient.connection.query(`
      SELECT Id, Email__c, Check_In_Date__c, Check_Out_Date__c,
             Guest_First_Name__c, Guest_Last_Name__c,
             Contact__c, Contact__r.Email
      FROM ${CONFIG.salesforce.objectType}
      WHERE Check_In_Date__c >= LAST_N_DAYS:14
      ORDER BY Check_In_Date__c DESC
    `);

    console.log(`✓ Found ${sfResult.records.length} TVRS_Guest__c records in Salesforce\n`);

    // Build Salesforce lookup
    const sfCheckins = new Map();
    sfResult.records.forEach(record => {
      const email = ((record.Email__c || record.Contact__r?.Email) || '').trim().toLowerCase();
      const checkIn = record.Check_In_Date__c;
      const key = `${email}|${checkIn}`;

      sfCheckins.set(key, {
        id: record.Id,
        email: email,
        checkIn: checkIn,
        checkOut: record.Check_Out_Date__c,
        firstName: record.Guest_First_Name__c,
        lastName: record.Guest_Last_Name__c,
        contactId: record.Contact__c
      });
    });

    console.log(`Unique Salesforce records (by email + date): ${sfCheckins.size}\n`);

    // Find missing check-ins
    console.log('='.repeat(70));
    console.log('MISSING CHECK-INS (in Opera but NOT in Salesforce)');
    console.log('='.repeat(70));
    console.log();

    const missing = [];
    for (const [key, opera] of operaCheckins) {
      if (!sfCheckins.has(key)) {
        missing.push(opera);
      }
    }

    if (missing.length === 0) {
      console.log('✓ No missing check-ins! All Opera records are in Salesforce.\n');
    } else {
      console.log(`Found ${missing.length} missing check-ins:\n`);

      // Sort by check-in date
      missing.sort((a, b) => a.checkIn.localeCompare(b.checkIn));

      console.log('Check-in Date | Guest Name              | Email                           | Status');
      console.log('-'.repeat(90));

      missing.forEach(record => {
        const name = `${record.firstName} ${record.lastName}`.padEnd(23);
        const email = record.email.padEnd(31);
        const checkIn = record.checkIn;
        const status = record.resvStatus;

        console.log(`${checkIn} | ${name} | ${email} | ${status}`);
      });

      console.log();
      console.log('='.repeat(70));
      console.log('SUMMARY');
      console.log('='.repeat(70));
      console.log(`Opera check-ins (last 14 days): ${operaCheckins.size}`);
      console.log(`Salesforce records (last 14 days): ${sfCheckins.size}`);
      console.log(`Missing in Salesforce: ${missing.length}`);
      console.log(`Sync success rate: ${((1 - missing.length / operaCheckins.size) * 100).toFixed(1)}%`);
      console.log();

      // Group by date
      const byDate = {};
      missing.forEach(record => {
        if (!byDate[record.checkIn]) byDate[record.checkIn] = 0;
        byDate[record.checkIn]++;
      });

      console.log('Missing by date:');
      Object.keys(byDate).sort().forEach(date => {
        console.log(`  ${date}: ${byDate[date]} check-ins`);
      });
      console.log();
    }

    // Find extras in Salesforce
    console.log('='.repeat(70));
    console.log('EXTRA RECORDS (in Salesforce but NOT in Opera)');
    console.log('='.repeat(70));
    console.log();

    const extras = [];
    for (const [key, sf] of sfCheckins) {
      if (!operaCheckins.has(key)) {
        extras.push(sf);
      }
    }

    if (extras.length === 0) {
      console.log('✓ No extra records. All Salesforce records match Opera.\n');
    } else {
      console.log(`Found ${extras.length} extra Salesforce records (might be old or from different source):\n`);

      extras.sort((a, b) => a.checkIn.localeCompare(b.checkIn));

      console.log('Check-in Date | Guest Name              | Email');
      console.log('-'.repeat(70));

      extras.forEach(record => {
        const name = `${record.firstName || ''} ${record.lastName || ''}`.padEnd(23);
        const email = record.email.padEnd(31);
        const checkIn = record.checkIn;

        console.log(`${checkIn} | ${name} | ${email}`);
      });
      console.log();
    }

    // Export missing to JSON for re-sync
    if (missing.length > 0) {
      const fs = require('fs');
      const output = {
        auditDate: new Date().toISOString(),
        period: 'last 14 days',
        operaTotal: operaCheckins.size,
        salesforceTotal: sfCheckins.size,
        missing: missing,
        extras: extras
      };

      fs.writeFileSync('missing-checkins.json', JSON.stringify(output, null, 2));
      console.log('✓ Saved missing check-ins to: missing-checkins.json\n');

      console.log('To re-sync these records:');
      console.log('  1. Ensure opera-db-sync service is running with polling mode');
      console.log('  2. Service will catch these up on next poll cycle');
      console.log('  3. Or manually trigger: node scripts/resync-missing.js\n');
    }

  } catch (err) {
    console.error('\n✗ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    if (oracleClient) await oracleClient.close();
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
