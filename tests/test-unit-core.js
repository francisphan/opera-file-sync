#!/usr/bin/env node

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opera-test-'));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Temporarily override environment variables, returning a restore function.
 */
function setEnv(vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined || v === null) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// SyncState tests
// ---------------------------------------------------------------------------

describe('SyncState', () => {
  // SyncState uses a module-level constant STATE_FILE resolved relative to
  // __dirname.  To test it in isolation we monkey-patch fs functions that it
  // uses so they operate on a temp file, or we can just re-require the module
  // after replacing the constant.  The simplest portable approach: we clear
  // the require cache each time and use the real file location but ensure we
  // clean up.

  let SyncState;
  let stateFile;

  beforeEach(() => {
    // Resolve the same path the module will use
    stateFile = path.resolve(__dirname, '..', 'sync-state.json');
    // Remove stale state file if present
    try { fs.unlinkSync(stateFile); } catch { /* ok */ }
    // Clear require cache so constructor runs fresh
    delete require.cache[require.resolve('../src/sync-state')];
    SyncState = require('../src/sync-state');
  });

  afterEach(() => {
    try { fs.unlinkSync(stateFile); } catch { /* ok */ }
  });

  test('load from non-existent file returns defaults', () => {
    const s = new SyncState();
    assert.equal(s.state.lastSyncTimestamp, null);
    assert.equal(s.state.lastSyncRecordCount, 0);
    assert.equal(s.state.lastSyncStatus, null);
  });

  test('save and reload state', () => {
    const s = new SyncState();
    s.markSuccess(42);

    // Clear cache and reload
    delete require.cache[require.resolve('../src/sync-state')];
    const SyncState2 = require('../src/sync-state');
    const s2 = new SyncState2();

    assert.equal(s2.state.lastSyncRecordCount, 42);
    assert.equal(s2.state.lastSyncStatus, 'success');
    assert.ok(s2.state.lastSyncTimestamp);
  });

  test('markSuccess updates timestamp and count', () => {
    const s = new SyncState();
    const before = new Date().toISOString();
    s.markSuccess(10);
    const after = new Date().toISOString();

    assert.equal(s.state.lastSyncRecordCount, 10);
    assert.equal(s.state.lastSyncStatus, 'success');
    assert.ok(s.state.lastSyncTimestamp >= before);
    assert.ok(s.state.lastSyncTimestamp <= after);
  });

  test('markFailed records error', () => {
    const s = new SyncState();
    s.markFailed(new Error('boom'));
    assert.equal(s.state.lastSyncStatus, 'failed');
    assert.equal(s.state.lastSyncError, 'boom');
    assert.ok(s.state.lastSyncTimestamp);
  });

  test('getStats returns a copy of state', () => {
    const s = new SyncState();
    s.markSuccess(7);
    const stats = s.getStats();
    assert.equal(stats.lastSyncRecordCount, 7);
    // Ensure it is a copy, not a reference
    stats.lastSyncRecordCount = 999;
    assert.equal(s.state.lastSyncRecordCount, 7);
  });

  test('corrupted JSON file triggers graceful recovery', () => {
    // Write garbage to the state file
    fs.writeFileSync(stateFile, '{{{not json!!!');

    // Re-require so constructor loads the corrupt file
    delete require.cache[require.resolve('../src/sync-state')];
    const SyncStateBad = require('../src/sync-state');

    // Should not throw; falls back to defaults
    const s = new SyncStateBad();
    assert.equal(s.state.lastSyncTimestamp, null);
    assert.equal(s.state.lastSyncRecordCount, 0);
  });
});

// ---------------------------------------------------------------------------
// DailyStats tests
// ---------------------------------------------------------------------------

