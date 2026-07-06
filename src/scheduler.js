/**
 * Scheduler Module
 *
 * Schedules daily summary emails at 9:00 AM Argentina Time (UTC-3)
 * Uses node-schedule for cron-like scheduling.
 */

const schedule = require('node-schedule');
const logger = require('./logger');

/**
 * Setup daily summary email scheduling
 * @param {Notifier} notifier - Notifier instance for sending emails
 * @param {DailyStats} dailyStats - DailyStats instance for statistics
 * @returns {Object} Scheduled job object
 */
function setupDailySummary(notifier, dailyStats) {
  // Get configuration from environment
  const enabled = process.env.ENABLE_DAILY_SUMMARY !== 'false';
  const summaryTime = process.env.DAILY_SUMMARY_TIME || '9:00';
  const timezone = process.env.DAILY_SUMMARY_TIMEZONE || 'America/Argentina/Buenos_Aires';

  if (!enabled) {
    logger.info('Daily summary reports are disabled (ENABLE_DAILY_SUMMARY=false)');
    return null;
  }

  // Parse time (format: "HH:MM")
  const [hour, minute] = summaryTime.split(':').map(Number);

  if (isNaN(hour) || isNaN(minute)) {
    logger.error(`Invalid DAILY_SUMMARY_TIME format: ${summaryTime}. Expected "HH:MM" (e.g., "9:00")`);
    return null;
  }

  // Create recurrence rule
  const rule = new schedule.RecurrenceRule();
  rule.hour = hour;
  rule.minute = minute;
  rule.tz = timezone;

  // Schedule the job
  const job = schedule.scheduleJob(rule, async () => {
    logger.info('='.repeat(70));
    logger.info(`Running scheduled daily summary report (${summaryTime} ${timezone})`);
    logger.info('='.repeat(70));

    try {
      const stats = dailyStats.getStats();

      // Only send if there was activity (or errors/review items)
      if (stats.uploaded > 0 || stats.frontDesk > 0 || stats.skippedDuplicates > 0 || stats.needsReview > 0 || stats.errors > 0) {
        logger.info(`Activity detected: ${stats.uploaded} uploaded, ${stats.frontDesk || 0} front desk, ${stats.skippedDuplicates} skipped, ${stats.needsReview || 0} review, ${stats.errors} errors`);

        // Prepare stats object for email
        const emailStats = {
          date: stats.date,
          recordsSynced: stats.uploaded,
          frontDesk: stats.frontDesk || 0,
          frontDeskDetails: stats.frontDeskDetails || [],
          skippedDuplicates: stats.skippedDuplicates,
          skippedDuplicateDetails: stats.skippedDuplicateDetails || [],
          needsReview: stats.needsReview || 0,
          needsReviewDetails: stats.needsReviewDetails || [],
          errors: stats.errors,
          errorDetails: stats.errorDetails.slice(0, 10) // First 10 errors
        };

        // Send the daily summary email
        await notifier.sendDailySummary(emailStats);

        logger.info('Daily summary email sent successfully');
      } else {
        logger.info('No activity to report today, skipping daily summary');
      }

      // Reset stats for new day
      dailyStats.reset();
      logger.info('Daily statistics reset for new day');

    } catch (err) {
      logger.error('Error sending daily summary:', err.message);
      if (err.stack) logger.error(err.stack);
      // Don't reset stats if send failed - will retry tomorrow
    }

    logger.info('='.repeat(70));
  });

  logger.info(`Daily summary scheduled for ${summaryTime} ${timezone}`);
  logger.info(`Next run: ${job.nextInvocation().toString()}`);

  return job;
}

/**
 * Manually trigger daily summary (for testing)
 * @param {Notifier} notifier - Notifier instance
 * @param {DailyStats} dailyStats - DailyStats instance
 */
async function triggerDailySummary(notifier, dailyStats) {
  logger.info('Manually triggering daily summary...');

  const stats = dailyStats.getStats();

  const emailStats = {
    date: stats.date,
    recordsSynced: stats.uploaded,
    frontDesk: stats.frontDesk || 0,
    frontDeskDetails: stats.frontDeskDetails || [],
    skippedDuplicates: stats.skippedDuplicates,
    skippedDuplicateDetails: stats.skippedDuplicateDetails || [],
    needsReview: stats.needsReview || 0,
    needsReviewDetails: stats.needsReviewDetails || [],
    errors: stats.errors,
    errorDetails: stats.errorDetails.slice(0, 10)
  };

  await notifier.sendDailySummary(emailStats);
  logger.info('Manual daily summary sent');
}

