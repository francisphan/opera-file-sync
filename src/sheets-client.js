/**
 * Google Sheets Client — appends checked-out guest rows to the checkout survey sheet.
 *
 * Reuses existing Gmail OAuth credentials (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN).
 * Each monthly tab is named in Spanish (e.g., "Febrero 2026").
 *
 * Columns: HotelID | First Name | Last Name | Email | Arrival Date | Departure Date | Language
 */

const { google } = require('googleapis');
const logger = require('./logger');
const { mapLanguageToSalesforce } = require('./guest-utils');

const SPANISH_MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

const HOTEL_ID = 'LW7063';

class SheetsClient {
  constructor() {
    this.spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    this.enabled = (process.env.GOOGLE_SHEETS_ENABLED || '').toLowerCase() === 'true';

    if (!this.enabled) {
      logger.info('Google Sheets integration disabled (GOOGLE_SHEETS_ENABLED != true)');
      return;
    }

    if (!this.spreadsheetId) {
      logger.warn('GOOGLE_SHEETS_ID not set — disabling Sheets integration');
      this.enabled = false;
      return;
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

    this.sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    logger.info(`Google Sheets integration enabled (spreadsheet: ${this.spreadsheetId})`);
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
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: 'sheets.properties.title'
    });
    const existing = meta.data.sheets.map(s => s.properties.title);

    if (existing.includes(tabName)) return tabName;

    logger.info(`Creating new sheet tab: "${tabName}"`);
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tabName } } }]
      }
    });

    // Write header row
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `'${tabName}'!A1:G1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['HotelID', 'First Name', 'Last Name', 'Email', 'Arrival Date', 'Departure Date', 'Language']]
      }
    });

    return tabName;
  }

  /**
   * Read existing email+checkout pairs from the tab for deduplication
   */
  async _getExistingKeys(tabName) {
    const keys = new Set();
    try {
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `'${tabName}'!D2:F`  // Email (col D), Arrival (col E), Departure (col F)
      });
      for (const row of (res.data.values || [])) {
        const email = (row[0] || '').toLowerCase().trim();
        const checkout = (row[2] || '').trim();  // col F = Departure Date
        if (email) keys.add(`${email}|${checkout}`);
      }
    } catch (err) {
      // 404 = empty range, 400 = tab doesn't exist yet — both mean no existing rows
      if (err.code !== 404 && err.code !== 400) throw err;
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

        await this.sheets.spreadsheets.values.append({
          spreadsheetId: this.spreadsheetId,
          range: `'${tabName}'!A:G`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: newRows }
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
}

module.exports = SheetsClient;
