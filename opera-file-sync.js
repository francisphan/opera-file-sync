#!/usr/bin/env node

/**
 * OPERA File Export to Salesforce Sync - Standalone Script
 *
 * This script watches for OPERA export files and syncs them to Salesforce.
 * Supports both CSV and XML formats.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const logger = require('./src/logger');
const SalesforceClient = require('./src/salesforce-client');
const FileTracker = require('./src/file-tracker');
const Notifier = require('./src/notifier');
const { parseCSV, isCSV } = require('./src/parsers/csv-parser');
const { parseXML, isXML } = require('./src/parsers/xml-parser');
const { parseOPERAFiles, findMatchingInvoiceFile, findMatchingCustomersFile } = require('./src/parsers/opera-parser');

// Configuration
const CONFIG = {
  exportDir: process.env.EXPORT_DIR || './exports',
  processedDir: process.env.PROCESSED_DIR || './exports/processed',
  failedDir: process.env.FAILED_DIR || './exports/failed',
  fileFormat: process.env.FILE_FORMAT || 'auto',
  fileProcessingDelay: parseInt(process.env.FILE_PROCESSING_DELAY) || 2000,
  keepProcessedFiles: process.env.KEEP_PROCESSED_FILES !== 'false',
  salesforce: {
    instanceUrl: process.env.SF_INSTANCE_URL,
    clientId: process.env.SF_CLIENT_ID,
    clientSecret: process.env.SF_CLIENT_SECRET,
    refreshToken: process.env.SF_REFRESH_TOKEN,
    objectType: process.env.SF_OBJECT || 'TVRS_Guest__c',
    externalIdField: process.env.SF_EXTERNAL_ID_FIELD || 'Email__c'
  }
};

// Global state
let sfClient;
let fileTracker;
let notifier;
let isProcessing = false;

/**
 * Initialize the application
 */
async function initialize() {
  logger.info('='.repeat(70));
  logger.info('OPERA File Export to Salesforce Sync - Starting');
  logger.info('='.repeat(70));

  // Validate configuration
  if (!validateConfig()) {
    process.exit(1);
  }

  // Create directories
  ensureDirectories();

  // Create logs directory
  if (!fs.existsSync('logs')) {
    fs.mkdirSync('logs');
  }

  // Initialize file tracker
  fileTracker = new FileTracker();

  // Initialize notifier
  notifier = new Notifier();

  // Initialize Salesforce client
  sfClient = new SalesforceClient(CONFIG.salesforce);

  // Test Salesforce connection
  logger.info('Testing Salesforce connection...');
  const connected = await sfClient.test();
  if (!connected) {
    logger.error('Failed to connect to Salesforce. Please check your credentials.');

    // Send notification about Salesforce connection failure
    await notifier.notifySalesforceError(new Error('Failed to connect to Salesforce during startup'));

    process.exit(1);
  }

  // Test email configuration if enabled
  if (process.env.EMAIL_ENABLED === 'true') {
    logger.info('Testing email configuration...');
    const emailWorking = await notifier.testEmail();
    if (!emailWorking) {
      logger.warn('Email notifications are enabled but test failed. Check SMTP settings.');
    }
  }

  // Test Slack configuration if enabled
  if (process.env.SLACK_WEBHOOK_URL) {
    logger.info('Testing Slack configuration...');
    const slackWorking = await notifier.testSlack();
    if (!slackWorking) {
      logger.warn('Slack notifications are enabled but test failed. Check webhook URL.');
    }
  }

  logger.info('Configuration:');
  logger.info(`  Export Directory: ${CONFIG.exportDir}`);
  logger.info(`  Processed Directory: ${CONFIG.processedDir}`);
  logger.info(`  Failed Directory: ${CONFIG.failedDir}`);
  logger.info(`  File Format: ${CONFIG.fileFormat}`);
  logger.info(`  External ID Field: ${CONFIG.salesforce.externalIdField}`);
  logger.info(`  Sync Mode: ${process.env.SYNC_MODE || 'upsert'}`);

  const stats = fileTracker.getStats();
  logger.info(`File Tracker Stats: ${stats.total} total, ${stats.success} success, ${stats.failed} failed`);

  logger.info('='.repeat(70));
  logger.info('Initialization complete. Watching for files...');
  logger.info('='.repeat(70));
}

