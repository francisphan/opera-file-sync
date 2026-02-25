#!/usr/bin/env node
/**
 * Repeat Guests Report
 *
 * Queries the Opera Oracle database for all guests with multiple reservations
 * at VINES, then cross-references Salesforce for associated Opportunities,
 * and sends an HTML email report.
 *
 * Usage:
 *   node scripts/repeat-guests-report.js                  # print to console
 *   node scripts/repeat-guests-report.js --email           # also send email report
 *   node scripts/repeat-guests-report.js --min-stays 3     # minimum stays (default: 2)
 */

'use strict';
require('dotenv').config();

const jsforce      = require('jsforce');
const OracleClient = require('../src/oracle-client');
const Notifier     = require('../src/notifier');
const { sanitizeEmail, isAgentEmail, mapLanguageToSalesforce } = require('../src/guest-utils');

// ── Config ────────────────────────────────────────────────────────────────────

const SEND_EMAIL   = process.argv.includes('--email');
const MIN_STAYS    = (() => { const i = process.argv.indexOf('--min-stays'); return i !== -1 ? parseInt(process.argv[i + 1]) || 2 : 2; })();
const BATCH_SIZE   = parseInt(process.env.BATCH_SIZE) || 200;

// ── SF connection (read-only) ─────────────────────────────────────────────────

function connectSF() {
  return new jsforce.Connection({
    oauth2: {
      loginUrl: 'https://login.salesforce.com',
      clientId: process.env.SF_CLIENT_ID,
      clientSecret: process.env.SF_CLIENT_SECRET,
      redirectUri: 'http://localhost:3000/oauth/callback',
    },
    instanceUrl: process.env.SF_INSTANCE_URL,
    refreshToken: process.env.SF_REFRESH_TOKEN,
    version: '59.0',
  });
}

