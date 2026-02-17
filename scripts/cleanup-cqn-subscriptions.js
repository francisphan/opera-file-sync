#!/usr/bin/env node
/**
 * CQN Subscription Cleanup Script
 *
 * Removes orphaned CQN subscriptions from Oracle that are consuming RAM.
 * Run this when the opera-db-sync service is STOPPED.
 */

require('dotenv').config();
const oracledb = require('oracledb');

const CONFIG = {
  user: process.env.ORACLE_USER,
  password: process.env.ORACLE_PASSWORD,
  host: process.env.ORACLE_HOST || 'localhost',
  port: parseInt(process.env.ORACLE_PORT) || 1521,
  sid: process.env.ORACLE_SID,
  service: process.env.ORACLE_SERVICE
};

async function main() {
  console.log('='.repeat(70));
  console.log('CQN Subscription Cleanup Tool');
  console.log('='.repeat(70));
  console.log('\n⚠️  WARNING: Run this ONLY when opera-db-sync is STOPPED\n');

  let connection;

  try {
    // Connect with events=true to manage subscriptions
    const connectString = CONFIG.sid
      ? `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${CONFIG.host})(PORT=${CONFIG.port}))(CONNECT_DATA=(SID=${CONFIG.sid})))`
      : `${CONFIG.host}:${CONFIG.port}/${CONFIG.service}`;

    console.log('Connecting to Oracle...');
    connection = await oracledb.getConnection({
      user: CONFIG.user,
      password: CONFIG.password,
      connectString,
      events: true
    });
    console.log('✓ Connected\n');

    // Step 1: Check for existing subscriptions
    console.log('Step 1: Checking for CQN subscriptions...');

    let subscriptions = [];
    try {
      const result = await connection.execute(`
        SELECT SUBSCRIPTION_NAME, STATUS,
               TO_CHAR(REG_TIME, 'YYYY-MM-DD HH24:MI:SS') as REGISTERED_TIME
        FROM USER_SUBSCR_REGISTRATIONS
        ORDER BY REG_TIME
      `);

      subscriptions = result.rows.map(row => ({
        name: row[0],
        status: row[1],
        created: row[2]
      }));

      if (subscriptions.length === 0) {
        console.log('✓ No CQN subscriptions found');
        console.log('  Oracle RAM is clean - no cleanup needed!\n');
        return;
      }

      console.log(`Found ${subscriptions.length} subscription(s):\n`);
      subscriptions.forEach((sub, idx) => {
        console.log(`  ${idx + 1}. Name: ${sub.name}`);
        console.log(`     Status: ${sub.status}`);
        console.log(`     Created: ${sub.created}`);
        console.log();
      });

    } catch (err) {
      if (err.message.includes('ORA-00942')) {
        console.log('✗ Cannot query USER_SUBSCR_REGISTRATIONS');
        console.log('  You may need DBA privileges to see subscriptions.\n');
        console.log('Ask your DBA to run this SQL:\n');
        console.log('  SELECT SUBSCRIPTION_NAME, STATUS, CREATED');
        console.log('  FROM DBA_SUBSCR_REGISTRATIONS');
        console.log(`  WHERE USERNAME = '${CONFIG.user.toUpperCase()}';`);
        console.log();
        process.exit(1);
      }
      throw err;
    }

    // Step 2: Estimate RAM usage
    console.log('Step 2: Estimating RAM usage...');

    // Try to get record count that subscriptions are tracking
    try {
      const countResult = await connection.execute(
        `SELECT COUNT(*) FROM OPERA.NAME_PHONE WHERE PHONE_ROLE = 'EMAIL'`
      );
      const emailCount = countResult.rows[0][0];
      const ramPerSub = Math.ceil((emailCount * 0.5) / 1024); // ~0.5 KB per row
      const totalRam = ramPerSub * subscriptions.length;

      console.log(`  Tracking ${emailCount.toLocaleString()} email records`);
      console.log(`  Estimated RAM per subscription: ~${ramPerSub} MB`);
      console.log(`  Total RAM used by all subscriptions: ~${totalRam} MB`);
      console.log();
    } catch (err) {
      console.log('  (Could not estimate RAM usage)\n');
    }

    // Step 3: Unsubscribe from all
    console.log('Step 3: Removing subscriptions...\n');

    let cleaned = 0;
    let failed = 0;

    for (const sub of subscriptions) {
      try {
        console.log(`  Unregistering: ${sub.name}...`);
        await connection.unsubscribe(sub.name);
        console.log(`  ✓ Removed successfully`);
        cleaned++;
      } catch (err) {
        console.log(`  ✗ Failed: ${err.message}`);
        failed++;
      }
      console.log();
    }

    // Step 4: Verify cleanup
    console.log('Step 4: Verifying cleanup...');
    const verifyResult = await connection.execute(
      `SELECT COUNT(*) FROM USER_SUBSCR_REGISTRATIONS`
    );
    const remaining = verifyResult.rows[0][0];

    if (remaining === 0) {
      console.log('✓ All subscriptions removed successfully!\n');
    } else {
      console.log(`⚠️  ${remaining} subscription(s) still remain\n`);
    }

    // Summary
    console.log('='.repeat(70));
    console.log('CLEANUP SUMMARY');
    console.log('='.repeat(70));
    console.log(`  Subscriptions found: ${subscriptions.length}`);
    console.log(`  Successfully removed: ${cleaned}`);
    console.log(`  Failed to remove: ${failed}`);
    console.log(`  Remaining: ${remaining}`);
    console.log('='.repeat(70));

    if (cleaned > 0) {
      console.log('\n✓ Oracle RAM should be freed immediately');
      console.log('  Check Task Manager on Opera server to confirm RAM reduction\n');
    }

    if (remaining > 0) {
      console.log('\n⚠️  Some subscriptions could not be removed');
      console.log('  Ask DBA to run:');
      console.log(`    SELECT * FROM DBA_SUBSCR_REGISTRATIONS WHERE USERNAME = '${CONFIG.user.toUpperCase()}';`);
      console.log('  And manually drop remaining subscriptions\n');
    }

    console.log('Next steps:');
    console.log('  1. Monitor Opera server RAM usage (should drop now)');
    console.log('  2. Deploy updated opera-db-sync.exe with RAM optimizations');
    console.log('  3. Restart the service');
    console.log();

  } catch (err) {
    console.error('\n✗ Fatal error:', err.message);
    if (err.errorNum) {
      console.error('  Oracle Error:', err.errorNum);
    }
    console.error('\nStack trace:', err.stack);
    process.exit(1);
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        // ignore
      }
    }
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
