#!/usr/bin/env node

/**
 * Test Single Record Sync
 * Tests syncing a single test record to TVRS_Guest__c
 */

require('dotenv').config();
const SalesforceClient = require('../src/salesforce-client');
const logger = require('../src/logger');

async function testSingleRecord() {
  logger.info('='.repeat(70));
  logger.info('Testing Single Record Sync to TVRS Guest');
  logger.info('='.repeat(70));

  // Create test record
  const testRecord = {
    Email__c: 'francis.phan@vinesofmendoza.com',
    Guest_First_Name__c: 'Francis',
    Guest_Last_Name__c: 'Phan',
    City__c: 'Cambridge',
    State_Province__c: 'Massachusetts',
    Country__c: 'United States',
    Check_In_Date__c: '2026-02-10',
    Check_Out_Date__c: '2026-02-13',

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

  logger.info('\nTest Record:');
  logger.info(`  Email: ${testRecord.Email__c}`);
  logger.info(`  Name: ${testRecord.Guest_First_Name__c} ${testRecord.Guest_Last_Name__c}`);
  logger.info(`  Location: ${testRecord.City__c}, ${testRecord.State_Province__c}, ${testRecord.Country__c}`);
  logger.info(`  Check-in: ${testRecord.Check_In_Date__c}`);
  logger.info(`  Check-out: ${testRecord.Check_Out_Date__c}`);

  // Initialize Salesforce client
  logger.info('\nConnecting to Salesforce...');
  const sfClient = new SalesforceClient({
    instanceUrl: process.env.SF_INSTANCE_URL,
    clientId: process.env.SF_CLIENT_ID,
    clientSecret: process.env.SF_CLIENT_SECRET,
    refreshToken: process.env.SF_REFRESH_TOKEN
  });

  try {
    await sfClient.connect();
    logger.info('✅ Connected to Salesforce');

    // Sync record
    logger.info('\nSyncing record to TVRS_Guest__c...');
    const results = await sfClient.syncRecords(
      [testRecord],
      'TVRS_Guest__c',
      'Email__c'
    );

    logger.info('\n' + '='.repeat(70));
    if (results.success > 0) {
      logger.info('✅ SUCCESS!');
      logger.info(`  Records synced: ${results.success}`);
      logger.info(`  Records failed: ${results.failed}`);

      if (results.failed > 0) {
        logger.error('\nErrors:');
        results.errors.forEach((err, index) => {
          logger.error(`  ${index + 1}. ${err}`);
        });
      }

      logger.info('\n🔍 Check Salesforce:');
      logger.info(`  https://thevinesofmendoza2.lightning.force.com/lightning/r/TVRS_Guest__c/a0g8b00001aEHRfAAO/view`);
      logger.info(`  Search for: ${testRecord.Email__c}`);
    } else {
      logger.error('❌ FAILED');
      logger.error('All records failed to sync');
      if (results.errors.length > 0) {
        logger.error('\nErrors:');
        results.errors.forEach((err, index) => {
          logger.error(`  ${index + 1}. ${err}`);
        });
      }
    }
    logger.info('='.repeat(70));

  } catch (err) {
    logger.error('❌ Test failed:', err.message);
    if (err.stack) {
      logger.debug('Stack trace:', err.stack);
    }
    process.exit(1);
  }
}

testSingleRecord().catch(err => {
  logger.error('Test failed:', err);
  process.exit(1);
});
