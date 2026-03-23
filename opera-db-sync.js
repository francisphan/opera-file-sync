#!/usr/bin/env node

/**
 * OPERA Database to Salesforce Sync - Polling Mode
 *
 * Polls Oracle database at regular intervals to detect new/updated guest
 * email records and syncs them to Salesforce.
 */

require('dotenv').config();

const logger = require('./src/logger');

// Prevent unhandled rejections from crashing the process (Node 18+ terminates by default)
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception (shutting down):', err);
  process.exit(1);
});

const SalesforceClient = require('./src/salesforce-client');
const OracleClient = require('./src/oracle-client');
const SyncState = require('./src/sync-state');
const Notifier = require('./src/notifier');
const DailyStats = require('./src/daily-stats');
const { setupDailySummary, setupFrontDeskReport } = require('./src/scheduler');
const { queryGuestsSince, queryFrontDeskReport } = require('./src/opera-db-query');
const SheetsClient = require('./src/sheets-client');

// Configuration
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
  },
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MINUTES || 5) * 60 * 1000
};

// Global state
let sfClient;
let oracleClient;
let syncState;
let notifier;
let dailyStats;
let sheetsClient;
let pollTimer = null;
let isPolling = false;

/**
 * Initialize the application
 */
async function initialize() {
  logger.info('='.repeat(70));
  logger.info('OPERA Database to Salesforce Sync (Polling Mode) - Starting');
  logger.info('='.repeat(70));

  if (!validateConfig()) {
    process.exit(1);
  }

  if (!require('fs').existsSync('logs')) {
    require('fs').mkdirSync('logs');
  }

  syncState = new SyncState();
  notifier = new Notifier();
  dailyStats = new DailyStats();
  sheetsClient = new SheetsClient();

  // Connect to Salesforce
  sfClient = new SalesforceClient(CONFIG.salesforce);

  // Setup daily summary scheduler (no fileTracker for DB mode)
  setupDailySummary(notifier, dailyStats, null);

  // Setup front desk report scheduler (wired to Oracle for direct queries)
  // Note: oracleClient is connected after this, but the queryFn closure captures the variable
  // and only executes at scheduled time, by which point oracleClient is connected.
  setupFrontDeskReport(notifier, dailyStats, (dateStr) => queryFrontDeskReport(oracleClient, dateStr));
  logger.info('Testing Salesforce connection...');
  const sfConnected = await sfClient.test();
  if (!sfConnected) {
    logger.error('Failed to connect to Salesforce.');
    await notifier.notifySalesforceError(new Error('Failed to connect to Salesforce during startup'));
    process.exit(1);
  }

  // Connect to Oracle
  oracleClient = new OracleClient(CONFIG.oracle);
  await oracleClient.connect();

  logger.info('Configuration:');
  logger.info(`  Oracle: ${CONFIG.oracle.host}:${CONFIG.oracle.port} (SID: ${CONFIG.oracle.sid || 'N/A'}, Service: ${CONFIG.oracle.service || 'N/A'})`);
  logger.info(`  Salesforce Object: ${CONFIG.salesforce.objectType}`);
  logger.info(`  Poll Interval: ${CONFIG.pollIntervalMs / 1000 / 60} minutes`);

  const stats = syncState.getStats();
  logger.info(`  Last sync: ${stats.lastSyncTimestamp || 'never'}`);

  // Validate check-in spreadsheet access at startup (disables feature with warning if inaccessible)
  await sheetsClient.validateCheckinAccess();

  logger.info('='.repeat(70));
}

/**
 * Validate configuration
 */
function validateConfig() {
  const required = ['SF_INSTANCE_URL', 'SF_CLIENT_ID', 'SF_CLIENT_SECRET', 'SF_REFRESH_TOKEN',
                     'ORACLE_HOST', 'ORACLE_USER', 'ORACLE_PASSWORD'];
  const missing = required.filter(key => !process.env[key]);

  if (!process.env.ORACLE_SID && !process.env.ORACLE_SERVICE) {
    missing.push('ORACLE_SID or ORACLE_SERVICE');
  }

  if (missing.length > 0) {
    logger.error('Missing required environment variables:');
    missing.forEach(key => logger.error(`  - ${key}`));
    return false;
  }
  return true;
}

/**
 * Poll for changes and sync
 */