async function sfQueryAll(conn, soql) {
  let res = await conn.query(soql);
  const records = [...res.records];
  while (!res.done) {
    res = await conn.queryMore(res.nextRecordsUrl);
    records.push(...res.records);
  }
  return records;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hr(char = '─', len = 72) { return char.repeat(len); }
function section(title) {
  console.log('\n' + hr());
  console.log('  ' + title);
  console.log(hr());
}
function row(label, value) {
  console.log(`  ${label.padEnd(42)}${value}`);
}
function formatDate(date) {
  if (!date || !(date instanceof Date)) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();

  console.log('\n' + hr('═'));
  console.log('  REPEAT GUESTS REPORT (Opera Source)');
  console.log(`  Run at: ${now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })} (ART)`);
  console.log(`  Minimum stays: ${MIN_STAYS}`);
  console.log(hr('═'));

  // ── 1. Connect to Oracle ──────────────────────────────────────────────────

  section('Oracle Database Connection');

  const oracleClient = new OracleClient({
    host    : process.env.ORACLE_HOST,
    port    : process.env.ORACLE_PORT || '1521',
    sid     : process.env.ORACLE_SID,
    service : process.env.ORACLE_SERVICE,
    user    : process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
  });

  await oracleClient.connect();
  console.log('  Connected to Oracle.');

  // ── 2. Query repeat guests directly from Opera ────────────────────────────

  section('Querying Opera for Repeat Guests');

  // Find all NAME_IDs with MIN_STAYS+ reservations at VINES
  const repeatRows = await oracleClient.query(`
    SELECT rn.NAME_ID, COUNT(*) AS STAY_COUNT
    FROM OPERA.RESERVATION_NAME rn
    WHERE rn.RESORT = 'VINES'
      AND rn.RESV_STATUS IN ('CHECKED IN', 'CHECKED OUT', 'RESERVED')
    GROUP BY rn.NAME_ID
    HAVING COUNT(*) >= :minStays
    ORDER BY COUNT(*) DESC
  `, { minStays: MIN_STAYS });

  console.log(`  Found ${repeatRows.length} guests with ${MIN_STAYS}+ reservations.`);

  if (repeatRows.length === 0) {
    console.log('\n  No repeat guests found. Report complete.');
    await oracleClient.close();
    process.exit(0);
  }

  // ── 3. Fetch full details for each repeat guest ───────────────────────────

  section('Fetching Guest Details from Opera');

  const nameIds = repeatRows.map(r => r.NAME_ID);
  const stayCountMap = new Map(repeatRows.map(r => [r.NAME_ID, r.STAY_COUNT]));

  // Batch-query guest profile info
  const guestProfiles = new Map(); // nameId → { firstName, lastName, email, phone, ... }
  const batchSizeOracle = 50;

  for (let i = 0; i < nameIds.length; i += batchSizeOracle) {
    const batch = nameIds.slice(i, i + batchSizeOracle);
    const binds = {};
    const placeholders = batch.map((id, idx) => {
      binds[`id${idx}`] = id;
      return `:id${idx}`;
    });

    const rows = await oracleClient.query(`
      SELECT n.NAME_ID, n.FIRST, n.LAST, n.LANGUAGE,
             p.PHONE_NUMBER AS EMAIL,
             phone.PHONE_NUMBER AS PHONE,
             a.CITY, a.STATE, a.COUNTRY
      FROM OPERA.NAME n
      JOIN OPERA.NAME_PHONE p ON n.NAME_ID = p.NAME_ID
        AND p.PHONE_ROLE = 'EMAIL' AND p.PRIMARY_YN = 'Y'
      LEFT JOIN (
        SELECT NAME_ID, PHONE_NUMBER,
               ROW_NUMBER() OVER (PARTITION BY NAME_ID ORDER BY
                 CASE PHONE_ROLE WHEN 'MOBILE' THEN 1 WHEN 'PHONE' THEN 2 ELSE 3 END) AS rn
        FROM OPERA.NAME_PHONE
        WHERE PHONE_ROLE IN ('PHONE', 'MOBILE') AND PRIMARY_YN = 'Y'
      ) phone ON n.NAME_ID = phone.NAME_ID AND phone.rn = 1
      LEFT JOIN OPERA.NAME_ADDRESS a ON n.NAME_ID = a.NAME_ID
        AND a.PRIMARY_YN = 'Y' AND a.INACTIVE_DATE IS NULL
      WHERE n.NAME_ID IN (${placeholders.join(',')})
    `, binds);

    for (const r of rows) {
      const rawEmail = (r.EMAIL || '').trim();
      const cleanedEmail = sanitizeEmail(rawEmail);
      if (!cleanedEmail) continue;

      const customer = {
        operaId: String(r.NAME_ID),
        firstName: (r.FIRST || '').trim(),
        lastName: (r.LAST || '').trim(),
        email: cleanedEmail,
        phone: (r.PHONE || '').trim(),
        language: (r.LANGUAGE || '').trim(),
        city: (r.CITY || '').trim(),
        state: (r.STATE || '').trim(),
        country: (r.COUNTRY || '').trim(),
      };

      // Skip agents
      if (isAgentEmail(customer)) continue;

      // Skip internal staff (any email domain containing "vines")
      const emailDomain = customer.email.toLowerCase().split('@')[1] || '';
      if (emailDomain.includes('vines')) continue;

      guestProfiles.set(r.NAME_ID, customer);
    }
  }

  console.log(`  Fetched profiles for ${guestProfiles.size} valid guests (after filtering agents/invalid).`);

  // ── 4. Fetch all reservation dates for repeat guests ──────────────────────

  section('Fetching Reservation History from Opera');

  const validNameIds = [...guestProfiles.keys()];
  const guestStays = new Map(); // nameId → [{checkIn, checkOut, status}, ...]

  for (let i = 0; i < validNameIds.length; i += batchSizeOracle) {
    const batch = validNameIds.slice(i, i + batchSizeOracle);
    const binds = {};
    const placeholders = batch.map((id, idx) => {
      binds[`id${idx}`] = id;
      return `:id${idx}`;
    });

    const rows = await oracleClient.query(`
      SELECT NAME_ID, BEGIN_DATE AS CHECK_IN, END_DATE AS CHECK_OUT, RESV_STATUS
      FROM OPERA.RESERVATION_NAME
      WHERE RESORT = 'VINES'
        AND RESV_STATUS IN ('CHECKED IN', 'CHECKED OUT', 'RESERVED')
        AND NAME_ID IN (${placeholders.join(',')})
      ORDER BY NAME_ID, BEGIN_DATE DESC
    `, binds);

    for (const r of rows) {
      if (!guestStays.has(r.NAME_ID)) guestStays.set(r.NAME_ID, []);
      guestStays.get(r.NAME_ID).push({
        checkIn: formatDate(r.CHECK_IN),
        checkOut: formatDate(r.CHECK_OUT),
        status: r.RESV_STATUS,
      });
    }
  }

  await oracleClient.close();

  // Filter to guests that still have MIN_STAYS+ after profile filtering
  const repeatGuestList = validNameIds
    .filter(id => (guestStays.get(id) || []).length >= MIN_STAYS);

  console.log(`  ${repeatGuestList.length} guests with ${MIN_STAYS}+ stays (with valid email, excluding agents).`);

  // ── 5. Connect to Salesforce and check Opportunities ──────────────────────

  section('Salesforce — Checking Opportunities');

  const sfConn = connectSF();
  const identity = await sfConn.identity();
  console.log(`  Connected as ${identity.username}`);

  // Look up SF Contacts by email for our repeat guests
  const emails = repeatGuestList.map(id => guestProfiles.get(id).email.toLowerCase());
  const uniqueEmails = [...new Set(emails)];

  console.log(`  Looking up ${uniqueEmails.length} unique emails in Salesforce Contacts...`);

  const emailToContactId = new Map(); // email → contactId

  for (let i = 0; i < uniqueEmails.length; i += BATCH_SIZE) {
    const batch = uniqueEmails.slice(i, i + BATCH_SIZE);
    const escaped = batch.map(e => `'${e.replace(/'/g, "\\'")}'`).join(',');
    const contacts = await sfQueryAll(sfConn,
      `SELECT Id, Email, AccountId FROM Contact WHERE Email IN (${escaped})`
    );
    for (const c of contacts) {
      const email = c.Email.toLowerCase();
      // Take first match if multiple
      if (!emailToContactId.has(email)) {
        emailToContactId.set(email, { contactId: c.Id, accountId: c.AccountId });
      }
    }
  }

  console.log(`  Found ${emailToContactId.size} matching SF Contacts.`);

  // Query Opportunities via OpportunityContactRole
  const contactIds = [...new Set([...emailToContactId.values()].map(v => v.contactId))];
  const opportunityMap = new Map(); // contactId → [Opportunity records]

  if (contactIds.length > 0) {
    console.log(`  Checking Opportunities for ${contactIds.length} Contacts...`);

    for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
      const batch = contactIds.slice(i, i + BATCH_SIZE);
      const escaped = batch.map(id => `'${id}'`).join(',');

      try {
        const roles = await sfQueryAll(sfConn,
          `SELECT ContactId, OpportunityId, Opportunity.Name, Opportunity.StageName,
                  Opportunity.Amount, Opportunity.CloseDate, Opportunity.IsClosed, Opportunity.IsWon
           FROM OpportunityContactRole
           WHERE ContactId IN (${escaped})`
        );
        for (const role of roles) {
          const cid = role.ContactId;
          if (!opportunityMap.has(cid)) opportunityMap.set(cid, []);
          opportunityMap.get(cid).push({
            id: role.OpportunityId,
            name: role.Opportunity?.Name || '',
            stage: role.Opportunity?.StageName || '',
            amount: role.Opportunity?.Amount,
            closeDate: role.Opportunity?.CloseDate,
            isClosed: role.Opportunity?.IsClosed,
            isWon: role.Opportunity?.IsWon,
          });
        }
      } catch (err) {
        console.warn(`  Warning querying OpportunityContactRole: ${err.message}`);
        console.log('  Trying fallback via Account → Opportunity...');

        const accountIds = [...new Set(
          batch.map(id => {
            for (const [, v] of emailToContactId) {
              if (v.contactId === id) return v.accountId;
            }
            return null;
          }).filter(Boolean)
        )];

        if (accountIds.length > 0) {
          const accEscaped = accountIds.map(id => `'${id}'`).join(',');
          try {
            const opps = await sfQueryAll(sfConn,
              `SELECT Id, Name, StageName, Amount, CloseDate, IsClosed, IsWon, AccountId
               FROM Opportunity WHERE AccountId IN (${accEscaped})`
            );
            const accountOpps = new Map();
            for (const opp of opps) {
              if (!accountOpps.has(opp.AccountId)) accountOpps.set(opp.AccountId, []);
              accountOpps.get(opp.AccountId).push({
                id: opp.Id, name: opp.Name || '', stage: opp.StageName || '',
                amount: opp.Amount, closeDate: opp.CloseDate,
                isClosed: opp.IsClosed, isWon: opp.IsWon,
              });
            }
            for (const cid of batch) {
              for (const [, v] of emailToContactId) {
                if (v.contactId === cid && v.accountId && accountOpps.has(v.accountId)) {
                  opportunityMap.set(cid, accountOpps.get(v.accountId));
                }
              }
            }
          } catch (err2) {
            console.warn(`  Warning querying Opportunities via Account: ${err2.message}`);
          }
        }
        break;
      }
    }
  }

  // ── 6. Build report data ──────────────────────────────────────────────────

  section('Building Report');

  const sortedGuests = repeatGuestList
    .map(nameId => {
      const profile = guestProfiles.get(nameId);
      const stays = guestStays.get(nameId) || [];
      const email = profile.email.toLowerCase();
      const sfInfo = emailToContactId.get(email);
      const contactId = sfInfo?.contactId;
      const opps = contactId ? (opportunityMap.get(contactId) || []) : [];

      return {
        nameId,
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: profile.email,
        phone: profile.phone,
        country: profile.country,
        city: profile.city,
        language: mapLanguageToSalesforce(profile.language),
        stayCount: stays.length,
        firstStay: stays.length > 0 ? stays[stays.length - 1].checkIn : '',
        lastStay: stays.length > 0 ? stays[0].checkIn : '',
        stays,
        inSalesforce: !!sfInfo,
        hasOpportunity: opps.length > 0,
        opportunities: opps,
      };
    })
    .sort((a, b) => b.stayCount - a.stayCount);

  const withOpps = sortedGuests.filter(g => g.hasOpportunity);
  const withoutOpps = sortedGuests.filter(g => !g.hasOpportunity);
  const notInSF = sortedGuests.filter(g => !g.inSalesforce);

  // Console output
  const topN = 25;
  console.log(`\n  Top ${Math.min(topN, sortedGuests.length)} repeat guests:`);
  console.log(`  ${'Name'.padEnd(28)} ${'Email'.padEnd(33)} ${'Stays'.padEnd(6)} ${'In SF'.padEnd(6)} ${'Opp?'.padEnd(5)}`);
  console.log(`  ${'-'.repeat(28)} ${'-'.repeat(33)} ${'-'.repeat(6)} ${'-'.repeat(6)} ${'-'.repeat(5)}`);
  sortedGuests.slice(0, topN).forEach(g => {
    const name = `${g.firstName} ${g.lastName}`.trim().substring(0, 27);
    const email = g.email.substring(0, 32);
    const sf = g.inSalesforce ? 'YES' : 'NO';
    const opp = g.hasOpportunity ? 'YES' : 'NO';
    console.log(`  ${name.padEnd(28)} ${email.padEnd(33)} ${String(g.stayCount).padEnd(6)} ${sf.padEnd(6)} ${opp}`);
  });
  if (sortedGuests.length > topN) {
    console.log(`  ... and ${sortedGuests.length - topN} more`);
  }

  // ── 7. Summary stats ─────────────────────────────────────────────────────

  section('Summary');

  const stayBuckets = { '2': 0, '3': 0, '4': 0, '5+': 0 };
  for (const g of sortedGuests) {
    if (g.stayCount >= 5) stayBuckets['5+']++;
    else stayBuckets[String(g.stayCount)]++;
  }

  row('Total repeat guests (Opera):', String(sortedGuests.length));
  if (stayBuckets['2'] > 0) row('  2 stays:', String(stayBuckets['2']));
  if (stayBuckets['3'] > 0) row('  3 stays:', String(stayBuckets['3']));
  if (stayBuckets['4'] > 0) row('  4 stays:', String(stayBuckets['4']));
  if (stayBuckets['5+'] > 0) row('  5+ stays:', String(stayBuckets['5+']));
  console.log('');
  row('In Salesforce:', String(sortedGuests.length - notInSF.length));
  row('Not in Salesforce:', String(notInSF.length));
  console.log('');
  row('With Opportunity:', String(withOpps.length));
  row('Without Opportunity:', String(withoutOpps.length));

  console.log('\n' + hr() + '\n');

  // ── 8. Email report ───────────────────────────────────────────────────────

  if (SEND_EMAIL) {
    const { subject, textBody, htmlBody } = buildEmailReport(sortedGuests, {
      runAt: now,
      repeatCount: sortedGuests.length,
      inSalesforce: sortedGuests.length - notInSF.length,
      notInSalesforce: notInSF.length,
      withOpps: withOpps.length,
      withoutOpps: withoutOpps.length,
      stayBuckets,
      minStays: MIN_STAYS,
    });

    console.log('  Sending email report...');
    const notifier = new Notifier();
    if (!notifier.emailEnabled) {
      console.warn('  WARNING: EMAIL_ENABLED is not set — skipping email.');
      return;
    }
    const sent = await notifier.sendEmail(subject, textBody, htmlBody);
    if (sent) {
      console.log(`  Report sent to ${process.env.EMAIL_TO}`);
    } else {
      console.warn('  WARNING: Email failed to send.');
    }
  } else {
    console.log('  Pass --email to send this report via email.');
  }
}

