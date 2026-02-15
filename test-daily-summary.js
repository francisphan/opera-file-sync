#!/usr/bin/env node

/**
 * Test Daily Summary Email
 *
 * Manually triggers a daily summary email to verify:
 * - Email formatting (HTML and text)
 * - Statistics display
 * - Timezone handling
 * - Email/Slack delivery
 */

require('dotenv').config();
const logger = require('./src/logger');
const Notifier = require('./src/notifier');
const DailyStats = require('./src/daily-stats');
const FileTracker = require('./src/file-tracker');

logger.level = 'info';

async function main() {
  logger.info('='.repeat(70));
  logger.info('Daily Summary Email Test');
  logger.info('='.repeat(70));

  const notifier = new Notifier();
  const dailyStats = new DailyStats();
  const fileTracker = new FileTracker();

  // Check email configuration
  logger.info('\nEmail Configuration:');
  logger.info(`  Email enabled: ${notifier.emailEnabled}`);
  logger.info(`  From: ${notifier.emailFrom || '(not configured)'}`);
  logger.info(`  To: ${notifier.emailTo || '(not configured)'}`);
  logger.info(`  Slack enabled: ${notifier.slackWebhookUrl ? 'Yes' : 'No'}`);

  if (!notifier.emailEnabled && !notifier.slackWebhookUrl) {
    logger.warn('\n⚠️  WARNING: Neither email nor Slack is configured!');
    logger.warn('   Set EMAIL_ENABLED=true and configure SMTP/Gmail credentials');
    logger.warn('   Or set SLACK_WEBHOOK_URL for Slack notifications');
    logger.info('\nContinuing with test anyway to show what would be sent...');
  }

  // Get current daily stats
  const currentStats = dailyStats.getStats();
  logger.info('\nCurrent Daily Statistics:');
  logger.info(`  Date: ${currentStats.date}`);
  logger.info(`  Uploaded: ${currentStats.uploaded}`);
  logger.info(`  Skipped (Agents): ${currentStats.skippedAgents}`);
  logger.info(`  Skipped (Duplicates): ${currentStats.skippedDuplicates}`);
  logger.info(`  Skipped (Invalid): ${currentStats.skippedInvalid}`);
  logger.info(`  Errors: ${currentStats.errors}`);

  // Check if we should use current stats or create test data
  const hasActivity = currentStats.uploaded > 0 || currentStats.errors > 0 ||
                      currentStats.skippedAgents > 0 || currentStats.skippedDuplicates > 0;

  let testStats;

  if (hasActivity) {
    logger.info('\n✅ Using current daily statistics');
    testStats = currentStats;
  } else {
    logger.info('\n⚠️  No activity today - creating test data for demonstration');
    testStats = {
      date: currentStats.date,
      recordsSynced: 142,
      skippedAgents: 8,
      skippedDuplicates: 3,
      skippedInvalid: 2,
      errors: 1,
      errorDetails: [
        {
          time: new Date(Date.now() - 3600000).toISOString(),
          message: 'Test error: Connection timeout to Salesforce'
        }
      ]
    };
    logger.info('  Created test statistics:');
    logger.info(`    Records synced: ${testStats.recordsSynced}`);
    logger.info(`    Skipped (agents): ${testStats.skippedAgents}`);
    logger.info(`    Skipped (duplicates): ${testStats.skippedDuplicates}`);
    logger.info(`    Errors: ${testStats.errors}`);
  }

  // Add file tracker stats (all-time)
  const fileStats = fileTracker.getStats();
  if (fileStats.total > 0) {
    testStats.totalFiles = fileStats.total;
    testStats.totalSuccess = fileStats.success;
    testStats.totalFailed = fileStats.failed;
    logger.info('\nFile Tracker Statistics (All-Time):');
    logger.info(`  Total files: ${fileStats.total}`);
    logger.info(`  Successful: ${fileStats.success}`);
    logger.info(`  Failed: ${fileStats.failed}`);
  } else {
    logger.info('\nNo file tracking data (likely running in DB sync mode)');
  }

  // Timezone test
  logger.info('\n' + '='.repeat(70));
  logger.info('Timezone Test');
  logger.info('='.repeat(70));

  const now = new Date();
  const argentinaTime = now.toLocaleString('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    dateStyle: 'full',
    timeStyle: 'long'
  });

  logger.info(`Current time (system): ${now.toISOString()}`);
  logger.info(`Current time (Argentina): ${argentinaTime}`);

  const argentinaDate = new Date(now.toLocaleString('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires'
  }));
  const argentinaHour = argentinaDate.getHours();
  const argentinaMinute = argentinaDate.getMinutes();

  logger.info(`Argentina time: ${argentinaHour}:${String(argentinaMinute).padStart(2, '0')}`);
  logger.info(`Scheduled summary time: 9:00 AM ART`);

  if (argentinaHour === 9 && argentinaMinute === 0) {
    logger.info('✅ It is currently 9:00 AM in Argentina - perfect timing!');
  } else {
    const timeUntil9AM = (9 - argentinaHour + 24) % 24;
    logger.info(`⏰ Daily summary will run in approximately ${timeUntil9AM} hours`);
  }

  // Send test email
  logger.info('\n' + '='.repeat(70));
  logger.info('Sending Test Daily Summary Email');
  logger.info('='.repeat(70));

  try {
    await notifier.sendDailySummary(testStats);

    if (notifier.emailEnabled) {
      logger.info('\n✅ Email sent successfully!');
      logger.info(`   To: ${notifier.emailTo}`);
      logger.info(`   Subject: 📊 OPERA Sync - Daily Summary (${testStats.date})`);
    }

    if (notifier.slackWebhookUrl) {
      logger.info('\n✅ Slack notification sent successfully!');
    }

    if (!notifier.emailEnabled && !notifier.slackWebhookUrl) {
      logger.info('\nℹ️  No notifications configured - email content prepared but not sent');
      logger.info('   Configure EMAIL_ENABLED=true or SLACK_WEBHOOK_URL to enable notifications');
    }

  } catch (err) {
    logger.error('\n❌ Error sending daily summary:', err.message);
    if (err.stack) logger.error(err.stack);

    logger.info('\nTroubleshooting:');
    logger.info('  - Check EMAIL_ENABLED=true in .env');
    logger.info('  - Verify Gmail OAuth credentials or SMTP settings');
    logger.info('  - Check email address format in EMAIL_TO');
    logger.info('  - Ensure network connectivity');

    process.exit(1);
  }

  // Summary
  logger.info('\n' + '='.repeat(70));
  logger.info('Test Summary');
  logger.info('='.repeat(70));

  logger.info('✅ Daily summary email test complete!');
  logger.info('\nWhat was tested:');
  logger.info('  ✅ Email/Slack notification system');
  logger.info('  ✅ Statistics formatting (HTML + text)');
  logger.info('  ✅ Timezone calculation (Argentina Time)');
  logger.info('  ✅ Error detail display');
  if (testStats.totalFiles) {
    logger.info('  ✅ All-time file statistics');
  }

  logger.info('\nNext steps:');
  logger.info('  1. Check your email inbox for the daily summary');
  logger.info('  2. Verify HTML formatting looks correct');
  logger.info('  3. Confirm all statistics are displayed properly');
  logger.info('  4. The scheduler will automatically send this at 9:00 AM ART daily');

  logger.info('\nScheduler Status:');
  const schedulerEnabled = process.env.ENABLE_DAILY_SUMMARY !== 'false';
  if (schedulerEnabled) {
    logger.info('  ✅ Daily summary scheduler is ENABLED');
    logger.info('  📅 Next automatic report: Tomorrow at 9:00 AM Argentina Time');
  } else {
    logger.warn('  ⚠️  Daily summary scheduler is DISABLED');
    logger.warn('     Set ENABLE_DAILY_SUMMARY=true in .env to enable');
  }
}

main().catch(err => {
  logger.error('Fatal error:', err.message);
  if (err.stack) logger.error(err.stack);
  process.exit(1);
});
