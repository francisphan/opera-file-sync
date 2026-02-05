const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const TRACKER_FILE = 'processed-files.json';

class FileTracker {
  constructor() {
    this.processedFiles = new Map();
    this.load();
  }

  /**
   * Load processed files from disk
   */
  load() {
    try {
      if (fs.existsSync(TRACKER_FILE)) {
        const data = JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8'));
        this.processedFiles = new Map(Object.entries(data));
        logger.info(`Loaded ${this.processedFiles.size} processed files from tracker`);
      } else {
        logger.info('No existing tracker file found, starting fresh');
      }
    } catch (err) {
      logger.error('Error loading file tracker:', err);
      this.processedFiles = new Map();
    }
  }

  /**
   * Save processed files to disk
   */
  save() {
    try {
      const data = Object.fromEntries(this.processedFiles);
      fs.writeFileSync(TRACKER_FILE, JSON.stringify(data, null, 2));
      logger.debug('Saved file tracker to disk');
    } catch (err) {
      logger.error('Error saving file tracker:', err);
    }
  }

  /**
   * Calculate file checksum
   */
  getChecksum(filePath) {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Check if file has been processed
   */
  isProcessed(filename) {
    return this.processedFiles.has(filename);
  }

  /**
   * Check if file content has changed (based on checksum)
   */
  hasChanged(filename, filePath) {
    if (!this.isProcessed(filename)) {
      return true;
    }

    const currentChecksum = this.getChecksum(filePath);
    const storedData = this.processedFiles.get(filename);

    return storedData.checksum !== currentChecksum;
  }

  /**
   * Mark file as processed
   */
  markProcessed(filename, filePath, recordCount) {
    const checksum = this.getChecksum(filePath);
    this.processedFiles.set(filename, {
      checksum,
      processedAt: new Date().toISOString(),
      recordCount,
      status: 'success'
    });
    this.save();
  }

  /**
   * Mark file as failed
   */
  markFailed(filename, filePath, error) {
    const checksum = this.getChecksum(filePath);
    this.processedFiles.set(filename, {
      checksum,
      processedAt: new Date().toISOString(),
      error: error.message,
      status: 'failed'
    });
    this.save();
  }

  /**
   * Get processing statistics
   */
  getStats() {
    const total = this.processedFiles.size;
    let success = 0;
    let failed = 0;

    for (const [, data] of this.processedFiles) {
      if (data.status === 'success') success++;
      if (data.status === 'failed') failed++;
    }

    return { total, success, failed };
  }
}

module.exports = FileTracker;
