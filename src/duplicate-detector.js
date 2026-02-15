/**
 * Duplicate Detection Module
 *
 * Detects potential duplicate guests by comparing name, location, and check-in dates.
 * Uses lazy-loaded Salesforce cache with name-based indexing for O(1) lookups.
 * Probability scoring algorithm ported from compare-name-matches.js.
 */

const logger = require('./logger');

class DuplicateDetector {
  constructor(sfClient) {
    this.sfClient = sfClient;
    this.cache = null;
    this.cacheTTL = parseInt(process.env.DUPLICATE_CACHE_TTL) || 3600000; // 1 hour default
    this.lastRefresh = null;
    this.threshold = parseInt(process.env.DUPLICATE_THRESHOLD) || 75;
    this.enabled = process.env.ENABLE_DUPLICATE_DETECTION !== 'false';
  }

  /**
   * Ensure cache is loaded and fresh
   */
  async ensureCache() {
    if (!this.enabled) {
      return false;
    }

    if (!this.cache || !this.lastRefresh || Date.now() - this.lastRefresh > this.cacheTTL) {
      await this.refreshCache();
    }
    return true;
  }

  /**
   * Refresh Salesforce cache
   */
  async refreshCache() {
    logger.info('Refreshing Salesforce cache for duplicate detection...');

    try {
      await this.sfClient.ensureConnected();

      const query = `
        SELECT Email__c, Guest_First_Name__c, Guest_Last_Name__c,
               City__c, State_Province__c, Country__c,
               Check_In_Date__c, Check_Out_Date__c
        FROM TVRS_Guest__c
      `;

      let allRecords = [];
      let result = await this.sfClient.connection.query(query);
      allRecords = allRecords.concat(result.records);

      while (!result.done) {
        result = await this.sfClient.connection.queryMore(result.nextRecordsUrl);
        allRecords = allRecords.concat(result.records);
      }

      logger.info(`Loaded ${allRecords.length} Salesforce records into cache`);

      // Build indexes
      const nameIndex = new Map();
      const emailIndex = new Map();
      const nameFrequency = new Map();

      for (const rec of allRecords) {
        // Email index (lowercase)
        if (rec.Email__c) {
          emailIndex.set(rec.Email__c.toLowerCase(), {
            email: rec.Email__c.toLowerCase(),
            firstName: rec.Guest_First_Name__c || '',
            lastName: rec.Guest_Last_Name__c || '',
            city: rec.City__c || '',
            state: rec.State_Province__c || '',
            country: rec.Country__c || '',
            checkIn: rec.Check_In_Date__c || '',
            checkOut: rec.Check_Out_Date__c || ''
          });
        }

        // Name index
        const key = this.nameKey(rec.Guest_First_Name__c, rec.Guest_Last_Name__c);
        if (key) {
          if (!nameIndex.has(key)) {
            nameIndex.set(key, []);
          }
          nameIndex.get(key).push({
            email: rec.Email__c ? rec.Email__c.toLowerCase() : '',
            firstName: rec.Guest_First_Name__c || '',
            lastName: rec.Guest_Last_Name__c || '',
            city: rec.City__c || '',
            state: rec.State_Province__c || '',
            country: rec.Country__c || '',
            checkIn: rec.Check_In_Date__c || '',
            checkOut: rec.Check_Out_Date__c || ''
          });

          // Count name frequency
          nameFrequency.set(key, (nameFrequency.get(key) || 0) + 1);
        }
      }

      this.cache = {
        nameIndex,
        emailIndex,
        nameFrequency
      };
      this.lastRefresh = Date.now();

      logger.info(`Cache built: ${nameIndex.size} unique names, ${emailIndex.size} emails`);

    } catch (err) {
      logger.error('Error refreshing Salesforce cache:', err.message);
      // Don't throw - allow sync to continue without duplicate detection
      this.cache = { nameIndex: new Map(), emailIndex: new Map(), nameFrequency: new Map() };
    }
  }

