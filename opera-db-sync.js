#!/usr/bin/env node

/**
 * OPERA Database to Salesforce Sync - CQN Event-Driven
 *
 * Uses Oracle Continuous Query Notification to detect new/updated guest
 * email records and sync them to Salesforce in real-time.
 */

require('dotenv').config();
const oracledb = require('oracledb');

const logger = require('./src/logger');
const SalesforceClient = require('./src/salesforce-client');
const OracleClient = require('./src/oracle-client');
const SyncState = require('./src/sync-state');
const Notifier = require('./src/notifier');
const DailyStats = require('./src/daily-stats');
const DuplicateDetector = require('./src/duplicate-detector');
const { setupDailySummary } = require('./src/scheduler');
const { queryGuestsByIds, queryGuestsSince } = require('./src/opera-db-query');

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
    objectType: process.env.SF_OBJECT || 'TVRS_Guest__c',
    externalIdField: process.env.SF_EXTERNAL_ID_FIELD || 'Email__c'
  },
  debounceMs: parseInt(process.env.CQN_DEBOUNCE_MS) || 5000
};

// Global state
let sfClient;
let oracleClient;
let syncState;
let notifier;
let dailyStats;
let duplicateDetector;
let cqnConnection;
let pendingNameIds = new Set();
let debounceTimer = null;
let isProcessing = false;

/**
 * Initialize the application
 */
