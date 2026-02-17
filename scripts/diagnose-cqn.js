#!/usr/bin/env node
/**
 * CQN Diagnostic Script
 *
 * Tests Oracle Continuous Query Notification prerequisites and configuration.
 * Run this on the Windows server to diagnose CQN registration failures.
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
  console.log('Oracle CQN Diagnostic Tool');
  console.log('='.repeat(70));
  console.log();

  let connection;

  try {
    // Step 1: Basic connection test
    console.log('Step 1: Testing basic Oracle connection...');
    const connectString = CONFIG.sid
      ? `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${CONFIG.host})(PORT=${CONFIG.port}))(CONNECT_DATA=(SID=${CONFIG.sid})))`
      : `${CONFIG.host}:${CONFIG.port}/${CONFIG.service}`;

    connection = await oracledb.getConnection({
      user: CONFIG.user,
      password: CONFIG.password,
      connectString
    });
    console.log('✓ Connected to Oracle successfully');
    console.log();

    // Step 2: Check Oracle version
    console.log('Step 2: Checking Oracle version...');
    const versionResult = await connection.execute(
      `SELECT * FROM V$VERSION WHERE BANNER LIKE 'Oracle%'`
    );
    if (versionResult.rows.length > 0) {
      console.log('✓ Oracle Version:', versionResult.rows[0][0]);
    }
    console.log();

    // Step 3: Check user privileges
    console.log('Step 3: Checking user privileges for CQN...');
    const privResult = await connection.execute(`
      SELECT PRIVILEGE FROM USER_SYS_PRIVS
      WHERE PRIVILEGE LIKE '%CHANGE%' OR PRIVILEGE LIKE '%NOTIFICATION%'
      UNION
      SELECT PRIVILEGE FROM SESSION_PRIVS
      WHERE PRIVILEGE LIKE '%CHANGE%' OR PRIVILEGE LIKE '%NOTIFICATION%'
    `);

    if (privResult.rows.length > 0) {
      console.log('✓ CQN-related privileges found:');
      privResult.rows.forEach(row => console.log(`  - ${row[0]}`));
    } else {
      console.log('✗ MISSING: CHANGE NOTIFICATION privilege');
      console.log('  Ask DBA to run: GRANT CHANGE NOTIFICATION TO ' + CONFIG.user);
    }
    console.log();

    // Step 4: Check JOB_QUEUE_PROCESSES parameter
    console.log('Step 4: Checking JOB_QUEUE_PROCESSES parameter...');
    try {
      const jobQueueResult = await connection.execute(
        `SELECT VALUE FROM V$PARAMETER WHERE NAME = 'job_queue_processes'`
      );
      const jobQueueValue = parseInt(jobQueueResult.rows[0][0]);
      if (jobQueueValue > 0) {
        console.log(`✓ JOB_QUEUE_PROCESSES = ${jobQueueValue} (OK)`);
      } else {
        console.log(`✗ JOB_QUEUE_PROCESSES = ${jobQueueValue} (MUST BE > 0)`);
        console.log('  Ask DBA to run: ALTER SYSTEM SET JOB_QUEUE_PROCESSES = 10 SCOPE=BOTH;');
      }
    } catch (err) {
      console.log('✗ Cannot query V$PARAMETER (insufficient privileges)');
      console.log('  Ask DBA to check JOB_QUEUE_PROCESSES value');
    }
    console.log();

    // Step 5: Check table access
    console.log('Step 5: Checking access to OPERA.NAME_PHONE...');
    const tableResult = await connection.execute(
      `SELECT COUNT(*) FROM OPERA.NAME_PHONE WHERE ROWNUM <= 1`
    );
    console.log('✓ Can query OPERA.NAME_PHONE table');
    console.log();

    // Step 6: Estimate CQN subscription size
    console.log('Step 6: Estimating CQN subscription size...');
    const emailCountResult = await connection.execute(
      `SELECT COUNT(*) FROM OPERA.NAME_PHONE WHERE PHONE_ROLE = 'EMAIL'`
    );
    const emailCount = emailCountResult.rows[0][0];
    console.log(`⚠ CQN would track ${emailCount.toLocaleString()} email records`);
    console.log(`  Estimated Oracle SGA usage: ~${Math.ceil(emailCount * 0.5 / 1024)} MB`);

    if (emailCount > 50000) {
      console.log('  WARNING: This is very large for CQN. Consider filtering by resort/date.');
    }
    console.log();

    // Step 7: Test CQN registration with events=true
    console.log('Step 7: Testing CQN connection with events=true...');
    await connection.close();

    connection = await oracledb.getConnection({
      user: CONFIG.user,
      password: CONFIG.password,
      connectString,
      events: true  // Required for CQN
    });
    console.log('✓ Connection with events=true successful');
    console.log();

    // Step 8: Attempt actual CQN subscription
    console.log('Step 8: Attempting CQN subscription registration...');
    console.log('  (This will fail if prerequisites are not met)');

    let subscribed = false;
    try {
      await connection.subscribe('test-cqn', {
        sql: `SELECT NAME_ID FROM OPERA.NAME_PHONE WHERE PHONE_ROLE = 'EMAIL' AND ROWNUM <= 100`,
        callback: (msg) => {
          console.log('CQN callback received:', msg.type);
        },
        qos: oracledb.SUBSCR_QOS_ROWIDS | oracledb.SUBSCR_QOS_BEST_EFFORT,
        timeout: 60 // 60 seconds for testing
      });

      subscribed = true;
      console.log('✓ CQN subscription registered successfully!');
      console.log('  Unregistering test subscription...');
      await connection.unsubscribe('test-cqn');
      console.log('✓ Test subscription removed');

    } catch (subErr) {
      console.log('✗ CQN subscription FAILED:');
      console.log('  Error:', subErr.message);
      if (subErr.errorNum) {
        console.log('  Oracle Error:', subErr.errorNum);
      }

      // Specific error guidance
      if (subErr.message.includes('ORA-29970')) {
        console.log('\n  → Missing CHANGE NOTIFICATION privilege');
        console.log('    Ask DBA: GRANT CHANGE NOTIFICATION TO ' + CONFIG.user);
      } else if (subErr.message.includes('ORA-29972')) {
        console.log('\n  → User not enabled for CQN');
        console.log('    Ask DBA: ALTER USER ' + CONFIG.user + ' ENABLE QUERY REWRITE');
      } else if (subErr.message.includes('ORA-01031')) {
        console.log('\n  → Insufficient privileges');
      }
    }
    console.log();

    // Step 9: Network connectivity test
    console.log('Step 9: Checking network configuration for CQN callbacks...');
    console.log('  CQN requires Oracle to make CALLBACK connections to this client.');
    console.log('  Checking local network info...');

    const os = require('os');
    const interfaces = os.networkInterfaces();
    console.log('  Local IP addresses:');
    Object.keys(interfaces).forEach(ifname => {
      interfaces[ifname].forEach(iface => {
        if (iface.family === 'IPv4' && !iface.internal) {
          console.log(`    - ${iface.address} (${ifname})`);
        }
      });
    });

    console.log('\n  ⚠ Important: Oracle server must be able to reach one of these IPs.');
    console.log('  If behind NAT/firewall, CQN callbacks may fail.');
    console.log('  Test: Can Oracle server ping this machine?');
    console.log();

    // Summary
    console.log('='.repeat(70));
    console.log('SUMMARY');
    console.log('='.repeat(70));

    if (subscribed) {
      console.log('✓ All CQN prerequisites met - CQN should work!');
      console.log('\nNext steps:');
      console.log('  1. Consider filtering the CQN query to reduce Oracle RAM usage');
      console.log('  2. Ensure firewall allows Oracle callbacks to this machine');
      console.log('  3. Start opera-db-sync and check logs for actual error details');
    } else {
      console.log('✗ CQN prerequisites NOT met - see errors above');
      console.log('\nRecommendations:');
      console.log('  Option A: Fix CQN prerequisites (preferred if possible)');
      console.log('  Option B: Switch to polling mode (disable CQN, query every N minutes)');
    }
    console.log('='.repeat(70));

  } catch (err) {
    console.error('\n✗ Fatal error:', err.message);
    if (err.errorNum) {
      console.error('  Oracle Error Number:', err.errorNum);
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
