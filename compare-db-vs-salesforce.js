#!/usr/bin/env node

/**
 * Compare Oracle DB guests vs Salesforce TVRS_Guest__c records
 *
 * Produces a markdown report showing:
 * - New records (in Oracle but not Salesforce)
 * - Records that would be updated (different data)
 * - Records already in sync
 *
 * Run: node compare-db-vs-salesforce.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const logger = require('./src/logger');
const OracleClient = require('./src/oracle-client');
const SalesforceClient = require('./src/salesforce-client');
const { isAgentEmail } = require('./src/guest-utils');
const { formatDate } = require('./src/opera-db-query');

logger.level = 'info';

async function queryAllOracleGuests(oracleClient) {
  logger.info('Querying Oracle for all VINES guests with emails...');

  const rows = await oracleClient.query(`
    SELECT n.NAME_ID, n.FIRST, n.LAST,
           p.PHONE_NUMBER AS EMAIL,
           a.CITY, a.STATE, a.COUNTRY,
           rn.CHECK_IN, rn.CHECK_OUT
    FROM OPERA.NAME n
    JOIN OPERA.NAME_PHONE p ON n.NAME_ID = p.NAME_ID
      AND p.PHONE_ROLE = 'EMAIL' AND p.PRIMARY_YN = 'Y'
    LEFT JOIN OPERA.NAME_ADDRESS a ON n.NAME_ID = a.NAME_ID
      AND a.PRIMARY_YN = 'Y' AND a.INACTIVE_DATE IS NULL
    LEFT JOIN (
      SELECT NAME_ID, BEGIN_DATE AS CHECK_IN, END_DATE AS CHECK_OUT,
             ROW_NUMBER() OVER (PARTITION BY NAME_ID ORDER BY BEGIN_DATE DESC) AS rn
      FROM OPERA.RESERVATION_NAME
      WHERE RESORT = 'VINES' AND RESV_STATUS IN ('RESERVED','CHECKED IN','CHECKED OUT')
    ) rn ON n.NAME_ID = rn.NAME_ID AND rn.rn = 1
    WHERE EXISTS (
      SELECT 1 FROM OPERA.RESERVATION_NAME r
      WHERE r.NAME_ID = n.NAME_ID AND r.RESORT = 'VINES'
    )
  `);

  logger.info(`Oracle returned ${rows.length} guest rows`);
  return rows;
}

async function queryAllSalesforceGuests(sfClient) {
  logger.info('Querying Salesforce for all TVRS_Guest__c records...');

  await sfClient.ensureConnected();

  let allRecords = [];
  let query = `SELECT Email__c, Guest_First_Name__c, Guest_Last_Name__c,
                      City__c, State_Province__c, Country__c,
                      Check_In_Date__c, Check_Out_Date__c
               FROM TVRS_Guest__c`;

  let result = await sfClient.connection.query(query);
  allRecords = allRecords.concat(result.records);

  while (!result.done) {
    result = await sfClient.connection.queryMore(result.nextRecordsUrl);
    allRecords = allRecords.concat(result.records);
  }

  logger.info(`Salesforce returned ${allRecords.length} records`);
  return allRecords;
}

function normalize(val) {
  return (val || '').toString().trim().toLowerCase();
}

async function main() {
  logger.info('='.repeat(70));
  logger.info('Oracle DB vs Salesforce Comparison');
  logger.info('='.repeat(70));

  const oracleClient = new OracleClient({
    host: process.env.ORACLE_HOST,
    port: process.env.ORACLE_PORT || '1521',
    sid: process.env.ORACLE_SID,
    service: process.env.ORACLE_SERVICE,
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD
  });

  const sfClient = new SalesforceClient({
    instanceUrl: process.env.SF_INSTANCE_URL,
    clientId: process.env.SF_CLIENT_ID,
    clientSecret: process.env.SF_CLIENT_SECRET,
    refreshToken: process.env.SF_REFRESH_TOKEN
  });

  try {
    await oracleClient.connect();
    await sfClient.connect();

    const oracleRows = await queryAllOracleGuests(oracleClient);
    const sfRecords = await queryAllSalesforceGuests(sfClient);

    // Build SF lookup by email (lowercase)
    const sfByEmail = new Map();
    for (const rec of sfRecords) {
      if (rec.Email__c) {
        sfByEmail.set(rec.Email__c.toLowerCase(), rec);
      }
    }

    // Categorize Oracle records
    const newRecords = [];
    const updates = [];
    const unchanged = [];
    const filteredAgents = [];
    const noEmail = [];

    for (const row of oracleRows) {
      const email = (row.EMAIL || '').trim();
      if (!email || !email.includes('@')) {
        noEmail.push(row);
        continue;
      }

      const customer = {
        operaId: String(row.NAME_ID),
        firstName: (row.FIRST || '').trim(),
        lastName: (row.LAST || '').trim(),
        email,
        billingCity: (row.CITY || '').trim(),
        billingState: (row.STATE || '').trim(),
        billingCountry: (row.COUNTRY || '').trim()
      };

      const agentCategory = isAgentEmail(customer);
      if (agentCategory) {
        filteredAgents.push({ ...customer, category: agentCategory });
        continue;
      }

      const checkIn = row.CHECK_IN ? formatDate(row.CHECK_IN) : '';
      const checkOut = row.CHECK_OUT ? formatDate(row.CHECK_OUT) : '';

      const sfRec = sfByEmail.get(email.toLowerCase());

      if (!sfRec) {
        newRecords.push({ ...customer, checkIn, checkOut });
      } else {
        // Compare fields
        const diffs = [];
        if (normalize(sfRec.Guest_First_Name__c) !== normalize(customer.firstName)) {
          diffs.push({ field: 'First Name', sf: sfRec.Guest_First_Name__c || '', db: customer.firstName });
        }
        if (normalize(sfRec.Guest_Last_Name__c) !== normalize(customer.lastName)) {
          diffs.push({ field: 'Last Name', sf: sfRec.Guest_Last_Name__c || '', db: customer.lastName });
        }
        if (normalize(sfRec.City__c) !== normalize(customer.billingCity)) {
          diffs.push({ field: 'City', sf: sfRec.City__c || '', db: customer.billingCity });
        }
        if (normalize(sfRec.State_Province__c) !== normalize(customer.billingState)) {
          diffs.push({ field: 'State', sf: sfRec.State_Province__c || '', db: customer.billingState });
        }
        if (normalize(sfRec.Country__c) !== normalize(customer.billingCountry)) {
          diffs.push({ field: 'Country', sf: sfRec.Country__c || '', db: customer.billingCountry });
        }

        const sfCheckIn = sfRec.Check_In_Date__c || '';
        const sfCheckOut = sfRec.Check_Out_Date__c || '';
        if (checkIn && sfCheckIn !== checkIn) {
          diffs.push({ field: 'Check-In', sf: sfCheckIn, db: checkIn });
        }
        if (checkOut && sfCheckOut !== checkOut) {
          diffs.push({ field: 'Check-Out', sf: sfCheckOut, db: checkOut });
        }

        if (diffs.length > 0) {
          updates.push({ ...customer, checkIn, checkOut, diffs });
        } else {
          unchanged.push(customer);
        }
      }
    }

    // Write markdown report
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.resolve(`reports/db-vs-salesforce-${today}.md`);

    let md = `# Oracle DB vs Salesforce Comparison Report\n\n`;
    md += `**Generated:** ${new Date().toISOString()}\n\n`;
    md += `## Summary\n\n`;
    md += `| Category | Count |\n`;
    md += `|----------|-------|\n`;
    md += `| Oracle guests (with VINES reservations) | ${oracleRows.length} |\n`;
    md += `| Salesforce TVRS_Guest__c records | ${sfRecords.length} |\n`;
    md += `| Filtered (agents/companies) | ${filteredAgents.length} |\n`;
    md += `| Skipped (no valid email) | ${noEmail.length} |\n`;
    md += `| **New** (in Oracle, not in Salesforce) | **${newRecords.length}** |\n`;
    md += `| **Updates** (data differs) | **${updates.length}** |\n`;
    md += `| Unchanged (already in sync) | ${unchanged.length} |\n\n`;

    // New records
    md += `## New Records (${newRecords.length})\n\n`;
    md += `These guests exist in Oracle but not in Salesforce.\n\n`;
    if (newRecords.length > 0) {
      md += `| Email | Name | City | Country | Check-In | Check-Out |\n`;
      md += `|-------|------|------|---------|----------|----------|\n`;
      for (const r of newRecords) {
        md += `| ${r.email} | ${r.firstName} ${r.lastName} | ${r.billingCity} | ${r.billingCountry} | ${r.checkIn} | ${r.checkOut} |\n`;
      }
    }

    // Updates
    md += `\n## Updates (${updates.length})\n\n`;
    md += `These guests exist in both systems but have different data. The sync would update Salesforce with the Oracle values.\n\n`;
    if (updates.length > 0) {
      md += `| Email | Field | Salesforce Value | Oracle DB Value |\n`;
      md += `|-------|-------|-----------------|----------------|\n`;
      for (const r of updates) {
        for (const d of r.diffs) {
          md += `| ${r.email} | ${d.field} | ${d.sf || '_(empty)_'} | ${d.db || '_(empty)_'} |\n`;
        }
      }
    }

    // Filtered agents
    md += `\n## Filtered Agents/Companies (${filteredAgents.length})\n\n`;
    md += `These would be excluded from sync.\n\n`;
    if (filteredAgents.length > 0) {
      md += `| Email | Name | Category |\n`;
      md += `|-------|------|----------|\n`;
      for (const r of filteredAgents) {
        md += `| ${r.email} | ${r.firstName} ${r.lastName} | ${r.category} |\n`;
      }
    }

    md += `\n---\n*Report generated by compare-db-vs-salesforce.js*\n`;

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, md);

    logger.info('\n' + '='.repeat(70));
    logger.info('Comparison complete');
    logger.info('='.repeat(70));
    logger.info(`  New records:     ${newRecords.length}`);
    logger.info(`  Updates:         ${updates.length}`);
    logger.info(`  Unchanged:       ${unchanged.length}`);
    logger.info(`  Filtered agents: ${filteredAgents.length}`);
    logger.info(`  No email:        ${noEmail.length}`);
    logger.info(`\nReport saved to: ${reportPath}`);

  } finally {
    await oracleClient.close();
  }
}

main().catch(err => {
  logger.error('Fatal error:', err.message);
  if (err.stack) logger.error(err.stack);
  process.exit(1);
});
