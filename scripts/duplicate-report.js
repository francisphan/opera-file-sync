#!/usr/bin/env node
/**
 * Duplicate Data Report
 *
 * Analyzes Salesforce Contact, Lead, Opportunity, and TVRS Guest data for
 * duplicates and data-quality issues:
 *   - Contacts sharing the same email address (true SF duplicates)
 *   - Contacts sharing the same name (potential duplicates)
 *   - Contacts linked to guests with multiple distinct last names
 *     (shared-email bug — different people mapped to one Contact)
 *   - Leads: duplicate emails, leads whose email matches an existing Contact
 *   - Opportunities: orphaned (no Account), no Contact role, stage breakdown
 *   - Person Accounts: duplicate emails (if Person Accounts are enabled)
 *   - Data gaps: guests missing email or Contact link (with sample records)
 *
 * Usage:
 *   node scripts/duplicate-report.js           # save HTML to scripts/output/
 *   node scripts/duplicate-report.js --send    # save + email the report
 */

'use strict';
require('dotenv').config();
const jsforce = require('jsforce');
const fs = require('fs');
const path = require('path');

const SEND = process.argv.includes('--send');
const GUEST_OBJECT = process.env.SF_OBJECT || 'TVRS_Guest__c';
const CONTACT_LOOKUP = process.env.SF_GUEST_CONTACT_LOOKUP || 'Contact__c';
const SF_URL = (process.env.SF_INSTANCE_URL || '').replace(/\/$/, '');

// ── Salesforce ──────────────────────────────────────────────────────────────

