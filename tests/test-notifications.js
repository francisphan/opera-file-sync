#!/usr/bin/env node

/**
 * Test notification system
 *
 * Run this script to verify your email/Slack notifications are working.
 */

require('dotenv').config();
const Notifier = require('../src/notifier');
const logger = require('../src/logger');

async function testNotifications() {
  logger.info('='.repeat(70));
  logger.info('Testing Notification System');
  logger.info('='.repeat(70));

  const notifier = new Notifier();

  // Test Email
  if (process.env.EMAIL_ENABLED === 'true') {
    logger.info('\n📧 Testing Email...');

    const hasGmailOAuth = !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_REFRESH_TOKEN);
    const hasSMTP = !!(process.env.SMTP_HOST && process.env.SMTP_PASSWORD);

    if (!process.env.SMTP_USER || !process.env.EMAIL_TO) {
      logger.error('❌ Email is enabled but missing required configuration:');
      logger.error('   - SMTP_USER (your email address)');
      logger.error('   - EMAIL_TO (recipient email)');
      if (!hasGmailOAuth && !hasSMTP) {
        logger.error('   - Either Gmail OAuth (GMAIL_CLIENT_ID, GMAIL_REFRESH_TOKEN)');
        logger.error('   - Or SMTP credentials (SMTP_HOST, SMTP_PASSWORD)');
      }
    } else {
      logger.info('Email Configuration:');
      if (hasGmailOAuth) {
        logger.info(`  Method: Gmail API (OAuth2)`);
      } else if (hasSMTP) {
        logger.info(`  Method: SMTP`);
        logger.info(`  SMTP Host: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT}`);
      }
      logger.info(`  User: ${process.env.SMTP_USER}`);
      logger.info(`  From: ${process.env.EMAIL_FROM || process.env.SMTP_USER}`);
      logger.info(`  To: ${process.env.EMAIL_TO}`);

      const emailSuccess = await notifier.testEmail();

      if (emailSuccess) {
        logger.info('✅ Email test passed! Check your inbox.');
      } else {
        logger.error('❌ Email test failed. Check the error above.');
        logger.error('\nCommon issues:');
        logger.error('  - Gmail OAuth: Ensure OAuth credentials are valid and not expired');
        logger.error('  - SMTP: Check host, port, and credentials');
        logger.error('  - Network: Check firewall/proxy settings');
        logger.error('  - Permissions: Verify Gmail API scope includes gmail.send');
      }
    }
  } else {
    logger.info('\n📧 Email notifications are disabled (EMAIL_ENABLED=false or not set)');
  }

  // Test Slack
  if (process.env.SLACK_WEBHOOK_URL) {
    logger.info('\n💬 Testing Slack...');
    logger.info(`Webhook URL: ${process.env.SLACK_WEBHOOK_URL.substring(0, 50)}...`);

    const slackSuccess = await notifier.testSlack();

    if (slackSuccess) {
      logger.info('✅ Slack test passed! Check your Slack channel.');
    } else {
      logger.error('❌ Slack test failed. Check the error above.');
      logger.error('\nCommon issues:');
      logger.error('  - Invalid webhook URL');
      logger.error('  - Webhook disabled in Slack');
      logger.error('  - Network connectivity issues');
    }
  } else {
    logger.info('\n💬 Slack notifications are disabled (SLACK_WEBHOOK_URL not set)');
  }

  // Test Error Notification
  logger.info('\n🚨 Testing Error Notification...');
  logger.info('This will simulate a file processing error:');

  // Simulate multiple errors to trigger notification
  notifier.consecutiveErrors = 3; // Set to threshold
  await notifier.notifyFileError(
    'test-file.csv',
    new Error('This is a test error notification'),
    {
      recordCount: 100,
      stack: 'Test stack trace'
    }
  );

  logger.info('✅ Error notification sent (if email/Slack is configured)');

  // Summary
  logger.info('\n' + '='.repeat(70));
  logger.info('Notification Test Complete');
  logger.info('='.repeat(70));

  if (!process.env.EMAIL_ENABLED && !process.env.SLACK_WEBHOOK_URL) {
    logger.warn('\n⚠️  No notification methods are configured!');
    logger.warn('To enable notifications, update your .env file:');
    logger.warn('  - Set EMAIL_ENABLED=true and configure SMTP settings');
    logger.warn('  - Or set SLACK_WEBHOOK_URL');
  }

  logger.info('\nIf you received test notifications, your setup is working correctly!');
  logger.info('Error notifications will be sent when:');
  logger.info(`  - ${process.env.ERROR_THRESHOLD || 3} consecutive errors occur`);
  logger.info(`  - At most once every ${process.env.ERROR_NOTIFICATION_THROTTLE || 15} minutes`);

  process.exit(0);
}

testNotifications().catch(err => {
  logger.error('Test failed:', err);
  process.exit(1);
});