  /**
   * Check if customer is a potential duplicate
   * @param {Object} customer - Customer data (email, firstName, lastName, billingCity, etc.)
   * @param {Object} invoice - Invoice data with checkIn/checkOut dates (optional)
   * @returns {Promise<Object>} {isDuplicate, probability, matches, reason}
   */
  async checkForDuplicates(customer, invoice = null) {
    if (!this.enabled) {
      return { isDuplicate: false, reason: 'disabled' };
    }

    const cacheReady = await this.ensureCache();
    if (!cacheReady || !this.cache) {
      return { isDuplicate: false, reason: 'cache-unavailable' };
    }

    // Check if email already exists (upsert case - not a duplicate, just an update)
    const existingByEmail = this.cache.emailIndex.get(customer.email.toLowerCase());
    if (existingByEmail) {
      return { isDuplicate: false, reason: 'upsert' };
    }

    // Check for name matches with different emails
    const nameKey = this.nameKey(customer.firstName, customer.lastName);
    if (!nameKey) {
      return { isDuplicate: false, reason: 'no-name' };
    }

    const sfNameMatches = this.cache.nameIndex.get(nameKey) || [];
    if (sfNameMatches.length === 0) {
      return { isDuplicate: false, reason: 'no-name-match' };
    }

    // Calculate probability for each SF record with same name
    const highProbMatches = [];
    const nameFreq = this.cache.nameFrequency.get(nameKey) || 1;

    for (const sfRec of sfNameMatches) {
      // Skip if same email (shouldn't happen, but be safe)
      if (sfRec.email === customer.email.toLowerCase()) {
        continue;
      }

      const customerData = {
        email: customer.email,
        billingCity: customer.billingCity || '',
        billingState: customer.billingState || '',
        billingCountry: customer.billingCountry || '',
        checkIn: invoice ? invoice.checkIn : '',
        checkOut: invoice ? invoice.checkOut : ''
      };

      const prob = this.calculateProbability(customerData, sfRec, nameFreq);

      if (prob >= this.threshold) {
        highProbMatches.push({
          record: sfRec,
          probability: prob
        });
      }
    }

    if (highProbMatches.length > 0) {
      const maxProb = Math.max(...highProbMatches.map(m => m.probability));
      return {
        isDuplicate: true,
        probability: maxProb,
        matches: highProbMatches,
        reason: 'high-probability-match'
      };
    }

    return { isDuplicate: false, reason: 'low-probability' };
  }

  /**
   * Calculate probability two records are the same guest (0-100%)
   * Algorithm ported from compare-name-matches.js
   */
  calculateProbability(dbData, sfData, nameFrequency) {
    let score = 0;
    let maxScore = 0;

    // Name uniqueness (rarer name = higher probability)
    maxScore += 30;
    const freq = nameFrequency || 1;
    if (freq === 1) score += 30;       // Unique name — strong signal
    else if (freq === 2) score += 22;
    else if (freq <= 5) score += 12;
    else if (freq <= 10) score += 5;
    // freq > 10: very common name, +0

    // Same city
    maxScore += 20;
    if (this.normalize(dbData.billingCity) && this.normalize(dbData.billingCity) === this.normalize(sfData.city)) {
      score += 20;
    }

    // Same country
    maxScore += 10;
    if (this.normalize(dbData.billingCountry) && this.normalize(dbData.billingCountry) === this.normalize(sfData.country)) {
      score += 10;
    }

    // Same state
    maxScore += 5;
    if (this.normalize(dbData.billingState) && this.normalize(dbData.billingState) === this.normalize(sfData.state)) {
      score += 5;
    }

    // Email domain match (same company/ISP)
    maxScore += 15;
    const dbDomain = this.emailDomain(dbData.email);
    const sfDomain = this.emailDomain(sfData.email);
    if (dbDomain && sfDomain && dbDomain === sfDomain) {
      score += 15;
    }

    // Check-in date proximity (within 3 days = likely same reservation)
    maxScore += 20;
    if (dbData.checkIn && sfData.checkIn) {
      const dbDate = new Date(dbData.checkIn);
      const sfDate = new Date(sfData.checkIn);
      const daysDiff = Math.abs((dbDate - sfDate) / (1000 * 60 * 60 * 24));
      if (daysDiff === 0) score += 20;
      else if (daysDiff <= 3) score += 15;
      else if (daysDiff <= 14) score += 8;
      else if (daysDiff <= 60) score += 3;
    }

    return Math.round((score / maxScore) * 100);
  }

  /**
   * Create normalized name key
   */
  nameKey(first, last) {
    const f = this.normalize(first).replace(/[^a-z0-9]/g, '');
    const l = this.normalize(last).replace(/[^a-z0-9]/g, '');
    if (!f || !l) return null;
    return `${f}|${l}`;
  }

  /**
   * Normalize string for comparison
   */
  normalize(val) {
    return (val || '').toString().trim().toLowerCase();
  }

  /**
   * Extract email domain
   */
  emailDomain(email) {
    const parts = (email || '').split('@');
    return parts.length === 2 ? parts[1].toLowerCase() : '';
  }

  /**
   * Get cache stats (for debugging)
   */
  getCacheStats() {
    if (!this.cache) {
      return { cached: false };
    }

    return {
      cached: true,
      nameCount: this.cache.nameIndex.size,
      emailCount: this.cache.emailIndex.size,
      lastRefresh: new Date(this.lastRefresh).toISOString(),
      ttl: this.cacheTTL,
      enabled: this.enabled,
      threshold: this.threshold
    };
  }
}

module.exports = DuplicateDetector;