/**
 * Validate configuration
 */
function validateConfig() {
  const required = [
    'SF_INSTANCE_URL',
    'SF_CLIENT_ID',
    'SF_CLIENT_SECRET',
    'SF_REFRESH_TOKEN'
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    logger.error('Missing required environment variables:');
    missing.forEach(key => logger.error(`  - ${key}`));
    logger.error('\nPlease create a .env file with these values.');
    logger.error('See .env.example for reference.');
    return false;
  }

  if (!fs.existsSync(CONFIG.exportDir)) {
    logger.error(`Export directory does not exist: ${CONFIG.exportDir}`);
    logger.error('Please create the directory or update EXPORT_DIR in .env');
    return false;
  }

  return true;
}

/**
 * Ensure required directories exist
 */
function ensureDirectories() {
  [CONFIG.processedDir, CONFIG.failedDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info(`Created directory: ${dir}`);
    }
  });
}

/**
 * Start watching for files
 */
function startWatcher() {
  logger.info(`Starting file watcher on: ${CONFIG.exportDir}`);

  const watcher = chokidar.watch(CONFIG.exportDir, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true,
    depth: 0, // only watch top level
    awaitWriteFinish: {
      stabilityThreshold: CONFIG.fileProcessingDelay,
      pollInterval: 500
    }
  });

  watcher
    .on('add', filePath => handleFileAdded(filePath))
    .on('error', error => logger.error('Watcher error:', error))
    .on('ready', () => logger.info('File watcher ready'));

  return watcher;
}

/**
 * Handle new file detected
 */
async function handleFileAdded(filePath) {
  const filename = path.basename(filePath);

  // Skip if in subdirectory
  if (path.dirname(filePath) !== path.resolve(CONFIG.exportDir)) {
    return;
  }

  // Skip if already processed
  if (fileTracker.isProcessed(filename)) {
    logger.debug(`File already processed: ${filename}`);
    return;
  }

  // Skip temp files
  if (filename.endsWith('.tmp') || filename.startsWith('.')) {
    return;
  }

  // Check file format
  if (CONFIG.fileFormat !== 'auto') {
    const isExpectedFormat =
      (CONFIG.fileFormat === 'csv' && isCSV(filePath)) ||
      (CONFIG.fileFormat === 'xml' && isXML(filePath));

    if (!isExpectedFormat) {
      logger.warn(`Skipping file with unexpected format: ${filename}`);
      return;
    }
  }

  logger.info(`New file detected: ${filename}`);

  // Process file (with queue to prevent concurrent processing)
  await queueFileProcessing(filePath);
}

/**
 * Queue file processing to prevent concurrent operations
 */
async function queueFileProcessing(filePath) {
  if (isProcessing) {
    logger.info('Processing in progress, will process file when ready...');
    setTimeout(() => queueFileProcessing(filePath), 1000);
    return;
  }

  isProcessing = true;
  try {
    await processFile(filePath);
  } finally {
    isProcessing = false;
  }
}

/**
 * Process a single file
 */
