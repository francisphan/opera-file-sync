const jsforce = require('jsforce');
const logger = require('./logger');
const { transformToContact, transformToTVRSGuest, GUEST_DIFF_SOQL_FIELDS, diffGuestRecord } = require('./guest-utils');

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
    if (process.env.ANDON_CORD === 'true') {
      logger.warn('Andon cord pulled — skipping Salesforce sync');
      return { andonPulled: true, success: 0, failed: 0, errors: [] };
    }

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
   * Two-phase sync: create Contacts (new only, never update existing), then upsert TVRS_Guest__c
   * @param {Array} guestDataList - Array of {customer, invoice} objects (raw, not yet transformed)
   * @returns {Object} Results with contacts/guests counters, needsReview array, and flat success/failed aliases
   */
  async syncGuestCheckIns(guestDataList) {
    if (process.env.ANDON_CORD === 'true') {
      logger.warn('Andon cord pulled — skipping Salesforce sync');
      return { andonPulled: true, contacts: { created: 0, failed: 0 }, guests: { created: 0, updated: 0, failed: 0 }, needsReview: [], errors: [], success: 0, failed: 0 };
    }

    await this.ensureConnected();

    if (!guestDataList || guestDataList.length === 0) {
      logger.warn('No guest data to sync');
      return { contacts: { created: 0, failed: 0 }, guests: { created: 0, updated: 0, failed: 0 }, needsReview: [], errors: [], success: 0, failed: 0 };
    }

    const batchSize = parseInt(process.env.BATCH_SIZE) || 200;
    const guestObject = process.env.SF_OBJECT || 'TVRS_Guest__c';
    const contactLookup = process.env.SF_GUEST_CONTACT_LOOKUP || 'Contact__c';
    const results = {
      contacts: { created: 0, failed: 0 },
      guests: { created: 0, updated: 0, failed: 0 },
      needsReview: [],
      errors: [] // kept for backwards compat (callers read errors[0]?.error)
    };

    function flagNeedsReview(entry, reason, details) {
      results.needsReview.push({
        email: (entry.customer.email || '').toLowerCase(),
        firstName: entry.customer.firstName || '',
        lastName: entry.customer.lastName || '',
        phone: entry.customer.phone || '',
        billingCity: entry.customer.billingCity || '',
        billingState: entry.customer.billingState || '',
        billingCountry: entry.customer.billingCountry || '',
        language: entry.customer.language || '',
        checkInDate: (entry.invoice && entry.invoice.checkIn) || null,
        checkOutDate: (entry.invoice && entry.invoice.checkOut) || null,
        reason,
        ...(details ? { details } : {})
      });
    }

    // --- Pre-flight: within-batch conflict detection ---
    // Group entries by email; identify groups with 2+ distinct names (shared-email groups)
    const emailGroups = new Map();
    for (const entry of guestDataList) {
      const email = (entry.customer.email || '').toLowerCase();
      if (!email) continue;
      if (!emailGroups.has(email)) emailGroups.set(email, []);
      emailGroups.get(email).push(entry);
    }

    const sharedEmailGroups = new Map(); // email → entries[] (only groups with 2+ distinct names)
    for (const [email, entries] of emailGroups) {
      if (entries.length < 2) continue;
      const names = new Set(
        entries.map(e =>
          `${(e.customer.firstName || '').toLowerCase()}|${(e.customer.lastName || '').toLowerCase()}`
        )
      );
      if (names.size > 1) {
        sharedEmailGroups.set(email, entries);
        logger.info(`Shared email detected: "${email}" has ${names.size} distinct names — will resolve after SF lookup`);
      }
    }

    // All entries with an email are eligible for Phase 1 lookup (including shared-email)
    const allWithEmail = guestDataList.filter(entry => {
      const email = (entry.customer.email || '').toLowerCase();
      return !!email;
    });

    // Unique emails for SF lookup
    const uniqueEmailsSet = new Set();
    for (const entry of allWithEmail) {
      uniqueEmailsSet.add((entry.customer.email || '').toLowerCase());
    }
    const uniqueEmails = [...uniqueEmailsSet];

    // emailStatus: email → { status: 'new'|'exists'|'ambiguous', contactId?, sfFirstName?, sfLastName? }
    const emailStatus = new Map();
    for (const email of uniqueEmails) {
      emailStatus.set(email, { status: 'new' });
    }

    // --- Phase 1: Batch email lookup in Salesforce ---
    logger.info(`Phase 1: Querying ${uniqueEmails.length} unique emails against Salesforce Contacts...`);

    for (let i = 0; i < uniqueEmails.length; i += batchSize) {
      const emailBatch = uniqueEmails.slice(i, i + batchSize);
      const escaped = emailBatch.map(e => `'${e.replace(/'/g, "\\'")}'`).join(',');
      const query = `SELECT Id, Email, FirstName, LastName FROM Contact WHERE Email IN (${escaped})`;

      // Re-throw on query failure — infra-level problem, don't continue silently
      const result = await this.connection.query(query);

      // Group by email to detect duplicates
      const sfByEmail = new Map();
      for (const rec of result.records) {
        const email = rec.Email.toLowerCase();
        if (!sfByEmail.has(email)) sfByEmail.set(email, []);
        sfByEmail.get(email).push({ id: rec.Id, firstName: rec.FirstName || '', lastName: rec.LastName || '' });
      }

      for (const [email, contacts] of sfByEmail) {
        if (contacts.length === 1) {
          emailStatus.set(email, {
            status: 'exists',
            contactId: contacts[0].id,
            sfFirstName: contacts[0].firstName,
            sfLastName: contacts[0].lastName
          });
        } else {
          emailStatus.set(email, { status: 'ambiguous' });
        }
      }
    }

    // --- Shared-email resolution (after Phase 1) ---
    const excludedEntries = new Set();

    for (const [email, entries] of sharedEmailGroups) {
      const status = emailStatus.get(email);
      if (!status) continue;

      if (status.status === 'exists') {
        // Try to match one Opera entry's name against the SF Contact name
        const sfFirst = (status.sfFirstName || '').toLowerCase();
        const sfLast = (status.sfLastName || '').toLowerCase();
        let matchedEntry = null;

        for (const entry of entries) {
          const opFirst = (entry.customer.firstName || '').toLowerCase();
          const opLast = (entry.customer.lastName || '').toLowerCase();
          if (opFirst === sfFirst && opLast === sfLast) {
            matchedEntry = entry;
            break;
          }
        }

        if (matchedEntry) {
          // Owner found — exclude non-matching entries
          logger.info(`Shared email "${email}": resolved to ${matchedEntry.customer.firstName} ${matchedEntry.customer.lastName} (matches SF Contact)`);
          for (const entry of entries) {
            if (entry !== matchedEntry) {
              excludedEntries.add(entry);
            }
          }
        } else {
          // No name match — flag all for review
          const nameList = entries.map(e => `${e.customer.firstName} ${e.customer.lastName}`).join(', ');
          logger.warn(`Shared email "${email}": no name matches SF Contact (${status.sfFirstName} ${status.sfLastName}) — all flagged for review`);
          for (const entry of entries) {
            flagNeedsReview(entry, 'shared-email-no-name-match',
              `SF Contact: ${status.sfFirstName} ${status.sfLastName}; Opera names: ${nameList}`);
          }
        }
      } else if (status.status === 'new') {
        // New email with shared names — flag all for review
        const nameList = entries.map(e => `${e.customer.firstName} ${e.customer.lastName}`).join(', ');
        logger.warn(`Shared email "${email}": new contact with ${entries.length} distinct names — all flagged for review`);
        for (const entry of entries) {
          flagNeedsReview(entry, 'shared-email-new-contact', `Opera names: ${nameList}`);
        }
      }
      // status === 'ambiguous' is handled below with the general ambiguous logic
    }

    // Build eligible entries: have email, not excluded by shared-email resolution
    const eligibleEntries = allWithEmail.filter(entry => !excludedEntries.has(entry));

    // Flag ambiguous emails for needsReview (one entry per eligible entry with that email)
    for (const entry of eligibleEntries) {
      const email = (entry.customer.email || '').toLowerCase();
      const status = emailStatus.get(email);
      if (status && status.status === 'ambiguous') {
        flagNeedsReview(entry, 'multiple-sf-contacts');
      }
    }

    const newCount = [...emailStatus.values()].filter(s => s.status === 'new').length;
    const existsCount = [...emailStatus.values()].filter(s => s.status === 'exists').length;
    const ambiguousCount = [...emailStatus.values()].filter(s => s.status === 'ambiguous').length;
    logger.info(`Phase 1 complete: ${newCount} new, ${existsCount} existing, ${ambiguousCount} ambiguous`);

    // --- Phase 2: Create new Contacts (status: 'new' only — never update existing) ---
    // Build lookup: email → first eligible entry (for new contact data)
    const emailToFirstEntry = new Map();
    for (const entry of eligibleEntries) {
      const email = (entry.customer.email || '').toLowerCase();
      if (!emailToFirstEntry.has(email)) emailToFirstEntry.set(email, entry);
    }

    const newEmails = [...emailStatus.entries()]
      .filter(([, s]) => s.status === 'new')
      .map(([email]) => email);

    logger.info(`Phase 2: Creating ${newEmails.length} new Contacts...`);

    for (let i = 0; i < newEmails.length; i += batchSize) {
      const emailSlice = newEmails.slice(i, i + batchSize);
      const records = emailSlice.map(email => transformToContact(emailToFirstEntry.get(email).customer));

      // Re-throw on batch-level failure
      const batchResults = await this.connection.sobject('Contact').create(records);
      const resultsArray = Array.isArray(batchResults) ? batchResults : [batchResults];

      resultsArray.forEach((res, idx) => {
        const email = emailSlice[idx];
        if (res.success) {
          results.contacts.created++;
          emailStatus.set(email, { status: 'exists', contactId: res.id });
          logger.debug(`Contact created: ${res.id} for ${email}`);
        } else {
          results.contacts.failed++;
          const errorMsg = res.errors ? res.errors.map(e => e.message).join(', ') : 'Unknown error';
          logger.error(`Contact create failed for ${email}: ${errorMsg}`);
          for (const entry of eligibleEntries) {
            if ((entry.customer.email || '').toLowerCase() === email) {
              flagNeedsReview(entry, 'contact-create-failed', errorMsg);
            }
          }
        }
      });
    }

    logger.info(`Phase 2 complete: ${results.contacts.created} created, ${results.contacts.failed} failed`);

    // --- Phase 3: Upsert TVRS_Guest__c ---
    logger.info(`Phase 3: Upserting ${guestObject} records...`);

    const successContactIds = [...emailStatus.values()]
      .filter(s => s.status === 'exists' && s.contactId)
      .map(s => s.contactId);

    // Query existing TVRS_Guest__c records for resolved contacts
    const existingGuestMap = new Map(); // "contactId|checkInDate" → guestRecordId
    for (let i = 0; i < successContactIds.length; i += batchSize) {
      const idBatch = successContactIds.slice(i, i + batchSize);
      const escaped = idBatch.map(id => `'${id}'`).join(',');
      const query = `SELECT Id, ${contactLookup}, Check_In_Date__c, ${GUEST_DIFF_SOQL_FIELDS} FROM ${guestObject} WHERE ${contactLookup} IN (${escaped})`;

      try {
        let result = await this.connection.query(query);
        let allRecords = result.records;
        while (!result.done) {
          result = await this.connection.queryMore(result.nextRecordsUrl);
          allRecords = allRecords.concat(result.records);
        }
        for (const rec of allRecords) {
          if (rec[contactLookup] && rec.Check_In_Date__c) {
            existingGuestMap.set(`${rec[contactLookup]}|${rec.Check_In_Date__c}`, rec);
          }
        }
      } catch (err) {
        logger.error(`Error querying existing ${guestObject}:`, err.message);
      }
    }

    logger.info(`Found ${existingGuestMap.size} existing ${guestObject} records for matched Contacts`);

    // Iterate full guestDataList — every Opera entry gets its own check-in record
    const guestsToCreate = [];
    const guestsToUpdate = [];
    const seenGuestKeys = new Set();

    for (const entry of guestDataList) {
      if (excludedEntries.has(entry)) continue;

      const email = (entry.customer.email || '').toLowerCase();
      if (!email) continue;

      const status = emailStatus.get(email);
      if (!status || status.status !== 'exists' || !status.contactId) continue;

      const guestRecord = transformToTVRSGuest(entry.customer, entry.invoice, status.contactId);
      const checkInDate = guestRecord.Check_In_Date__c || null;
      const matchKey = checkInDate ? `${status.contactId}|${checkInDate}` : null;

      if (matchKey && seenGuestKeys.has(matchKey)) continue;
      if (matchKey) seenGuestKeys.add(matchKey);

      const currentRecord = matchKey ? existingGuestMap.get(matchKey) : null;
      if (currentRecord) {
        const changes = diffGuestRecord(currentRecord, guestRecord);
        if (changes.length === 0) {
          logger.debug(`Skipping no-op update for ${guestRecord.Email__c} check-in ${checkInDate} — no field changes`);
        } else {
          guestRecord.Id = currentRecord.Id;
          guestsToUpdate.push({ record: guestRecord, entry });
        }
      } else {
        guestsToCreate.push({ record: guestRecord, entry });
      }
    }

    // Batch create new TVRS_Guest__c
    for (let i = 0; i < guestsToCreate.length; i += batchSize) {
      const batch = guestsToCreate.slice(i, i + batchSize);
      const records = batch.map(g => g.record);

      // Re-throw on batch-level failure
      const batchResults = await this.connection.sobject(guestObject).create(records);
      const resultsArray = Array.isArray(batchResults) ? batchResults : [batchResults];

      resultsArray.forEach((res, idx) => {
        const { record, entry } = batch[idx];
        if (res.success) {
          results.guests.created++;
          logger.debug(`${guestObject} created: ${res.id} for ${record.Email__c}`);
        } else {
          results.guests.failed++;
          const errorMsg = res.errors ? res.errors.map(e => e.message).join(', ') : 'Unknown error';
          logger.error(`${guestObject} create failed for ${record.Email__c}: ${errorMsg}`);
          flagNeedsReview(entry, 'guest-sync-failed', errorMsg);
        }
      });
    }

    // Batch update existing TVRS_Guest__c
    for (let i = 0; i < guestsToUpdate.length; i += batchSize) {
      const batch = guestsToUpdate.slice(i, i + batchSize);
      const records = batch.map(g => g.record);

      // Re-throw on batch-level failure
      const batchResults = await this.connection.sobject(guestObject).update(records);
      const resultsArray = Array.isArray(batchResults) ? batchResults : [batchResults];

      resultsArray.forEach((res, idx) => {
        const { record, entry } = batch[idx];
        if (res.success) {
          results.guests.updated++;
          logger.debug(`${guestObject} updated: ${res.id} for ${record.Email__c}`);
        } else {
          results.guests.failed++;
          const errorMsg = res.errors ? res.errors.map(e => e.message).join(', ') : 'Unknown error';
          logger.error(`${guestObject} update failed for ${record.Email__c}: ${errorMsg}`);
          flagNeedsReview(entry, 'guest-sync-failed', errorMsg);
        }
      });
    }

    logger.info(`Phase 3 complete: ${results.guests.created} created, ${results.guests.updated} updated, ${results.guests.failed} failed`);
    logger.info(`Sync complete. needsReview: ${results.needsReview.length} items`);

    // Flat aliases for backwards compat with callers (opera-file-sync.js, opera-db-sync.js)
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
