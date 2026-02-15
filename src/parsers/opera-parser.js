/**
 * OPERA CSV Parser - Joins customers and invoices files
 *
 * This parser handles the specific OPERA export format from
 * The Vines of Mendoza, joining customer data with invoice data
 * to create complete guest records for Salesforce.
 */

const fs = require('fs');
const path = require('path');
const csvParser = require('csv-parser');
const logger = require('../logger');
const { isAgentEmail, AGENT_DOMAIN_KEYWORDS, transformToTVRSGuest } = require('../guest-utils');

/**
 * Parse customers CSV file
 * @param {string} filePath - Path to customers CSV file
 * @returns {Promise<Map>} Map of Opera Internal ID -> customer data
 */
async function parseCustomers(filePath) {
  return new Promise((resolve, reject) => {
    const customers = new Map();

    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (row) => {
        const operaId = row['Opera Internal ID'];
        if (operaId && operaId.trim()) {
          customers.set(operaId.trim(), {
            operaId: operaId.trim(),
            firstName: row['First Name'] || '',
            lastName: row['Last Name'] || '',
            email: row['Email Address'] || '',
            phone: row['Phone'] || '',
            billingAddress: row['BILLING_ADDRESS'] || '',
            billingCity: row['Billing City'] || '',
            billingState: row['Billing State'] || '',
            billingCountry: row['Billing Country'] || '',
            billingZip: row['Billing Zip'] || ''
          });
        }
      })
      .on('end', () => {
        logger.debug(`Parsed ${customers.size} customers`);
        resolve(customers);
      })
      .on('error', (err) => reject(err));
  });
}

/**
 * Parse invoices CSV file and group by customer
 * @param {string} filePath - Path to invoices CSV file
 * @returns {Promise<Map>} Map of Opera ID -> invoice data
 */
async function parseInvoices(filePath) {
  return new Promise((resolve, reject) => {
    const invoices = new Map();

    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (row) => {
        const customerId = row['CUSTOMER_ID OPERA'];
        if (customerId && customerId.trim()) {
          const id = customerId.trim();

          // Only store the first occurrence (all line items have same check-in/out dates)
          if (!invoices.has(id)) {
            invoices.set(id, {
              checkIn: row['Check in'] || '',
              checkOut: row['Check out'] || '',
              guestName: row['Guest Name'] || ''
            });
          }
        }
      })
      .on('end', () => {
        logger.debug(`Parsed invoices for ${invoices.size} customers`);
        resolve(invoices);
      })
      .on('error', (err) => reject(err));
  });
}

/**
 * Convert DD-MM-YYYY to YYYY-MM-DD format for Salesforce
 * @param {string} dateStr - Date string in DD-MM-YYYY format
 * @returns {string} Date string in YYYY-MM-DD format or empty string
 */
function convertDateFormat(dateStr) {
  if (!dateStr || !dateStr.trim()) return '';

  const parts = dateStr.trim().split('-');
  if (parts.length !== 3) return '';

  // Convert DD-MM-YYYY to YYYY-MM-DD
  const [day, month, year] = parts;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * CSV-specific wrapper: converts DD-MM-YYYY dates before passing to transformToTVRSGuest
 */
function transformToTVRSGuestCSV(customer, invoice) {
  const convertedInvoice = invoice ? {
    checkIn: convertDateFormat(invoice.checkIn),
    checkOut: convertDateFormat(invoice.checkOut)
  } : null;
  return transformToTVRSGuest(customer, convertedInvoice);
}

/**
 * Parse and join OPERA export files
 * @param {string} customersFile - Path to customers CSV
 * @param {string} invoicesFile - Path to invoices CSV (optional)
 * @returns {Promise<Array>} Array of Salesforce records
 */
async function parseOPERAFiles(customersFile, invoicesFile = null) {
  logger.info('Parsing OPERA export files...');
  logger.debug(`Customers file: ${customersFile}`);
  if (invoicesFile) {
    logger.debug(`Invoices file: ${invoicesFile}`);
  }

  // Parse customers file
  const customers = await parseCustomers(customersFile);

  // Parse invoices file if provided
  let invoices = new Map();
  if (invoicesFile && fs.existsSync(invoicesFile)) {
    invoices = await parseInvoices(invoicesFile);
  } else if (invoicesFile) {
    logger.warn(`Invoices file not found: ${invoicesFile}`);
  }

  // Join customers with invoices and transform, filtering out agent emails
  const records = [];
  const filtered = [];
  for (const [operaId, customer] of customers) {
    // Skip records without email (required for upsert)
    if (!customer.email || !customer.email.includes('@')) {
      logger.debug(`Skipping customer ${operaId} - no valid email`);
      continue;
    }

    // Check if this looks like a travel agent / non-guest
    const agentCategory = isAgentEmail(customer);
    if (agentCategory) {
      filtered.push({
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        operaId: customer.operaId,
        category: agentCategory
      });
      continue;
    }

    const invoice = invoices.get(operaId);
    const record = transformToTVRSGuestCSV(customer, invoice);
    records.push(record);
  }

  if (filtered.length > 0) {
    logger.info(`Filtered ${filtered.length} agent/company emails`);
  }
  logger.info(`Transformed ${records.length} guest records for Salesforce`);
  return { records, filtered };
}

/**
 * Find matching invoice file for a customer file
 * @param {string} customersFile - Path to customers CSV
 * @returns {string|null} Path to matching invoices file or null
 */
function findMatchingInvoiceFile(customersFile) {
  const dir = path.dirname(customersFile);
  const basename = path.basename(customersFile);

  // Extract date from customers file (e.g., customers20260212.csv -> 20260212)
  const match = basename.match(/customers(\d{8})\.csv$/i);
  if (!match) return null;

  const date = match[1];
  const invoiceFile = path.join(dir, `invoices${date}.csv`);

  if (fs.existsSync(invoiceFile)) {
    return invoiceFile;
  }

  return null;
}

/**
 * Find matching customers file for an invoices file
 * Checks the same directory first, then the processed directory
 * @param {string} invoicesFile - Path to invoices CSV
 * @param {string} processedDir - Path to processed directory
 * @returns {string|null} Path to matching customers file or null
 */
function findMatchingCustomersFile(invoicesFile, processedDir) {
  const dir = path.dirname(invoicesFile);
  const basename = path.basename(invoicesFile);

  // Extract date from invoices file (e.g., invoices20260212.csv -> 20260212)
  const match = basename.match(/invoices(\d{8})\.csv$/i);
  if (!match) return null;

  const date = match[1];
  const customersFilename = `customers${date}.csv`;

  // Check export directory first
  const inExportDir = path.join(dir, customersFilename);
  if (fs.existsSync(inExportDir)) {
    return inExportDir;
  }

  // Check processed directory
  if (processedDir) {
    const inProcessedDir = path.join(processedDir, customersFilename);
    if (fs.existsSync(inProcessedDir)) {
      return inProcessedDir;
    }
  }

  return null;
}

module.exports = {
  parseOPERAFiles,
  findMatchingInvoiceFile,
  findMatchingCustomersFile,
  isAgentEmail,
  parseCustomers,
  parseInvoices,
  transformToTVRSGuest,
  convertDateFormat
};

// Re-export from guest-utils for backwards compatibility
// isAgentEmail and transformToTVRSGuest are imported at the top
