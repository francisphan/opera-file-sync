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
 * @param {FileTracker} fileTracker - Optional FileTracker for all-time file stats
 * @returns {Object} Scheduled job object
 */
function setupDailySummary(notifier, dailyStats, fileTracker = null) {
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

        // Add all-time file stats if available (file sync mode only)
        if (fileTracker) {
          const fileStats = fileTracker.getStats();
          emailStats.totalFiles = fileStats.total;
          emailStats.totalSuccess = fileStats.success;
          emailStats.totalFailed = fileStats.failed;
        }

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
 * @param {FileTracker} fileTracker - Optional FileTracker
 */
async function triggerDailySummary(notifier, dailyStats, fileTracker = null) {
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

  if (fileTracker) {
    const fileStats = fileTracker.getStats();
    emailStats.totalFiles = fileStats.total;
    emailStats.totalSuccess = fileStats.success;
    emailStats.totalFailed = fileStats.failed;
  }

  await notifier.sendDailySummary(emailStats);
  logger.info('Manual daily summary sent');
}

/**
 * Setup front desk report email scheduling
 * @param {Notifier} notifier - Notifier instance
 * @param {DailyStats} dailyStats - DailyStats instance
 * @returns {Object|null} Scheduled job object or null
 */
function setupFrontDeskReport(notifier, dailyStats) {
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
      const stats = dailyStats.getStats();
      if ((stats.frontDeskDetails || []).length > 0) {
        await notifier.sendFrontDeskReport(stats);
        logger.info('Front desk report sent');
      } else {
        logger.info('No front desk items to report');
      }
    } catch (err) {
      logger.error('Error sending front desk report:', err.message);
    }
  });

  logger.info(`Front desk report scheduled for ${reportTime} ${timezone} → ${frontDeskTo}`);
  return job;
}

module.exports = {
  setupDailySummary,
  setupFrontDeskReport,
  triggerDailySummary
};