/**
 * Setup front desk report email scheduling
 * @param {Notifier} notifier - Notifier instance
 * @param {DailyStats} dailyStats - DailyStats instance
 * @param {Function|null} queryFn - Async function(dateStr) returning report data from Oracle. If null, falls back to dailyStats.
 * @returns {Object|null} Scheduled job object or null
 */
function setupFrontDeskReport(notifier, dailyStats, queryFn) {
  const enabled = process.env.ENABLE_FRONT_DESK_REPORT !== 'false';
  const frontDeskTo = process.env.FRONT_DESK_EMAIL_TO;

  if (!enabled || !frontDeskTo) {
    if (!frontDeskTo) {
      logger.info('Front desk report not configured (FRONT_DESK_EMAIL_TO not set)');
    } else {
      logger.info('Front desk report disabled (ENABLE_FRONT_DESK_REPORT=false)');
    }
    return null;
  }

  const reportTime = process.env.FRONT_DESK_EMAIL_TIME || process.env.DAILY_SUMMARY_TIME || '7:00';
  const timezone = process.env.DAILY_SUMMARY_TIMEZONE || 'America/Argentina/Buenos_Aires';

  const [hour, minute] = reportTime.split(':').map(Number);
  if (isNaN(hour) || isNaN(minute)) {
    logger.error(`Invalid FRONT_DESK_EMAIL_TIME format: ${reportTime}. Expected "HH:MM"`);
    return null;
  }

  const rule = new schedule.RecurrenceRule();
  rule.hour = hour;
  rule.minute = minute;
  rule.tz = timezone;

  const job = schedule.scheduleJob(rule, async () => {
    logger.info(`Running scheduled front desk report (${reportTime} ${timezone})`);
    try {
      if (queryFn) {
        // Direct Oracle query for comprehensive report
        const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })).toISOString().slice(0, 10);
        const reportData = await queryFn(today);
        await notifier.sendDailyFrontDeskReport(reportData);
        // Second daily email off the same query: missing guest data + open
        // posting masters for the restricted control list. No-op unless
        // FRONT_DESK_CONTROL_EMAIL_TO is set; when it is set, the daily report
        // above drops those sections and stays a one-page operations view.
        await notifier.sendOperationalControlReport(reportData);
        logger.info('Daily front desk report sent (Oracle query)');
      } else {
        // Fallback: use accumulated dailyStats (old behavior)
        const stats = dailyStats.getStats();
        if ((stats.frontDeskDetails || []).length > 0) {
          await notifier.sendFrontDeskReport(stats);
          logger.info('Front desk report sent (dailyStats fallback)');
        } else {
          logger.info('No front desk items to report');
        }
      }
    } catch (err) {
      logger.error('Error sending front desk report:', err.message);
      if (err.stack) logger.error(err.stack);
    }
  });

  logger.info(`Front desk report scheduled for ${reportTime} ${timezone} → ${frontDeskTo}${queryFn ? ' (Oracle direct query)' : ' (dailyStats fallback)'}`);
  return job;
}

/**
 * Setup weekly villa-map refresh from the renumbering Google Sheet.
 * The map is cached locally; this just keeps the cache fresh in case the
 * sheet ever changes. Refresh is non-fatal (keeps the cached map on failure).
 * @param {Object} villaMap - the villa-map module (exposes refresh())
 * @returns {Object|null} Scheduled job object or null
 */
function setupVillaMapRefresh(villaMap) {
  if (process.env.VILLA_MAP_REFRESH_ENABLED === 'false') {
    logger.info('Villa map weekly refresh disabled (VILLA_MAP_REFRESH_ENABLED=false)');
    return null;
  }

  const timezone = process.env.DAILY_SUMMARY_TIMEZONE || 'America/Argentina/Buenos_Aires';
  const dayOfWeek = parseInt(process.env.VILLA_MAP_REFRESH_DOW ?? '0', 10); // 0 = Sunday
  const [hour, minute] = (process.env.VILLA_MAP_REFRESH_TIME || '3:00').split(':').map(Number);

  const rule = new schedule.RecurrenceRule();
  rule.dayOfWeek = dayOfWeek;
  rule.hour = hour;
  rule.minute = minute;
  rule.tz = timezone;

  const job = schedule.scheduleJob(rule, async () => {
    logger.info('Running weekly villa-map refresh from sheet');
    await villaMap.refresh();
  });

  logger.info(`Villa map refresh scheduled weekly (day ${dayOfWeek}, ${hour}:${String(minute).padStart(2, '0')} ${timezone})`);
  return job;
}

