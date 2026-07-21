const nodemailer = require('nodemailer');
const axios = require('axios');
const logger = require('./logger');
const { mapLanguageToSalesforce } = require('./guest-utils');
const { formatVilla } = require('./villa-map');

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
    // Data-quality report (email / DOB / phone / passport gaps) goes to the
    // front office desk only, separate from the main daily report recipients.
    this.frontDeskDataEmailTo = process.env.FRONT_DESK_DATA_EMAIL_TO || 'foh@vinesresortandspa.com';

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
  async _sendEmailToRecipients(to, subject, textBody, htmlBody, attachments = [], cc = null) {
    if (!this.emailEnabled) {
      return;
    }

    try {
      if (this.useGmailAPI) {
        return await this._sendViaGmailREST(to, subject, textBody, htmlBody, attachments, cc);
      }

      const mailOptions = {
        from: this.emailFrom,
        to: to,
        subject: subject,
        text: textBody,
        html: htmlBody
      };

      if (cc) {
        mailOptions.cc = cc;
      }

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
  async _sendViaGmailREST(to, subject, textBody, htmlBody, attachments = [], cc = null) {
    // Get access token
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: this.gmailClientId,
      client_secret: this.gmailClientSecret,
      refresh_token: this.gmailRefreshToken,
      grant_type: 'refresh_token'
    }, { timeout: 15000 });
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
        ...(cc ? [`Cc: ${cc}`] : []),
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
        ...(cc ? [`Cc: ${cc}`] : []),
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
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30000 }
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

      await axios.post(this.slackWebhookUrl, payload, { timeout: 10000 });
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
        ${details.map(r => {
          const reason = r.reason === 'invalid-mailbox' ? 'SMTP rejected (mailbox not found)'
            : r.reason === 'invalid-email' ? 'invalid email'
            : r.reason || '';
          return `
        <tr>
          <td style="padding:6px 10px;border:1px solid #ddd">${r.firstName} ${r.lastName}</td>
          <td style="padding:6px 10px;border:1px solid #ddd">${r.email || ''}</td>
          <td style="padding:6px 10px;border:1px solid #ddd${r.reason === 'invalid-mailbox' ? ';color:#c62828;font-weight:bold' : ''}">${reason}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;white-space:nowrap">${r.checkIn || ''}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;white-space:nowrap">${r.checkOut || ''}</td>
        </tr>`;
        }).join('')}
      </table>
      <p style="color:#666;font-size:12px">Please collect personal email addresses for these guests during their stay.</p>
    `;

    await this._sendEmailToRecipients(this.frontDeskEmailTo, subject, textBody, htmlBody);
    logger.info(`Front desk report sent to ${this.frontDeskEmailTo}: ${details.length} guests`);
  }

  /**
   * Human-readable explanation of why a guest's email needs collection.
   * Shared by the data-quality report (and the legacy stats fallback).
   */
  _describeEmailReason(g) {
    const r = g.reason;
    const labels = {
      'no email':           'No email on file',
      'no-email':           'No email on file',
      'booking-proxy':      'Booking.com proxy address',
      'expedia-proxy':      'Expedia proxy address',
      'agent-domain':       'Travel agent / company domain',
      'missing-first-name': 'Name incomplete (TBC or missing)',
      'role-mailbox':       'Role mailbox (info@, sales@, reservations@, etc.)',
      'invalid-mailbox':    'Mailbox does not exist (SMTP rejected)',
      'domain-unreachable': 'Email domain has no mail server',
      'invalid-email':      'Invalid email format',
    };
    if (!r) return '';
    const noEmail = r === 'no email' || r === 'no-email';
    if (labels[r]) {
      return noEmail || !g.email ? labels[r] : `${labels[r]}: ${g.email}`;
    }
    // Free-form reasons from emailInvalidReason() — already include the domain
    // (e.g. "likely typo of gmail.com (gmial.com)") so we don't append the email.
    return r;
  }

  /**
   * Build the daily front desk report content without sending it. Extracted
   * from sendDailyFrontDeskReport so the layout can be unit-tested and
   * previewed (scripts/preview-front-desk-report.js).
   * @param {Object} reportData - From queryFrontDeskReport()
   * @returns {Object|null} { subject, textBody, htmlBody, csv } or null when empty
   */
  buildDailyFrontDeskReport(reportData) {
    const { date, inHouse, departures, arrivalsToday, arrivalsTomorrow, arrivalsDayAfter = [], postingMasters = [] } = reportData;
    const totalGuests = inHouse.length + departures.length + arrivalsToday.length + arrivalsTomorrow.length + arrivalsDayAfter.length;

    if (totalGuests === 0 && postingMasters.length === 0) {
      return null;
    }

    const subject = `Daily Front Desk Report — ${date}`;

    // Plain text fallback
    const textLines = [`Daily Front Desk Report — ${date}\n`];
    const sections = [
      { label: 'IN HOUSE', guests: inHouse },
      { label: 'DEPARTURES', guests: departures, time: 'etd' },
      { label: 'ARRIVALS TODAY', guests: arrivalsToday, time: 'eta' },
      { label: 'ARRIVALS TOMORROW', guests: arrivalsTomorrow, time: 'eta' },
      { label: 'ARRIVALS (2 DAYS OUT)', guests: arrivalsDayAfter, time: 'eta' },
      { label: 'POSTING MASTERS (charge accounts, not real stays)', guests: postingMasters }
    ];
    for (const s of sections) {
      if (s.guests.length > 0) {
        textLines.push(`${s.label} (${s.guests.length}):`);
        s.guests.forEach(g => {
          const t = s.time && g[s.time] ? ` | ${s.time === 'eta' ? 'ETA' : 'ETD'}: ~${g[s.time]}` : '';
          textLines.push(`  - ${g.firstName} ${g.lastName} | Villa: ${formatVilla(g.villa) || '—'} | PRS: ${g.prs || '—'} | ${g.checkIn}→${g.checkOut}${t} | ${g.country} | ${g.language}`);
        });
        textLines.push('');
      }
    }
    const textBody = textLines.join('\n');

    // HTML email — layout tuned for printing from Gmail (front desk prints this
    // daily): compact cells, and notes rendered as a full-width row under each
    // guest instead of a narrow column. The old notes *column* wrapped a few
    // characters per line and stretched printouts to 9-10 pages.
    const tableStyle = 'border-collapse:collapse;width:100%;font-size:12px;margin-bottom:16px';
    const thStyle = 'padding:4px 8px;border:1px solid #ddd;text-align:left;white-space:nowrap;background:#f5f5f5';
    const tdStyle = 'padding:4px 8px;border:1px solid #ddd';
    const tdNowrap = 'padding:4px 8px;border:1px solid #ddd;white-space:nowrap';

    // Full-width notes row directly under the guest row. border-top:0 visually
    // attaches it to its guest.
    const notesRow = (g, cols) => (g.notes
      ? `
      <tr>
        <td colspan="${cols}" style="${tdStyle};border-top:0;font-size:11px;color:#444">${g.notes}</td>
      </tr>`
      : '');

    const nameCell = (g) => {
      let name = `${g.firstName} ${g.lastName}`;
      if (g.companionNames) name += `<br><span style="font-size:11px;color:#666">+${g.companionNames}</span>`;
      return name;
    };

    // Estimated times are best-effort scrapes from reservation notes (OPERA has
    // no structured time fields here), so flag them with a "~" to signal that.
    const estTime = (t) => (t ? `~${t}` : '—');

    // Each guest is its own <tbody> so the guest row and its notes row stay
    // together across printed page breaks (page-break-inside:avoid).
    const guestRow = (g) => `
      <tbody style="page-break-inside:avoid">
      <tr>
        <td style="${tdStyle}">${nameCell(g)}</td>
        <td style="${tdNowrap}">${formatVilla(g.villa) || '—'}</td>
        <td style="${tdNowrap}">${g.prs || '—'}</td>
        <td style="${tdNowrap}">${g.checkIn}</td>
        <td style="${tdNowrap}">${g.checkOut}</td>
        <td style="${tdStyle}">${g.country}</td>
        <td style="${tdStyle}">${g.language}</td>
      </tr>${notesRow(g, 7)}
      </tbody>`;

    const tableHeaders = `
      <tr>
        <th style="${thStyle}">Name</th>
        <th style="${thStyle}">Villa</th>
        <th style="${thStyle}">PRS</th>
        <th style="${thStyle}">Check-in</th>
        <th style="${thStyle}">Check-out</th>
        <th style="${thStyle}">Country</th>
        <th style="${thStyle}">Language</th>
      </tr>`;

    const arrivalRow = (g) => `
      <tbody style="page-break-inside:avoid">
      <tr>
        <td style="${tdStyle}">${nameCell(g)}</td>
        <td style="${tdNowrap}">${formatVilla(g.villa) || '—'}</td>
        <td style="${tdNowrap}">${g.prs || '—'}</td>
        <td style="${tdNowrap}">${estTime(g.eta)}</td>
        <td style="${tdNowrap}">${g.checkOut}</td>
        <td style="${tdStyle}">${g.country}</td>
        <td style="${tdStyle}">${g.language}</td>
      </tr>${notesRow(g, 7)}
      </tbody>`;

    const arrivalHeaders = `
      <tr>
        <th style="${thStyle}">Name</th>
        <th style="${thStyle}">Villa</th>
        <th style="${thStyle}">PRS</th>
        <th style="${thStyle}">ETA</th>
        <th style="${thStyle}">Check-out</th>
        <th style="${thStyle}">Country</th>
        <th style="${thStyle}">Language</th>
      </tr>`;

    // Departures show estimated time-out (ETD) in place of the check-in date.
    const departureRow = (g) => `
      <tbody style="page-break-inside:avoid">
      <tr>
        <td style="${tdStyle}">${nameCell(g)}</td>
        <td style="${tdNowrap}">${formatVilla(g.villa) || '—'}</td>
        <td style="${tdNowrap}">${g.prs || '—'}</td>
        <td style="${tdNowrap}">${estTime(g.etd)}</td>
        <td style="${tdNowrap}">${g.checkOut}</td>
        <td style="${tdStyle}">${g.country}</td>
        <td style="${tdStyle}">${g.language}</td>
      </tr>${notesRow(g, 7)}
      </tbody>`;

    const departureHeaders = `
      <tr>
        <th style="${thStyle}">Name</th>
        <th style="${thStyle}">Villa</th>
        <th style="${thStyle}">PRS</th>
        <th style="${thStyle}">ETD</th>
        <th style="${thStyle}">Check-out</th>
        <th style="${thStyle}">Country</th>
        <th style="${thStyle}">Language</th>
      </tr>`;

    const prsTotal = (guests) => guests.reduce((sum, g) => sum + (g.adults || 0) + (g.children || 0), 0);

    const buildSection = (title, color, guests, variant = 'default') => {
      if (guests.length === 0) return '';
      const total = prsTotal(guests);
      const hdrs = variant === 'arrival' ? arrivalHeaders : variant === 'departure' ? departureHeaders : tableHeaders;
      const rowFn = variant === 'arrival' ? arrivalRow : variant === 'departure' ? departureRow : guestRow;
      // <thead> makes browsers repeat the header row on every printed page.
      return `
        <h3 style="margin:14px 0 6px;padding:6px 10px;background:${color};color:#fff;border-radius:4px;font-size:13px">${title}</h3>
        <table style="${tableStyle}">
          <thead>${hdrs}</thead>
          ${guests.map(rowFn).join('')}
          <tbody>
          <tr style="background:#f9f9f9">
            <td colspan="7" style="${tdStyle};font-weight:bold">Total: ${total} guest(s)</td>
          </tr>
          </tbody>
        </table>`;
    };

    let htmlBody = `
      <h2 style="margin-bottom:4px">Daily Front Desk Report</h2>
      <p style="color:#666;margin-top:0"><strong>Date:</strong> ${date}</p>`;

    htmlBody += buildSection('Guests In House', '#1565c0', inHouse);
    htmlBody += buildSection('Departures', '#757575', departures, 'departure');
    htmlBody += buildSection('Arrivals Today', '#2e7d32', arrivalsToday, 'arrival');
    htmlBody += buildSection('Arrivals Tomorrow', '#66bb6a', arrivalsTomorrow, 'arrival');
    htmlBody += buildSection('Arrivals (2 Days Out)', '#9ccc65', arrivalsDayAfter, 'arrival');

    if (postingMasters.length > 0) {
      htmlBody += `
        <h3 style="margin:14px 0 6px;padding:6px 10px;background:#9e9e9e;color:#fff;border-radius:4px;font-size:13px">
          Posting Masters — ${postingMasters.length} (charge accounts, not real stays)
        </h3>
        <p style="color:#666;font-size:12px;margin:0 0 8px">These are 9000-series accounts used to track charges. No email collection needed.</p>
        <table style="${tableStyle}">
          <thead>
          <tr>
            <th style="${thStyle}">Name</th>
            <th style="${thStyle}">Villa</th>
            <th style="${thStyle}">Check-in</th>
            <th style="${thStyle}">Check-out</th>
          </tr>
          </thead>
          ${postingMasters.map(g => `
          <tbody style="page-break-inside:avoid">
          <tr>
            <td style="${tdStyle}">${nameCell(g)}</td>
            <td style="${tdNowrap}">${formatVilla(g.villa) || '—'}</td>
            <td style="${tdNowrap}">${g.checkIn}</td>
            <td style="${tdNowrap}">${g.checkOut}</td>
          </tr>${notesRow(g, 4)}
          </tbody>`).join('')}
        </table>`;
    }

    htmlBody += `
      <p style="color:#999;font-size:11px;margin-top:24px;border-top:1px solid #eee;padding-top:8px">
        Generated by OPERA Sync at ${new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })}
      </p>`;

    // Build CSV attachment with all sections
    const csvEscape = (v) => {
      const s = String(v || '');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csvRows = ['Section,Name,Email,Villa,PRS,ETA,ETD,Check-in,Check-out,Country,Language,Reason,Notes'];
    const addCsvRows = (section, guests) => {
      for (const g of guests) {
        csvRows.push([
          section,
          `${g.firstName} ${g.lastName}`,
          g.email || '',
          formatVilla(g.villa) || '',
          g.prs || '',
          g.eta || '',
          g.etd || '',
          g.checkIn,
          g.checkOut,
          g.country,
          g.language,
          g.reason || '',
          g.notes || ''
        ].map(csvEscape).join(','));
      }
    };
    addCsvRows('In House', inHouse);
    addCsvRows('Departures', departures);
    addCsvRows('Arrivals Today', arrivalsToday);
    addCsvRows('Arrivals Tomorrow', arrivalsTomorrow);
    addCsvRows('Arrivals 2 Days Out', arrivalsDayAfter);
    addCsvRows('Posting Master', postingMasters);

    return { subject, textBody, htmlBody, csv: csvRows.join('\n') };
  }

  /**
   * Send comprehensive daily front desk report with all on-property activity
   * @param {Object} reportData - From queryFrontDeskReport()
   */
  async sendDailyFrontDeskReport(reportData) {
    if (!this.frontDeskEmailTo) return;

    const built = this.buildDailyFrontDeskReport(reportData);
    if (!built) {
      logger.info('Daily front desk report: no guests to report');
      return;
    }

    const attachments = [{
      filename: `front-desk-report-${reportData.date}.csv`,
      content: built.csv,
      contentType: 'text/csv'
    }];

    await this._sendEmailToRecipients(this.frontDeskEmailTo, built.subject, built.textBody, built.htmlBody, attachments);
    logger.info(`Daily front desk report sent to ${this.frontDeskEmailTo}`);
  }

  /**
   * Send the front-office data-quality report: guests on/arriving at the
   * property whose profile is missing a valid email, DOB, phone, or passport.
   * Goes to the front office desk (FRONT_DESK_DATA_EMAIL_TO), optionally
   * copying FRONT_DESK_DATA_EMAIL_CC (comma-separated for multiple).
   * @param {Object} reportData - From queryFrontDeskReport() (uses dataQuality)
   * @param {string} [toOverride] - Recipient override (e.g. dry-run --to)
   * @param {string} [ccOverride] - CC override (e.g. dry-run --cc)
   */
  async sendDataQualityReport(reportData, toOverride, ccOverride) {
    const to = toOverride || this.frontDeskDataEmailTo;
    const cc = ccOverride || process.env.FRONT_DESK_DATA_EMAIL_CC || null;
    if (!this.emailEnabled || !to) {
      logger.info('Data-quality report: email disabled or no recipient configured — skipping');
      return;
    }

    const { date, dataQuality = [] } = reportData;
    if (dataQuality.length === 0) {
      logger.info('Data-quality report: no guests with missing info — skipping');
      return;
    }

    const subject = `Front Desk — ${dataQuality.length} Guest(s) Missing Info (${date})`;

    // Per-guest description of what's missing. Email gets the detailed reason;
    // DOB/phone/passport are simple presence flags.
    const missingDetail = (g) => {
      const parts = [];
      for (const item of g.missing || []) {
        if (item === 'Email') parts.push(`Email (${this._describeEmailReason(g) || 'needs collection'})`);
        else if (item === 'DOB') parts.push('Date of birth');
        else if (item === 'Phone') parts.push('Phone number');
        else if (item === 'Passport') parts.push('Passport');
        else parts.push(item);
      }
      return parts;
    };

    // Plain text fallback
    const textLines = [
      `Front Desk — Guests Missing Info — ${date}`,
      `${dataQuality.length} guest(s) need data collected during their stay.\n`,
    ];
    dataQuality.forEach(g => {
      const name = `${g.firstName} ${g.lastName}${g.companionNames ? ` (+${g.companionNames})` : ''}`;
      textLines.push(`  - ${name} | Villa ${formatVilla(g.villa) || '—'} | ${g.section} | ${g.checkIn}→${g.checkOut}`);
      textLines.push(`      Missing: ${missingDetail(g).join('; ')}`);
    });
    const textBody = textLines.join('\n');

    // HTML
    const tableStyle = 'border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px';
    const thStyle = 'padding:6px 10px;border:1px solid #ddd;text-align:left;white-space:nowrap';
    const tdStyle = 'padding:6px 10px;border:1px solid #ddd';
    const tdNowrap = 'padding:6px 10px;border:1px solid #ddd;white-space:nowrap';

    const chip = (label) => `<span style="display:inline-block;background:#ffebee;color:#c62828;border-radius:3px;padding:1px 6px;margin:1px;font-size:11px">${label}</span>`;

    const rows = dataQuality.map(g => {
      const name = `${g.firstName} ${g.lastName}` + (g.companionNames ? `<br><span style="font-size:11px;color:#666">+${g.companionNames}</span>` : '');
      const flags = (g.missing || []).map(chip).join(' ');
      const emailNote = (g.missing || []).includes('Email') ? `<br><span style="font-size:11px;color:#c62828">${this._describeEmailReason(g) || ''}</span>` : '';
      return `
        <tr>
          <td style="${tdStyle}">${name}</td>
          <td style="${tdNowrap}">${formatVilla(g.villa) || '—'}</td>
          <td style="${tdNowrap}">${g.section}</td>
          <td style="${tdNowrap}">${g.checkIn}</td>
          <td style="${tdNowrap}">${g.checkOut}</td>
          <td style="${tdStyle}">${g.email || '—'}</td>
          <td style="${tdStyle}">${flags}${emailNote}</td>
        </tr>`;
    }).join('');

    const htmlBody = `
      <h2 style="margin-bottom:4px">Front Desk — Guests Missing Info</h2>
      <p style="color:#666;margin-top:0"><strong>Date:</strong> ${date} | <strong>Count:</strong> ${dataQuality.length}</p>
      <table style="${tableStyle}">
        <tr style="background:#ffebee">
          <th style="${thStyle}">Name</th>
          <th style="${thStyle}">Villa</th>
          <th style="${thStyle}">Section</th>
          <th style="${thStyle}">Check-in</th>
          <th style="${thStyle}">Check-out</th>
          <th style="${thStyle}">Current Email</th>
          <th style="${thStyle}">Missing</th>
        </tr>
        ${rows}
      </table>
      <p style="color:#666;font-size:12px">Please collect the flagged details (email, date of birth, phone, passport) during the guest's stay.</p>
      <p style="color:#999;font-size:11px;margin-top:24px;border-top:1px solid #eee;padding-top:8px">
        Generated by OPERA Sync at ${new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })}
      </p>`;

    // CSV attachment
    const csvEscape = (v) => {
      const s = String(v || '');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csvRows = ['Name,Villa,Section,Check-in,Check-out,Email,DOB,Missing'];
    for (const g of dataQuality) {
      csvRows.push([
        `${g.firstName} ${g.lastName}`,
        formatVilla(g.villa) || '',
        g.section,
        g.checkIn,
        g.checkOut,
        g.email || '',
        g.dob || '',
        (g.missing || []).join(' / '),
      ].map(csvEscape).join(','));
    }
    const attachments = [{
      filename: `front-desk-missing-info-${date}.csv`,
      content: csvRows.join('\n'),
      contentType: 'text/csv',
    }];

    await this._sendEmailToRecipients(to, subject, textBody, htmlBody, attachments, cc);
    logger.info(`Data-quality report sent to ${to}${cc ? ` (cc ${cc})` : ''}: ${dataQuality.length} guest(s) missing info`);
  }

  /**
   * Send the bi-weekly villa-nights report: nights per villa split into comp
   * (rate 0) vs paid, plus a per-rate-code breakdown.
   * @param {Object} reportData - From queryVillaNightsReport()
   * @param {string} [toOverride] - Recipient override (defaults to VILLA_REPORT_EMAIL_TO / admin)
   */
  async sendVillaNightsReport(reportData, toOverride, ccOverride) {
    const to = toOverride || process.env.VILLA_REPORT_EMAIL_TO || this.emailTo;
    const cc = ccOverride || process.env.VILLA_REPORT_EMAIL_CC || null;
    if (!this.emailEnabled || !to) {
      logger.info('Villa nights report: email disabled or no recipient configured — skipping');
      return false;
    }

    const { startDate, endDate, villas, rateCodes, totals } = reportData;

    // endDate is exclusive; show the window as start → last counted night.
    const lastNight = (() => {
      const d = new Date(`${endDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();

    const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

    const subject = `Villa Nights Report — ${startDate} to ${lastNight}`;

    // ── Plain-text fallback ──
    const vacantCount = totals.villas - totals.occupiedVillas;
    const textLines = [
      `Villa Nights Report`,
      `Window: ${startDate} through ${lastNight}`,
      `Villas occupied: ${totals.occupiedVillas}/${totals.villas} (${vacantCount} vacant) | ${totals.nights} villa-nights`,
      `Comp: ${totals.compNights} (${pct(totals.compNights, totals.nights)}%) | Paid: ${totals.paidNights} (${pct(totals.paidNights, totals.nights)}%)`,
      ``,
      `PER VILLA:`,
      ...villas.map(v => {
        const codes = v.nights === 0 ? 'vacant' : v.rateCodes.map(rc => `${rc.code}×${rc.nights}`).join(', ');
        return `  ${formatVilla(v.villa) || v.villa}: ${v.nights} nights (${v.compNights} comp / ${v.paidNights} paid) — ${codes}`;
      }),
      ``,
      `BY RATE CODE:`,
      ...rateCodes.map(rc => `  ${rc.code}: ${rc.nights} nights (${rc.compNights} comp / ${rc.paidNights} paid)`)
    ];
    const textBody = textLines.join('\n');

    // ── HTML ──
    const tableStyle = 'border-collapse:collapse;width:100%;font-size:16px;margin-bottom:20px';
    const thStyle = 'padding:9px 13px;border:1px solid #ddd;text-align:left;white-space:nowrap';
    const tdStyle = 'padding:9px 13px;border:1px solid #ddd';
    const tdNum = 'padding:9px 13px;border:1px solid #ddd;text-align:right;white-space:nowrap';

    const compChip = (n) => n > 0 ? `<span style="color:#c62828">${n}</span>` : '0';

    let htmlBody = `
      <div style="font-size:16px;line-height:1.45">
      <h2 style="margin-bottom:4px;font-size:24px">Villa Nights Report</h2>
      <p style="color:#666;margin-top:0;font-size:16px"><strong>Window:</strong> ${startDate} through ${lastNight}</p>

      <table style="border-collapse:collapse;margin:12px 0 24px;font-size:16px">
        <tr style="background:#e8f5e9">
          <td style="${tdStyle};font-weight:bold">Villas occupied</td>
          <td style="${tdNum};font-weight:bold;font-size:22px">${totals.occupiedVillas} / ${totals.villas}</td>
          <td style="${tdStyle};color:#2e7d32;font-weight:bold">${totals.villas - totals.occupiedVillas} vacant this period</td>
        </tr>
        <tr>
          <td style="${tdStyle};font-weight:bold">Villa-nights</td>
          <td style="${tdNum}">${totals.nights}</td>
          <td style="${tdStyle};color:#666">total nights sold</td>
        </tr>
        <tr>
          <td style="${tdStyle};font-weight:bold">Paid</td>
          <td style="${tdNum}">${totals.paidNights}</td>
          <td style="${tdStyle};color:#666">${pct(totals.paidNights, totals.nights)}%</td>
        </tr>
        <tr style="background:#fff3e0">
          <td style="${tdStyle};font-weight:bold;color:#c62828">Comp</td>
          <td style="${tdNum};color:#c62828">${totals.compNights}</td>
          <td style="${tdStyle};color:#666">${pct(totals.compNights, totals.nights)}%</td>
        </tr>
      </table>

      <h3 style="margin:20px 0 8px;padding:8px 12px;background:#1565c0;color:#fff;border-radius:4px;font-size:17px">Nights per Villa</h3>
      <table style="${tableStyle}">
        <tr style="background:#e3f2fd">
          <th style="${thStyle}">Villa</th>
          <th style="${thStyle};text-align:right">Nights</th>
          <th style="${thStyle};text-align:right">Comp</th>
          <th style="${thStyle};text-align:right">Paid</th>
          <th style="${thStyle}">Rate codes</th>
        </tr>
        ${villas.map(v => {
          const vacant = v.nights === 0;
          const codes = vacant ? '<span style="color:#2e7d32">vacant</span>' : v.rateCodes.map(rc => `${rc.code}&times;${rc.nights}`).join(', ');
          return `
        <tr${vacant ? ' style="background:#f1f8e9;color:#9e9e9e"' : ''}>
          <td style="${tdStyle};white-space:nowrap">${formatVilla(v.villa) || v.villa}</td>
          <td style="${tdNum}">${v.nights}</td>
          <td style="${tdNum}">${vacant ? '0' : compChip(v.compNights)}</td>
          <td style="${tdNum}">${v.paidNights}</td>
          <td style="${tdStyle};font-size:14px${vacant ? '' : ';color:#555'}">${codes}</td>
        </tr>`;
        }).join('')}
        <tr style="background:#f9f9f9;font-weight:bold">
          <td style="${tdStyle}">Total (${totals.villas})</td>
          <td style="${tdNum}">${totals.nights}</td>
          <td style="${tdNum}">${totals.compNights}</td>
          <td style="${tdNum}">${totals.paidNights}</td>
          <td style="${tdStyle}"></td>
        </tr>
      </table>

      <h3 style="margin:20px 0 8px;padding:8px 12px;background:#6a1b9a;color:#fff;border-radius:4px;font-size:17px">Nights by Rate Code</h3>
      <p style="color:#666;font-size:15px;margin:0 0 8px">The rate-plan mix behind the nights above — comp plans (COMP, HOUSE, COMPSTAYSALE&hellip;) vs. owner / friends &amp; family / market rates.</p>
      <table style="${tableStyle}">
        <tr style="background:#f3e5f5">
          <th style="${thStyle}">Rate code</th>
          <th style="${thStyle};text-align:right">Nights</th>
          <th style="${thStyle};text-align:right">Comp</th>
          <th style="${thStyle};text-align:right">Paid</th>
        </tr>
        ${rateCodes.map(rc => `
        <tr>
          <td style="${tdStyle};white-space:nowrap">${rc.code}</td>
          <td style="${tdNum}">${rc.nights}</td>
          <td style="${tdNum}">${compChip(rc.compNights)}</td>
          <td style="${tdNum}">${rc.paidNights}</td>
        </tr>`).join('')}
      </table>

      <p style="color:#999;font-size:13px;margin-top:24px;border-top:1px solid #eee;padding-top:8px">
        Comp = OPERA per-night RATE_AMOUNT of 0 (free night). Counts are villa-nights — one reservation per villa per night. PM and 9000-series charge accounts are excluded.<br>
        Generated by OPERA Sync at ${new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })}.
      </p>
      </div>`;

    // ── CSV attachment (per-villa) ──
    const csvEscape = (val) => {
      const s = String(val == null ? '' : val);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csvRows = ['Villa,OperaRoom,Nights,CompNights,PaidNights,RateCodes'];
    for (const v of villas) {
      csvRows.push([
        formatVilla(v.villa) || v.villa,
        v.villa,
        v.nights,
        v.compNights,
        v.paidNights,
        v.rateCodes.map(rc => `${rc.code} x${rc.nights}`).join('; ')
      ].map(csvEscape).join(','));
    }
    const attachments = [{
      filename: `villa-nights-${startDate}_to_${lastNight}.csv`,
      content: csvRows.join('\n'),
      contentType: 'text/csv'
    }];

    const sent = await this._sendEmailToRecipients(to, subject, textBody, htmlBody, attachments, cc);
    logger.info(`Villa nights report sent to ${to}${cc ? ` (cc ${cc})` : ''}: ${totals.villas} villas, ${totals.nights} nights (${startDate}..${lastNight})`);
    return sent;
  }

  /**
   * Send the weekly villa-rotation outlook: booked nights per villa across the
   * three forward horizons (current month + next / 3 months / 6 months), so
   * reservations can distribute upcoming assignments evenly. Windows nest —
   * the wider columns include the narrower ones.
   * @param {Object} reportData - From queryVillaNightsOutlook(): { windows: [...] }
   * @param {string} [toOverride] - Recipient override (defaults to VILLA_REPORT_EMAIL_TO / admin)
   * @param {string} [ccOverride]
   */
  async sendVillaNightsOutlook(reportData, toOverride, ccOverride) {
    const to = toOverride || process.env.VILLA_REPORT_EMAIL_TO || this.emailTo;
    const cc = ccOverride || process.env.VILLA_REPORT_EMAIL_CC || null;
    if (!this.emailEnabled || !to) {
      logger.info('Villa rotation outlook: email disabled or no recipient configured — skipping');
      return false;
    }

    const { windows } = reportData;
    const widest = windows[windows.length - 1];

    const monthLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    // endDate is an exclusive first-of-month; the last covered month is the one before it.
    const lastMonth = (endIso) => {
      const d = new Date(`${endIso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      return monthLabel(d.toISOString().slice(0, 10));
    };
    const windowRange = (w) => `${monthLabel(w.startDate)} – ${lastMonth(w.endDate)}`;

    const subject = `Villa Rotation Outlook — ${monthLabel(widest.startDate)} to ${lastMonth(widest.endDate)}`;

    // Per-villa lookup per window (all windows share the same villa set/order).
    const byVilla = windows.map(w => new Map(w.villas.map(v => [v.villa, v])));
    const villaOrder = widest.villas.map(v => v.villa);

    const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

    // ── Plain-text fallback ──
    const textLines = [
      `Villa Rotation Outlook`,
      ...windows.map(w => `${w.label} (${windowRange(w)}): ${w.totals.nights} nights booked across ${w.totals.occupiedVillas}/${w.totals.villas} villas (${w.totals.compNights} comp / ${w.totals.paidNights} paid)`),
      ``,
      `NIGHTS PER VILLA (columns: ${windows.map(w => w.label).join(' | ')}):`,
      ...villaOrder.map(villa => {
        const cells = byVilla.map(m => {
          const v = m.get(villa);
          return v && v.nights > 0 ? `${v.nights}${v.compNights > 0 ? ` (${v.compNights}c)` : ''}` : '0';
        });
        return `  ${formatVilla(villa) || villa}: ${cells.join(' | ')}`;
      }),
      ``,
      `BY RATE CODE (${widest.label}):`,
      ...widest.rateCodes.map(rc => `  ${rc.code}: ${rc.nights} nights (${rc.compNights} comp / ${rc.paidNights} paid)`)
    ];
    const textBody = textLines.join('\n');

    // ── HTML ──
    const tableStyle = 'border-collapse:collapse;width:100%;font-size:16px;margin-bottom:20px';
    const thStyle = 'padding:9px 13px;border:1px solid #ddd;text-align:left;white-space:nowrap';
    const tdStyle = 'padding:9px 13px;border:1px solid #ddd';
    const tdNum = 'padding:9px 13px;border:1px solid #ddd;text-align:right;white-space:nowrap';

    const nightsCell = (v) => {
      if (!v || v.nights === 0) return '<span style="color:#2e7d32">0</span>';
      const comp = v.compNights > 0 ? ` <span style="color:#c62828;font-size:13px">(${v.compNights}c)</span>` : '';
      return `${v.nights}${comp}`;
    };

    const htmlBody = `
      <div style="font-size:16px;line-height:1.45">
      <h2 style="margin-bottom:4px;font-size:24px">Villa Rotation Outlook</h2>
      <p style="color:#666;margin-top:0;font-size:16px">Booked nights per villa over the next months — for distributing upcoming assignments evenly. Columns are cumulative: wider windows include the narrower ones.</p>

      <table style="border-collapse:collapse;margin:12px 0 24px;font-size:16px">
        <tr style="background:#e3f2fd">
          <th style="${thStyle}">Window</th>
          <th style="${thStyle}">Months</th>
          <th style="${thStyle};text-align:right">Nights booked</th>
          <th style="${thStyle};text-align:right">Villas with nights</th>
          <th style="${thStyle};text-align:right">Comp</th>
          <th style="${thStyle};text-align:right">Paid</th>
        </tr>
        ${windows.map(w => `
        <tr>
          <td style="${tdStyle};font-weight:bold;white-space:nowrap">${w.label}</td>
          <td style="${tdStyle};white-space:nowrap">${windowRange(w)}</td>
          <td style="${tdNum}">${w.totals.nights}</td>
          <td style="${tdNum}">${w.totals.occupiedVillas} / ${w.totals.villas}</td>
          <td style="${tdNum};color:#c62828">${w.totals.compNights} (${pct(w.totals.compNights, w.totals.nights)}%)</td>
          <td style="${tdNum}">${w.totals.paidNights}</td>
        </tr>`).join('')}
      </table>

      <h3 style="margin:20px 0 8px;padding:8px 12px;background:#1565c0;color:#fff;border-radius:4px;font-size:17px">Nights per Villa</h3>
      <table style="${tableStyle}">
        <tr style="background:#e3f2fd">
          <th style="${thStyle}">Villa</th>
          ${windows.map(w => `<th style="${thStyle};text-align:right">${w.label}<br><span style="font-weight:normal;font-size:12px;color:#666">${windowRange(w)}</span></th>`).join('')}
        </tr>
        ${villaOrder.map(villa => {
          const wide = byVilla[byVilla.length - 1].get(villa);
          const empty = !wide || wide.nights === 0;
          return `
        <tr${empty ? ' style="background:#f1f8e9"' : ''}>
          <td style="${tdStyle};white-space:nowrap">${formatVilla(villa) || villa}</td>
          ${byVilla.map(m => `<td style="${tdNum}">${nightsCell(m.get(villa))}</td>`).join('')}
        </tr>`;
        }).join('')}
        <tr style="background:#f9f9f9;font-weight:bold">
          <td style="${tdStyle}">Total (${widest.totals.villas})</td>
          ${windows.map(w => `<td style="${tdNum}">${w.totals.nights}</td>`).join('')}
        </tr>
      </table>

      <h3 style="margin:20px 0 8px;padding:8px 12px;background:#6a1b9a;color:#fff;border-radius:4px;font-size:17px">Nights by Rate Code — ${widest.label}</h3>
      <p style="color:#666;font-size:15px;margin:0 0 8px">The rate-plan mix behind the booked nights over the full window — comp plans vs. owner / friends &amp; family / market rates.</p>
      <table style="${tableStyle}">
        <tr style="background:#f3e5f5">
          <th style="${thStyle}">Rate code</th>
          <th style="${thStyle};text-align:right">Nights</th>
          <th style="${thStyle};text-align:right">Comp</th>
          <th style="${thStyle};text-align:right">Paid</th>
        </tr>
        ${widest.rateCodes.map(rc => `
        <tr>
          <td style="${tdStyle};white-space:nowrap">${rc.code}</td>
          <td style="${tdNum}">${rc.nights}</td>
          <td style="${tdNum}">${rc.compNights > 0 ? `<span style="color:#c62828">${rc.compNights}</span>` : '0'}</td>
          <td style="${tdNum}">${rc.paidNights}</td>
        </tr>`).join('')}
      </table>

      <p style="color:#999;font-size:13px;margin-top:24px;border-top:1px solid #eee;padding-top:8px">
        Counts are villa-nights already on the books (reserved or in-house; cancellations, no-shows and waitlist excluded), including nights already hosted since the 1st of this month. (Nc) = N comp nights (OPERA rate 0). PM and 9000-series charge accounts are excluded.<br>
        Generated by OPERA Sync at ${new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })}.
      </p>
      </div>`;

    // ── CSV attachment (per-villa × per-window) ──
    const csvEscape = (val) => {
      const s = String(val == null ? '' : val);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Villa', 'OperaRoom'];
    for (const w of windows) header.push(`Nights (${w.label})`, `Comp (${w.label})`, `Paid (${w.label})`);
    const csvRows = [header.map(csvEscape).join(',')];
    for (const villa of villaOrder) {
      const cells = [formatVilla(villa) || villa, villa];
      for (const m of byVilla) {
        const v = m.get(villa);
        cells.push(v ? v.nights : 0, v ? v.compNights : 0, v ? v.paidNights : 0);
      }
      csvRows.push(cells.map(csvEscape).join(','));
    }
    const attachments = [{
      filename: `villa-rotation-outlook-${widest.startDate}.csv`,
      content: csvRows.join('\n'),
      contentType: 'text/csv'
    }];

    const sent = await this._sendEmailToRecipients(to, subject, textBody, htmlBody, attachments, cc);
    logger.info(`Villa rotation outlook sent to ${to}${cc ? ` (cc ${cc})` : ''}: ${windows.map(w => `${w.label}=${w.totals.nights}n`).join(', ')}`);
    return sent;
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
    const subject = `📊 OPERA Sync - Daily Admin Summary (${stats.date})`;

    const duplicateDetails = stats.skippedDuplicateDetails || [];
    const reviewDetails = stats.needsReviewDetails || [];
    const frontDeskDetails = stats.frontDeskDetails || [];

    const textBody = `
OPERA to Salesforce Sync - Daily Admin Summary
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
      <h2>📊 OPERA Sync - Daily Admin Summary</h2>
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
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Reason</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;white-space:nowrap">Check-in</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;white-space:nowrap">Check-out</th>
          </tr>
          ${frontDeskDetails.map(r => {
            const reason = r.reason === 'invalid-mailbox' ? 'SMTP rejected (mailbox not found)'
              : r.reason === 'invalid-email' ? 'invalid email'
              : r.reason || '';
            return `
          <tr>
            <td style="padding:6px 10px;border:1px solid #ddd">${r.firstName} ${r.lastName}</td>
            <td style="padding:6px 10px;border:1px solid #ddd${r.reason === 'invalid-mailbox' ? ';color:#c62828;font-weight:bold' : ''}">${reason}</td>
            <td style="padding:6px 10px;border:1px solid #ddd;white-space:nowrap">${r.checkIn || ''}</td>
            <td style="padding:6px 10px;border:1px solid #ddd;white-space:nowrap">${r.checkOut || ''}</td>
          </tr>`;
          }).join('')}
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
        text: `📊 *OPERA Sync - Daily Admin Summary (${stats.date})*`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `📊 *OPERA Sync - Daily Admin Summary*\n*Date:* ${stats.date}`
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
      await this.sendSlackMessage(slackMessage);
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
      await this.sendSlackMessage(slackMessage);
    }

    logger.info(`Duplicate notification sent for ${duplicates.length} records`);
  }
}

module.exports = Notifier;