function connect() {
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

async function queryAll(conn, soql) {
  let res = await conn.query(soql);
  const records = [...res.records];
  while (!res.done) {
    res = await conn.queryMore(res.nextRecordsUrl);
    records.push(...res.records);
  }
  return records;
}

function esc(s) { return (s || '').replace(/'/g, "\\'"); }
function sfUrl(id) { return SF_URL ? `${SF_URL}/${id}` : '#'; }

// Groups with more contacts than this threshold are too noisy to list by name
// (e.g. unknown@unknown.com with hundreds of contacts) — names are omitted
const NAMES_FETCH_THRESHOLD = 50;
const NAMES_DISPLAY_CAP = 4;

// ── Data collection ─────────────────────────────────────────────────────────

async function collectData(conn) {
  console.log('  Fetching totals...');
  const [totalContactsRes, totalGuestsRes, missingEmailRes, missingContactRes] = await Promise.all([
    conn.query('SELECT COUNT() FROM Contact'),
    conn.query(`SELECT COUNT() FROM ${GUEST_OBJECT}`),
    conn.query(`SELECT COUNT() FROM ${GUEST_OBJECT} WHERE Email__c = null`),
    conn.query(`SELECT COUNT() FROM ${GUEST_OBJECT} WHERE ${CONTACT_LOOKUP} = null`),
  ]);

  // ── Duplicate Contact emails ──────────────────────────────────────────────

  console.log('  Fetching duplicate Contact emails...');
  const dupEmailRes = await conn.query(
    'SELECT Email, COUNT(Id) cnt FROM Contact WHERE Email != null ' +
    'GROUP BY Email HAVING COUNT(Id) > 1 ORDER BY COUNT(Id) DESC LIMIT 500'
  );
  const dupEmails = (dupEmailRes.records || []).map(r => ({
    email: r.Email,
    cnt: r.cnt ?? r.expr0 ?? 0,
  }));

  // Fetch Contact names for the top 20 dup-email groups.
  // Skip groups above NAMES_FETCH_THRESHOLD — listing hundreds of names is not useful
  // and balloons the email (e.g. unknown@unknown.com with thousands of contacts).
  const dupEmailDetails = new Map(); // email.toLowerCase() → [{id, name}]
  const fetchableContactEmails = dupEmails.slice(0, 20).filter(r => r.cnt <= NAMES_FETCH_THRESHOLD);
  if (fetchableContactEmails.length > 0) {
    const escaped = fetchableContactEmails.map(r => `'${esc(r.email)}'`).join(',');
    const recs = await queryAll(conn,
      `SELECT Id, FirstName, LastName, Email FROM Contact WHERE Email IN (${escaped}) ORDER BY Email, LastName`
    );
    for (const c of recs) {
      const key = (c.Email || '').toLowerCase();
      if (!dupEmailDetails.has(key)) dupEmailDetails.set(key, []);
      dupEmailDetails.get(key).push({ id: c.Id, name: `${c.FirstName || ''} ${c.LastName || ''}`.trim() });
    }
  }

  // ── Duplicate Contact names ───────────────────────────────────────────────

  console.log('  Fetching duplicate Contact names...');
  const dupNamesRes = await conn.query(
    'SELECT FirstName, LastName, COUNT(Id) cnt FROM Contact ' +
    'WHERE FirstName != null AND LastName != null ' +
    'GROUP BY FirstName, LastName HAVING COUNT(Id) > 1 ORDER BY COUNT(Id) DESC LIMIT 500'
  );
  const dupNames = (dupNamesRes.records || []).map(r => ({
    firstName: r.FirstName,
    lastName: r.LastName,
    cnt: r.cnt ?? r.expr0 ?? 0,
  }));

  // Fetch email + ID for each Contact in the top 10 dup-name groups
  const dupNameDetails = new Map(); // "first|last" → [{id, email}]
  if (dupNames.length > 0) {
    const top = dupNames.slice(0, 10);
    const conditions = top.map(r =>
      `(FirstName = '${esc(r.firstName)}' AND LastName = '${esc(r.lastName)}')`
    ).join(' OR ');
    const recs = await queryAll(conn,
      `SELECT Id, FirstName, LastName, Email FROM Contact WHERE ${conditions} ORDER BY LastName, FirstName`
    );
    for (const c of recs) {
      const key = `${(c.FirstName || '').toLowerCase()}|${(c.LastName || '').toLowerCase()}`;
      if (!dupNameDetails.has(key)) dupNameDetails.set(key, []);
      if (c.Email) dupNameDetails.get(key).push({ id: c.Id, email: c.Email });
    }
  }

  // ── Shared-email detection ────────────────────────────────────────────────

  console.log(`  Scanning ${GUEST_OBJECT} for shared-email contacts...`);
  const allGuests = await queryAll(conn,
    `SELECT ${CONTACT_LOOKUP}, Guest_Last_Name__c FROM ${GUEST_OBJECT} ` +
    `WHERE ${CONTACT_LOOKUP} != null AND Guest_Last_Name__c != null`
  );

  const lastNamesByContact = new Map();
  for (const g of allGuests) {
    const cid = g[CONTACT_LOOKUP];
    if (!lastNamesByContact.has(cid)) lastNamesByContact.set(cid, new Set());
    lastNamesByContact.get(cid).add((g.Guest_Last_Name__c || '').trim().toLowerCase());
  }

  const sharedContacts = [...lastNamesByContact.entries()]
    .filter(([, names]) => names.size > 1)
    .sort((a, b) => b[1].size - a[1].size)
    .map(([contactId, names]) => ({ contactId, distinctLastNames: names.size }));

  // Fetch full details for top 25 shared-email contacts (up from 15), including check-in dates
  let sharedDetails = [];
  if (sharedContacts.length > 0) {
    const topIds = sharedContacts.slice(0, 25).map(c => c.contactId);
    const escaped = topIds.map(id => `'${id}'`).join(',');

    const [contactRecs, guestRecs] = await Promise.all([
      queryAll(conn, `SELECT Id, FirstName, LastName, Email FROM Contact WHERE Id IN (${escaped})`),
      queryAll(conn,
        `SELECT ${CONTACT_LOOKUP}, Guest_First_Name__c, Guest_Last_Name__c, Check_In_Date__c ` +
        `FROM ${GUEST_OBJECT} WHERE ${CONTACT_LOOKUP} IN (${escaped}) ORDER BY Check_In_Date__c DESC NULLS LAST`
      ),
    ]);

    const contactMap = new Map(contactRecs.map(c => [c.Id, c]));
    const guestsByContact = new Map();
    for (const g of guestRecs) {
      const cid = g[CONTACT_LOOKUP];
      if (!guestsByContact.has(cid)) guestsByContact.set(cid, []);
      const fullName = `${(g.Guest_First_Name__c || '').trim()} ${(g.Guest_Last_Name__c || '').trim()}`.trim();
      if (fullName) guestsByContact.get(cid).push({ name: fullName, checkIn: g.Check_In_Date__c || null });
    }

    sharedDetails = sharedContacts.slice(0, 25).map(({ contactId, distinctLastNames }) => {
      const c = contactMap.get(contactId) || {};
      const allGuestEntries = guestsByContact.get(contactId) || [];
      // Deduplicate by name (keep first occurrence, which has the most recent check-in due to ORDER BY)
      const uniqueByName = [...new Map(allGuestEntries.map(g => [g.name.toLowerCase(), g])).values()];
      return {
        contactId,
        contactName: `${c.FirstName || ''} ${c.LastName || ''}`.trim() || '—',
        email: c.Email || '—',
        totalGuests: allGuestEntries.length,
        distinctLastNames,
        guestList: uniqueByName.slice(0, 8),
        moreNames: Math.max(0, uniqueByName.length - 8),
      };
    });
  }

  // ── Data gap samples ──────────────────────────────────────────────────────

  const [missingEmailSamples, missingContactSamples] = await Promise.all([
    missingEmailRes.totalSize > 0
      ? queryAll(conn,
          `SELECT Id, Guest_First_Name__c, Guest_Last_Name__c, Check_In_Date__c ` +
          `FROM ${GUEST_OBJECT} WHERE Email__c = null ORDER BY Check_In_Date__c DESC NULLS LAST LIMIT 5`)
      : Promise.resolve([]),
    missingContactRes.totalSize > 0
      ? queryAll(conn,
          `SELECT Id, Email__c, Guest_First_Name__c, Guest_Last_Name__c, Check_In_Date__c ` +
          `FROM ${GUEST_OBJECT} WHERE ${CONTACT_LOOKUP} = null AND Email__c != null ` +
          `ORDER BY Check_In_Date__c DESC NULLS LAST LIMIT 5`)
      : Promise.resolve([]),
  ]);

  // ── Leads ─────────────────────────────────────────────────────────────────

  console.log('  Fetching Lead data...');
  let leadData = null;
  try {
    const [totalLeadsRes, dupLeadEmailRes] = await Promise.all([
      conn.query('SELECT COUNT() FROM Lead WHERE IsConverted = false'),
      conn.query(
        'SELECT Email, COUNT(Id) cnt FROM Lead WHERE Email != null AND IsConverted = false ' +
        'GROUP BY Email HAVING COUNT(Id) > 1 ORDER BY COUNT(Id) DESC LIMIT 100'
      ),
    ]);
    const dupLeadEmails = (dupLeadEmailRes.records || []).map(r => ({
      email: r.Email,
      cnt: r.cnt ?? r.expr0 ?? 0,
    }));

    // Lead emails that also exist on a Contact (potential missed conversions)
    // Intersect in JS since SOQL semi-joins don't support cross-object field equality
    const [leadEmailRecs, contactEmailRecs] = await Promise.all([
      queryAll(conn, 'SELECT Email FROM Lead WHERE Email != null AND IsConverted = false'),
      queryAll(conn, 'SELECT Email FROM Contact WHERE Email != null'),
    ]);
    const leadEmails = new Set(leadEmailRecs.map(r => (r.Email || '').toLowerCase()));
    const contactEmails = new Set(contactEmailRecs.map(r => (r.Email || '').toLowerCase()));
    const crossEmails = [...leadEmails].filter(e => contactEmails.has(e));

    // Fetch Lead names for top 10 dup-email groups (same threshold as Contacts)
    const dupLeadEmailDetails = new Map();
    const fetchableLeadEmails = dupLeadEmails.slice(0, 10).filter(r => r.cnt <= NAMES_FETCH_THRESHOLD);
    if (fetchableLeadEmails.length > 0) {
      const escaped = fetchableLeadEmails.map(r => `'${esc(r.email)}'`).join(',');
      const recs = await queryAll(conn,
        `SELECT Id, FirstName, LastName, Email FROM Lead WHERE Email IN (${escaped}) AND IsConverted = false ORDER BY Email, LastName`
      );
      for (const l of recs) {
        const key = (l.Email || '').toLowerCase();
        if (!dupLeadEmailDetails.has(key)) dupLeadEmailDetails.set(key, []);
        dupLeadEmailDetails.get(key).push({ id: l.Id, name: `${l.FirstName || ''} ${l.LastName || ''}`.trim() });
      }
    }

    leadData = {
      total: totalLeadsRes.totalSize,
      dupEmails: dupLeadEmails,
      dupEmailDetails: dupLeadEmailDetails,
      crossEmailCount: crossEmails.length,
    };
  } catch (err) {
    console.warn(`  Lead data unavailable: ${err.message}`);
  }

  // ── Opportunities ─────────────────────────────────────────────────────────

  console.log('  Fetching Opportunity data...');
  let oppData = null;
  try {
    const [totalOppsRes, openOppsRes, noAccountRes] = await Promise.all([
      conn.query('SELECT COUNT() FROM Opportunity'),
      conn.query('SELECT COUNT() FROM Opportunity WHERE IsClosed = false'),
      conn.query('SELECT COUNT() FROM Opportunity WHERE AccountId = null'),
    ]);

    let noContactRoleCount = null;
    try {
      const res = await conn.query(
        'SELECT COUNT() FROM Opportunity WHERE Id NOT IN (SELECT OpportunityId FROM OpportunityContactRole)'
      );
      noContactRoleCount = res.totalSize;
    } catch (e) { /* semi-join may time out on large orgs */ }

    let stageBreakdown = [];
    try {
      const stageRes = await conn.query(
        'SELECT StageName, COUNT(Id) cnt FROM Opportunity WHERE IsClosed = false ' +
        'GROUP BY StageName ORDER BY COUNT(Id) DESC LIMIT 10'
      );
      stageBreakdown = (stageRes.records || []).map(r => ({ stage: r.StageName, cnt: r.cnt ?? r.expr0 ?? 0 }));
    } catch (e) { /* not critical */ }

    oppData = {
      total: totalOppsRes.totalSize,
      open: openOppsRes.totalSize,
      noAccount: noAccountRes.totalSize,
      noContactRole: noContactRoleCount,
      stageBreakdown,
    };
  } catch (err) {
    console.warn(`  Opportunity data unavailable: ${err.message}`);
  }

  // ── Person Accounts ───────────────────────────────────────────────────────

  console.log('  Checking Person Accounts...');
  let personAccountData = null;
  try {
    const [totalPARes, dupPAEmailRes] = await Promise.all([
      conn.query('SELECT COUNT() FROM Account WHERE IsPersonAccount = true'),
      conn.query(
        'SELECT PersonEmail, COUNT(Id) cnt FROM Account WHERE PersonEmail != null AND IsPersonAccount = true ' +
        'GROUP BY PersonEmail HAVING COUNT(Id) > 1 ORDER BY COUNT(Id) DESC LIMIT 100'
      ),
    ]);
    const dupPAEmails = (dupPAEmailRes.records || []).map(r => ({
      email: r.PersonEmail,
      cnt: r.cnt ?? r.expr0 ?? 0,
    }));
    personAccountData = {
      total: totalPARes.totalSize,
      dupEmails: dupPAEmails,
    };
  } catch (err) {
    // IsPersonAccount won't exist if Person Accounts are not enabled
    console.log('  Person Accounts: not enabled or not accessible.');
  }

  return {
    totalContacts: totalContactsRes.totalSize,
    totalGuests: totalGuestsRes.totalSize,
    dupEmails,
    dupEmailDetails,
    dupNames,
    dupNameDetails,
    sharedContacts,
    sharedDetails,
    missingEmail: missingEmailRes.totalSize,
    missingContact: missingContactRes.totalSize,
    missingEmailSamples,
    missingContactSamples,
    leadData,
    oppData,
    personAccountData,
  };
}

// ── HTML generation ──────────────────────────────────────────────────────────

function fmtDate(d) {
  return d.toLocaleDateString('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

function n(x) { return Number(x || 0).toLocaleString(); }

function badge(count, { badAt = 100 } = {}) {
  if (count === 0) return `<span class="badge badge-ok">OK</span>`;
  if (count < badAt) return `<span class="badge badge-warn">&#9888; ${n(count)}</span>`;
  return `<span class="badge badge-bad">&#9888; ${n(count)}</span>`;
}

function recordLink(id, label) {
  if (!SF_URL || !id) return label || id || '—';
  return `<a href="${sfUrl(id)}" target="_blank" rel="noopener">${label || id}</a>`;
}

function generateHTML(data, date) {
  const dupEmailGroups = data.dupEmails.length;
  const dupEmailRecords = data.dupEmails.reduce((s, r) => s + r.cnt, 0);
  const dupNameGroups = data.dupNames.length;
  const dupNameRecords = data.dupNames.reduce((s, r) => s + r.cnt, 0);
  const sharedCount = data.sharedContacts.length;
  const hasIssues = dupEmailGroups > 0 || sharedCount > 0;

  const topDupEmails = data.dupEmails.slice(0, 20);
  const topDupNames = data.dupNames.slice(0, 10);

  // Render a row for each dup-email group with Contact/Lead names inline.
  // Groups above NAMES_FETCH_THRESHOLD show a note instead of names (too many to list).
  function dupEmailRows(emails, detailsMap) {
    return emails.map(r => {
      let namesHtml;
      if (r.cnt > NAMES_FETCH_THRESHOLD) {
        namesHtml = `<em style="color:#aaa">omitted &mdash; ${n(r.cnt)} contacts</em>`;
      } else {
        const contacts = detailsMap.get((r.email || '').toLowerCase()) || [];
        const shown = contacts.slice(0, NAMES_DISPLAY_CAP);
        const more = contacts.length - shown.length;
        namesHtml = shown.length
          ? shown.map(c => recordLink(c.id, c.name || c.id)).join(', ') + (more > 0 ? ` <em>+${more} more</em>` : '')
          : '—';
      }
      return `
        <tr>
          <td class="left"><code>${r.email}</code></td>
          <td>${r.cnt}</td>
          <td class="left names-cell">${namesHtml}</td>
        </tr>`;
    }).join('');
  }

  // Render a row for each dup-name group with emails inline
  function dupNameRows(names, detailsMap) {
    return names.map(r => {
      const key = `${(r.firstName || '').toLowerCase()}|${(r.lastName || '').toLowerCase()}`;
      const details = detailsMap.get(key) || [];
      const shown = details.slice(0, 4);
      const more = details.length - shown.length;
      const emailsHtml = shown.length
        ? shown.map(d => recordLink(d.id, d.email)).join(', ') + (more > 0 ? ` <em>+${more} more</em>` : '')
        : '—';
      return `
        <tr>
          <td class="left">${r.firstName} ${r.lastName}</td>
          <td>${r.cnt}</td>
          <td class="left names-cell">${emailsHtml}</td>
        </tr>`;
    }).join('');
  }

  // Render sample records for data gaps
  function sampleGuestRows(samples, hasEmail) {
    if (!samples || samples.length === 0) return '';
    const rows = samples.map(r => {
      const name = `${r.Guest_First_Name__c || ''} ${r.Guest_Last_Name__c || ''}`.trim() || '—';
      const emailCell = hasEmail ? `<td class="left"><code style="font-size:11px">${r.Email__c || '—'}</code></td>` : '';
      return `
        <tr>
          <td class="left">${name}</td>
          ${emailCell}
          <td>${r.Check_In_Date__c || '—'}</td>
          <td>${recordLink(r.Id, 'View')}</td>
        </tr>`;
    }).join('');
    const emailHeader = hasEmail ? '<th class="left">Email</th>' : '';
    return `
      <h3 style="margin-top:18px">Sample Records</h3>
      <table>
        <tr><th class="left">Guest</th>${emailHeader}<th>Check-In</th><th>Link</th></tr>
        ${rows}
      </table>`;
  }

  // Leads section HTML
  function leadsHTML() {
    if (!data.leadData) {
      return `<div class="section"><p style="font-size:13px;color:#888">Lead data could not be retrieved (check permissions).</p></div>`;
    }
    const ld = data.leadData;
    const dupCount = ld.dupEmails.length;
    const topLeadDups = ld.dupEmails.slice(0, 10);
    return `
    <div class="section">
      <table>
        <tr><th>Metric</th><th>Value</th></tr>
        <tr><td>Open (unconverted) Leads</td><td>${n(ld.total)}</td></tr>
        <tr><td>Duplicate email groups</td><td>${badge(dupCount, { badAt: 20 })}</td></tr>
        <tr>
          <td>Lead emails also on a Contact <small style="color:#999">(missed conversions?)</small></td>
          <td>${badge(ld.crossEmailCount, { badAt: 10 })}</td>
        </tr>
      </table>
      ${topLeadDups.length > 0 ? `
      <h3 style="margin-top:18px">Top Duplicate Lead Emails</h3>
      <table>
        <tr><th>Email</th><th>Leads</th><th class="left">Names</th></tr>
        ${dupEmailRows(topLeadDups, ld.dupEmailDetails)}
        ${dupCount > 10 ? `<tr><td colspan="3" class="muted">&hellip; and ${n(dupCount - 10)} more group${dupCount !== 11 ? 's' : ''}</td></tr>` : ''}
      </table>` : '<p style="font-size:13px;color:#888;margin-top:12px">No duplicate Lead emails found.</p>'}
    </div>`;
  }

  // Opportunities section HTML
  function oppsHTML() {
    if (!data.oppData) {
      return `<div class="section"><p style="font-size:13px;color:#888">Opportunity data could not be retrieved (check permissions).</p></div>`;
    }
    const od = data.oppData;
    const noContactRow = od.noContactRole !== null
      ? `<tr><td>No Contact role (unattributed)</td><td>${n(od.noContactRole)}</td><td>${badge(od.noContactRole)}</td></tr>`
      : '';
    const stageRows = od.stageBreakdown.map(s =>
      `<tr><td class="left">${s.stage}</td><td>${n(s.cnt)}</td></tr>`
    ).join('');
    return `
    <div class="section">
      <table>
        <tr><th>Metric</th><th>Value</th><th>Status</th></tr>
        <tr><td>Total Opportunities</td><td>${n(od.total)}</td><td></td></tr>
        <tr><td>Open</td><td>${n(od.open)}</td><td></td></tr>
        <tr><td>No Account (orphaned)</td><td>${n(od.noAccount)}</td><td>${badge(od.noAccount)}</td></tr>
        ${noContactRow}
      </table>
      ${stageRows ? `
      <h3 style="margin-top:18px">Open Opportunities by Stage</h3>
      <table>
        <tr><th class="left">Stage</th><th>Count</th></tr>
        ${stageRows}
      </table>` : ''}
    </div>`;
  }

  // Person Accounts section HTML
  function personAccountsHTML() {
    if (!data.personAccountData) {
      return `<div class="section"><p style="font-size:13px;color:#888">Person Accounts are not enabled in this org.</p></div>`;
    }
    const pa = data.personAccountData;
    const dupCount = pa.dupEmails.length;
    const topDups = pa.dupEmails.slice(0, 10);
    const dupRecords = pa.dupEmails.reduce((s, r) => s + r.cnt, 0);
    return `
    <div class="section">
      <table>
        <tr><th>Metric</th><th>Value</th></tr>
        <tr><td>Total Person Accounts</td><td>${n(pa.total)}</td></tr>
        <tr><td>Duplicate email groups</td><td>${badge(dupCount, { badAt: 50 })}</td></tr>
        <tr><td>Records in those groups</td><td>${n(dupRecords)}</td></tr>
      </table>
      ${topDups.length > 0 ? `
      <h3 style="margin-top:18px">Top Duplicate Emails</h3>
      <table>
        <tr><th>Email</th><th>Person Accounts</th></tr>
        ${topDups.map(r => `<tr><td class="left"><code>${r.email}</code></td><td>${r.cnt}</td></tr>`).join('')}
        ${dupCount > 10 ? `<tr><td colspan="2" class="muted">&hellip; and ${n(dupCount - 10)} more</td></tr>` : ''}
      </table>` : ''}
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Duplicate Data Report &mdash; ${fmtDate(date)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f4f7; color: #333; }
  .wrapper { max-width: 760px; margin: 32px auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  .header { background: linear-gradient(135deg, #6b2d8b 0%, #9b4dca 100%); color: #fff; padding: 36px 40px 28px; }
  .header h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.3px; }
  .header p { margin-top: 6px; font-size: 13px; opacity: 0.85; }
  .body { padding: 32px 40px; }
  h2 { font-size: 17px; font-weight: 700; color: #1a1a2e; margin: 28px 0 14px; border-left: 4px solid #9b4dca; padding-left: 12px; }
  h3 { font-size: 14px; font-weight: 600; color: #444; margin: 20px 0 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .section { background: #f9f8fc; border-radius: 8px; padding: 20px 24px; margin-bottom: 24px; border: 1px solid #ebe8f2; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; background: #ebe8f2; color: #6b2d8b; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }
  td { padding: 7px 10px; border-bottom: 1px solid #f0edf7; color: #333; }
  tr:last-child td { border-bottom: none; }
  td:not(:first-child), th:not(:first-child) { text-align: right; }
  td.left { text-align: left !important; }
  th.left { text-align: left !important; }
  td.names-cell { text-align: left !important; font-size: 12px; color: #555; }
  td.names-cell a { color: #6b2d8b; text-decoration: none; }
  td.names-cell a:hover { text-decoration: underline; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .badge-warn { background: #fff3cd; color: #856404; }
  .badge-ok { background: #d1e7dd; color: #0a3622; }
  .badge-bad { background: #f8d7da; color: #842029; }
  .kpi-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
  .kpi { background: #fff; border: 1px solid #ebe8f2; border-radius: 8px; padding: 14px 16px; }
  .kpi .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-bottom: 4px; }
  .kpi .value { font-size: 24px; font-weight: 700; color: #6b2d8b; }
  .kpi .sub { font-size: 11px; color: #aaa; margin-top: 2px; }
  .alert-box { border-radius: 6px; padding: 14px 16px; font-size: 13px; line-height: 1.6; margin-bottom: 20px; }
  .alert-warn { background: #fff3cd; border: 1px solid #ffc107; }
  .alert-ok { background: #d1e7dd; border: 1px solid #198754; }
  ul.tips { padding-left: 18px; font-size: 13px; line-height: 1.8; margin-top: 12px; }
  .divider { border: none; border-top: 2px solid #ebe8f2; margin: 28px 0; }
  .footer { background: #f4f4f7; padding: 20px 40px; text-align: center; font-size: 11px; color: #999; border-top: 1px solid #e8e4f0; }
  code { font-family: monospace; background: #f0edf7; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  .muted { font-size: 12px; color: #777; text-align: center; padding-top: 6px; }
  .guest-row { font-size: 12px; color: #666; font-style: italic; padding: 6px 10px 8px; border-bottom: 1px solid #f0edf7; }
  .guest-row td { padding: 4px 10px 8px; color: #555; font-style: italic; font-size: 12px; }
  .checkin { color: #999; font-style: normal; font-size: 11px; margin-left: 2px; }
  a { color: #6b2d8b; }
</style>
</head>
<body>
<div class="wrapper">

  <div class="header">
    <h1>The Vines of Mendoza &mdash; Duplicate Data Report</h1>
    <p>Generated: ${fmtDate(date)} &nbsp;&bull;&nbsp; ${n(data.totalContacts)} Contacts &bull; ${n(data.totalGuests)} TVRS Guests</p>
  </div>

  <div class="body">

    <!-- KPIs -->
    <div class="kpi-grid">
      <div class="kpi">
        <div class="label">Dup Email Groups</div>
        <div class="value">${n(dupEmailGroups)}${dupEmailGroups >= 500 ? '+' : ''}</div>
        <div class="sub">${n(dupEmailRecords)} Contact records affected</div>
      </div>
      <div class="kpi">
        <div class="label">Dup Name Groups</div>
        <div class="value">${n(dupNameGroups)}${dupNameGroups >= 500 ? '+' : ''}</div>
        <div class="sub">${n(dupNameRecords)} Contact records affected</div>
      </div>
      <div class="kpi">
        <div class="label">Shared-Email Contacts</div>
        <div class="value">${n(sharedCount)}</div>
        <div class="sub">Multiple identities on one Contact</div>
      </div>
      <div class="kpi">
        <div class="label">Guest Data Gaps</div>
        <div class="value">${n(data.missingEmail + data.missingContact)}</div>
        <div class="sub">${n(data.missingEmail)} no email &bull; ${n(data.missingContact)} no Contact link</div>
      </div>
    </div>

    <div class="alert-box ${hasIssues ? 'alert-warn' : 'alert-ok'}">
      ${hasIssues
        ? `&#9888; <strong>${n(dupEmailGroups)} duplicate email group${dupEmailGroups !== 1 ? 's' : ''}</strong> and <strong>${n(sharedCount)} shared-email Contact${sharedCount !== 1 ? 's' : ''}</strong> detected. Review and remediate to maintain CRM accuracy.`
        : `&#10003; No significant duplicate issues detected. Contact database looks healthy.`}
    </div>

    <!-- ── Contact Record Duplicates ─────────────────────────── -->
    <h2>Contact Record Duplicates</h2>

    <div class="section">
      <h3>Same Email on Multiple Contacts</h3>
      <p style="font-size:13px;color:#666;margin-bottom:12px">Multiple <em>Contact</em> records sharing the same email address &mdash; true Salesforce duplicates that should be merged.</p>
      <table>
        <tr><th>Metric</th><th>Value</th></tr>
        <tr><td>Duplicate groups</td><td>${badge(dupEmailGroups, { badAt: 100 })}</td></tr>
        <tr><td>Records in those groups</td><td>${n(dupEmailRecords)}</td></tr>
        <tr><td>Excess (mergeable) records</td><td>${n(Math.max(0, dupEmailRecords - dupEmailGroups))}</td></tr>
      </table>

      ${topDupEmails.length > 0 ? `
      <h3 style="margin-top:18px">Top Groups by Count</h3>
      <table>
        <tr><th>Email</th><th>Contacts</th><th class="left">Contact Names</th></tr>
        ${dupEmailRows(topDupEmails, data.dupEmailDetails)}
        ${dupEmailGroups > 20 ? `<tr><td colspan="3" class="muted">&hellip; and ${n(dupEmailGroups - 20)} more group${dupEmailGroups - 20 !== 1 ? 's' : ''}</td></tr>` : ''}
      </table>` : '<p style="font-size:13px;color:#888;margin-top:12px">No duplicate emails found.</p>'}
    </div>

    <div class="section">
      <h3>Same Name on Multiple Contacts</h3>
      <p style="font-size:13px;color:#666;margin-bottom:12px">Same first + last name across multiple Contacts. May be the same person (candidate for merge) or a genuinely common name (keep separate). Email column helps distinguish.</p>
      <table>
        <tr><th>Metric</th><th>Value</th></tr>
        <tr><td>Duplicate groups</td><td>${badge(dupNameGroups, { badAt: 5000 })}</td></tr>
        <tr><td>Records in those groups</td><td>${n(dupNameRecords)}</td></tr>
      </table>

      ${topDupNames.length > 0 ? `
      <h3 style="margin-top:18px">Most Common Names</h3>
      <table>
        <tr><th>Name</th><th>Contacts</th><th class="left">Sample Emails</th></tr>
        ${dupNameRows(topDupNames, data.dupNameDetails)}
        ${dupNameGroups > 10 ? `<tr><td colspan="3" class="muted">&hellip; and ${n(dupNameGroups - 10)} more group${dupNameGroups - 10 !== 1 ? 's' : ''}</td></tr>` : ''}
      </table>` : '<p style="font-size:13px;color:#888;margin-top:12px">No duplicate names found.</p>'}
    </div>

    <hr class="divider">

    <!-- ── Shared-Email Contacts ──────────────────────────────── -->
    <h2>Shared-Email Contacts (OPERA Import)</h2>

    <div class="section">
      <p style="font-size:13px;color:#666;margin-bottom:12px">
        Contacts linked to TVRS Guest records with <strong>multiple distinct last names</strong> &mdash;
        different guests were mapped to the same Contact because they shared an email address in OPERA.
        This is the root cause of the Contact name-overwrite bug.
      </p>
      <table>
        <tr><th>Metric</th><th>Value</th></tr>
        <tr><td>Contacts with multiple guest identities</td><td>${badge(sharedCount, { badAt: 50 })}</td></tr>
        <tr><td>As % of all Contacts</td><td>${data.totalContacts > 0 ? ((sharedCount / data.totalContacts) * 100).toFixed(2) : '0'}%</td></tr>
      </table>

      ${data.sharedDetails.length > 0 ? `
      <h3 style="margin-top:18px">Top Examples (Most Distinct Last Names)</h3>
      <table>
        <tr><th>Contact Name</th><th class="left">Email</th><th>Stays</th><th>Identities</th></tr>
        ${data.sharedDetails.map(c => `
        <tr>
          <td class="left">${recordLink(c.contactId, c.contactName)}</td>
          <td class="left"><code style="font-size:11px">${c.email}</code></td>
          <td>${c.totalGuests}</td>
          <td><strong>${c.distinctLastNames}</strong></td>
        </tr>
        <tr class="guest-row">
          <td colspan="4" class="left">
            ${c.guestList.map(g =>
              `${g.name}${g.checkIn ? `<span class="checkin">(${g.checkIn})</span>` : ''}`
            ).join(' &bull; ')}${c.moreNames > 0 ? ` &bull; <em>+${c.moreNames} more</em>` : ''}
          </td>
        </tr>`).join('')}
        ${sharedCount > 25 ? `<tr><td colspan="4" class="muted">&hellip; and ${n(sharedCount - 25)} more</td></tr>` : ''}
      </table>` : ''}

      <ul class="tips">
        <li>Run <code>node scripts/find-name-conflicts.js</code> to list every Contact whose current name doesn&rsquo;t match any linked guest name.</li>
        <li>Run <code>node scripts/rollback-contact-names.js</code> to restore the correct name where it can be determined.</li>
      </ul>
    </div>

    <hr class="divider">

    <!-- ── Leads ──────────────────────────────────────────────── -->
    <h2>Leads</h2>
    ${leadsHTML()}

    <hr class="divider">

    <!-- ── Opportunities ──────────────────────────────────────── -->
    <h2>Opportunities</h2>
    ${oppsHTML()}

    <hr class="divider">

    <!-- ── Person Accounts ────────────────────────────────────── -->
    <h2>Person Accounts</h2>
    ${personAccountsHTML()}

    <hr class="divider">

    <!-- ── Data Gaps ──────────────────────────────────────────── -->
    <h2>Data Gaps</h2>

    <div class="section">
      <table>
        <tr><th>Issue</th><th>Count</th><th>Status</th></tr>
        <tr>
          <td>TVRS Guests missing email (<code>Email__c</code>)</td>
          <td>${n(data.missingEmail)}</td>
          <td>${badge(data.missingEmail)}</td>
        </tr>
        <tr>
          <td>TVRS Guests with no Contact link (<code>${CONTACT_LOOKUP}</code>)</td>
          <td>${n(data.missingContact)}</td>
          <td>${badge(data.missingContact)}</td>
        </tr>
      </table>

      ${sampleGuestRows(data.missingEmailSamples, false)
        ? `<h3 style="margin-top:18px">Sample: Guests Missing Email</h3>
           <table>
             <tr><th class="left">Guest</th><th>Check-In</th><th>Link</th></tr>
             ${data.missingEmailSamples.map(r => {
               const name = `${r.Guest_First_Name__c || ''} ${r.Guest_Last_Name__c || ''}`.trim() || '—';
               return `<tr>
                 <td class="left">${name}</td>
                 <td>${r.Check_In_Date__c || '—'}</td>
                 <td>${recordLink(r.Id, 'View')}</td>
               </tr>`;
             }).join('')}
           </table>`
        : ''}

      ${data.missingContactSamples.length > 0
        ? `<h3 style="margin-top:18px">Sample: Guests Missing Contact Link</h3>
           <table>
             <tr><th class="left">Guest</th><th class="left">Email</th><th>Check-In</th><th>Link</th></tr>
             ${data.missingContactSamples.map(r => {
               const name = `${r.Guest_First_Name__c || ''} ${r.Guest_Last_Name__c || ''}`.trim() || '—';
               return `<tr>
                 <td class="left">${name}</td>
                 <td class="left"><code style="font-size:11px">${r.Email__c || '—'}</code></td>
                 <td>${r.Check_In_Date__c || '—'}</td>
                 <td>${recordLink(r.Id, 'View')}</td>
               </tr>`;
             }).join('')}
           </table>`
        : ''}
    </div>

  </div>

  <div class="footer">
    Generated by OPERA File Sync &bull; The Vines of Mendoza &bull; ${fmtDate(date)}<br>
    Run <code>node scripts/duplicate-report.js [--send]</code> to regenerate
  </div>

</div>
</body>
</html>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const date = new Date();
  console.log('='.repeat(70));
  console.log('  Duplicate Data Report');
  console.log(`  ${fmtDate(date)}`);
  console.log('='.repeat(70));

  const conn = connect();
  console.log('\nConnecting to Salesforce...');
  const identity = await conn.identity();
  console.log(`Connected as: ${identity.username}`);

  console.log('\nRunning analysis...');
  const data = await collectData(conn);

  const dupEmailGroups = data.dupEmails.length;
  const dupEmailRecords = data.dupEmails.reduce((s, r) => s + r.cnt, 0);
  const dupNameGroups = data.dupNames.length;
  const sharedCount = data.sharedContacts.length;

  console.log('\n--- Summary ---');
  console.log(`Total Contacts:              ${n(data.totalContacts)}`);
  console.log(`Total TVRS Guests:           ${n(data.totalGuests)}`);
  console.log(`Dup email groups:            ${n(dupEmailGroups)}${dupEmailGroups >= 500 ? '+' : ''} (${n(dupEmailRecords)} records)`);
  console.log(`Dup name groups:             ${n(dupNameGroups)}${dupNameGroups >= 500 ? '+' : ''}`);
  console.log(`Shared-email Contacts:       ${n(sharedCount)}`);
  console.log(`Guests missing email:        ${n(data.missingEmail)}`);
  console.log(`Guests missing Contact link: ${n(data.missingContact)}`);
  if (data.leadData) {
    console.log(`Open Leads:                  ${n(data.leadData.total)}`);
    console.log(`Lead dup email groups:       ${n(data.leadData.dupEmails.length)}`);
    console.log(`Lead emails on a Contact:    ${n(data.leadData.crossEmailCount)}`);
  }
  if (data.oppData) {
    console.log(`Total Opportunities:         ${n(data.oppData.total)} (${n(data.oppData.open)} open)`);
    console.log(`Opps with no Account:        ${n(data.oppData.noAccount)}`);
    if (data.oppData.noContactRole !== null)
      console.log(`Opps with no Contact role:   ${n(data.oppData.noContactRole)}`);
  }
  if (data.personAccountData) {
    console.log(`Person Accounts:             ${n(data.personAccountData.total)}`);
    console.log(`Person Acct dup emails:      ${n(data.personAccountData.dupEmails.length)}`);
  }

  // Save HTML report
  const html = generateHTML(data, date);
  const outputDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const ts = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const htmlPath = path.join(outputDir, `duplicate-report-${ts}.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log(`\nReport saved to: ${htmlPath}`);

  // Optionally email the report
  if (SEND) {
    if (!process.env.EMAIL_ENABLED || process.env.EMAIL_ENABLED === 'false') {
      console.warn('WARN: EMAIL_ENABLED is not set — skipping email send.');
      console.warn('      Set EMAIL_ENABLED=true and configure Gmail OAuth to send.');
    } else {
      const Notifier = require('../src/notifier');
      const notifier = new Notifier();
      const subject = `Duplicate Data Report | ${fmtDate(date)}`;
      console.log('Sending email...');
      const sent = await notifier.sendEmail(subject, `Duplicate Data Report — ${fmtDate(date)}`, html);
      console.log(sent ? 'Email sent.' : 'Email send failed — check logs.');
    }
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nFatal error:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
