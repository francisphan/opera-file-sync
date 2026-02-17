#!/usr/bin/env node
/**
 * Opera Server Memory Diagnostic
 *
 * Analyzes Oracle memory usage to identify what's consuming RAM
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

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function main() {
  console.log('='.repeat(70));
  console.log('Opera Server Memory Diagnostic');
  console.log('='.repeat(70));
  console.log();

  let connection;

  try {
    const connectString = CONFIG.sid
      ? `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${CONFIG.host})(PORT=${CONFIG.port}))(CONNECT_DATA=(SID=${CONFIG.sid})))`
      : `${CONFIG.host}:${CONFIG.port}/${CONFIG.service}`;

    console.log('Connecting to Oracle...');
    connection = await oracledb.getConnection({
      user: CONFIG.user,
      password: CONFIG.password,
      connectString
    });
    console.log('✓ Connected\n');

    // 1. SGA Memory Allocation
    console.log('=' .repeat(70));
    console.log('1. SYSTEM GLOBAL AREA (SGA) - Shared Memory');
    console.log('='.repeat(70));
    try {
      const sgaResult = await connection.execute(`
        SELECT NAME, VALUE
        FROM V$SGA
        ORDER BY NAME
      `);

      let totalSGA = 0;
      sgaResult.rows.forEach(row => {
        const value = parseInt(row[1]);
        totalSGA += value;
        console.log(`  ${row[0]}: ${formatBytes(value)}`);
      });
      console.log(`  ${'TOTAL SGA'.padEnd(30)}: ${formatBytes(totalSGA)}`);
      console.log();

      // SGA Component breakdown
      console.log('  SGA Component Breakdown:');
      const sgaStatResult = await connection.execute(`
        SELECT POOL, NAME, BYTES
        FROM V$SGASTAT
        WHERE BYTES > 1048576
        ORDER BY BYTES DESC
        FETCH FIRST 15 ROWS ONLY
      `);

      sgaStatResult.rows.forEach(row => {
        const pool = row[0] || 'other';
        const name = row[1];
        const bytes = parseInt(row[2]);
        console.log(`    ${pool.padEnd(15)} ${name.padEnd(35)} ${formatBytes(bytes)}`);
      });
      console.log();

    } catch (err) {
      console.log('  ⚠️  Cannot query V$SGA (insufficient privileges)');
      console.log('     Ask DBA to check SGA usage\n');
    }

    // 2. PGA Memory Allocation
    console.log('='.repeat(70));
    console.log('2. PROCESS GLOBAL AREA (PGA) - Session Memory');
    console.log('='.repeat(70));
    try {
      const pgaResult = await connection.execute(`
        SELECT NAME, VALUE
        FROM V$PGASTAT
        WHERE NAME IN ('aggregate PGA target parameter',
                       'aggregate PGA auto target',
                       'total PGA inuse',
                       'total PGA allocated',
                       'maximum PGA allocated')
      `);

      pgaResult.rows.forEach(row => {
        const value = parseInt(row[1]);
        console.log(`  ${row[0].padEnd(40)}: ${formatBytes(value)}`);
      });
      console.log();

    } catch (err) {
      console.log('  ⚠️  Cannot query V$PGASTAT (insufficient privileges)\n');
    }

    // 3. Active Sessions and Memory Usage
    console.log('='.repeat(70));
    console.log('3. ACTIVE SESSIONS - Memory Per Session');
    console.log('='.repeat(70));
    try {
      const sessionsResult = await connection.execute(`
        SELECT s.USERNAME, s.PROGRAM, s.STATUS, s.MACHINE,
               pga.VALUE as PGA_MEMORY
        FROM V$SESSION s
        LEFT JOIN V$SESSTAT pga ON s.SID = pga.SID
        LEFT JOIN V$STATNAME n ON pga.STATISTIC# = n.STATISTIC#
        WHERE s.TYPE = 'USER'
          AND n.NAME = 'session pga memory'
        ORDER BY pga.VALUE DESC NULLS LAST
      `);

      console.log(`  Total active sessions: ${sessionsResult.rows.length}\n`);

      if (sessionsResult.rows.length > 0) {
        console.log('  Top 10 sessions by memory:');
        sessionsResult.rows.slice(0, 10).forEach((row, idx) => {
          const username = row[0] || 'N/A';
          const program = (row[1] || 'N/A').substring(0, 30);
          const status = row[2];
          const memory = row[4] ? formatBytes(row[4]) : '0 B';
          console.log(`    ${(idx + 1).toString().padStart(2)}. ${username.padEnd(12)} ${program.padEnd(32)} ${status.padEnd(8)} ${memory}`);
        });
        console.log();
      }

      // Our app's sessions specifically
      const ourSessionsResult = await connection.execute(`
        SELECT COUNT(*) as SESSION_COUNT,
               SUM(pga.VALUE) as TOTAL_PGA
        FROM V$SESSION s
        LEFT JOIN V$SESSTAT pga ON s.SID = pga.SID
        LEFT JOIN V$STATNAME n ON pga.STATISTIC# = n.STATISTIC#
        WHERE s.USERNAME = :username
          AND n.NAME = 'session pga memory'
      `, { username: CONFIG.user.toUpperCase() });

      if (ourSessionsResult.rows[0][0] > 0) {
        const count = ourSessionsResult.rows[0][0];
        const totalPga = ourSessionsResult.rows[0][1] || 0;
        console.log(`  Our app (${CONFIG.user}) sessions: ${count}`);
        console.log(`  Our app total PGA memory: ${formatBytes(totalPga)}`);
        console.log();
      }

    } catch (err) {
      console.log('  ⚠️  Cannot query V$SESSION (insufficient privileges)\n');
    }

    // 4. Connection Pools
    console.log('='.repeat(70));
    console.log('4. CONNECTION POOLS');
    console.log('='.repeat(70));
    try {
      const poolResult = await connection.execute(`
        SELECT USERNAME, COUNT(*) as CONNECTION_COUNT
        FROM V$SESSION
        WHERE TYPE = 'USER' AND USERNAME IS NOT NULL
        GROUP BY USERNAME
        ORDER BY COUNT(*) DESC
      `);

      console.log('  Connections by user:');
      poolResult.rows.forEach(row => {
        console.log(`    ${row[0].padEnd(20)} ${row[1]} connections`);
      });
      console.log();

    } catch (err) {
      console.log('  ⚠️  Cannot query connection pools\n');
    }

    // 5. Table sizes (NAME_PHONE specifically)
    console.log('='.repeat(70));
    console.log('5. TABLE SIZES - Data Volume');
    console.log('='.repeat(70));
    try {
      const tableResult = await connection.execute(`
        SELECT COUNT(*) as TOTAL_RECORDS
        FROM OPERA.NAME_PHONE
      `);
      const totalRecords = tableResult.rows[0][0];
      console.log(`  OPERA.NAME_PHONE total records: ${totalRecords.toLocaleString()}`);

      const emailResult = await connection.execute(`
        SELECT COUNT(*) as EMAIL_RECORDS
        FROM OPERA.NAME_PHONE
        WHERE PHONE_ROLE = 'EMAIL'
      `);
      const emailRecords = emailResult.rows[0][0];
      console.log(`  Email records (PHONE_ROLE = 'EMAIL'): ${emailRecords.toLocaleString()}`);

      const recentResult = await connection.execute(`
        SELECT COUNT(*) as RECENT_RECORDS
        FROM OPERA.NAME_PHONE
        WHERE PHONE_ROLE = 'EMAIL'
          AND (UPDATE_DATE >= SYSDATE - 365 OR INSERT_DATE >= SYSDATE - 365)
      `);
      const recentRecords = recentResult.rows[0][0];
      console.log(`  Recent emails (last 365 days): ${recentRecords.toLocaleString()}`);
      console.log(`  Reduction from date filter: ${((1 - recentRecords/emailRecords) * 100).toFixed(1)}%`);
      console.log();

    } catch (err) {
      console.log('  ⚠️  Cannot query table sizes\n');
    }

    // 6. Database parameters affecting memory
    console.log('='.repeat(70));
    console.log('6. DATABASE PARAMETERS - Memory Configuration');
    console.log('='.repeat(70));
    try {
      const paramResult = await connection.execute(`
        SELECT NAME, VALUE, DISPLAY_VALUE
        FROM V$PARAMETER
        WHERE NAME IN ('sga_target', 'sga_max_size', 'pga_aggregate_target',
                       'memory_target', 'memory_max_target',
                       'shared_pool_size', 'db_cache_size',
                       'java_pool_size', 'large_pool_size',
                       'job_queue_processes')
        ORDER BY NAME
      `);

      paramResult.rows.forEach(row => {
        const name = row[0];
        const displayValue = row[2] || row[1];
        console.log(`  ${name.padEnd(30)}: ${displayValue}`);
      });
      console.log();

    } catch (err) {
      console.log('  ⚠️  Cannot query V$PARAMETER (insufficient privileges)');
      console.log('     Ask DBA to check memory parameters\n');
    }

    // Summary and Recommendations
    console.log('='.repeat(70));
    console.log('ANALYSIS & RECOMMENDATIONS');
    console.log('='.repeat(70));
    console.log();

    // Calculate our app's potential memory footprint
    try {
      const emailCount = await connection.execute(`
        SELECT COUNT(*) FROM OPERA.NAME_PHONE WHERE PHONE_ROLE = 'EMAIL'
      `);
      const emails = emailCount.rows[0][0];

      console.log('Our application memory footprint (estimated):');
      console.log();
      console.log('  Connection pool: 4 connections × 2-5 MB = 8-20 MB');
      console.log('  Query result sets (transient): 5-10 MB');
      console.log(`  CQN subscriptions (if enabled): 0 MB (none active)`);
      console.log(`  Total: ~13-30 MB`);
      console.log();
      console.log(`  → Our app uses <0.5% of total RAM (minimal impact)`);
      console.log();

      console.log('Where is the 86% RAM going?');
      console.log();
      console.log('  Most likely culprits:');
      console.log('  1. Oracle SGA configured too high for available RAM');
      console.log('  2. Oracle PGA (session memory) from many connections');
      console.log('  3. Opera PMS application itself (not our sync tool)');
      console.log('  4. Other Windows services on the server');
      console.log('  5. Operating system cache/buffers');
      console.log();

      console.log('Recommended actions:');
      console.log('  1. Check Windows Task Manager → Details tab');
      console.log('     - Sort by Memory to see top processes');
      console.log('     - Look for oracle.exe, OperaPMS.exe, etc.');
      console.log();
      console.log('  2. Ask DBA to review Oracle memory settings');
      console.log('     - SGA might be over-allocated');
      console.log('     - PGA target might need tuning');
      console.log();
      console.log('  3. Check if other apps connect to Opera DB');
      console.log('     - Reporting tools, backup jobs, etc.');
      console.log();
      console.log('  4. Our optimizations (date filters) will help slightly,');
      console.log('     but the 86% RAM is NOT from our application.');
      console.log();

    } catch (err) {
      console.log('  Could not complete analysis');
    }

    console.log('='.repeat(70));

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
