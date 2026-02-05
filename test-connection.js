#!/usr/bin/env node

/**
 * Test Salesforce connection
 *
 * Run this script to verify your Salesforce credentials are working.
 */

require('dotenv').config();
const SalesforceClient = require('./src/salesforce-client');
const logger = require('./src/logger');

async function testConnection() {
  logger.info('='.repeat(70));
  logger.info('Testing Salesforce Connection');
  logger.info('='.repeat(70));

  // Check environment variables
  const required = ['SF_INSTANCE_URL', 'SF_CLIENT_ID', 'SF_CLIENT_SECRET', 'SF_REFRESH_TOKEN'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    logger.error('Missing required environment variables:');
    missing.forEach(key => logger.error(`  - ${key}`));
    logger.error('\nPlease create a .env file with these values.');
    process.exit(1);
  }

  logger.info('Configuration:');
  logger.info(`  Instance URL: ${process.env.SF_INSTANCE_URL}`);
  logger.info(`  Client ID: ${process.env.SF_CLIENT_ID.substring(0, 10)}...`);
  logger.info(`  Client Secret: ${process.env.SF_CLIENT_SECRET.substring(0, 10)}...`);
  logger.info(`  Refresh Token: ${process.env.SF_REFRESH_TOKEN.substring(0, 10)}...`);
  logger.info('');

  // Create client
  const client = new SalesforceClient({
    instanceUrl: process.env.SF_INSTANCE_URL,
    clientId: process.env.SF_CLIENT_ID,
    clientSecret: process.env.SF_CLIENT_SECRET,
    refreshToken: process.env.SF_REFRESH_TOKEN
  });

  // Test connection
  const success = await client.test();

  logger.info('='.repeat(70));
  if (success) {
    logger.info('✓ CONNECTION TEST PASSED');
    logger.info('Your Salesforce credentials are working correctly!');
  } else {
    logger.error('✗ CONNECTION TEST FAILED');
    logger.error('Please check your credentials and try again.');
  }
  logger.info('='.repeat(70));

  process.exit(success ? 0 : 1);
}

testConnection();
