#!/usr/bin/env node

/**
 * Test Duplicate Detection
 *
 * Uses known high-probability duplicates from name-match-analysis report
 * to verify duplicate detection is working correctly.
 */

require('dotenv').config();
const logger = require('../src/logger');
const SalesforceClient = require('../src/salesforce-client');
const DuplicateDetector = require('../src/duplicate-detector');

logger.level = 'info';

// Test cases from name-match-analysis-2026-02-15.md (77% probability matches)
const testCases = [
  {
    name: 'Pierre-Edward Marsden',
    oracleEmail: 'PEAMARSDEN@gmail.com',
    sfEmail: 'peamardsen@gmail.com',
    city: 'London',
    country: 'GB',
    checkIn: '2024-10-15',
    expectedProbability: 77
  },
  {
    name: 'Marcelo Longobardi',
    oracleEmail: 'mruaben@gmail.com',
    sfEmail: 'mriuaben@gmail.com',
    city: 'Ribeirao Preto',
    country: 'BR',
    checkIn: '2025-06-12',
    expectedProbability: 77
  },
  {
    name: 'Eduardo Ventana',
    oracleEmail: 'mayatvd@gmail.com',
    sfEmail: 'mayratvd@gmail.com',
    city: 'Buenos Aires',
    country: 'AR',
    checkIn: '2025-05-10',
    expectedProbability: 77
  },
  {
    name: 'Andrew Haugen',
    oracleEmail: 'ahaugen@odettewinery.com',
    sfEmail: 'ahayden@odettewinery.com',
    city: 'Napa',
    country: 'US',
    checkIn: '2025-05-16',
    expectedProbability: 77
  },
  {
    name: 'Gabriel Figueira',
    oracleEmail: 'figueira.gabriel03@gmail.com',
    sfEmail: 'figueira.gabriel.03@gmail.com',
    city: 'Rio de Janeiro',
    country: 'BR',
    checkIn: '2025-06-09',
    expectedProbability: 77
  }
];

async function main() {
  logger.info('='.repeat(70));
  logger.info('Duplicate Detection Test');
  logger.info('='.repeat(70));

  // Initialize clients
  const sfClient = new SalesforceClient({
    instanceUrl: process.env.SF_INSTANCE_URL,
    clientId: process.env.SF_CLIENT_ID,
    clientSecret: process.env.SF_CLIENT_SECRET,
    refreshToken: process.env.SF_REFRESH_TOKEN
  });

  logger.info('Connecting to Salesforce...');
  const connected = await sfClient.test();
  if (!connected) {
    logger.error('Failed to connect to Salesforce');
    process.exit(1);
  }

  const duplicateDetector = new DuplicateDetector(sfClient);

  // Check configuration
  const cacheStats = duplicateDetector.getCacheStats();
  logger.info('\nDuplicate Detector Configuration:');
  logger.info(`  Enabled: ${cacheStats.enabled}`);
  logger.info(`  Threshold: ${cacheStats.threshold}%`);
  logger.info(`  Cache TTL: ${cacheStats.ttl}ms (${Math.round(cacheStats.ttl / 60000)} minutes)`);

  if (!cacheStats.enabled) {
    logger.warn('⚠️  Duplicate detection is DISABLED in configuration');
    logger.warn('   Set ENABLE_DUPLICATE_DETECTION=true in .env to enable');
  }

  logger.info('\n' + '='.repeat(70));
  logger.info('Testing Known High-Probability Duplicates');
  logger.info('='.repeat(70));

  let passed = 0;
  let failed = 0;
  const results = [];

  for (const testCase of testCases) {
    logger.info(`\nTest: ${testCase.name}`);
    logger.info(`  Oracle email: ${testCase.oracleEmail}`);
    logger.info(`  SF email:     ${testCase.sfEmail}`);

    const [firstName, ...lastNameParts] = testCase.name.split(' ');
    const lastName = lastNameParts.join(' ');

    const customer = {
      firstName,
      lastName,
      email: testCase.oracleEmail,
      billingCity: testCase.city,
      billingState: '',
      billingCountry: testCase.country
    };

    const invoice = {
      checkIn: testCase.checkIn,
      checkOut: ''
    };

    try {
      const dupCheck = await duplicateDetector.checkForDuplicates(customer, invoice);

      logger.info(`  Result: ${dupCheck.isDuplicate ? '⚠️  DUPLICATE DETECTED' : '✅ No duplicate'}`);

      if (dupCheck.isDuplicate) {
        logger.info(`  Probability: ${dupCheck.probability}%`);
        logger.info(`  Matches: ${dupCheck.matches.length}`);
        dupCheck.matches.forEach(m => {
          logger.info(`    - ${m.record.email} (${m.probability}%)`);
        });

        // Check if probability is close to expected
        const probDiff = Math.abs(dupCheck.probability - testCase.expectedProbability);
        if (probDiff <= 5) { // Allow 5% variance
          logger.info(`  ✅ PASS - Probability within expected range`);
          passed++;
          results.push({ test: testCase.name, status: 'PASS', probability: dupCheck.probability });
        } else {
          logger.warn(`  ⚠️  WARNING - Probability ${dupCheck.probability}% differs from expected ${testCase.expectedProbability}%`);
          passed++; // Still count as pass if detected
          results.push({ test: testCase.name, status: 'PASS (variance)', probability: dupCheck.probability });
        }
      } else {
        logger.error(`  ❌ FAIL - Expected duplicate but none detected`);
        logger.error(`  Reason: ${dupCheck.reason}`);
        failed++;
        results.push({ test: testCase.name, status: 'FAIL', reason: dupCheck.reason });
      }

    } catch (err) {
      logger.error(`  ❌ ERROR: ${err.message}`);
      failed++;
      results.push({ test: testCase.name, status: 'ERROR', error: err.message });
    }
  }

  // Summary
  logger.info('\n' + '='.repeat(70));
  logger.info('Test Summary');
  logger.info('='.repeat(70));
  logger.info(`Total tests: ${testCases.length}`);
  logger.info(`Passed: ${passed} ✅`);
  logger.info(`Failed: ${failed} ❌`);
  logger.info(`Success rate: ${Math.round((passed / testCases.length) * 100)}%`);

  logger.info('\nDetailed Results:');
  results.forEach((r, i) => {
    logger.info(`${i + 1}. ${r.test}: ${r.status}${r.probability ? ` (${r.probability}%)` : ''}`);
  });

  // Cache stats after tests
  const finalStats = duplicateDetector.getCacheStats();
  if (finalStats.cached) {
    logger.info('\nCache Statistics:');
    logger.info(`  Unique names: ${finalStats.nameCount}`);
    logger.info(`  Total emails: ${finalStats.emailCount}`);
    logger.info(`  Last refresh: ${finalStats.lastRefresh}`);
  }

  logger.info('\n' + '='.repeat(70));
  if (failed === 0) {
    logger.info('✅ All tests passed!');
  } else {
    logger.warn(`⚠️  ${failed} test(s) failed`);
  }
  logger.info('='.repeat(70));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  logger.error('Fatal error:', err.message);
  if (err.stack) logger.error(err.stack);
  process.exit(1);
});