async function initialize() {
  logger.info('='.repeat(70));
  logger.info('OPERA Database to Salesforce Sync (CQN) - Starting');
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

  // Initialize duplicate detector
  duplicateDetector = new DuplicateDetector(sfClient);

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
  logger.info(`  CQN Debounce: ${CONFIG.debounceMs}ms`);

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
 * Register CQN subscription on OPERA.NAME_PHONE
 */
async function registerCQN() {
  logger.info('Registering CQN subscription on OPERA.NAME_PHONE...');

  // CQN requires a dedicated connection (not from pool)
  const connectString = CONFIG.oracle.sid
    ? `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${CONFIG.oracle.host})(PORT=${CONFIG.oracle.port}))(CONNECT_DATA=(SID=${CONFIG.oracle.sid})))`
    : `${CONFIG.oracle.host}:${CONFIG.oracle.port}/${CONFIG.oracle.service}`;

  cqnConnection = await oracledb.getConnection({
    user: CONFIG.oracle.user,
    password: CONFIG.oracle.password,
    connectString,
    events: true
  });

  const options = {
    callback: onDatabaseChange,
    sql: `SELECT NAME_ID, PHONE_NUMBER FROM OPERA.NAME_PHONE WHERE PHONE_ROLE = 'EMAIL'`,
    qos: oracledb.SUBSCR_QOS_ROWIDS | oracledb.SUBSCR_QOS_BEST_EFFORT,
    timeout: 0 // No timeout — persistent subscription
  };

  await cqnConnection.subscribe('guest-email-changes', options);
  logger.info('CQN subscription registered successfully');
}

/**
 * CQN callback — fired when OPERA.NAME_PHONE rows change
 */
function onDatabaseChange(message) {
  logger.debug('CQN event received:', JSON.stringify(message.type));

  if (!message.tables) return;

  for (const table of message.tables) {
    if (!table.rows) continue;

    for (const row of table.rows) {
      // row.rowid is available; we need to query NAME_ID from it
      // Add rowid to pending set for batch processing
      if (row.rowid) {
        pendingNameIds.add(row.rowid);
      }
    }
  }

  // Debounce: wait for more events before processing
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(processPendingChanges, CONFIG.debounceMs);
}

/**
 * Process accumulated CQN changes
 */
async function processPendingChanges() {
  if (isProcessing || pendingNameIds.size === 0) return;

  isProcessing = true;
  const rowids = [...pendingNameIds];
  pendingNameIds.clear();

  try {
    // Resolve ROWIDs to NAME_IDs
    const binds = {};
    const placeholders = rowids.map((rid, idx) => {
      binds[`r${idx}`] = rid;
      return `:r${idx}`;
    });

    const rows = await oracleClient.query(
      `SELECT DISTINCT NAME_ID FROM OPERA.NAME_PHONE WHERE ROWID IN (${placeholders.join(',')})`,
      binds
    );

    const nameIds = rows.map(r => r.NAME_ID);
    if (nameIds.length === 0) {
      logger.debug('No valid NAME_IDs from CQN event');
      return;
    }

    logger.info(`Processing CQN event: ${nameIds.length} guest(s) changed`);
    await syncGuests(nameIds);

  } catch (err) {
    logger.error('Error processing CQN changes:', err.message);
    if (err.stack) logger.error(err.stack);
    dailyStats.addError(err);
    await notifier.notifyFileError('CQN event', err, { stack: err.stack });
  } finally {
    isProcessing = false;
  }
}

/**
 * Query guest data and sync to Salesforce
 */
async function syncGuests(nameIds) {
  const { records, filtered } = await queryGuestsByIds(oracleClient, nameIds);

  if (filtered.length > 0) {
    await notifier.notifyFilteredAgents('db-sync', filtered);
    dailyStats.addSkipped('agent', filtered.length);
  }

  if (records.length === 0) {
    logger.info('No guest records to sync after filtering');
    syncState.markSuccess(0);
    return;
  }

  // Duplicate detection
  const duplicates = [];
  const recordsToSync = [];

  for (const record of records) {
    const customer = {
      firstName: record.Guest_First_Name__c || '',
      lastName: record.Guest_Last_Name__c || '',
      email: record.Email__c || '',
      billingCity: record.City__c || '',
      billingState: record.State_Province__c || '',
      billingCountry: record.Country__c || ''
    };

    const invoice = {
      checkIn: record.Check_In_Date__c || '',
      checkOut: record.Check_Out_Date__c || ''
    };

    const dupCheck = await duplicateDetector.checkForDuplicates(customer, invoice);

    if (dupCheck.isDuplicate) {
      duplicates.push({
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        probability: dupCheck.probability,
        matches: dupCheck.matches,
        category: 'duplicate-detected'
      });
    } else {
      recordsToSync.push(record);
    }
  }

  if (duplicates.length > 0) {
    logger.info(`Detected ${duplicates.length} potential duplicates (skipped)`);
    await notifier.notifyDuplicatesDetected('db-sync', duplicates);
    dailyStats.addSkipped('duplicate', duplicates.length);
  }

  if (recordsToSync.length === 0) {
    logger.info('All records were filtered or duplicates - nothing to sync');
    syncState.markSuccess(0);
    return;
  }

  const results = await sfClient.syncRecords(
    recordsToSync,
    CONFIG.salesforce.objectType,
    CONFIG.salesforce.externalIdField
  );

  if (results.failed > 0 && results.success === 0) {
    const err = new Error(`All ${results.failed} records failed: ${results.errors[0]?.error}`);
    syncState.markFailed(err);
    dailyStats.addError(err);
    throw err;
  }

  logger.info(`Synced ${results.success} records to Salesforce (${results.failed} failed)`);
  syncState.markSuccess(results.success);
  dailyStats.addUpload(results.success);

  await notifier.notifyFileProcessed('db-sync', results.success, filtered.length);

  if (notifier.consecutiveErrors > 0) {
    await notifier.notifyRecovery(results.success);
  } else {
    notifier.resetErrorCount();
  }
}

/**
 * Run catch-up query for records modified since last sync
 */
async function runCatchUp() {
  const lastSync = syncState.getLastSyncTimestamp();
  logger.info(lastSync
    ? `Running catch-up query for changes since ${lastSync}...`
    : 'Running initial sync (no previous sync state)...');

  const { records, filtered } = await queryGuestsSince(oracleClient, lastSync);

  if (filtered.length > 0) {
    await notifier.notifyFilteredAgents('db-catchup', filtered);
    dailyStats.addSkipped('agent', filtered.length);
  }

  if (records.length === 0) {
    logger.info('No new records to sync');
    syncState.markSuccess(0);
    return;
  }

  // Duplicate detection for catch-up records
  const duplicates = [];
  const recordsToSync = [];

  for (const record of records) {
    const customer = {
      firstName: record.Guest_First_Name__c || '',
      lastName: record.Guest_Last_Name__c || '',
      email: record.Email__c || '',
      billingCity: record.City__c || '',
      billingState: record.State_Province__c || '',
      billingCountry: record.Country__c || ''
    };

    const invoice = {
      checkIn: record.Check_In_Date__c || '',
      checkOut: record.Check_Out_Date__c || ''
    };

    const dupCheck = await duplicateDetector.checkForDuplicates(customer, invoice);

    if (dupCheck.isDuplicate) {
      duplicates.push({
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        probability: dupCheck.probability,
        matches: dupCheck.matches,
        category: 'duplicate-detected'
      });
    } else {
      recordsToSync.push(record);
    }
  }

  if (duplicates.length > 0) {
    logger.info(`Catch-up: detected ${duplicates.length} potential duplicates (skipped)`);
    await notifier.notifyDuplicatesDetected('db-catchup', duplicates);
    dailyStats.addSkipped('duplicate', duplicates.length);
  }

  logger.info(`Catch-up: syncing ${recordsToSync.length} records to Salesforce...`);

  const results = await sfClient.syncRecords(
    recordsToSync,
    CONFIG.salesforce.objectType,
    CONFIG.salesforce.externalIdField
  );

  logger.info(`Catch-up complete: ${results.success} synced, ${results.failed} failed`);
  syncState.markSuccess(results.success);
  dailyStats.addUpload(results.success);

  await notifier.notifyFileProcessed('db-catchup', results.success, filtered.length);
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  logger.info('\nShutting down...');

  if (debounceTimer) clearTimeout(debounceTimer);

  if (cqnConnection) {
    try {
      await cqnConnection.unsubscribe('guest-email-changes');
      logger.info('CQN subscription removed');
    } catch (err) {
      logger.debug('Error unsubscribing CQN:', err.message);
    }
    try {
      await cqnConnection.close();
    } catch (err) {
      logger.debug('Error closing CQN connection:', err.message);
    }
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
    await runCatchUp();
    await registerCQN();

    logger.info('='.repeat(70));
    logger.info('Listening for database changes...');
    logger.info('='.repeat(70));

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (err) {
    logger.error('Fatal error during startup:', err.message);
    if (err.stack) logger.error(err.stack);
    if (dailyStats) dailyStats.addError(err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { syncGuests, runCatchUp };