async function poll() {
  if (isPolling) {
    logger.debug('Previous poll still running, skipping this interval');
    return;
  }

  isPolling = true;

  try {
    const lastSync = syncState.getLastSyncTimestamp();
    logger.debug(`Polling for changes since ${lastSync || 'beginning'}...`);

    const { records, frontDesk } = await queryGuestsSince(oracleClient, lastSync);

    if (frontDesk.length > 0) {
      dailyStats.addFrontDesk(frontDesk.length, frontDesk);
    }

    if (records.length === 0 && frontDesk.length === 0) {
      logger.debug('No new records found');
      syncState.markSuccess(0);
      return;
    }

    // ── Salesforce sync (only when records exist) ──
    if (records.length > 0) {
      logger.info(`Found ${records.length} new/updated guest(s), syncing to Salesforce...`);

      const results = await sfClient.syncGuestCheckIns(records);

      if (results.andonPulled) {
        logger.warn('Andon cord active — skipping sync state update, will retry next poll');
        return;
      }

      if (results.failed > 0 && results.success === 0) {
        const err = new Error(`All ${results.failed} records failed: ${results.errors[0]?.error}`);
        syncState.markFailed(err);
        dailyStats.addError(err);
        throw err;
      }

      logger.info(`✓ Synced ${results.success} records (${results.failed} failed)`);
      syncState.markSuccess(results.success);
      dailyStats.addUpload(results.success);

      if (results.needsReview && results.needsReview.length > 0) {
        dailyStats.addNeedsReview(results.needsReview.length, results.needsReview);
      }

      await notifier.notifyFileProcessed('db-poll', results.success, frontDesk.length);

      if (notifier.consecutiveErrors > 0) {
        await notifier.notifyRecovery(results.success);
      } else {
        notifier.resetErrorCount();
      }
    } else {
      syncState.markSuccess(0);
    }

    // ── Google Sheets: checkout survey (only when records exist) ──
    const argNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    const today = argNow.toISOString().slice(0, 10);
    const checkedOut = records.filter(r => r.invoice && r.invoice.checkOut === today);
    if (checkedOut.length > 0) {
      try {
        await sheetsClient.appendCheckedOutGuests(checkedOut);
      } catch (err) {
        logger.error('Sheets checkout append failed (non-fatal):', err.message);
        dailyStats.addError(new Error(`Sheets checkout: ${err.message}`));
      }
    }

    // ── Google Sheets: check-in arrivals (records + frontDesk, today + yesterday) ──
    const yesterdayDate = new Date(argNow);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = yesterdayDate.toISOString().slice(0, 10);

    const checkingInFromRecords = records.filter(r =>
      r.invoice && (r.invoice.checkIn === today || r.invoice.checkIn === yesterday)
    );
    const checkingInFromFrontDesk = frontDesk
      .filter(fd => fd.checkIn === today || fd.checkIn === yesterday)
      .map(fd => ({
        customer: {
          firstName: fd.firstName,
          lastName: fd.lastName,
          email: fd.email || '',
          language: ''
        },
        invoice: {
          checkIn: fd.checkIn,
          checkOut: fd.checkOut,
          resvStatus: fd.reason === 'invalid-email' ? 'No Email' : 'Agent Email'
        }
      }));
    const allCheckIns = [...checkingInFromRecords, ...checkingInFromFrontDesk];
    if (allCheckIns.length > 0) {
      try {
        await sheetsClient.appendCheckInGuests(allCheckIns);
      } catch (err) {
        logger.error('Sheets check-in append failed (non-fatal):', err.message);
        dailyStats.addError(new Error(`Sheets check-in: ${err.message}`));
      }
    }

  } catch (err) {
    logger.error('Error during poll:', err.message);
    if (err.stack) logger.debug(err.stack);
    dailyStats.addError(err);
    try {
      await notifier.notifyFileError('db-poll', err, { stack: err.stack });
    } catch (notifyErr) {
      logger.error('Failed to send error notification:', notifyErr.message);
    }
  } finally {
    isPolling = false;
  }
}

/**
 * Start the polling loop
 */
function startPolling() {
  logger.info('='.repeat(70));
  logger.info(`Polling every ${CONFIG.pollIntervalMs / 1000 / 60} minutes for database changes...`);
  logger.info('='.repeat(70));

  // Run first poll immediately (with .catch to prevent unhandled rejection)
  poll().catch(err => logger.error('Initial poll failed:', err.message));

  // Then poll on interval
  pollTimer = setInterval(() => poll().catch(err => logger.error('Poll failed:', err.message)), CONFIG.pollIntervalMs);
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  logger.info('\nShutting down...');

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // Wait for current poll to finish
  let waitCount = 0;
  while (isPolling && waitCount < 30) {
    logger.debug('Waiting for current poll to finish...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    waitCount++;
  }

  if (oracleClient) {
    await oracleClient.close();
  }

  const stats = syncState.getStats();
  logger.info('Final state:');
  logger.info(`  Last sync: ${stats.lastSyncTimestamp}`);
  logger.info(`  Status: ${stats.lastSyncStatus}`);
  logger.info('Goodbye!');
  process.exit(0);
}

/**
 * Main entry point
 */
async function main() {
  try {
    await initialize();

    // Start polling loop (first poll runs immediately inside startPolling)
    startPolling();

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    // SIGBREAK is sent by Windows when the console window is closed or Ctrl+Break is pressed
    if (process.platform === 'win32') {
      process.on('SIGBREAK', shutdown);
    }

  } catch (err) {
    logger.error('Fatal error during startup:', err);
    logger.error('Error details:', {
      message: err.message,
      code: err.code,
      errorNum: err.errorNum,
      offset: err.offset
    });
    if (err.stack) logger.error(err.stack);
    if (dailyStats) dailyStats.addError(err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { poll };
