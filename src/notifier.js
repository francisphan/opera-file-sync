const nodemailer = require('nodemailer');
const axios = require('axios');
const logger = require('./logger');

class Notifier {
  constructor() {
    this.emailEnabled = !!process.env.EMAIL_ENABLED && process.env.EMAIL_ENABLED !== 'false';
    this.slackEnabled = !!process.env.SLACK_WEBHOOK_URL;

    // Email configuration
    if (this.emailEnabled) {
      // Check if using Gmail OAuth or standard SMTP
      const useGmailOAuth = !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_REFRESH_TOKEN);

      if (useGmailOAuth) {
        // Gmail OAuth2 configuration
        logger.info('Gmail OAuth credentials detected - configuring Gmail OAuth2');
        logger.debug(`Client ID: ${process.env.GMAIL_CLIENT_ID?.substring(0, 20)}...`);
        logger.debug(`Refresh Token: ${process.env.GMAIL_REFRESH_TOKEN?.substring(0, 20)}...`);

        this.useGmailAPI = true;
        this.gmailUser = process.env.SMTP_USER;
        this.gmailClientId = process.env.GMAIL_CLIENT_ID;
        this.gmailClientSecret = process.env.GMAIL_CLIENT_SECRET;
        this.gmailRefreshToken = process.env.GMAIL_REFRESH_TOKEN;

        logger.info('Using Gmail OAuth2 via nodemailer');
      } else {
        // Standard SMTP configuration
        this.emailConfig = {
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT) || 587,
          secure: process.env.SMTP_SECURE === 'true',
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD
          }
        };
        logger.info('Using SMTP for email');
        this.transporter = nodemailer.createTransport(this.emailConfig);
      }

      this.emailFrom = process.env.EMAIL_FROM || process.env.SMTP_USER;
      this.emailTo = process.env.EMAIL_TO;
    }

    // Slack configuration
    this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    // Notification throttling (prevent spam)
    this.lastErrorNotification = null;
    this.errorThrottleMinutes = parseInt(process.env.ERROR_NOTIFICATION_THROTTLE) || 15;
    this.consecutiveErrors = 0;
    this.errorThreshold = parseInt(process.env.ERROR_THRESHOLD) || 3;

    if (this.emailEnabled) {
      logger.info('Email notifications enabled');
    }
    if (this.slackEnabled) {
      logger.info('Slack notifications enabled');
    }
  }

  /**
   * Test email configuration
   */
  async testEmail() {
    if (!this.emailEnabled) {
      logger.warn('Email is not enabled');
      return false;
    }

    try {
      // Verify transport (skip for Gmail OAuth - verified on first send)
      if (!this.useGmailAPI && this.transporter) {
        await this.transporter.verify();
        logger.info('SMTP transport verified');
      }

      // Send test email
      const sent = await this.sendEmail(
        'OPERA Sync - Test Email',
        'This is a test email from the OPERA to Salesforce sync script.\n\nIf you received this, email notifications are working correctly!',
        '<h2>OPERA Sync - Test Email</h2><p>This is a test email from the OPERA to Salesforce sync script.</p><p><strong>If you received this, email notifications are working correctly!</strong></p>'
      );

      if (sent) {
        logger.info('Test email sent successfully');
      } else {
        logger.warn('Test email failed to send');
      }
      return sent;
    } catch (err) {
      logger.error('Email test failed:', err);
      return false;
    }
  }

  /**
   * Test Slack configuration
   */
  async testSlack() {
    if (!this.slackEnabled) {
      logger.warn('Slack is not enabled');
      return false;
    }

    try {
      await this.sendSlackMessage(
        '🧪 *OPERA Sync - Test Message*\n\nThis is a test message from the OPERA to Salesforce sync script.\n\nIf you received this, Slack notifications are working correctly!'
      );

      logger.info('Test Slack message sent successfully');
      return true;
    } catch (err) {
      logger.error('Slack test failed:', err);
      return false;
    }
  }

  /**
   * Send email notification
   */
  async sendEmail(subject, textBody, htmlBody) {
    if (!this.emailEnabled) {
      return;
    }

    try {
      if (this.useGmailAPI) {
        return await this._sendViaGmailREST(subject, textBody, htmlBody);
      }

      const info = await this.transporter.sendMail({
        from: this.emailFrom,
        to: this.emailTo,
        subject: subject,
        text: textBody,
        html: htmlBody
      });

      logger.debug(`Email sent: ${info.messageId}`);
      return true;
    } catch (err) {
      logger.error('Failed to send email:', err);
      return false;
    }
  }

  /**
   * Send email via Gmail REST API (bypasses SMTP entirely, works in pkg bundles)
   */
  async _sendViaGmailREST(subject, textBody, htmlBody) {
    // Get access token
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: this.gmailClientId,
      client_secret: this.gmailClientSecret,
      refresh_token: this.gmailRefreshToken,
      grant_type: 'refresh_token'
    });
    const accessToken = tokenRes.data.access_token;
    logger.debug('Gmail access token obtained');

    // Build MIME message
    const message = [
      `From: ${this.emailFrom}`,
      `To: ${this.emailTo}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      htmlBody || textBody
    ].join('\r\n');

    // Base64url encode
    const encoded = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Send via Gmail API
    const res = await axios.post(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      { raw: encoded },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    logger.debug(`Email sent via Gmail API: ${res.data.id}`);
    return true;
  }

  /**
   * Send Slack message
   */
  async sendSlackMessage(text, fields = null) {
    if (!this.slackEnabled) {
      return;
    }

    try {
      const payload = {
        text: text
      };

      if (fields) {
        payload.attachments = [{
          color: 'danger',
          fields: fields
        }];
      }

      await axios.post(this.slackWebhookUrl, payload);
      logger.debug('Slack message sent');
      return true;
    } catch (err) {
      logger.error('Failed to send Slack message:', err);
      return false;
    }
  }

  /**
   * Check if we should send notification (throttling)
   */
  shouldNotify() {
    if (!this.lastErrorNotification) {
      return true;
    }

    const now = new Date();
    const minutesSinceLastNotification = (now - this.lastErrorNotification) / 1000 / 60;

    return minutesSinceLastNotification >= this.errorThrottleMinutes;
  }

  /**
   * Notify about successful file processing
   */
  async notifyFileProcessed(filename, recordCount, filteredCount) {
    const subject = `OPERA Sync - ${filename} processed (${recordCount} records)`;
    const filteredNote = filteredCount > 0 ? `\n${filteredCount} agent/company emails were filtered out.` : '';

    const textBody = `
OPERA Sync - File Processed Successfully
=========================================

File: ${filename}
Records Synced: ${recordCount}
Time: ${new Date().toISOString()}
${filteredNote}
    `.trim();

    const htmlBody = `
      <h2>OPERA Sync - File Processed</h2>
      <table style="border-collapse: collapse; margin: 20px 0;">
        <tr style="background: #d4edda;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Status</td>
          <td style="padding: 8px; border: 1px solid #ddd; color: green;">Success</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">File</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${filename}</td>
        </tr>
        <tr style="background: #f5f5f5;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Records Synced</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${recordCount}</td>
        </tr>
        ${filteredCount > 0 ? `<tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Filtered Out</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${filteredCount} agent/company emails</td>
        </tr>` : ''}
        <tr style="background: #f5f5f5;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Time</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${new Date().toISOString()}</td>
        </tr>
      </table>
    `;

    if (this.emailEnabled) {
      await this.sendEmail(subject, textBody, htmlBody);
    }

    if (this.slackEnabled) {
      let text = `:white_check_mark: *OPERA Sync* — \`${filename}\` processed successfully\n*${recordCount}* records synced to Salesforce`;
      if (filteredCount > 0) {
        text += `\n*${filteredCount}* agent/company emails filtered out`;
      }
      await this.sendSlackMessage(text);
    }
  }

  /**
   * Notify about filtered agent/non-guest emails
   */
  async notifyFilteredAgents(filename, filteredRecords) {
    if (filteredRecords.length === 0) {
      return;
    }

    const count = filteredRecords.length;
    const subject = `OPERA Sync - Filtered Agent Emails (${count})`;

    const tableRows = filteredRecords.map(r => {
      return `<tr>
        <td style="padding: 6px; border: 1px solid #ddd;">${r.email}</td>
        <td style="padding: 6px; border: 1px solid #ddd;">${r.firstName}</td>
        <td style="padding: 6px; border: 1px solid #ddd;">${r.lastName}</td>
        <td style="padding: 6px; border: 1px solid #ddd;">${r.operaId}</td>
        <td style="padding: 6px; border: 1px solid #ddd;">${r.category}</td>
      </tr>`;
    }).join('\n');

    const textLines = filteredRecords.map(r =>
      `  ${r.email} | ${r.firstName} ${r.lastName} | ${r.operaId} | ${r.category}`
    ).join('\n');

    const textBody = `
OPERA Sync - Filtered Agent Emails
===================================

File: ${filename}
Filtered: ${count} records
Time: ${new Date().toISOString()}

These records were excluded from the Salesforce sync because they
appear to be travel agents, OTA proxies, or company entries.

${textLines}

If any of these are real guests, they can be manually added to Salesforce.
    `.trim();

    const htmlBody = `
      <h2>OPERA Sync - Filtered Agent Emails</h2>
      <p><strong>File:</strong> ${filename}<br>
      <strong>Filtered:</strong> ${count} records<br>
      <strong>Time:</strong> ${new Date().toISOString()}</p>

      <p>These records were excluded from the Salesforce sync because they
      appear to be travel agents, OTA proxies, or company entries.
      If any are real guests, they can be manually added.</p>

      <table style="border-collapse: collapse; margin: 20px 0; font-size: 13px;">
        <tr style="background: #f5f5f5;">
          <th style="padding: 6px; border: 1px solid #ddd; text-align: left;">Email</th>
          <th style="padding: 6px; border: 1px solid #ddd; text-align: left;">First Name</th>
          <th style="padding: 6px; border: 1px solid #ddd; text-align: left;">Last Name</th>
          <th style="padding: 6px; border: 1px solid #ddd; text-align: left;">Opera ID</th>
          <th style="padding: 6px; border: 1px solid #ddd; text-align: left;">Category</th>
        </tr>
        ${tableRows}
      </table>
    `;

    if (this.emailEnabled) {
      await this.sendEmail(subject, textBody, htmlBody);
    }

    if (this.slackEnabled) {
      const slackLines = filteredRecords.slice(0, 10).map(r =>
        `  ${r.email} — ${r.firstName} ${r.lastName} (${r.category})`
      ).join('\n');
      const more = count > 10 ? `\n  _...and ${count - 10} more_` : '';
      await this.sendSlackMessage(`:mag: *OPERA Sync - Filtered ${count} Agent Emails*\nFile: \`${filename}\`\n\`\`\`${slackLines}${more}\`\`\`\n_Check email for full list_`);
    }

    logger.info(`Filtered agents notification sent for ${count} records`);
  }

  /**
   * Notify about file processing error
   */
  async notifyFileError(filename, error, details = {}) {
    this.consecutiveErrors++;

    // Only notify after threshold is reached
    if (this.consecutiveErrors < this.errorThreshold) {
      logger.debug(`Error count: ${this.consecutiveErrors}/${this.errorThreshold}, not notifying yet`);
      return;
    }

    // Throttle notifications
    if (!this.shouldNotify()) {
      logger.debug('Notification throttled, skipping');
      return;
    }

    this.lastErrorNotification = new Date();

    const subject = `🚨 OPERA Sync Error - File Processing Failed`;
    const textBody = `
OPERA to Salesforce Sync Error
==============================

File: ${filename}
Error: ${error.message}
Time: ${new Date().toISOString()}
Consecutive Errors: ${this.consecutiveErrors}

${details.recordCount ? `Records in file: ${details.recordCount}` : ''}
${details.stack ? `\nStack trace:\n${details.stack}` : ''}

Action Required:
- Check the logs at logs/opera-sync.log
- Review the failed file in the Failed directory
- Verify Salesforce credentials and connectivity
- Check OPERA export format

This notification was sent because ${this.consecutiveErrors} consecutive errors were detected.
    `.trim();

    const htmlBody = `
      <h2>🚨 OPERA Sync Error</h2>
      <p><strong>File Processing Failed</strong></p>

      <table style="border-collapse: collapse; margin: 20px 0;">
        <tr style="background: #f5f5f5;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">File</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${filename}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Error</td>
          <td style="padding: 8px; border: 1px solid #ddd; color: red;">${error.message}</td>
        </tr>
        <tr style="background: #f5f5f5;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Time</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${new Date().toISOString()}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Consecutive Errors</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${this.consecutiveErrors}</td>
        </tr>
      </table>

      <h3>Action Required:</h3>
      <ul>
        <li>Check the logs at <code>logs/opera-sync.log</code></li>
        <li>Review the failed file in the Failed directory</li>
        <li>Verify Salesforce credentials and connectivity</li>
        <li>Check OPERA export format</li>
      </ul>

      <p style="color: #666; font-size: 12px;">
        This notification was sent because ${this.consecutiveErrors} consecutive errors were detected.
      </p>
    `;

    // Send email
    if (this.emailEnabled) {
      await this.sendEmail(subject, textBody, htmlBody);
    }

    // Send Slack notification
    if (this.slackEnabled) {
      const slackMessage = `🚨 *OPERA Sync Error*\n\n*File:* ${filename}\n*Error:* ${error.message}\n*Consecutive Errors:* ${this.consecutiveErrors}\n\nCheck logs and failed files directory.`;

      const fields = [
        { title: 'File', value: filename, short: true },
        { title: 'Time', value: new Date().toISOString(), short: true },
        { title: 'Error', value: error.message, short: false },
        { title: 'Consecutive Errors', value: this.consecutiveErrors.toString(), short: true }
      ];

      await this.sendSlackMessage(slackMessage, fields);
    }

    logger.info('Error notification sent');
  }

  /**
   * Notify about Salesforce connection error
   */
  async notifySalesforceError(error) {
    if (!this.shouldNotify()) {
      return;
    }

    this.lastErrorNotification = new Date();

    const subject = `🚨 OPERA Sync - Salesforce Connection Error`;
    const textBody = `
OPERA to Salesforce Sync - Connection Error
===========================================

Error: ${error.message}
Time: ${new Date().toISOString()}

The sync script cannot connect to Salesforce.

Possible causes:
- Invalid or expired refresh token
- Network connectivity issues
- Salesforce instance down
- Incorrect credentials in .env file

Action Required:
- Verify network connectivity
- Check Salesforce credentials in .env
- Test connection with: node test-connection.js
- Review logs at logs/opera-sync.log
    `.trim();

    const htmlBody = `
      <h2>🚨 OPERA Sync Error</h2>
      <p><strong>Salesforce Connection Failed</strong></p>

      <table style="border-collapse: collapse; margin: 20px 0;">
        <tr style="background: #f5f5f5;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Error</td>
          <td style="padding: 8px; border: 1px solid #ddd; color: red;">${error.message}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Time</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${new Date().toISOString()}</td>
        </tr>
      </table>

      <h3>Possible Causes:</h3>
      <ul>
        <li>Invalid or expired refresh token</li>
        <li>Network connectivity issues</li>
        <li>Salesforce instance down</li>
        <li>Incorrect credentials in .env file</li>
      </ul>

      <h3>Action Required:</h3>
      <ul>
        <li>Verify network connectivity</li>
        <li>Check Salesforce credentials in .env</li>
        <li>Test connection with: <code>node test-connection.js</code></li>
        <li>Review logs at <code>logs/opera-sync.log</code></li>
      </ul>
    `;

    if (this.emailEnabled) {
      await this.sendEmail(subject, textBody, htmlBody);
    }

    if (this.slackEnabled) {
      await this.sendSlackMessage(
        `🚨 *OPERA Sync - Salesforce Connection Error*\n\n*Error:* ${error.message}\n\nThe sync script cannot connect to Salesforce. Check credentials and network connectivity.`
      );
    }

    logger.info('Salesforce error notification sent');
  }

  /**
   * Notify about successful recovery
   */
  async notifyRecovery(filesProcessed) {
    // Only notify if we had previous errors
    if (this.consecutiveErrors === 0) {
      return;
    }

    const subject = `✅ OPERA Sync - Recovered`;
    const textBody = `
OPERA to Salesforce Sync - Recovered
====================================

The sync script has recovered and is processing files successfully.

Previous errors: ${this.consecutiveErrors}
Files processed successfully: ${filesProcessed}
Recovery time: ${new Date().toISOString()}

No action required - the system is operating normally.
    `.trim();

    const htmlBody = `
      <h2>✅ OPERA Sync - Recovered</h2>
      <p><strong>System Operating Normally</strong></p>

      <table style="border-collapse: collapse; margin: 20px 0;">
        <tr style="background: #d4edda;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Status</td>
          <td style="padding: 8px; border: 1px solid #ddd; color: green;">Recovered</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Previous Errors</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${this.consecutiveErrors}</td>
        </tr>
        <tr style="background: #f5f5f5;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Files Processed</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${filesProcessed}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Recovery Time</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${new Date().toISOString()}</td>
        </tr>
      </table>

      <p style="color: green;">No action required - the system is operating normally.</p>
    `;

    if (this.emailEnabled) {
      await this.sendEmail(subject, textBody, htmlBody);
    }

    if (this.slackEnabled) {
      await this.sendSlackMessage(
        `✅ *OPERA Sync - Recovered*\n\nThe sync script has recovered and is processing files successfully.\n\nPrevious errors: ${this.consecutiveErrors}\nFiles processed: ${filesProcessed}`
      );
    }

    logger.info('Recovery notification sent');

    // Reset error count
    this.consecutiveErrors = 0;
  }

  /**
   * Reset error counter (called on successful processing)
   */
  resetErrorCount() {
    if (this.consecutiveErrors > 0) {
      logger.info(`Resetting error count from ${this.consecutiveErrors} to 0`);
      this.consecutiveErrors = 0;
    }
  }

  /**
   * Send daily summary (optional)
   */
  async sendDailySummary(stats) {
    const subject = `📊 OPERA Sync - Daily Summary`;
    const textBody = `
OPERA to Salesforce Sync - Daily Summary
========================================

Date: ${new Date().toLocaleDateString()}

Files Processed: ${stats.filesProcessed}
Records Synced: ${stats.recordsSynced}
Failures: ${stats.failures}
Success Rate: ${stats.successRate}%

Total Files (All Time): ${stats.totalFiles}
Total Successful: ${stats.totalSuccess}
Total Failed: ${stats.totalFailed}

The system is operating normally.
    `.trim();

    const htmlBody = `
      <h2>📊 OPERA Sync - Daily Summary</h2>
      <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>

      <h3>Today's Statistics</h3>
      <table style="border-collapse: collapse; margin: 20px 0;">
        <tr style="background: #f5f5f5;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Files Processed</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.filesProcessed}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Records Synced</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.recordsSynced}</td>
        </tr>
        <tr style="background: #f5f5f5;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Failures</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.failures}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Success Rate</td>
          <td style="padding: 8px; border: 1px solid #ddd; color: ${stats.successRate > 90 ? 'green' : 'orange'};">${stats.successRate}%</td>
        </tr>
      </table>

      <h3>All-Time Statistics</h3>
      <table style="border-collapse: collapse; margin: 20px 0;">
        <tr style="background: #f5f5f5;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Total Files</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.totalFiles}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Total Successful</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.totalSuccess}</td>
        </tr>
        <tr style="background: #f5f5f5;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Total Failed</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.totalFailed}</td>
        </tr>
      </table>
    `;

    if (this.emailEnabled) {
      await this.sendEmail(subject, textBody, htmlBody);
    }

    logger.info('Daily summary sent');
  }
}

module.exports = Notifier;
