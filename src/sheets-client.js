/**
 * Google Sheets Client — appends checked-out guest rows to the checkout survey sheet.
 *
 * Uses direct REST calls via axios (same pattern as notifier.js) to avoid
 * googleapis library issues in pkg-bundled executables.
 *
 * Reuses existing Gmail OAuth credentials (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN).
 * Each monthly tab is named in Spanish (e.g., "Febrero 2026").
 *
 * Columns: HotelID | First Name | Last Name | Email | Arrival Date | Departure Date | Language
 */

const axios = require('axios');
const logger = require('./logger');
const { mapLanguageToSalesforce } = require('./guest-utils');

const SPANISH_MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

const HOTEL_ID = 'LW7063';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

class SheetsClient {
  constructor() {
    this.spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    this.enabled = (process.env.GOOGLE_SHEETS_ENABLED || '').toLowerCase() === 'true';

    // Check-in arrivals sheet (separate spreadsheet)
    this.checkinSpreadsheetId = process.env.GOOGLE_SHEETS_CHECKIN_ID;
    this.checkinEnabled = (process.env.GOOGLE_SHEETS_CHECKIN_ENABLED || '').toLowerCase() === 'true';

    if (!this.enabled && !this.checkinEnabled) {
      logger.info('Google Sheets integration disabled');
      return;
    }

    if (this.enabled && !this.spreadsheetId) {
      logger.warn('GOOGLE_SHEETS_ID not set — disabling checkout Sheets integration');
      this.enabled = false;
    }

    if (this.checkinEnabled && !this.checkinSpreadsheetId) {
      logger.warn('GOOGLE_SHEETS_CHECKIN_ID not set — disabling check-in Sheets integration');
      this.checkinEnabled = false;
    }

    // OAuth token cache (shared across both features)
    this._cachedToken = null;
    this._tokenExpiry = 0;

    this._clientId = process.env.GMAIL_CLIENT_ID;
    this._clientSecret = process.env.GMAIL_CLIENT_SECRET;
    this._refreshToken = process.env.GMAIL_REFRESH_TOKEN;

    if (this.enabled) logger.info(`Sheets checkout integration enabled (spreadsheet: ${this.spreadsheetId})`);
    if (this.checkinEnabled) logger.info(`Sheets check-in integration enabled (spreadsheet: ${this.checkinSpreadsheetId})`);
  }