async function processFile(filePath) {
  const filename = path.basename(filePath);

  logger.info('='.repeat(70));
  logger.info(`Processing file: ${filename}`);
  logger.info('='.repeat(70));

  try {
    // Parse file based on format
    let records;
    let filtered;

    // Check if this is an OPERA customers file
    if (filename.match(/customers\d{8}\.csv$/i)) {
      logger.info('Detected OPERA customers CSV format');

      // Find matching invoices file
      const invoicesFile = findMatchingInvoiceFile(filePath);
      if (invoicesFile) {
        logger.info(`Found matching invoices file: ${path.basename(invoicesFile)}`);
      } else {
        logger.warn('No matching invoices file found - proceeding without check-in/out dates');
      }

      // Parse and join OPERA files
      const result = await parseOPERAFiles(filePath, invoicesFile);
      records = result.records;
      filtered = result.filtered;
    } else if (filename.match(/invoices\d{8}\.csv$/i)) {
      logger.info('Detected OPERA invoices CSV format');

      // Find matching customers file (export dir first, then processed dir)
      const customersFile = findMatchingCustomersFile(filePath, CONFIG.processedDir);
      if (!customersFile) {
        logger.warn('No matching customers file found - cannot sync without customer emails, skipping');
        return;
      }

      logger.info(`Found matching customers file: ${path.basename(customersFile)}`);

      // Parse and join OPERA files, then upsert (idempotent - updates existing records with dates)
      const result = await parseOPERAFiles(customersFile, filePath);
      records = result.records;
      filtered = result.filtered;
    } else if (isCSV(filePath)) {
      logger.info('Detected generic CSV format');
      records = await parseCSV(filePath);
    } else if (isXML(filePath)) {
      logger.info('Detected XML format');
      records = await parseXML(filePath);
    } else {
      throw new Error(`Unsupported file format: ${filename}`);
    }

    // Send notification for filtered agent emails
    if (filtered && filtered.length > 0) {
      await notifier.notifyFilteredAgents(filename, filtered);
    }

    if (!records || records.length === 0) {
      logger.warn('No records found in file');
      handleSuccessfulProcessing(filePath, 0);
      return;
    }

    logger.info(`Extracted ${records.length} records from file`);

    // Sync to Salesforce
    const results = await sfClient.syncRecords(
      records,
      CONFIG.salesforce.objectType,
      CONFIG.salesforce.externalIdField
    );

    // Check results
    if (results.failed > 0) {
      logger.warn(`File processed with errors: ${results.success} success, ${results.failed} failed`);
      // Still mark as processed if at least some records succeeded
      if (results.success > 0) {
        handleSuccessfulProcessing(filePath, results.success);
      } else {
        throw new Error(`All records failed to sync: ${results.errors[0]?.error}`);
      }
    } else {
      logger.info(`✓ File processed successfully: ${results.success} records synced`);
      handleSuccessfulProcessing(filePath, results.success);

      // Notify recovery if we had previous errors
      if (notifier.consecutiveErrors > 0) {
        await notifier.notifyRecovery(results.success);
      } else {
        notifier.resetErrorCount();
      }
    }

  } catch (err) {
    logger.error(`✗ File processing failed: ${err.message}`, err);
    handleFailedProcessing(filePath, err);

    // Send error notification
    await notifier.notifyFileError(filename, err, {
      recordCount: records?.length,
      stack: err.stack
    });
  }
}

/**
 * Handle successful file processing
 */
function handleSuccessfulProcessing(filePath, recordCount) {
  const filename = path.basename(filePath);

  // Mark as processed
  fileTracker.markProcessed(filename, filePath, recordCount);

  // Move or delete file
  if (CONFIG.keepProcessedFiles) {
    const destPath = path.join(CONFIG.processedDir, filename);
    fs.renameSync(filePath, destPath);
    logger.info(`File moved to: ${destPath}`);
  } else {
    fs.unlinkSync(filePath);
    logger.info('File deleted');
  }

  logger.info('='.repeat(70));
}

/**
 * Handle failed file processing
 */
function handleFailedProcessing(filePath, error) {
  const filename = path.basename(filePath);

  // Mark as failed
  fileTracker.markFailed(filename, filePath, error);

  // Move to failed directory
  const destPath = path.join(CONFIG.failedDir, filename);
  fs.renameSync(filePath, destPath);
  logger.error(`File moved to failed directory: ${destPath}`);

  logger.info('='.repeat(70));
}

/**
 * Graceful shutdown
 */
function shutdown(watcher) {
  logger.info('\nShutting down...');

  if (watcher) {
    watcher.close();
  }

  const stats = fileTracker.getStats();
  logger.info('Final statistics:');
  logger.info(`  Total files processed: ${stats.total}`);
  logger.info(`  Successful: ${stats.success}`);
  logger.info(`  Failed: ${stats.failed}`);

  logger.info('Goodbye!');
  process.exit(0);
}

/**
 * Main entry point
 */
async function main() {
  try {
    await initialize();
    const watcher = startWatcher();

    // Handle graceful shutdown
    process.on('SIGINT', () => shutdown(watcher));
    process.on('SIGTERM', () => shutdown(watcher));

  } catch (err) {
    logger.error('Fatal error during startup:', err);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { processFile };
