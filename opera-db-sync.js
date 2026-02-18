#!/usr/bin/env node

/**
 * OPERA Database to Salesforce Sync - Polling Mode
 *
 * Polls Oracle database at regular intervals to detect new/updated guest
 * email records and syncs them to Salesforce.
 */

require('dotenv').config();

const logger = require('./src/logger');
const SalesforceClient = require('./src/salesforce-client');
const OracleClient = require('./src/oracle-client');
const SyncState = require('./src/sync-state');
const Notifier = require('./src/notifier');
const DailyStats = require('./src/daily-stats');
const { setupDailySummary } = require('./src/scheduler');
const { queryGuestsSince } = require('./src/opera-db-query');

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

  // Connect to Salesforce
  sfClient = new SalesforceClient(CONFIG.salesforce);

  // Setup daily summary scheduler (no fileTracker for DB mode)
  setupDailySummary(notifier, dailyStats, null);
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

    const { records, filtered, invalid } = await queryGuestsSince(oracleClient, lastSync);

    if (filtered.length > 0) {
      await notifier.notifyFilteredAgents('db-poll', filtered);
      dailyStats.addSkipped('agent', filtered.length, filtered);
    }

    if (invalid.length > 0) {
      dailyStats.addSkipped('invalid', invalid.length, invalid);
    }

    if (records.length === 0) {
      logger.debug('No new records found');
      syncState.markSuccess(0);
      return;
    }

    logger.info(`Found ${records.length} new/updated guest(s), syncing to Salesforce...`);

    const results = await sfClient.syncGuestCheckIns(records);

    if (results.failed > 0 && results.success === 0) {
      const err = new Error(`All ${results.failed} records failed: ${results.errors[0]?.error}`);
      syncState.markFailed(err);
      dailyStats.addError(err);
      throw err;
    }

    logger.info(`✓ Synced ${results.success} records (${results.failed} failed)`);
    syncState.markSuccess(results.success);
    dailyStats.addUpload(results.success);

    await notifier.notifyFileProcessed('db-poll', results.success, filtered.length);

    if (notifier.consecutiveErrors > 0) {
      await notifier.notifyRecovery(results.success);
    } else {
      notifier.resetErrorCount();
    }

  } catch (err) {
    logger.error('Error during poll:', err.message);
    if (err.stack) logger.debug(err.stack);
    dailyStats.addError(err);
    await notifier.notifyFileError('db-poll', err, { stack: err.stack });
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

  // Run first poll immediately
  poll();

  // Then poll on interval
  pollTimer = setInterval(poll, CONFIG.pollIntervalMs);
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

    // Run initial catch-up sync
    logger.info('Running initial sync...');
    await poll();

    // Start polling loop
    startPolling();

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

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