  /**
   * Get an access token, returning cached token if still valid (with 60s margin).
   */
  async _getAccessToken() {
    if (this._cachedToken && Date.now() < this._tokenExpiry) {
      return this._cachedToken;
    }
    const res = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: this._clientId,
      client_secret: this._clientSecret,
      refresh_token: this._refreshToken,
      grant_type: 'refresh_token'
    });
    this._cachedToken = res.data.access_token;
    this._tokenExpiry = Date.now() + ((res.data.expires_in || 3600) - 60) * 1000;
    return this._cachedToken;
  }

  /**
   * Make an authenticated GET request to the Sheets API
   */
  async _get(path, params = {}, sheetId) {
    const token = await this._getAccessToken();
    const id = sheetId || this.spreadsheetId;
    const res = await axios.get(`${SHEETS_BASE}/${id}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      params
    });
    return res.data;
  }

  /**
   * Make an authenticated POST request to the Sheets API
   */
  async _post(path, body, params = {}, sheetId) {
    const token = await this._getAccessToken();
    const id = sheetId || this.spreadsheetId;
    const res = await axios.post(`${SHEETS_BASE}/${id}${path}`, body, {
      headers: { Authorization: `Bearer ${token}` },
      params
    });
    return res.data;
  }

  /**
   * Make an authenticated PUT request to the Sheets API
   */
  async _put(path, body, params = {}, sheetId) {
    const token = await this._getAccessToken();
    const id = sheetId || this.spreadsheetId;
    const res = await axios.put(`${SHEETS_BASE}/${id}${path}`, body, {
      headers: { Authorization: `Bearer ${token}` },
      params
    });
    return res.data;
  }

  /**
   * Convert YYYY-MM-DD to D/M/YY
   */
  _formatDate(isoDate) {
    if (!isoDate) return '';
    const [y, m, d] = isoDate.split('-');
    return `${parseInt(d)}/${parseInt(m)}/${y.slice(2)}`;
  }

  /**
   * Get Spanish tab name for a given checkout date
   * @param {string} isoDate - YYYY-MM-DD
   */
  _getTabName(isoDate) {
    const [y, m] = isoDate.split('-');
    return `${SPANISH_MONTHS[parseInt(m) - 1]} ${y}`;
  }

  /**
   * Ensure the monthly tab exists; create it from template headers if not.
   * @returns {string} The tab name
   */
  async _ensureTab(tabName) {
    const meta = await this._get('', { fields: 'sheets.properties.title' });
    const existing = meta.sheets.map(s => s.properties.title);

    if (existing.includes(tabName)) return tabName;

    logger.info(`Creating new sheet tab: "${tabName}"`);
    await this._post(':batchUpdate', {
      requests: [{ addSheet: { properties: { title: tabName } } }]
    });

    // Write header row
    const range = encodeURIComponent(`'${tabName}'!A1:G1`);
    await this._put(`/values/${range}`, {
      values: [['HotelID', 'First Name', 'Last Name', 'Email', 'Arrival Date', 'Departure Date', 'Language']]
    }, { valueInputOption: 'RAW' });

    return tabName;
  }

  /**
   * Read existing email+checkout pairs from the tab for deduplication
   */
  async _getExistingKeys(tabName) {
    const keys = new Set();
    try {
      const range = encodeURIComponent(`'${tabName}'!D2:F`);
      const data = await this._get(`/values/${range}`);
      for (const row of (data.values || [])) {
        const email = (row[0] || '').toLowerCase().trim();
        const checkout = (row[2] || '').trim();  // col F = Departure Date
        if (email) keys.add(`${email}|${checkout}`);
      }
    } catch (err) {
      // 404 = empty range, 400 = tab doesn't exist yet — both mean no existing rows
      const status = err.response?.status;
      if (status !== 404 && status !== 400) throw err;
    }
    return keys;
  }

  /**
   * Append checked-out guest rows to the correct monthly tab.
   * Deduplicates by email + checkout date. Rows are sorted by checkout date.
   *
   * @param {Array<{customer: Object, invoice: Object}>} guests
   *   Each guest must have customer.email, customer.firstName, customer.lastName,
   *   customer.language, invoice.checkIn (YYYY-MM-DD), invoice.checkOut (YYYY-MM-DD).
   */
  async appendCheckedOutGuests(guests) {
    if (!this.enabled || guests.length === 0) return;

    // Group guests by checkout month tab
    const byTab = new Map();
    for (const { customer, invoice } of guests) {
      if (!invoice.checkOut) continue;
      const tabName = this._getTabName(invoice.checkOut);
      if (!byTab.has(tabName)) byTab.set(tabName, []);
      byTab.get(tabName).push({ customer, invoice });
    }

    let totalAppended = 0;

    for (const [tabName, tabGuests] of byTab) {
      try {
        await this._ensureTab(tabName);
        const existingKeys = await this._getExistingKeys(tabName);

        // Sort by checkout date ascending
        tabGuests.sort((a, b) => a.invoice.checkOut.localeCompare(b.invoice.checkOut));

        const newRows = [];
        for (const { customer, invoice } of tabGuests) {
          const key = `${customer.email.toLowerCase()}|${this._formatDate(invoice.checkOut)}`;
          if (existingKeys.has(key)) continue;

          newRows.push([
            HOTEL_ID,
            customer.firstName,
            customer.lastName,
            customer.email,
            this._formatDate(invoice.checkIn),
            this._formatDate(invoice.checkOut),
            mapLanguageToSalesforce(customer.language)
          ]);
        }

        if (newRows.length === 0) {
          logger.debug(`Sheets [${tabName}]: all ${tabGuests.length} guests already exist, skipping`);
          continue;
        }

        const range = encodeURIComponent(`'${tabName}'!A:G`);
        await this._post(`/values/${range}:append`, { values: newRows }, {
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS'
        });

        totalAppended += newRows.length;
        logger.info(`Sheets [${tabName}]: appended ${newRows.length} guest(s) (${tabGuests.length - newRows.length} duplicates skipped)`);
      } catch (err) {
        logger.error(`Sheets [${tabName}]: failed to append guests — ${err.message}`);
      }
    }

    if (totalAppended > 0) {
      logger.info(`Sheets: total ${totalAppended} guest(s) added to checkout survey sheet`);
    }
  }

  // ─── Check-in Arrivals Sheet ───────────────────────────────────────

  static get CHECKIN_HEADERS() {
    return [
      'Check-in Date', 'First Name', 'Last Name', 'Email',
      'Departure Date', 'Language', 'Status',
      'Tasting Pre-Scheduled?', 'Offered at Check-in?', 'Scheduled By', 'Decline Reason'
    ];
  }

  /**
   * Get monthly tab name for check-in arrivals (e.g., "Check-ins Marzo 2026")
   */
  _getCheckinTabName(isoDate) {
    const [y, m] = isoDate.split('-');
    return `Check-ins ${SPANISH_MONTHS[parseInt(m) - 1]} ${y}`;
  }

  /**
   * Ensure a check-in monthly tab exists with correct headers.
   * Validates headers on existing tabs to prevent column misalignment.
   * @returns {boolean} true if the tab is ready to use, false if headers mismatch
   */
  async _ensureCheckinTab(tabName) {
    const meta = await this._get('', { fields: 'sheets.properties.title' }, this.checkinSpreadsheetId);
    const existing = meta.sheets.map(s => s.properties.title);

    if (existing.includes(tabName)) {
      // Validate headers on existing tab
      try {
        const range = encodeURIComponent(`'${tabName}'!A1:K1`);
        const data = await this._get(`/values/${range}`, {}, this.checkinSpreadsheetId);
        const headers = (data.values && data.values[0]) || [];
        const expected = SheetsClient.CHECKIN_HEADERS;
        if (headers.length > 0 && headers[0] !== expected[0]) {
          logger.warn(`Sheets check-in [${tabName}]: header mismatch — found "${headers.slice(0, 3).join(', ')}", expected "${expected.slice(0, 3).join(', ')}". Skipping tab to avoid misaligned data.`);
          return false;
        }
      } catch (err) {
        logger.debug(`Sheets check-in [${tabName}]: could not validate headers — ${err.message}`);
      }
      return true;
    }

    logger.info(`Creating check-in tab: "${tabName}"`);
    await this._post(':batchUpdate', {
      requests: [{ addSheet: { properties: { title: tabName } } }]
    }, {}, this.checkinSpreadsheetId);

    const range = encodeURIComponent(`'${tabName}'!A1:K1`);
    await this._put(`/values/${range}`, {
      values: [SheetsClient.CHECKIN_HEADERS]
    }, { valueInputOption: 'RAW' }, this.checkinSpreadsheetId);

    return true;
  }

  /**
   * Read existing email+checkin pairs from a check-in tab for deduplication.
   */
  async _getExistingCheckinKeys(tabName) {
    const keys = new Set();
    try {
      // Columns A (Check-in Date) and D (Email)
      const range = encodeURIComponent(`'${tabName}'!A2:D`);
      const data = await this._get(`/values/${range}`, {}, this.checkinSpreadsheetId);
      for (const row of (data.values || [])) {
        const checkinDate = (row[0] || '').trim();   // col A
        const email = (row[3] || '').toLowerCase().trim(); // col D
        if (email || checkinDate) keys.add(`${email}|${checkinDate}`);
      }
    } catch (err) {
      const status = err.response?.status;
      if (status !== 404 && status !== 400) throw err;
    }
    return keys;
  }

  /**
   * Validate that the OAuth account has access to the check-in spreadsheet.
   * Call during startup to fail loudly rather than silently on each poll.
   */
  async validateCheckinAccess() {
    if (!this.checkinEnabled) return;
    try {
      const meta = await this._get('', { fields: 'sheets.properties.title' }, this.checkinSpreadsheetId);
      logger.info(`Sheets check-in: access verified — spreadsheet has ${meta.sheets.length} tab(s)`);
    } catch (err) {
      const status = err.response?.status;
      if (status === 403 || status === 404) {
        logger.error(`Sheets check-in: cannot access spreadsheet ${this.checkinSpreadsheetId} (HTTP ${status}). Ensure the spreadsheet is shared with the OAuth account. Disabling check-in Sheets.`);
        this.checkinEnabled = false;
      } else {
        logger.warn(`Sheets check-in: startup access check failed — ${err.message} (will retry on first poll)`);
      }
    }
  }

  /**
   * Append check-in arrivals to monthly tabs in the check-in tracking spreadsheet.
   * Deduplicates by email + check-in date. Auto-populates guest info + status;
   * tasting columns are left blank for the team to fill manually.
   *
   * @param {Array<{customer: Object, invoice: Object}>} guests
   *   customer: { firstName, lastName, email, language } (email may be empty for frontDesk guests)
   *   invoice: { checkIn (YYYY-MM-DD), checkOut, resvStatus }
   */
  async appendCheckInGuests(guests) {
    if (!this.checkinEnabled || guests.length === 0) return;

    // Group by monthly tab
    const byTab = new Map();
    for (const guest of guests) {
      if (!guest.invoice || !guest.invoice.checkIn) continue;
      const tabName = this._getCheckinTabName(guest.invoice.checkIn);
      if (!byTab.has(tabName)) byTab.set(tabName, []);
      byTab.get(tabName).push(guest);
    }

    let totalAppended = 0;

    for (const [tabName, tabGuests] of byTab) {
      try {
        const tabOk = await this._ensureCheckinTab(tabName);
        if (!tabOk) continue;

        const existingKeys = await this._getExistingCheckinKeys(tabName);

        tabGuests.sort((a, b) => a.invoice.checkIn.localeCompare(b.invoice.checkIn));

        const newRows = [];
        for (const { customer, invoice } of tabGuests) {
          const email = (customer.email || '').toLowerCase();
          const formattedCheckIn = this._formatDate(invoice.checkIn);
          const key = `${email}|${formattedCheckIn}`;
          if (existingKeys.has(key)) continue;

          newRows.push([
            formattedCheckIn,
            customer.firstName || '',
            customer.lastName || '',
            customer.email || '',
            this._formatDate(invoice.checkOut),
            mapLanguageToSalesforce(customer.language || ''),
            invoice.resvStatus || '',
            '', '', '', ''  // tasting columns — filled manually by team
          ]);
        }

        if (newRows.length === 0) {
          logger.debug(`Sheets check-in [${tabName}]: all ${tabGuests.length} guests already exist, skipping`);
          continue;
        }

        const range = encodeURIComponent(`'${tabName}'!A:K`);
        await this._post(`/values/${range}:append`, { values: newRows }, {
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS'
        }, this.checkinSpreadsheetId);

        totalAppended += newRows.length;
        logger.info(`Sheets check-in [${tabName}]: appended ${newRows.length} arrival(s) (${tabGuests.length - newRows.length} duplicates skipped)`);
      } catch (err) {
        logger.error(`Sheets check-in [${tabName}]: failed to append arrivals — ${err.message}`);
      }
    }

    if (totalAppended > 0) {
      logger.info(`Sheets check-in: total ${totalAppended} arrival(s) added`);
    }
  }
}

module.exports = SheetsClient;
