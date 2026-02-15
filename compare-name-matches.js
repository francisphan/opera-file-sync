#!/usr/bin/env node

/**
 * Find guests with same name but different email between Oracle and Salesforce.
 * Calculates probability they're the same person based on multiple signals.
 *
 * Run: node compare-name-matches.js
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

function normalize(val) {
  return (val || '').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function nameKey(first, last) {
  const f = normalize(first);
  const l = normalize(last);
  if (!f || !l) return null;
  return `${f}|${l}`;
}

function emailDomain(email) {
  const parts = (email || '').split('@');
  return parts.length === 2 ? parts[1].toLowerCase() : '';
}

/**
 * Calculate probability two records are the same guest (0-100%)
 */
function calculateProbability(db, sf, nameFrequency) {
  let score = 0;
  let maxScore = 0;

  // Name uniqueness (rarer name = higher probability)
  maxScore += 30;
  const freq = nameFrequency || 1;
  if (freq === 1) score += 30;       // Unique name — strong signal
  else if (freq === 2) score += 22;
  else if (freq <= 5) score += 12;
  else if (freq <= 10) score += 5;
  // freq > 10: very common name, +0

  // Same city
  maxScore += 20;
  if (normalize(db.billingCity) && normalize(db.billingCity) === normalize(sf.city)) {
    score += 20;
  }

  // Same country
  maxScore += 10;
  if (normalize(db.billingCountry) && normalize(db.billingCountry) === normalize(sf.country)) {
    score += 10;
  }

  // Same state
  maxScore += 5;
  if (normalize(db.billingState) && normalize(db.billingState) === normalize(sf.state)) {
    score += 5;
  }

  // Email domain match (same company/ISP)
  maxScore += 15;
  const dbDomain = emailDomain(db.email);
  const sfDomain = emailDomain(sf.email);
  if (dbDomain && sfDomain && dbDomain === sfDomain) {
    score += 15;
  }

  // Check-in date proximity (within 3 days = likely same reservation)
  maxScore += 20;
  if (db.checkIn && sf.checkIn) {
    const dbDate = new Date(db.checkIn);
    const sfDate = new Date(sf.checkIn);
    const daysDiff = Math.abs((dbDate - sfDate) / (1000 * 60 * 60 * 24));
    if (daysDiff === 0) score += 20;
    else if (daysDiff <= 3) score += 15;
    else if (daysDiff <= 14) score += 8;
    else if (daysDiff <= 60) score += 3;
  }

  return Math.round((score / maxScore) * 100);
}

