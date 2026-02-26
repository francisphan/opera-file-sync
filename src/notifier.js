const nodemailer = require('nodemailer');
const axios = require('axios');
const logger = require('./logger');
const { mapLanguageToSalesforce } = require('./guest-utils');

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

    this.frontDeskEmailTo = process.env.FRONT_DESK_EMAIL_TO || null;

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
   * Send email notification (to default admin recipients)
   */
  async sendEmail(subject, textBody, htmlBody) {
    return this._sendEmailToRecipients(this.emailTo, subject, textBody, htmlBody);
  }

  /**
   * Send email to specific recipients with optional attachments
   * @param {string} to - Comma-separated email addresses
   * @param {string} subject - Email subject
   * @param {string} textBody - Plain text body
   * @param {string} htmlBody - HTML body
   * @param {Array} attachments - Array of { filename, content, contentType } objects
   */
  async _sendEmailToRecipients(to, subject, textBody, htmlBody, attachments = []) {
    if (!this.emailEnabled) {
      return;
    }

    try {
      if (this.useGmailAPI) {
        return await this._sendViaGmailREST(to, subject, textBody, htmlBody, attachments);
      }

      const mailOptions = {
        from: this.emailFrom,
        to: to,
        subject: subject,
        text: textBody,
        html: htmlBody
      };

      if (attachments.length > 0) {
        mailOptions.attachments = attachments.map(a => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType
        }));
      }

      const info = await this.transporter.sendMail(mailOptions);
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
  async _sendViaGmailREST(to, subject, textBody, htmlBody, attachments = []) {
    // Get access token
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: this.gmailClientId,
      client_secret: this.gmailClientSecret,
      refresh_token: this.gmailRefreshToken,
      grant_type: 'refresh_token'
    });
    const accessToken = tokenRes.data.access_token;
    logger.debug('Gmail access token obtained');

    // Encode subject line for UTF-8 (RFC 2047) to handle emojis correctly
    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;

    let message;

    if (attachments.length > 0) {
      // Build multipart/mixed MIME message with attachments
      const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const parts = [
        `From: ${this.emailFrom}`,
        `To: ${to}`,
        `Subject: ${encodedSubject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        '',
        htmlBody || textBody
      ];

      for (const att of attachments) {
        const b64Content = Buffer.from(att.content).toString('base64');
        parts.push(
          `--${boundary}`,
          `Content-Type: ${att.contentType || 'application/octet-stream'}; name="${att.filename}"`,
          `Content-Disposition: attachment; filename="${att.filename}"`,
          'Content-Transfer-Encoding: base64',
          '',
          b64Content
        );
      }

      parts.push(`--${boundary}--`);
      message = parts.join('\r\n');
    } else {
      // Simple HTML message (no attachments)
      message = [
        `From: ${this.emailFrom}`,
        `To: ${to}`,
        `Subject: ${encodedSubject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=utf-8',
        '',
        htmlBody || textBody
      ].join('\r\n');
    }

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
   * Note: Email skipped for per-sync events — success stats go in the daily summary.
   */
  async notifyFileProcessed(filename, recordCount, filteredCount) {
    logger.info(`Processed ${filename}: ${recordCount} records synced${filteredCount > 0 ? `, ${filteredCount} filtered` : ''}`);

    if (this.slackEnabled) {
      let text = `:white_check_mark: *OPERA Sync* — \`${filename}\` processed successfully\n*${recordCount}* records synced to Salesforce`;
      if (filteredCount > 0) {
        text += `\n*${filteredCount}* agent/company emails filtered out`;
      }
      await this.sendSlackMessage(text);
    }
  }

  /**
   * Send front desk report email listing on-property guests needing email collection
   * @param {Object} stats - Daily stats object with frontDeskDetails
   */
  async sendFrontDeskReport(stats) {
    if (!this.frontDeskEmailTo) return;

    const details = stats.frontDeskDetails || [];
    if (details.length === 0) return;

    const subject = `Front Desk — ${details.length} Guest(s) Need Email Collection (${stats.date})`;

    const textBody = details.map(r =>
      `${r.firstName} ${r.lastName} — ${r.email || '(none)'} — ${r.reason} — check-in: ${r.checkIn || '—'} check-out: ${r.checkOut || '—'}`
    ).join('\n');

    const htmlBody = `
      <h2>Front Desk — Guests Needing Email Collection</h2>
      <p><strong>Date:</strong> ${stats.date} | <strong>Count:</strong> ${details.length}</p>
      <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:16px">
        <tr style="background:#e3f2fd">
          <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Guest Name</th>
          <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Current Email</th>
          <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Reason</th>
          <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;white-space:nowrap">Check-in</th>
          <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;white-space:nowrap">Check-out</th>
        </tr>
        ${details.map(r => `
        <tr>
          <td style="padding:6px 10px;border:1px solid #ddd">${r.firstName} ${r.lastName}</td>
          <td style="padding:6px 10px;border:1px solid #ddd">${r.email || ''}</td>
          <td style="padding:6px 10px;border:1px solid #ddd">${r.reason || ''}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;white-space:nowrap">${r.checkIn || ''}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;white-space:nowrap">${r.checkOut || ''}</td>
        </tr>`).join('')}
      </table>
      <p style="color:#666;font-size:12px">Please collect personal email addresses for these guests during their stay.</p>
    `;

    await this._sendEmailToRecipients(this.frontDeskEmailTo, subject, textBody, htmlBody);
    logger.info(`Front desk report sent to ${this.frontDeskEmailTo}: ${details.length} guests`);
  }

  /**
   * Build CSV string for needs-review records (ready for SF Data Loader)
   * @param {Array} reviewDetails - Array of needsReview objects
   * @returns {string} CSV content
   */
  _buildNeedsReviewCSV(reviewDetails) {
    const headers = ['Email', 'FirstName', 'LastName', 'Phone', 'City__c', 'State_Province__c', 'Country__c', 'Language__c', 'Check_In_Date__c', 'Check_Out_Date__c', 'Review_Reason'];

    const escapeCSV = (val) => {
      const str = String(val || '');
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const rows = reviewDetails.map(r => [
      r.email || '',
      r.firstName || '',
      r.lastName || '',
      r.phone || '',
      r.billingCity || '',
      r.billingState || '',
      r.billingCountry || '',
      mapLanguageToSalesforce(r.language) || '',
      r.checkInDate || '',
      r.checkOutDate || '',
      r.reason || ''
    ].map(escapeCSV).join(','));

    return [headers.join(','), ...rows].join('\n');
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
   * Send daily summary email
   */
  async sendDailySummary(stats) {
    const subject = `📊 OPERA Sync - Daily Summary (${stats.date})`;

    const duplicateDetails = stats.skippedDuplicateDetails || [];
    const reviewDetails = stats.needsReviewDetails || [];
    const frontDeskDetails = stats.frontDeskDetails || [];

    const textBody = `
OPERA to Salesforce Sync - Daily Summary
========================================

Date: ${stats.date}

TODAY'S ACTIVITY:
Records Synced: ${stats.recordsSynced || 0}
Front Desk (email collection): ${stats.frontDesk || 0}
Skipped (Duplicates): ${stats.skippedDuplicates || 0}
Needs Review: ${stats.needsReview || 0}
Errors: ${stats.errors || 0}

${frontDeskDetails.length > 0 ? `\nFRONT DESK — ON-PROPERTY GUESTS (email collection needed):\n${frontDeskDetails.map(r => `  - ${r.firstName} ${r.lastName} <${r.email || '(none)'}> (${r.reason}) check-in: ${r.checkIn || '—'} check-out: ${r.checkOut || '—'}`).join('\n')}` : ''}
${duplicateDetails.length > 0 ? `\nSKIPPED - DUPLICATES (please review):\n${duplicateDetails.map(r => `  - ${r.firstName} ${r.lastName} <${r.email}> (${r.reason || r.category || ''})`).join('\n')}` : ''}
${reviewDetails.length > 0 ? `\nNEEDS REVIEW (manual entry required):\n${reviewDetails.map(r => `  - ${r.firstName} ${r.lastName} <${r.email}> (${r.reason}) check-in: ${r.checkInDate || '—'}`).join('\n')}` : ''}
${stats.errors > 0 ? `\nRECENT ERRORS:\n${(stats.errorDetails || []).map(e => `- [${new Date(e.time).toLocaleTimeString()}] ${e.message}`).join('\n')}` : ''}

${stats.totalFiles ? `\nALL-TIME STATISTICS:\nTotal Files: ${stats.totalFiles}\nSuccessful: ${stats.totalSuccess}\nFailed: ${stats.totalFailed}` : ''}

${stats.recordsSynced > 0 ? 'The system is operating normally.' : 'No records were synced today.'}
    `.trim();

    const htmlBody = `
      <h2>📊 OPERA Sync - Daily Summary</h2>
      <p><strong>Date:</strong> ${stats.date}</p>

      <h3>Today's Activity</h3>
      <table style="border-collapse: collapse; margin: 20px 0;">
        <tr style="background: #e8f5e9;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Records Synced to Salesforce</td>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; color: green; font-size: 16px;">${stats.recordsSynced || 0}</td>
        </tr>
        ${(stats.frontDesk || 0) > 0 ? `
        <tr style="background: #e3f2fd;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Front Desk (email collection)</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.frontDesk}</td>
        </tr>` : ''}
        <tr style="background: #fff3e0;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Skipped (Duplicates)</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.skippedDuplicates || 0}</td>
        </tr>
        ${(stats.needsReview || 0) > 0 ? `
        <tr style="background: #fffbeb;">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Needs Review (manual entry)</td>
          <td style="padding: 8px; border: 1px solid #ddd; color: #d97706; font-weight: bold;">${stats.needsReview}</td>
        </tr>` : ''}
        <tr style="background: ${stats.errors > 0 ? '#ffebee' : '#f5f5f5'};">
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Errors</td>
          <td style="padding: 8px; border: 1px solid #ddd; ${stats.errors > 0 ? 'color: red; font-weight: bold;' : ''}">${stats.errors || 0}</td>
        </tr>
      </table>

      ${frontDeskDetails.length > 0 ? `
        <h3>📋 Front Desk — On-Property Guests (email collection needed)</h3>
        <table style="border-collapse:collapse;width:100%;font-size:12px;margin-bottom:16px">
          <tr style="background:#e3f2fd">
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Name</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Current Email</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Reason</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;white-space:nowrap">Check-in</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;white-space:nowrap">Check-out</th>
          </tr>
          ${frontDeskDetails.map(r => `
          <tr>
            <td style="padding:6px 10px;border:1px solid #ddd">${r.firstName} ${r.lastName}</td>
            <td style="padding:6px 10px;border:1px solid #ddd">${r.email || ''}</td>
            <td style="padding:6px 10px;border:1px solid #ddd">${r.reason || ''}</td>
            <td style="padding:6px 10px;border:1px solid #ddd;white-space:nowrap">${r.checkIn || ''}</td>
            <td style="padding:6px 10px;border:1px solid #ddd;white-space:nowrap">${r.checkOut || ''}</td>
          </tr>`).join('')}
        </table>
      ` : ''}

      ${duplicateDetails.length > 0 ? `
        <h3>⚠️ Skipped — Duplicates (please review)</h3>
        <table style="border-collapse: collapse; width: 100%; font-size: 12px; margin-bottom: 16px;">
          <tr style="background: #fff3e0;">
            <th style="padding: 6px 10px; border: 1px solid #ddd; text-align: left;">Name</th>
            <th style="padding: 6px 10px; border: 1px solid #ddd; text-align: left;">Email</th>
            <th style="padding: 6px 10px; border: 1px solid #ddd; text-align: left;">Reason</th>
            <th style="padding: 6px 10px; border: 1px solid #ddd; text-align: left;">Opera ID</th>
          </tr>
          ${duplicateDetails.map(r => `
          <tr>
            <td style="padding: 6px 10px; border: 1px solid #ddd;">${r.firstName} ${r.lastName}</td>
            <td style="padding: 6px 10px; border: 1px solid #ddd;">${r.email}</td>
            <td style="padding: 6px 10px; border: 1px solid #ddd;">${r.reason || r.category || ''}</td>
            <td style="padding: 6px 10px; border: 1px solid #ddd; color: #999;">${r.operaId || ''}</td>
          </tr>`).join('')}
        </table>
      ` : ''}

      ${reviewDetails.length > 0 ? `
        <h3>⚠️ Needs Review — Manual Entry Required (${reviewDetails.length})</h3>
        <div style="overflow-x:auto">
        <table style="border-collapse:collapse;width:100%;font-size:12px;margin-bottom:16px">
          <tr style="background:#fffbeb">
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Name</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Email</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Phone</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">City</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Country</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Language</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;white-space:nowrap">Check-in</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;white-space:nowrap">Check-out</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Reason</th>
          </tr>
          ${reviewDetails.map(r => {
            const name = `${r.firstName || ''} ${r.lastName || ''}`.trim();
            const lang = mapLanguageToSalesforce(r.language) || '';
            const reason = r.reason === 'shared-email-in-batch' ? 'Shared email'
              : r.reason === 'shared-email-no-name-match' ? 'Shared email (no match)'
              : r.reason === 'shared-email-new-contact' ? 'Shared email (new)'
              : r.reason === 'multiple-sf-contacts' ? '2+ SF Contacts'
              : r.reason;
            return `<tr>
              <td style="padding:6px 10px;border:1px solid #ddd">${name}</td>
              <td style="padding:6px 10px;border:1px solid #ddd">${r.email || ''}</td>
              <td style="padding:6px 10px;border:1px solid #ddd">${r.phone || ''}</td>
              <td style="padding:6px 10px;border:1px solid #ddd">${r.billingCity || ''}</td>
              <td style="padding:6px 10px;border:1px solid #ddd">${r.billingCountry || ''}</td>
              <td style="padding:6px 10px;border:1px solid #ddd">${lang}</td>
              <td style="padding:6px 10px;border:1px solid #ddd;white-space:nowrap">${r.checkInDate || ''}</td>
              <td style="padding:6px 10px;border:1px solid #ddd;white-space:nowrap">${r.checkOutDate || ''}</td>
              <td style="padding:6px 10px;border:1px solid #ddd;color:#92400e">${reason}</td>
            </tr>`;
          }).join('')}
        </table>
        </div>
        <p style="font-size:12px;color:#666">A CSV file is attached for SF Data Loader import.</p>
      ` : ''}

      ${stats.errors > 0 ? `
        <h3>⚠️ Recent Errors</h3>
        <ul style="font-size: 12px; color: #666; background: #ffebee; padding: 15px; border-radius: 4px;">
          ${(stats.errorDetails || []).map(e => `<li><strong>[${new Date(e.time).toLocaleTimeString()}]</strong> ${e.message}</li>`).join('')}
        </ul>
      ` : ''}

      ${stats.totalFiles ? `
        <h3>All-Time Statistics</h3>
        <table style="border-collapse: collapse; margin: 20px 0;">
          <tr style="background: #f5f5f5;">
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Total Files Processed</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${stats.totalFiles}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Successful</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${stats.totalSuccess}</td>
          </tr>
          <tr style="background: #f5f5f5;">
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Failed</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${stats.totalFailed}</td>
          </tr>
        </table>
      ` : ''}

      <p style="margin-top: 20px; padding: 10px; background: ${stats.recordsSynced > 0 ? '#e8f5e9' : '#f5f5f5'}; border-radius: 4px;">
        ${stats.recordsSynced > 0 ? '✅ The system is operating normally.' : 'ℹ️ No records were synced today.'}
      </p>
    `;

    if (this.emailEnabled) {
      // Build CSV attachment for needs-review records
      const attachments = [];
      if (reviewDetails.length > 0) {
        const csvContent = this._buildNeedsReviewCSV(reviewDetails);
        attachments.push({
          filename: `needs-review-${stats.date}.csv`,
          content: csvContent,
          contentType: 'text/csv'
        });
      }

      await this._sendEmailToRecipients(this.emailTo, subject, textBody, htmlBody, attachments);
    }

    if (this.slackWebhookUrl) {
      const slackMessage = {
        text: `📊 *OPERA Sync - Daily Summary (${stats.date})*`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `📊 *OPERA Sync - Daily Summary*\n*Date:* ${stats.date}`
            }
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Records Synced:*\n${stats.recordsSynced || 0}` },
              { type: 'mrkdwn', text: `*Front Desk:*\n${stats.frontDesk || 0}` },
              { type: 'mrkdwn', text: `*Skipped (Duplicates):*\n${stats.skippedDuplicates || 0}` },
              { type: 'mrkdwn', text: `*Needs Review:*\n${stats.needsReview || 0}` },
              { type: 'mrkdwn', text: `*Errors:*\n${stats.errors || 0}` }
            ]
          }
        ]
      };
      await this.sendSlack(slackMessage);
    }

    logger.info('Daily summary sent');
  }

  /**
   * Notify about detected duplicates
   */
  async notifyDuplicatesDetected(filename, duplicates) {
    if (!duplicates || duplicates.length === 0) return;

    const subject = `⚠️ OPERA Sync - Duplicates Detected (${duplicates.length})`;

    const textBody = `
OPERA to Salesforce Sync - Duplicate Detection Alert
====================================================

File: ${filename || 'Database Sync'}
Date: ${new Date().toLocaleString()}

${duplicates.length} potential duplicate(s) detected and skipped.
These records have the same name but different email addresses as existing Salesforce records.

DUPLICATES SKIPPED:
${duplicates.map((d, i) => `
${i + 1}. ${d.firstName} ${d.lastName}
   Email (Oracle): ${d.email}
   Probability: ${d.probability}%
   Matching SF Record(s): ${d.matches.map(m => m.record.email).join(', ')}
`).join('\n')}

ACTION REQUIRED:
Please review these records to determine if they are:
1. True duplicates (same person with typo in email)
2. Different people with the same name
3. Updated contact information that should replace the existing record

The records were NOT synced to Salesforce and are waiting for manual review.
    `.trim();

    const htmlBody = `
      <h2>⚠️ OPERA Sync - Duplicate Detection Alert</h2>
      <p><strong>File:</strong> ${filename || 'Database Sync'}<br>
      <strong>Date:</strong> ${new Date().toLocaleString()}</p>

      <p style="background: #fff3e0; padding: 10px; border-left: 4px solid #ff9800;">
        <strong>${duplicates.length} potential duplicate(s) detected and skipped.</strong><br>
        These records have the same name but different email addresses as existing Salesforce records.
      </p>

      <h3>Duplicates Skipped</h3>
      <table style="border-collapse: collapse; width: 100%; font-size: 12px;">
        <tr style="background: #f5f5f5;">
          <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Name</th>
          <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Oracle Email</th>
          <th style="padding: 8px; border: 1px solid #ddd; text-align: center;">Probability</th>
          <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Matching SF Email(s)</th>
        </tr>
        ${duplicates.map(d => `
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd;">${d.firstName} ${d.lastName}</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${d.email}</td>
          <td style="padding: 8px; border: 1px solid #ddd; text-align: center; background: ${d.probability >= 90 ? '#ffcdd2' : d.probability >= 75 ? '#fff3e0' : '#f5f5f5'};">
            <strong>${d.probability}%</strong>
          </td>
          <td style="padding: 8px; border: 1px solid #ddd; font-size: 11px;">${d.matches.map(m => m.record.email).join('<br>')}</td>
        </tr>
        `).join('')}
      </table>

      <h3>⚡ Action Required</h3>
      <p>Please review these records to determine if they are:</p>
      <ol>
        <li><strong>True duplicates</strong> - Same person with typo in email address</li>
        <li><strong>Different people</strong> - Different people who happen to have the same name</li>
        <li><strong>Updated information</strong> - Contact information that should replace the existing record</li>
      </ol>

      <p style="background: #ffebee; padding: 10px; border-radius: 4px; margin-top: 20px;">
        ⚠️ These records were <strong>NOT synced to Salesforce</strong> and are waiting for manual review.
      </p>
    `;

    if (this.emailEnabled) {
      await this.sendEmail(subject, textBody, htmlBody);
    }

    if (this.slackWebhookUrl) {
      const slackMessage = {
        text: `⚠️ *Duplicate Detection Alert*: ${duplicates.length} potential duplicate(s) detected`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `⚠️ *Duplicate Detection Alert*\n*File:* ${filename || 'Database Sync'}\n*Duplicates:* ${duplicates.length}`
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Top duplicates:\n${duplicates.slice(0, 5).map(d => `• ${d.firstName} ${d.lastName} - ${d.probability}% probability`).join('\n')}`
            }
          }
        ]
      };
      await this.sendSlack(slackMessage);
    }

    logger.info(`Duplicate notification sent for ${duplicates.length} records`);
  }
}

module.exports = Notifier;
