/**
 * Daily Statistics Tracking Module
 *
 * Tracks sync statistics for daily summary reports.
 * Automatically resets at midnight Argentina Time (UTC-3).
 * Persists to daily-stats.json.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class DailyStats {
  constructor(statsFile = 'daily-stats.json') {
    this.statsFile = path.resolve(statsFile);
    this.currentDate = this.getDateKey();
    this.stats = {
      date: this.currentDate,
      uploaded: 0,
      skippedAgents: 0,
      skippedDuplicates: 0,
      skippedInvalid: 0,
      errors: 0,
      errorDetails: [],
      skippedAgentDetails: [],
      skippedInvalidDetails: [],
      skippedDuplicateDetails: []
    };
    this.load();
  }

  /**
   * Get current date in Argentina timezone (UTC-3)
   * @returns {string} Date in YYYY-MM-DD format
   */
  getDateKey() {
    // Argentina Time is UTC-3 (no DST)
    const argDate = new Date().toLocaleString('en-US', {
      timeZone: 'America/Argentina/Buenos_Aires'
    });
    return new Date(argDate).toISOString().slice(0, 10);
  }

  /**
   * Check if date has rolled over, reset stats if so
   */
  checkDateRollover() {
    const today = this.getDateKey();
    if (today !== this.currentDate) {
      logger.info(`Date rollover detected: ${this.currentDate} → ${today}`);
      logger.info('Resetting daily statistics for new day');
      this.reset();
    }
  }

  /**
   * Add uploaded records count
   * @param {number} count - Number of records successfully uploaded to Salesforce
   */
  addUpload(count) {
    this.checkDateRollover();
    this.stats.uploaded += count;
    this.save();
    logger.debug(`Daily stats: +${count} uploaded (total: ${this.stats.uploaded})`);
  }

  /**
   * Add skipped records count and details
   * @param {string} category - Skip category: 'agent', 'company', 'duplicate', 'invalid'
   * @param {number} count - Number of records skipped
   * @param {Array} [details] - Array of skipped record objects for human review
   */
  addSkipped(category, count, details = []) {
    this.checkDateRollover();

    if (category === 'agent' || category === 'company' || category === 'agent-domain' || category === 'booking-proxy' || category === 'expedia-proxy') {
      this.stats.skippedAgents += count;
      this.stats.skippedAgentDetails.push(...details);
    } else if (category === 'duplicate' || category === 'duplicate-detected') {
      this.stats.skippedDuplicates += count;
      this.stats.skippedDuplicateDetails.push(...details);
    } else if (category === 'invalid' || category === 'no-email') {
      this.stats.skippedInvalid += count;
      this.stats.skippedInvalidDetails.push(...details);
    }

    this.save();
    logger.debug(`Daily stats: +${count} skipped (${category}) - agents:${this.stats.skippedAgents}, duplicates:${this.stats.skippedDuplicates}, invalid:${this.stats.skippedInvalid}`);
  }

  /**
   * Add error to tracking
   * @param {Error|string} error - Error object or message
   */
  addError(error) {
    this.checkDateRollover();
    this.stats.errors++;

    const errorMessage = error.message || String(error);
    this.stats.errorDetails.push({
      time: new Date().toISOString(),
      message: errorMessage
    });

    // Keep only last 50 errors to prevent unbounded growth
    if (this.stats.errorDetails.length > 50) {
      this.stats.errorDetails = this.stats.errorDetails.slice(-50);
    }

    this.save();
    logger.debug(`Daily stats: error recorded (total: ${this.stats.errors})`);
  }

  /**
   * Get current statistics
   * @returns {Object} Current day's statistics
   */
  getStats() {
    this.checkDateRollover();
    return { ...this.stats };
  }

  /**
   * Reset statistics for new day
   */
  reset() {
    this.currentDate = this.getDateKey();
    this.stats = {
      date: this.currentDate,
      uploaded: 0,
      skippedAgents: 0,
      skippedDuplicates: 0,
      skippedInvalid: 0,
      errors: 0,
      errorDetails: [],
      skippedAgentDetails: [],
      skippedInvalidDetails: [],
      skippedDuplicateDetails: []
    };
    this.save();
    logger.info('Daily statistics reset');
  }

  /**
   * Load statistics from file
   */
  load() {
    try {
      if (fs.existsSync(this.statsFile)) {
        const data = fs.readFileSync(this.statsFile, 'utf8');
        const loaded = JSON.parse(data);

        // Check if loaded stats are from today
        if (loaded.date === this.currentDate) {
          this.stats = loaded;
          logger.debug('Daily stats loaded from file');
        } else {
          logger.info(`Loaded stats from ${loaded.date}, resetting for ${this.currentDate}`);
          this.reset();
        }
      } else {
        logger.debug('No existing stats file, starting fresh');
      }
    } catch (err) {
      logger.error('Error loading daily stats:', err.message);
      logger.warn('Starting with fresh statistics');
    }
  }

  /**
   * Save statistics to file
   */
  save() {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.statsFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.statsFile, JSON.stringify(this.stats, null, 2), 'utf8');
    } catch (err) {
      logger.error('Error saving daily stats:', err.message);
    }
  }
}

module.exports = DailyStats;
