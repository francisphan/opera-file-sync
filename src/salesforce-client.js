const jsforce = require('jsforce');
const logger = require('./logger');
const { transformToContact, transformToTVRSGuest } = require('./guest-utils');

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
   * Two-phase sync: upsert Contacts by email, then upsert TVRS_Guest__c by Contact+CheckInDate
   * @param {Array} guestDataList - Array of {customer, invoice} objects (raw, not yet transformed)
   * @returns {Object} Combined results {contacts: {created, updated, failed}, guests: {created, updated, failed}, errors: []}
   */
  async syncGuestCheckIns(guestDataList) {
    await this.ensureConnected();

    if (!guestDataList || guestDataList.length === 0) {
      logger.warn('No guest data to sync');
      return { contacts: { created: 0, updated: 0, failed: 0, skippedConflicts: 0 }, guests: { created: 0, updated: 0, failed: 0 }, errors: [] };
    }

    const batchSize = parseInt(process.env.BATCH_SIZE) || 200;
    const guestObject = process.env.SF_OBJECT || 'TVRS_Guest__c';
    const contactLookup = process.env.SF_GUEST_CONTACT_LOOKUP || 'Contact__c';
    const results = {
      contacts: { created: 0, updated: 0, failed: 0, skippedConflicts: 0 },
      guests: { created: 0, updated: 0, failed: 0 },
      errors: []
    };

    // --- Phase 1: Upsert Contacts ---
    logger.info(`Phase 1: Upserting ${guestDataList.length} Contacts...`);

    // Group entries by email to detect name conflicts before deduplication
    const emailGroups = new Map(); // email → [{customer, invoice}, ...]
    for (const entry of guestDataList) {
      const email = (entry.customer.email || '').toLowerCase();
      if (!email) continue;
      if (!emailGroups.has(email)) emailGroups.set(email, []);
      emailGroups.get(email).push(entry);
    }

    // Identify emails with multiple distinct names (case-insensitive firstName+lastName)
    const conflictedEmails = new Set();
    for (const [email, entries] of emailGroups) {
      if (entries.length > 1) {
        const names = new Set(
          entries.map(e =>
            `${(e.customer.firstName || '').toLowerCase()}|${(e.customer.lastName || '').toLowerCase()}`
          )
        );
        if (names.size > 1) {
          conflictedEmails.add(email);
          const nameList = [...names].join(', ');
          logger.warn(`Email conflict: "${email}" is shared by ${names.size} distinct names (${nameList})`);
        }
      }
    }

    // Build deduplicated map: first occurrence wins for each email
    const byEmail = new Map();
    for (const entry of guestDataList) {
      const email = (entry.customer.email || '').toLowerCase();
      if (email && !byEmail.has(email)) byEmail.set(email, entry);
    }
    const uniqueEmails = [...byEmail.keys()];

    // Query existing Contacts by email
    const emailToContactId = new Map();
    for (let i = 0; i < uniqueEmails.length; i += batchSize) {
      const emailBatch = uniqueEmails.slice(i, i + batchSize);
      const escaped = emailBatch.map(e => `'${e.replace(/'/g, "\\'")}'`).join(',');
      const query = `SELECT Id, Email FROM Contact WHERE Email IN (${escaped})`;

      try {
        const result = await this.connection.query(query);
        for (const rec of result.records) {
          emailToContactId.set(rec.Email.toLowerCase(), rec.Id);
        }
      } catch (err) {
        logger.error('Error querying existing Contacts:', err.message);
        results.errors.push({ phase: 'contact-query', error: err.message });
      }
    }

    logger.info(`Found ${emailToContactId.size} existing Contacts out of ${uniqueEmails.length} emails`);

    // Split into inserts and updates
    const contactsToInsert = [];
    const contactsToUpdate = [];
    const emailToEntry = new Map(); // track which entry goes with which email

    for (const [email, entry] of byEmail) {
      const contactData = transformToContact(entry.customer);
      const existingId = emailToContactId.get(email);

      if (conflictedEmails.has(email)) {
        if (existingId) {
          // Existing Contact: skip update to avoid overwriting name with a different person's data
          results.contacts.skippedConflicts++;
          logger.warn(`Skipping Contact update for "${email}" (conflicted email, existing Contact ${existingId} preserved)`);
        } else {
          // New Contact: create using first occurrence
          contactsToInsert.push(contactData);
          logger.warn(`Creating new Contact for conflicted email "${email}" using first occurrence`);
        }
      } else {
        if (existingId) {
          contactData.Id = existingId;
          contactsToUpdate.push(contactData);
        } else {
          contactsToInsert.push(contactData);
        }
      }
      emailToEntry.set(email, entry);
    }

    // Batch insert new Contacts
    for (let i = 0; i < contactsToInsert.length; i += batchSize) {
      const batch = contactsToInsert.slice(i, i + batchSize);
      try {
        const batchResults = await this.connection.sobject('Contact').create(batch);
        const resultsArray = Array.isArray(batchResults) ? batchResults : [batchResults];
        resultsArray.forEach((res, idx) => {
          if (res.success) {
            results.contacts.created++;
            emailToContactId.set(batch[idx].Email.toLowerCase(), res.id);
          } else {
            results.contacts.failed++;
            const errorMsg = res.errors ? res.errors.map(e => e.message).join(', ') : 'Unknown error';
            results.errors.push({ phase: 'contact-insert', email: batch[idx].Email, error: errorMsg });
            logger.warn(`Contact insert failed for ${batch[idx].Email}: ${errorMsg}`);
          }
        });
      } catch (err) {
        logger.error('Contact insert batch failed:', err.message);
        results.contacts.failed += batch.length;
        results.errors.push({ phase: 'contact-insert', error: err.message });
      }
    }

    // Batch update existing Contacts
    for (let i = 0; i < contactsToUpdate.length; i += batchSize) {
      const batch = contactsToUpdate.slice(i, i + batchSize);
      try {
        const batchResults = await this.connection.sobject('Contact').update(batch);
        const resultsArray = Array.isArray(batchResults) ? batchResults : [batchResults];
        resultsArray.forEach((res, idx) => {
          if (res.success) {
            results.contacts.updated++;
          } else {
            results.contacts.failed++;
            const errorMsg = res.errors ? res.errors.map(e => e.message).join(', ') : 'Unknown error';
            results.errors.push({ phase: 'contact-update', email: batch[idx].Email, error: errorMsg });
            logger.warn(`Contact update failed for ${batch[idx].Email}: ${errorMsg}`);
          }
        });
      } catch (err) {
        logger.error('Contact update batch failed:', err.message);
        results.contacts.failed += batch.length;
        results.errors.push({ phase: 'contact-update', error: err.message });
      }
    }

    logger.info(`Phase 1 complete: ${results.contacts.created} created, ${results.contacts.updated} updated, ${results.contacts.failed} failed, ${results.contacts.skippedConflicts} skipped (email conflicts)`);

    // --- Phase 2: Upsert TVRS_Guest__c records ---
    logger.info(`Phase 2: Upserting TVRS_Guest__c records...`);

    // Collect Contact IDs that succeeded
    const successContactIds = [...emailToContactId.values()];

    // Query existing TVRS_Guest__c for these Contacts
    const existingGuestMap = new Map(); // "contactId|checkInDate" → guestRecordId
    for (let i = 0; i < successContactIds.length; i += batchSize) {
      const idBatch = successContactIds.slice(i, i + batchSize);
      const escaped = idBatch.map(id => `'${id}'`).join(',');
      const query = `SELECT Id, ${contactLookup}, Check_In_Date__c FROM ${guestObject} WHERE ${contactLookup} IN (${escaped})`;

      try {
        let result = await this.connection.query(query);
        let allRecords = result.records;
        while (!result.done) {
          result = await this.connection.queryMore(result.nextRecordsUrl);
          allRecords = allRecords.concat(result.records);
        }
        for (const rec of allRecords) {
          if (rec[contactLookup] && rec.Check_In_Date__c) {
            const key = `${rec[contactLookup]}|${rec.Check_In_Date__c}`;
            existingGuestMap.set(key, rec.Id);
          }
        }
      } catch (err) {
        logger.error('Error querying existing TVRS_Guest__c:', err.message);
        results.errors.push({ phase: 'guest-query', error: err.message });
      }
    }

    logger.info(`Found ${existingGuestMap.size} existing TVRS_Guest__c records for matched Contacts`);

    // Build TVRS_Guest__c records, split into creates vs updates
    // Iterate full guestDataList (not byEmail) so every original OPERA entry gets its own check-in record
    const guestsToCreate = [];
    const guestsToUpdate = [];
    const seenGuestKeys = new Set();

    for (const entry of guestDataList) {
      const email = (entry.customer.email || '').toLowerCase();
      if (!email) continue;

      const contactId = emailToContactId.get(email);
      if (!contactId) {
        // Contact failed to create — skip guest record
        continue;
      }

      const guestRecord = transformToTVRSGuest(entry.customer, entry.invoice, contactId);
      const checkInDate = guestRecord.Check_In_Date__c || null;
      const matchKey = checkInDate ? `${contactId}|${checkInDate}` : null;

      // Skip if we have already queued this Contact+CheckInDate combination
      if (matchKey && seenGuestKeys.has(matchKey)) continue;
      if (matchKey) seenGuestKeys.add(matchKey);

      const existingId = matchKey ? existingGuestMap.get(matchKey) : null;

      if (existingId) {
        guestRecord.Id = existingId;
        guestsToUpdate.push(guestRecord);
      } else {
        guestsToCreate.push(guestRecord);
      }
    }

    // Batch create new TVRS_Guest__c
    for (let i = 0; i < guestsToCreate.length; i += batchSize) {
      const batch = guestsToCreate.slice(i, i + batchSize);
      try {
        const batchResults = await this.connection.sobject(guestObject).create(batch);
        const resultsArray = Array.isArray(batchResults) ? batchResults : [batchResults];
        resultsArray.forEach((res, idx) => {
          if (res.success) {
            results.guests.created++;
            logger.debug(`TVRS_Guest__c created: ${res.id} for ${batch[idx].Email__c}`);
          } else {
            results.guests.failed++;
            const errorMsg = res.errors ? res.errors.map(e => e.message).join(', ') : 'Unknown error';
            results.errors.push({ phase: 'guest-create', email: batch[idx].Email__c, error: errorMsg });
            logger.warn(`TVRS_Guest__c create failed for ${batch[idx].Email__c}: ${errorMsg}`);
          }
        });
      } catch (err) {
        logger.error('TVRS_Guest__c create batch failed:', err.message);
        results.guests.failed += batch.length;
        results.errors.push({ phase: 'guest-create', error: err.message });
      }
    }

    // Batch update existing TVRS_Guest__c
    for (let i = 0; i < guestsToUpdate.length; i += batchSize) {
      const batch = guestsToUpdate.slice(i, i + batchSize);
      try {
        const batchResults = await this.connection.sobject(guestObject).update(batch);
        const resultsArray = Array.isArray(batchResults) ? batchResults : [batchResults];
        resultsArray.forEach((res, idx) => {
          if (res.success) {
            results.guests.updated++;
            logger.debug(`TVRS_Guest__c updated: ${res.id} for ${batch[idx].Email__c}`);
          } else {
            results.guests.failed++;
            const errorMsg = res.errors ? res.errors.map(e => e.message).join(', ') : 'Unknown error';
            results.errors.push({ phase: 'guest-update', email: batch[idx].Email__c, error: errorMsg });
            logger.warn(`TVRS_Guest__c update failed for ${batch[idx].Email__c}: ${errorMsg}`);
          }
        });
      } catch (err) {
        logger.error('TVRS_Guest__c update batch failed:', err.message);
        results.guests.failed += batch.length;
        results.errors.push({ phase: 'guest-update', error: err.message });
      }
    }

    const totalSuccess = results.contacts.created + results.contacts.updated + results.guests.created + results.guests.updated;
    const totalFailed = results.contacts.failed + results.guests.failed;
    logger.info(`Phase 2 complete: ${results.guests.created} created, ${results.guests.updated} updated, ${results.guests.failed} failed`);
    logger.info(`Sync complete: ${totalSuccess} total operations succeeded, ${totalFailed} failed`);

    // Return a flat summary for backwards compatibility with notifier/stats
    results.success = results.guests.created + results.guests.updated;
    results.failed = results.contacts.failed + results.guests.failed;

    return results;
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