async function main() {
  logger.info('='.repeat(70));
  logger.info('Name Match Analysis: Same Name, Different Email');
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

    // Query Oracle
    logger.info('Querying Oracle...');
    const oracleRows = await oracleClient.query(`
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
    logger.info(`Oracle: ${oracleRows.length} guests`);

    // Query Salesforce
    logger.info('Querying Salesforce...');
    await sfClient.ensureConnected();
    let allSf = [];
    let result = await sfClient.connection.query(
      `SELECT Email__c, Guest_First_Name__c, Guest_Last_Name__c,
              City__c, State_Province__c, Country__c,
              Check_In_Date__c, Check_Out_Date__c
       FROM TVRS_Guest__c`
    );
    allSf = allSf.concat(result.records);
    while (!result.done) {
      result = await sfClient.connection.queryMore(result.nextRecordsUrl);
      allSf = allSf.concat(result.records);
    }
    logger.info(`Salesforce: ${allSf.length} records`);

    // Build maps by email and by name
    const sfByEmail = new Map();
    const sfByName = new Map();
    for (const rec of allSf) {
      if (rec.Email__c) sfByEmail.set(rec.Email__c.toLowerCase(), rec);
      const key = nameKey(rec.Guest_First_Name__c, rec.Guest_Last_Name__c);
      if (key) {
        if (!sfByName.has(key)) sfByName.set(key, []);
        sfByName.get(key).push(rec);
      }
    }

    // Count name frequencies across both systems for uniqueness scoring
    const nameFreq = new Map();
    for (const row of oracleRows) {
      const key = nameKey(row.FIRST, row.LAST);
      if (key) nameFreq.set(key, (nameFreq.get(key) || 0) + 1);
    }
    for (const rec of allSf) {
      const key = nameKey(rec.Guest_First_Name__c, rec.Guest_Last_Name__c);
      if (key) nameFreq.set(key, (nameFreq.get(key) || 0) + 1);
    }

    // Find: same name, different email
    const matches = [];

    for (const row of oracleRows) {
      const email = (row.EMAIL || '').trim();
      if (!email || !email.includes('@')) continue;

      const customer = {
        operaId: String(row.NAME_ID),
        firstName: (row.FIRST || '').trim(),
        lastName: (row.LAST || '').trim(),
        email,
        billingCity: (row.CITY || '').trim(),
        billingState: (row.STATE || '').trim(),
        billingCountry: (row.COUNTRY || '').trim()
      };

      if (isAgentEmail(customer)) continue;

      // Skip if email already in SF (that's an update, not a name match issue)
      if (sfByEmail.has(email.toLowerCase())) continue;

      // Check if name matches an SF record with a different email
      const key = nameKey(customer.firstName, customer.lastName);
      if (!key) continue;

      const sfNameMatches = sfByName.get(key);
      if (!sfNameMatches) continue;

      for (const sfRec of sfNameMatches) {
        if (sfRec.Email__c && sfRec.Email__c.toLowerCase() === email.toLowerCase()) continue;

        const dbData = {
          ...customer,
          checkIn: row.CHECK_IN ? formatDate(row.CHECK_IN) : '',
          checkOut: row.CHECK_OUT ? formatDate(row.CHECK_OUT) : ''
        };
        const sfData = {
          email: sfRec.Email__c,
          city: sfRec.City__c || '',
          state: sfRec.State_Province__c || '',
          country: sfRec.Country__c || '',
          checkIn: sfRec.Check_In_Date__c || '',
          checkOut: sfRec.Check_Out_Date__c || ''
        };

        const prob = calculateProbability(dbData, sfData, nameFreq.get(key));

        matches.push({
          name: `${customer.firstName} ${customer.lastName}`,
          operaId: customer.operaId,
          dbEmail: email,
          sfEmail: sfRec.Email__c,
          probability: prob,
          dbCity: customer.billingCity,
          sfCity: sfData.city,
          dbCountry: customer.billingCountry,
          sfCountry: sfData.country,
          dbCheckIn: dbData.checkIn,
          sfCheckIn: sfData.checkIn,
          nameFrequency: nameFreq.get(key),
          domainMatch: emailDomain(email) === emailDomain(sfRec.Email__c)
        });
      }
    }

    // Sort by probability descending
    matches.sort((a, b) => b.probability - a.probability);

    // Write report
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.resolve(`reports/name-match-analysis-${today}.md`);

    let md = `# Same Name, Different Email — Duplicate Analysis\n\n`;
    md += `**Generated:** ${new Date().toISOString()}\n\n`;

    // Summary by probability bucket
    const high = matches.filter(m => m.probability >= 70);
    const medium = matches.filter(m => m.probability >= 40 && m.probability < 70);
    const low = matches.filter(m => m.probability < 40);

    md += `## Summary\n\n`;
    md += `| Probability | Count | Description |\n`;
    md += `|-------------|-------|-------------|\n`;
    md += `| **70-100%** (Likely same person) | **${high.length}** | Strong match on location, dates, or unique name |\n`;
    md += `| **40-69%** (Possible match) | **${medium.length}** | Some signals match |\n`;
    md += `| **0-39%** (Unlikely) | **${low.length}** | Common name, few matching signals |\n`;
    md += `| **Total** | **${matches.length}** | |\n\n`;

    md += `### Scoring Factors\n\n`;
    md += `| Factor | Weight | Description |\n`;
    md += `|--------|--------|-------------|\n`;
    md += `| Name uniqueness | 30% | Rare names score higher |\n`;
    md += `| Same city | 20% | Exact city match |\n`;
    md += `| Check-in proximity | 20% | Dates within a few days |\n`;
    md += `| Email domain match | 15% | Same @domain |\n`;
    md += `| Same country | 10% | Country match |\n`;
    md += `| Same state | 5% | State/province match |\n\n`;

    // High probability matches
    md += `## High Probability (70-100%) — ${high.length} matches\n\n`;
    if (high.length > 0) {
      md += `| Prob | Name | Oracle Email | SF Email | Oracle City | SF City | DB Check-In | SF Check-In |\n`;
      md += `|------|------|-------------|----------|-------------|---------|-------------|-------------|\n`;
      for (const m of high) {
        md += `| ${m.probability}% | ${m.name} | ${m.dbEmail} | ${m.sfEmail} | ${m.dbCity} | ${m.sfCity} | ${m.dbCheckIn} | ${m.sfCheckIn} |\n`;
      }
    } else {
      md += `_None found._\n`;
    }

    // Medium probability
    md += `\n## Medium Probability (40-69%) — ${medium.length} matches\n\n`;
    if (medium.length > 0) {
      md += `| Prob | Name | Oracle Email | SF Email | Oracle City | SF City | DB Check-In | SF Check-In |\n`;
      md += `|------|------|-------------|----------|-------------|---------|-------------|-------------|\n`;
      for (const m of medium) {
        md += `| ${m.probability}% | ${m.name} | ${m.dbEmail} | ${m.sfEmail} | ${m.dbCity} | ${m.sfCity} | ${m.dbCheckIn} | ${m.sfCheckIn} |\n`;
      }
    } else {
      md += `_None found._\n`;
    }

    // Low probability
    md += `\n## Low Probability (0-39%) — ${low.length} matches\n\n`;
    if (low.length > 0) {
      md += `| Prob | Name | Oracle Email | SF Email | Name Freq |\n`;
      md += `|------|------|-------------|----------|-----------|\n`;
      for (const m of low) {
        md += `| ${m.probability}% | ${m.name} | ${m.dbEmail} | ${m.sfEmail} | ${m.nameFrequency} |\n`;
      }
    } else {
      md += `_None found._\n`;
    }

    md += `\n---\n*Report generated by compare-name-matches.js*\n`;

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, md);

    logger.info('\n' + '='.repeat(70));
    logger.info('Analysis complete');
    logger.info('='.repeat(70));
    logger.info(`  Total name matches with different email: ${matches.length}`);
    logger.info(`  High probability (70-100%): ${high.length}`);
    logger.info(`  Medium probability (40-69%): ${medium.length}`);
    logger.info(`  Low probability (0-39%):     ${low.length}`);
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
