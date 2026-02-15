const fs = require('fs');
const logger = require('./logger');

const STATE_FILE = 'sync-state.json';

class SyncState {
  constructor() {
    this.state = {
      lastSyncTimestamp: null,
      lastSyncRecordCount: 0,
      lastSyncStatus: null
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        this.state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        logger.info(`Loaded sync state: last sync ${this.state.lastSyncTimestamp || 'never'}`);
      } else {
        logger.info('No existing sync state found, starting fresh');
      }
    } catch (err) {
      logger.error('Error loading sync state:', err);
    }
  }

  save() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
      logger.debug('Saved sync state to disk');
    } catch (err) {
      logger.error('Error saving sync state:', err);
    }
  }

  getLastSyncTimestamp() {
    return this.state.lastSyncTimestamp;
  }

  markSuccess(recordCount) {
    this.state.lastSyncTimestamp = new Date().toISOString();
    this.state.lastSyncRecordCount = recordCount;
    this.state.lastSyncStatus = 'success';
    this.save();
  }

  markFailed(error) {
    this.state.lastSyncTimestamp = new Date().toISOString();
    this.state.lastSyncStatus = 'failed';
    this.state.lastSyncError = error.message;
    this.save();
  }

  getStats() {
    return { ...this.state };
  }
}

module.exports = SyncState;