// ── Email builder ─────────────────────────────────────────────────────────────

function buildEmailReport(guests, stats) {
  const runAt = stats.runAt.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' });
  const withOppGuests = guests.filter(g => g.hasOpportunity);
  const withoutOppGuests = guests.filter(g => !g.hasOpportunity);
  const notInSFGuests = guests.filter(g => !g.inSalesforce);

  const subject = `Repeat Guests Report (Opera) — ${stats.repeatCount} guests with ${stats.minStays}+ stays (${stats.withOpps} with Opportunities)`;

  const css = `
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 0; background: #f4f6f8; }
    .wrap { max-width: 960px; margin: 24px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .header { background: #1a3a5c; color: #fff; padding: 24px 32px; }
    .header h1 { margin: 0 0 4px; font-size: 20px; font-weight: 700; letter-spacing: 0.5px; }
    .header .sub { font-size: 13px; opacity: 0.75; margin: 0; }
    .body { padding: 24px 32px; }
    .section { margin-bottom: 28px; }
    .section h2 { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #6b7280; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin: 0 0 14px; }
    .stat-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
    .stat { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 16px; }
    .stat .num { font-size: 28px; font-weight: 700; line-height: 1; margin-bottom: 4px; }
    .stat .lbl { font-size: 12px; color: #6b7280; }
    .stat.green .num { color: #059669; }
    .stat.blue  .num { color: #2563eb; }
    .stat.amber .num { color: #d97706; }
    .stat.red   .num { color: #dc2626; }
    .stat.gray  .num { color: #6b7280; }
    table.data { width: 100%; border-collapse: collapse; font-size: 12px; }
    table.data th { background: #f1f5f9; padding: 8px 10px; text-align: left; font-weight: 600; color: #374151; border-bottom: 2px solid #e5e7eb; white-space: nowrap; }
    table.data td { padding: 7px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    table.data tr:hover td { background: #fafafa; }
    .pill { display: inline-block; font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 10px; }
    .pill.yes { background: #d1fae5; color: #065f46; }
    .pill.no  { background: #fee2e2; color: #991b1b; }
    .pill.sf  { background: #dbeafe; color: #1e40af; }
    .pill.nosf { background: #fef3c7; color: #92400e; }
    .opp-list { font-size: 11px; color: #6b7280; margin: 2px 0 0; padding: 0; list-style: none; }
    .opp-list li { margin-bottom: 2px; }
    .opp-list .stage { font-weight: 600; }
    .opp-list .won { color: #059669; }
    .opp-list .lost { color: #dc2626; }
    .opp-list .open { color: #d97706; }
    .footer { background: #f8fafc; padding: 16px 32px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af; }
  `;

  const MAX_ROWS = 200;

  function guestRow(g) {
    const name = `${g.firstName} ${g.lastName}`.trim();
    const oppPill = g.hasOpportunity
      ? '<span class="pill yes">YES</span>'
      : '<span class="pill no">NO</span>';
    const sfPill = g.inSalesforce
      ? '<span class="pill sf">YES</span>'
      : '<span class="pill nosf">NO</span>';

    const stayDates = g.stays.slice(0, 5).map(s =>
      `${s.checkIn}${s.status === 'RESERVED' ? ' <em style="color:#d97706;font-size:10px">(future)</em>' : ''}`
    ).join('<br>');
    const moreDates = g.stays.length > 5
      ? `<br><span style="color:#9ca3af;font-style:italic">+${g.stays.length - 5} more</span>` : '';

    let oppDetail = '';
    if (g.hasOpportunity) {
      oppDetail = '<ul class="opp-list">' +
        g.opportunities.slice(0, 3).map(o => {
          const stageClass = o.isWon ? 'won' : o.isClosed ? 'lost' : 'open';
          const amt = o.amount != null ? ` — $${Number(o.amount).toLocaleString()}` : '';
          return `<li><span class="stage ${stageClass}">${o.stage}</span>${amt}<br>${o.name}</li>`;
        }).join('') +
        (g.opportunities.length > 3 ? `<li>+${g.opportunities.length - 3} more</li>` : '') +
        '</ul>';
    }

    return `<tr>
      <td><strong>${name}</strong><br><span style="color:#6b7280">${g.email}</span>
          ${g.phone ? `<br><span style="color:#9ca3af;font-size:11px">${g.phone}</span>` : ''}</td>
      <td>${g.country || ''}</td>
      <td>${g.language || ''}</td>
      <td style="text-align:center"><strong>${g.stayCount}</strong></td>
      <td style="font-size:11px">${stayDates}${moreDates}</td>
      <td style="text-align:center">${sfPill}</td>
      <td style="text-align:center">${oppPill}${oppDetail}</td>
    </tr>`;
  }

  function guestTable(guestList, maxRows = MAX_ROWS) {
    if (!guestList.length) return '<p style="color:#9ca3af;font-size:13px;">None.</p>';
    const shown = guestList.slice(0, maxRows);
    const more = guestList.length - shown.length;
    const rows = shown.map(guestRow).join('');
    const moreRow = more > 0
      ? `<tr><td colspan="7" style="color:#9ca3af;font-style:italic;padding:8px 12px">... and ${more} more</td></tr>`
      : '';
    return `<div style="overflow-x:auto"><table class="data">
      <thead><tr>
        <th>Guest</th>
        <th>Country</th>
        <th>Language</th>
        <th style="text-align:center">Stays</th>
        <th>Stay Dates</th>
        <th style="text-align:center">In SF</th>
        <th style="text-align:center">Opportunity</th>
      </tr></thead>
      <tbody>${rows}${moreRow}</tbody>
    </table></div>`;
  }

  const htmlBody = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
<div class="wrap">
  <div class="header">
    <h1>Repeat Guests Report</h1>
    <p class="sub">Source: Opera PMS (Oracle) &middot; Generated ${runAt} (ART) &middot; Guests with ${stats.minStays}+ stays at VINES</p>
  </div>
  <div class="body">

    <div class="section">
      <h2>Summary</h2>
      <div class="stat-grid">
        <div class="stat green"><div class="num">${stats.repeatCount}</div><div class="lbl">Repeat guests (${stats.minStays}+ stays)</div></div>
        <div class="stat blue"><div class="num">${stats.inSalesforce}</div><div class="lbl">In Salesforce</div></div>
        <div class="stat ${stats.notInSalesforce > 0 ? 'amber' : 'gray'}"><div class="num">${stats.notInSalesforce}</div><div class="lbl">Not in Salesforce</div></div>
        <div class="stat ${stats.withOpps > 0 ? 'green' : 'gray'}"><div class="num">${stats.withOpps}</div><div class="lbl">With Opportunity</div></div>
        <div class="stat ${stats.withoutOpps > 0 ? 'amber' : 'gray'}"><div class="num">${stats.withoutOpps}</div><div class="lbl">Without Opportunity</div></div>
        <div class="stat gray"><div class="num">${stats.stayBuckets['5+'] || 0}</div><div class="lbl">Guests with 5+ stays</div></div>
      </div>
    </div>

    <div class="section">
      <h2>Stay Distribution</h2>
      <table class="data" style="width:auto">
        <thead><tr><th>Stays</th><th style="text-align:right">Guests</th></tr></thead>
        <tbody>
          ${Object.entries(stats.stayBuckets).filter(([,v]) => v > 0).map(([k,v]) =>
            `<tr><td>${k} stays</td><td style="text-align:right;font-weight:600">${v}</td></tr>`
          ).join('')}
          <tr style="border-top:2px solid #e5e7eb"><td><strong>Total</strong></td><td style="text-align:right;font-weight:700">${stats.repeatCount}</td></tr>
        </tbody>
      </table>
    </div>

    ${withoutOppGuests.length > 0 ? `
    <div class="section">
      <h2>Repeat Guests WITHOUT Opportunity (${withoutOppGuests.length})</h2>
      <p style="font-size:12px;color:#92400e;background:#fffbeb;padding:10px;border-radius:4px;border:1px solid #fcd34d;margin:0 0 12px">
        These repeat guests have no associated Opportunity in Salesforce — potential sales follow-up candidates.
      </p>
      ${guestTable(withoutOppGuests)}
    </div>` : ''}

    ${withOppGuests.length > 0 ? `
    <div class="section">
      <h2>Repeat Guests WITH Opportunity (${withOppGuests.length})</h2>
      ${guestTable(withOppGuests)}
    </div>` : ''}

  </div>
  <div class="footer">
    Repeat Guests Report &middot; Source: Opera PMS (Oracle) &middot; ${runAt} (ART)
  </div>
</div>
</body></html>`;

  const textBody = [
    'REPEAT GUESTS REPORT (Opera Source)',
    `Generated: ${runAt} (ART)`,
    `Minimum stays: ${stats.minStays}`,
    '',
    'SUMMARY',
    `  Repeat guests (${stats.minStays}+ stays):  ${stats.repeatCount}`,
    `  In Salesforce:                ${stats.inSalesforce}`,
    `  Not in Salesforce:            ${stats.notInSalesforce}`,
    `  With Opportunity:             ${stats.withOpps}`,
    `  Without Opportunity:          ${stats.withoutOpps}`,
    '',
    'REPEAT GUESTS WITHOUT OPPORTUNITY:',
    ...guests.filter(g => !g.hasOpportunity).slice(0, 100).map(g =>
      `  ${g.firstName} ${g.lastName} <${g.email}> — ${g.stayCount} stays (${g.firstStay} to ${g.lastStay}) [${g.country}]${g.inSalesforce ? '' : ' [NOT IN SF]'}`
    ),
    '',
    'REPEAT GUESTS WITH OPPORTUNITY:',
    ...guests.filter(g => g.hasOpportunity).slice(0, 50).map(g =>
      `  ${g.firstName} ${g.lastName} <${g.email}> — ${g.stayCount} stays — Opps: ${g.opportunities.map(o => `${o.name} (${o.stage})`).join(', ')}`
    ),
  ].join('\n');

  return { subject, textBody, htmlBody };
}

main().catch(err => {
  console.error('\nFatal error:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