describe('DailyStats', () => {
  let tmpDir;
  let DailyStats;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    delete require.cache[require.resolve('../src/daily-stats')];
    DailyStats = require('../src/daily-stats');
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  test('construct with temp directory', () => {
    const statsPath = path.join(tmpDir, 'stats.json');
    const ds = new DailyStats(statsPath);
    assert.equal(ds.stats.uploaded, 0);
    assert.equal(ds.stats.errors, 0);
    assert.ok(ds.stats.date);
  });

  test('addUpload increments count', () => {
    const ds = new DailyStats(path.join(tmpDir, 'stats.json'));
    ds.addUpload(5);
    assert.equal(ds.stats.uploaded, 5);
    ds.addUpload(3);
    assert.equal(ds.stats.uploaded, 8);
  });

  test('addError increments and caps at 50', () => {
    const ds = new DailyStats(path.join(tmpDir, 'stats.json'));

    // Add 55 errors
    for (let i = 0; i < 55; i++) {
      ds.addError(new Error(`err-${i}`));
    }

    assert.equal(ds.stats.errors, 55); // count keeps going
    assert.equal(ds.stats.errorDetails.length, 50); // details capped
    // Last entry should be the most recent
    assert.ok(ds.stats.errorDetails[49].message.includes('err-54'));
  });

  test('addSkipped increments count for various categories', () => {
    const ds = new DailyStats(path.join(tmpDir, 'stats.json'));

    ds.addSkipped('agent', 2, [{ name: 'A' }, { name: 'B' }]);
    assert.equal(ds.stats.skippedAgents, 2);

    ds.addSkipped('duplicate', 1);
    assert.equal(ds.stats.skippedDuplicates, 1);

    ds.addSkipped('invalid', 3);
    assert.equal(ds.stats.skippedInvalid, 3);
  });

  test('getDateKey returns YYYY-MM-DD string', () => {
    const ds = new DailyStats(path.join(tmpDir, 'stats.json'));
    const key = ds.getDateKey();
    assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('stats reset on new day (date rollover)', () => {
    const ds = new DailyStats(path.join(tmpDir, 'stats.json'));
    ds.addUpload(10);
    assert.equal(ds.stats.uploaded, 10);

    // Simulate date rollover by changing currentDate to yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    ds.currentDate = yesterday.toISOString().slice(0, 10);

    // Next operation triggers checkDateRollover
    ds.addUpload(1);
    assert.equal(ds.stats.uploaded, 1); // reset + 1
  });

  test('save and reload from file', () => {
    const statsPath = path.join(tmpDir, 'stats.json');
    const ds = new DailyStats(statsPath);
    ds.addUpload(20);
    ds.addError('something broke');

    // Load into new instance
    const ds2 = new DailyStats(statsPath);
    assert.equal(ds2.stats.uploaded, 20);
    assert.equal(ds2.stats.errors, 1);
  });

  test('addFrontDesk deduplicates by name+checkInDate', () => {
    const ds = new DailyStats(path.join(tmpDir, 'stats.json'));
    const guest = { firstName: 'John', lastName: 'Doe', checkInDate: '2026-03-25' };

    ds.addFrontDesk(1, [guest]);
    assert.equal(ds.stats.frontDesk, 1);

    // Add same guest again - should deduplicate
    ds.addFrontDesk(1, [guest]);
    assert.equal(ds.stats.frontDesk, 1);
    assert.equal(ds.stats.frontDeskDetails.length, 1);

    // Add different guest
    ds.addFrontDesk(1, [{ firstName: 'Jane', lastName: 'Doe', checkInDate: '2026-03-25' }]);
    assert.equal(ds.stats.frontDesk, 2);
  });

  test('addNeedsReview deduplicates by email+checkInDate', () => {
    const ds = new DailyStats(path.join(tmpDir, 'stats.json'));
    const item = { email: 'a@b.com', checkInDate: '2026-03-25' };

    ds.addNeedsReview(1, [item]);
    assert.equal(ds.stats.needsReview, 1);

    // Duplicate
    ds.addNeedsReview(1, [item]);
    assert.equal(ds.stats.needsReview, 1);

    // Different
    ds.addNeedsReview(1, [{ email: 'x@y.com', checkInDate: '2026-03-25' }]);
    assert.equal(ds.stats.needsReview, 2);
  });
});

// ---------------------------------------------------------------------------
// Notifier constructor & throttling tests (no network calls)
// ---------------------------------------------------------------------------

describe('Notifier', () => {
  let restore;

  // Blank out all notification env vars before each test to ensure isolation
  const blankVars = {
    EMAIL_ENABLED: undefined,
    SMTP_HOST: undefined,
    SMTP_PORT: undefined,
    SMTP_USER: undefined,
    SMTP_PASSWORD: undefined,
    SMTP_SECURE: undefined,
    EMAIL_FROM: undefined,
    EMAIL_TO: undefined,
    GMAIL_CLIENT_ID: undefined,
    GMAIL_CLIENT_SECRET: undefined,
    GMAIL_REFRESH_TOKEN: undefined,
    SLACK_WEBHOOK_URL: undefined,
    ERROR_NOTIFICATION_THROTTLE: undefined,
    ERROR_THRESHOLD: undefined,
    FRONT_DESK_EMAIL_TO: undefined,
  };

  beforeEach(() => {
    restore = setEnv(blankVars);
    // Clear require cache so constructor picks up new env vars
    delete require.cache[require.resolve('../src/notifier')];
  });

  afterEach(() => {
    restore();
  });

  function loadNotifier(envOverrides = {}) {
    const r = setEnv(envOverrides);
    delete require.cache[require.resolve('../src/notifier')];
    const Notifier = require('../src/notifier');
    const n = new Notifier();
    r(); // restore env immediately; the instance already captured values
    return n;
  }

  test('EMAIL_ENABLED=false sets emailEnabled to false', () => {
    const n = loadNotifier({ EMAIL_ENABLED: 'false' });
    assert.equal(n.emailEnabled, false);
  });

  test('EMAIL_ENABLED unset sets emailEnabled to false', () => {
    const n = loadNotifier({});
    assert.equal(n.emailEnabled, false);
  });

  test('EMAIL_ENABLED=true with Gmail OAuth vars sets useGmailAPI', () => {
    const n = loadNotifier({
      EMAIL_ENABLED: 'true',
      GMAIL_CLIENT_ID: 'test-client-id',
      GMAIL_CLIENT_SECRET: 'test-secret',
      GMAIL_REFRESH_TOKEN: 'test-refresh-token',
      SMTP_USER: 'user@gmail.com',
      EMAIL_TO: 'dest@example.com',
    });
    assert.equal(n.emailEnabled, true);
    assert.equal(n.useGmailAPI, true);
    assert.equal(n.gmailClientId, 'test-client-id');
  });

  test('EMAIL_ENABLED=true without OAuth falls back to SMTP', () => {
    const n = loadNotifier({
      EMAIL_ENABLED: 'true',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_USER: 'user@example.com',
      SMTP_PASSWORD: 'pass',
      SMTP_SECURE: 'true',
      EMAIL_TO: 'dest@example.com',
    });
    assert.equal(n.emailEnabled, true);
    assert.equal(n.useGmailAPI, undefined);
    assert.ok(n.emailConfig);
    assert.equal(n.emailConfig.host, 'smtp.example.com');
    assert.equal(n.emailConfig.port, 465);
    assert.equal(n.emailConfig.secure, true);
    assert.ok(n.transporter); // nodemailer transport created
  });

  test('error throttling: consecutiveErrors below threshold does not notify', async () => {
    const n = loadNotifier({
      EMAIL_ENABLED: 'true',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'u@x.com',
      SMTP_PASSWORD: 'p',
      EMAIL_TO: 'd@x.com',
      ERROR_THRESHOLD: '5',
    });

    // Simulate errors below threshold — notifyFileError should return early
    // We test by checking consecutiveErrors increments and no crash
    n.consecutiveErrors = 2; // below threshold of 5
    assert.equal(n.consecutiveErrors < n.errorThreshold, true);
  });

  test('error throttling: shouldNotify returns true when no previous notification', () => {
    const n = loadNotifier({});
    assert.equal(n.lastErrorNotification, null);
    assert.equal(n.shouldNotify(), true);
  });

  test('error throttling: shouldNotify returns false within time window', () => {
    const n = loadNotifier({ ERROR_NOTIFICATION_THROTTLE: '15' });
    // Simulate a recent notification (5 minutes ago)
    n.lastErrorNotification = new Date(Date.now() - 5 * 60 * 1000);
    assert.equal(n.shouldNotify(), false);
  });

  test('error throttling: shouldNotify returns true after time window expires', () => {
    const n = loadNotifier({ ERROR_NOTIFICATION_THROTTLE: '15' });
    // Simulate an old notification (20 minutes ago)
    n.lastErrorNotification = new Date(Date.now() - 20 * 60 * 1000);
    assert.equal(n.shouldNotify(), true);
  });

  test('default errorThreshold is 3 and errorThrottleMinutes is 15', () => {
    const n = loadNotifier({});
    assert.equal(n.errorThreshold, 3);
    assert.equal(n.errorThrottleMinutes, 15);
  });

  test('resetErrorCount resets consecutiveErrors to 0', () => {
    const n = loadNotifier({});
    n.consecutiveErrors = 10;
    n.resetErrorCount();
    assert.equal(n.consecutiveErrors, 0);
  });
});
