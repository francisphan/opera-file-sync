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
 * Transform joined data to TVRS_Guest__c format
 * @param {Object} customer - Customer data
 * @param {Object} invoice - Invoice data (optional)
 * @returns {Object} Salesforce record
 */
function transformToTVRSGuest(customer, invoice) {
  const record = {
    // External ID (required for upsert)
    Email__c: customer.email,

    // Guest information
    Guest_First_Name__c: customer.firstName,
    Guest_Last_Name__c: customer.lastName,

    // Address information
    City__c: customer.billingCity,
    State_Province__c: customer.billingState,
    Country__c: customer.billingCountry,

    // Required boolean fields (all default to false)
    Future_Sales_Prospect__c: false,
    TVG__c: false,
    Greeted_at_Check_In__c: false,
    Received_PV_Explanation__c: false,
    Vineyard_Tour__c: false,
    Did_TVG_Tasting_With_Sales_Rep__c: false,
    Did_TVG_Tasting_with_Sommelier__c: false,
    Villa_Tour__c: false,
    Attended_Happy_Hour__c: false,
    Brochure_Clicked__c: false,
    Replied_to_Mkt_campaign_2025__c: false,
    In_Conversation__c: false,
    Not_interested__c: false,
    Ready_for_pardot_email_list__c: false,
    In_Conversation_PV__c: false,
    Follow_up__c: false,
    Ready_for_PV_mail__c: false
  };

  // Add check-in/out dates if available from invoice
  if (invoice) {
    if (invoice.checkIn) {
      record.Check_In_Date__c = convertDateFormat(invoice.checkIn);
    }
    if (invoice.checkOut) {
      record.Check_Out_Date__c = convertDateFormat(invoice.checkOut);
    }
  }

  return record;
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

  // Join customers with invoices and transform
  const records = [];
  for (const [operaId, customer] of customers) {
    // Skip records without email (required for upsert)
    if (!customer.email || !customer.email.includes('@')) {
      logger.debug(`Skipping customer ${operaId} - no valid email`);
      continue;
    }

    const invoice = invoices.get(operaId);
    const record = transformToTVRSGuest(customer, invoice);
    records.push(record);
  }

  logger.info(`Transformed ${records.length} records for Salesforce`);
  return records;
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

module.exports = {
  parseOPERAFiles,
  findMatchingInvoiceFile,
  parseCustomers,
  parseInvoices,
  transformToTVRSGuest,
  convertDateFormat
};
