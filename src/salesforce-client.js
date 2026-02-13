const jsforce = require('jsforce');
const logger = require('./logger');

class SalesforceClient {
  constructor(config) {
    this.config = config;
    this.connection = null;
  }

  /**
   * Connect to Salesforce
   */
  async connect() {
    try {
      logger.info('Connecting to Salesforce...');

      this.connection = new jsforce.Connection({
        oauth2: {
          loginUrl: 'https://login.salesforce.com',
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
          redirectUri: 'http://localhost:3000/oauth/callback'
        },
        instanceUrl: this.config.instanceUrl,
        refreshToken: this.config.refreshToken,
        version: '59.0'
      });

      // Test connection by getting identity
      const identity = await this.connection.identity();
      logger.info(`Connected to Salesforce as ${identity.username}`);
      logger.info(`Organization ID: ${identity.organization_id}`);

      return true;
    } catch (err) {
      logger.error('Failed to connect to Salesforce:', err);
      throw err;
    }
  }

  /**
   * Ensure connection is active
   */
  async ensureConnected() {
    if (!this.connection) {
      await this.connect();
    }
    return this.connection;
  }

  /**
   * Sync records to Salesforce
   * @param {Array} records - Array of records to sync
   * @param {String} objectType - Salesforce object type (e.g., 'Account', 'Contact')
   * @param {String} externalIdField - Field to use for upsert
   * @returns {Object} Results summary
   */
  async syncRecords(records, objectType = 'Account', externalIdField = 'OPERA_Reservation_ID__c') {
    await this.ensureConnected();

    if (!records || records.length === 0) {
      logger.warn('No records to sync');
      return { success: 0, failed: 0, errors: [] };
    }

    logger.info(`Syncing ${records.length} records to Salesforce ${objectType}...`);

    const batchSize = parseInt(process.env.BATCH_SIZE) || 200;
    const results = {
      success: 0,
      failed: 0,
      errors: []
    };

    // Process in batches
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      logger.debug(`Processing batch ${Math.floor(i / batchSize) + 1}: ${batch.length} records`);

      try {
        const batchResults = await this.processBatch(batch, objectType, externalIdField);
        results.success += batchResults.success;
        results.failed += batchResults.failed;
        results.errors.push(...batchResults.errors);
      } catch (err) {
        logger.error(`Batch processing failed:`, err);
        results.failed += batch.length;
        results.errors.push({ batch: i, error: err.message });
      }
    }

    logger.info(`Sync complete: ${results.success} success, ${results.failed} failed`);

    if (results.errors.length > 0) {
      logger.warn(`Encountered ${results.errors.length} errors during sync`);
      results.errors.slice(0, 5).forEach((err, idx) => {
        logger.debug(`Error ${idx + 1}:`, err);
      });
    }

    return results;
  }

  /**
   * Process a single batch
   */
  async processBatch(records, objectType, externalIdField) {
    const mode = process.env.SYNC_MODE || 'upsert';

    try {
      let batchResults;

      if (mode === 'upsert') {
        batchResults = await this.connection.sobject(objectType).upsert(records, externalIdField);
      } else {
        batchResults = await this.connection.sobject(objectType).create(records);
      }

      // Handle results (both single record and array)
      const resultsArray = Array.isArray(batchResults) ? batchResults : [batchResults];

      const results = {
        success: 0,
        failed: 0,
        errors: []
      };

      resultsArray.forEach((result, idx) => {
        if (result.success) {
          results.success++;
          logger.debug(`Record ${idx + 1} synced: ${result.id}`);
        } else {
          results.failed++;
          const errorMsg = result.errors ? result.errors.map(e => e.message).join(', ') : 'Unknown error';
          results.errors.push({
            record: records[idx],
            error: errorMsg
          });
          logger.warn(`Record ${idx + 1} failed: ${errorMsg}`);
        }
      });

      return results;
    } catch (err) {
      logger.error('Batch upsert failed:', err);
      throw err;
    }
  }

  /**
   * Test connection
   */
  async test() {
    try {
      await this.connect();

      // Query a small set of records to verify API access
      const result = await this.connection.query('SELECT Id, Name FROM Account LIMIT 5');
      logger.info(`API access verified - found ${result.totalSize} accounts`);

      return true;
    } catch (err) {
      logger.error('Connection test failed:', err);
      return false;
    }
  }
}

module.exports = SalesforceClient;
