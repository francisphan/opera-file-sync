#!/usr/bin/env node

/**
 * Test OPERA Parser
 * Tests parsing and joining of OPERA customers + invoices files
 */

require('dotenv').config();
const { parseOPERAFiles, findMatchingInvoiceFile } = require('./src/parsers/opera-parser');
const logger = require('./src/logger');

async function testParser() {
  logger.info('='.repeat(70));
  logger.info('Testing OPERA Parser');
  logger.info('='.repeat(70));

  // Test with local mounted drive
  const customersFile = '/mnt/y/MICROS/opera/export/OPERA/vines/customers20260212.csv';

  logger.info(`\nTest file: ${customersFile}`);

  // Find matching invoice file
  const invoicesFile = findMatchingInvoiceFile(customersFile);
  if (invoicesFile) {
    logger.info(`Found matching invoices: ${invoicesFile}`);
  } else {
    logger.warn('No matching invoices file found');
  }

  try {
    // Parse files
    logger.info('\nParsing files...');
    const records = await parseOPERAFiles(customersFile, invoicesFile);

    logger.info(`\n✅ Successfully parsed ${records.length} records`);

    // Show first 3 records as sample
    logger.info('\nSample records:');
    logger.info('='.repeat(70));

    records.slice(0, 3).forEach((record, index) => {
      logger.info(`\nRecord ${index + 1}:`);
      logger.info(`  Email: ${record.Email__c}`);
      logger.info(`  Name: ${record.Guest_First_Name__c} ${record.Guest_Last_Name__c}`);
      logger.info(`  Check-in: ${record.Check_In_Date__c || 'N/A'}`);
      logger.info(`  Check-out: ${record.Check_Out_Date__c || 'N/A'}`);
    });

    logger.info('\n' + '='.repeat(70));
    logger.info('✅ OPERA Parser Test Passed');
    logger.info('='.repeat(70));

  } catch (err) {
    logger.error('❌ Parser test failed:', err);
    process.exit(1);
  }
}

testParser().catch(err => {
  logger.error('Test failed:', err);
  process.exit(1);
});