// Today's date (YYYY-MM-DD) in the report timezone.
function argTodayStr(timezone) {
  return new Date(new Date().toLocaleString('en-US', { timeZone: timezone })).toISOString().slice(0, 10);
}

// Shift a YYYY-MM-DD string by `days` (may be negative), returning YYYY-MM-DD.
function shiftDateStr(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// True on "even" ISO weeks relative to a fixed Monday epoch (2024-01-01), so the
// every-other-week cadence stays stable across process restarts.
function isReportWeek() {
  const epoch = Date.UTC(2024, 0, 1); // a Monday
  const weeks = Math.floor((Date.now() - epoch) / (7 * 24 * 60 * 60 * 1000));
  return weeks % 2 === 0;
}

/**
 * Setup the bi-weekly villa-nights report. Fires weekly on the configured day,
 * but only sends every other week (see isReportWeek) so the effective cadence is
 * 14 days. Each run covers the prior 14 nights.
 * @param {Notifier} notifier
 * @param {Function} queryFn - async (startDate, endDate) => reportData
 * @returns {Object|null} Scheduled job or null
 */
function setupVillaNightsReport(notifier, queryFn) {
  const enabled = process.env.ENABLE_VILLA_REPORT !== 'false';
  const to = process.env.VILLA_REPORT_EMAIL_TO;

  if (!enabled || !to) {
    logger.info(to
      ? 'Villa nights report disabled (ENABLE_VILLA_REPORT=false)'
      : 'Villa nights report not configured (VILLA_REPORT_EMAIL_TO not set)');
    return null;
  }

  const timezone = process.env.DAILY_SUMMARY_TIMEZONE || 'America/Argentina/Buenos_Aires';
  const dayOfWeek = parseInt(process.env.VILLA_REPORT_DOW ?? '1', 10); // 1 = Monday
  const [hour, minute] = (process.env.VILLA_REPORT_TIME || '8:00').split(':').map(Number);
  if (isNaN(hour) || isNaN(minute)) {
    logger.error(`Invalid VILLA_REPORT_TIME format: ${process.env.VILLA_REPORT_TIME}. Expected "HH:MM"`);
    return null;
  }

  const rule = new schedule.RecurrenceRule();
  rule.dayOfWeek = dayOfWeek;
  rule.hour = hour;
  rule.minute = minute;
  rule.tz = timezone;

  const job = schedule.scheduleJob(rule, async () => {
    if (!isReportWeek()) {
      logger.info('Villa nights report: off-week, skipping (bi-weekly cadence)');
      return;
    }
    logger.info('Running scheduled villa nights report');
    try {
      const endDate = argTodayStr(timezone);          // exclusive — excludes the in-progress night
      const startDate = shiftDateStr(endDate, -14);   // prior 14 nights
      const reportData = await queryFn(startDate, endDate);
      await notifier.sendVillaNightsReport(reportData);
    } catch (err) {
      logger.error('Error sending villa nights report:', err.message);
      if (err.stack) logger.error(err.stack);
    }
  });

  logger.info(`Villa nights report scheduled bi-weekly (day ${dayOfWeek}, ${hour}:${String(minute).padStart(2, '0')} ${timezone}) → ${to}`);
  return job;
}

/**
 * Manually run the villa-nights report (for the standalone script / testing).
 * @param {Notifier} notifier
 * @param {Function} queryFn - async (startDate, endDate) => reportData
 * @param {Object} [opts] - { to, startDate, endDate, days, timezone }
 */
async function triggerVillaNightsReport(notifier, queryFn, opts = {}) {
  const timezone = opts.timezone || process.env.DAILY_SUMMARY_TIMEZONE || 'America/Argentina/Buenos_Aires';
  const endDate = opts.endDate || argTodayStr(timezone);
  const startDate = opts.startDate || shiftDateStr(endDate, -(opts.days || 14));
  logger.info(`Manually running villa nights report ${startDate}..${endDate}`);
  const reportData = await queryFn(startDate, endDate);
  return notifier.sendVillaNightsReport(reportData, opts.to, opts.cc);
}

module.exports = {
  setupDailySummary,
  setupFrontDeskReport,
  setupVillaMapRefresh,
  setupVillaNightsReport,
  triggerDailySummary,
  triggerVillaNightsReport
};
