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

      // Only send if there was activity (or errors)
      if (stats.uploaded > 0 || stats.skippedAgents > 0 || stats.skippedDuplicates > 0 || stats.errors > 0) {
        logger.info(`Activity detected: ${stats.uploaded} uploaded, ${stats.skippedAgents + stats.skippedDuplicates} skipped, ${stats.errors} errors`);

        // Prepare stats object for email
        const emailStats = {
          date: stats.date,
          recordsSynced: stats.uploaded,
          skippedAgents: stats.skippedAgents,
          skippedDuplicates: stats.skippedDuplicates,
          skippedInvalid: stats.skippedInvalid,
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
    skippedAgents: stats.skippedAgents,
    skippedDuplicates: stats.skippedDuplicates,
    skippedInvalid: stats.skippedInvalid,
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

module.exports = {
  setupDailySummary,
  triggerDailySummary
};
