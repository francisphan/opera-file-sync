#!/usr/bin/env node
/**
 * Dry Run — Opera DB → Salesforce Preview
 *
 * Reads the last-sync timestamp from sync-state.json, queries the Opera Oracle
 * database for guests modified since that point (exactly what the live sync
 * would pick up), then queries Salesforce (read-only) to classify every record.
 *
 * Nothing is written to Oracle or Salesforce.
 *
 * Usage:
 *   node scripts/dry-run.js
 *   node scripts/dry-run.js --verbose          # show individual guest rows
 *   node scripts/dry-run.js --since 2026-02-01  # override the since timestamp
 *   node scripts/dry-run.js --email             # send HTML report via email
 */

'use strict';
require('dotenv').config();

const fs      = require('fs');
const jsforce = require('jsforce');
const OracleClient      = require('../src/oracle-client');
const { queryGuestsSince } = require('../src/opera-db-query');
const { transformToTVRSGuest, GUEST_DIFF_SOQL_FIELDS, diffGuestRecord, mapLanguageToSalesforce } = require('../src/guest-utils');
const Notifier = require('../src/notifier');

// ── Config ────────────────────────────────────────────────────────────────────

const VERBOSE      = process.argv.includes('--verbose');
const SEND_EMAIL   = process.argv.includes('--email');
const SINCE_ARG    = (() => { const i = process.argv.indexOf('--since'); return i !== -1 ? process.argv[i + 1] : null; })();

const STATE_FILE   = '/mnt/y/opera-sf-sync/sync-state.json';
const GUEST_OBJECT = process.env.SF_OBJECT || 'TVRS_Guest__c';
const CONTACT_LOOKUP = process.env.SF_GUEST_CONTACT_LOOKUP || 'Contact__c';
const BATCH_SIZE   = parseInt(process.env.BATCH_SIZE) || 200;

// ── Helpers ───────────────────────────────────────────────────────────────────

function hr(char = '─', len = 68) { return char.repeat(len); }
function section(title) {
  console.log('\n' + hr());
  console.log('  ' + title);
  console.log(hr());
}
function row(label, value) {
  console.log(`  ${label.padEnd(38)}${value}`);
}
function guestLabel(entry) {
  const { firstName, lastName, email } = entry.customer;
  const checkIn = entry.invoice?.checkIn || '—';
  return `${firstName} ${lastName} <${email}>  check-in: ${checkIn}`;
}
function verboseList(title, entries, max = 30) {
  if (!entries.length) return;
  console.log(`\n    ${title}:`);
  entries.slice(0, max).forEach(e => console.log(`      · ${guestLabel(e)}`));
  if (entries.length > max) console.log(`      … and ${entries.length - max} more`);
}


// ── Email report builder ──────────────────────────────────────────────────────

function buildDryRunEmail(r) {
  const runAt = r.runAt.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' });
  const since = r.lastSyncTimestamp || '(initial sync — no previous timestamp)';

  const css = `
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 0; background: #f4f6f8; }
    .wrap { max-width: 680px; margin: 24px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .header { background: #1a3a5c; color: #fff; padding: 24px 32px; }
    .header h1 { margin: 0 0 4px; font-size: 20px; font-weight: 700; letter-spacing: 0.5px; }
    .header .sub { font-size: 13px; opacity: 0.75; margin: 0; }
    .badge { display: inline-block; background: #f59e0b; color: #1a1a1a; font-size: 11px; font-weight: 700; letter-spacing: 1px; padding: 2px 8px; border-radius: 3px; text-transform: uppercase; margin-bottom: 8px; }
    .body { padding: 24px 32px; }
    .section { margin-bottom: 28px; }
    .section h2 { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #6b7280; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin: 0 0 14px; }
    .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .stat { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 16px; }
    .stat .num { font-size: 28px; font-weight: 700; line-height: 1; margin-bottom: 4px; }
    .stat .lbl { font-size: 12px; color: #6b7280; }
    .stat.green .num { color: #059669; }
    .stat.blue  .num { color: #2563eb; }
    .stat.amber .num { color: #d97706; }
    .stat.red   .num { color: #dc2626; }
    .stat.gray  .num { color: #6b7280; }
    .diff-record { border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 12px; overflow: hidden; }
    .diff-record .dr-header { background: #f1f5f9; padding: 8px 14px; font-size: 13px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
    .diff-record .dr-header .dr-meta { font-weight: 400; color: #6b7280; font-size: 12px; }
    .diff-record table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .diff-record td { padding: 5px 14px; border-top: 1px solid #f1f5f9; }
    .diff-record td.lbl { color: #6b7280; width: 36%; }
    .diff-record td.from { color: #dc2626; text-decoration: line-through; width: 32%; }
    .diff-record td.to   { color: #059669; width: 32%; }
    .diff-record .no-changes { padding: 8px 14px; font-size: 12px; color: #9ca3af; font-style: italic; }
    .diff-record .overwrite-warn { background: #fff7ed; border-top: 1px solid #fed7aa; padding: 5px 14px; font-size: 11px; color: #c2410c; }
    table.data { width: 100%; border-collapse: collapse; font-size: 13px; }
    table.data th { background: #f1f5f9; padding: 8px 12px; text-align: left; font-weight: 600; color: #374151; border-bottom: 2px solid #e5e7eb; }
    table.data td { padding: 7px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    table.data tr:last-child td { border-bottom: none; }
    table.data tr:hover td { background: #fafafa; }
    .kv { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
    .kv:last-child { border-bottom: none; }
    .kv .k { color: #6b7280; }
    .kv .v { font-weight: 600; text-align: right; }
    .pill { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 10px; }
    .pill.new    { background: #dbeafe; color: #1e40af; }
    .pill.exists { background: #d1fae5; color: #065f46; }
    .pill.update { background: #e0e7ff; color: #3730a3; }
    .pill.warn   { background: #fef3c7; color: #92400e; }
    .pill.danger { background: #fee2e2; color: #991b1b; }
    .footer { background: #f8fafc; padding: 16px 32px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af; }
    .notice { background: #fffbeb; border: 1px solid #fcd34d; border-radius: 6px; padding: 12px 16px; font-size: 13px; color: #92400e; margin-bottom: 20px; }
  `;

  // ── Guest table helper ──────────────────────────────────────────────────────
  const MAX_LIST = 50;
  function guestTable(entries, showCheckIn = true) {
    if (!entries.length) return '<p style="color:#9ca3af;font-size:13px;">None.</p>';
    const shown = entries.slice(0, MAX_LIST);
    const more  = entries.length - shown.length;
    const rows  = shown.map(e => {
      const name    = `${e.customer.firstName || ''} ${e.customer.lastName || ''}`.trim();
      const email   = e.customer.email || '';
      const checkIn = e.invoice?.checkIn || '—';
      return `<tr>
        <td>${name}</td>
        <td style="color:#6b7280">${email}</td>
        ${showCheckIn ? `<td style="color:#6b7280;white-space:nowrap">${checkIn}</td>` : ''}
      </tr>`;
    }).join('');
    const moreRow = more > 0
      ? `<tr><td colspan="${showCheckIn ? 3 : 2}" style="color:#9ca3af;font-style:italic;padding:8px 12px">… and ${more} more</td></tr>`
      : '';
    return `<table class="data">
      <thead><tr>
        <th>Name</th><th>Email</th>${showCheckIn ? '<th>Check-in</th>' : ''}
      </tr></thead>
      <tbody>${rows}${moreRow}</tbody>
    </table>`;
  }

  // ── Update diff section helper ─────────────────────────────────────────────
  function updateDiffSection(guestsToUpdate) {
    if (!guestsToUpdate.length) return '<p style="color:#9ca3af;font-size:13px;">None.</p>';
    const shown = guestsToUpdate.slice(0, MAX_LIST);
    const more  = guestsToUpdate.length - shown.length;

    const cards = shown.map(({ entry, changes }) => {
      const name    = `${entry.customer.firstName || ''} ${entry.customer.lastName || ''}`.trim();
      const email   = entry.customer.email || '';
      const checkIn = entry.invoice?.checkIn || '—';

      const overwrites = changes.filter(c => c.boolean && c.from === true && c.to === false);
      const overwriteWarn = overwrites.length > 0
        ? `<div class="overwrite-warn">⚠ Sync would reset ${overwrites.map(c => c.label).join(', ')} from true → false</div>`
        : '';

      const fieldRows = changes.map(c => {
        const fromVal = (c.from === null || c.from === undefined) ? '<em style="color:#9ca3af">(empty)</em>' : String(c.from);
        const toVal   = (c.to   === null || c.to   === undefined) ? '<em style="color:#9ca3af">(empty)</em>' : String(c.to);
        return `<tr>
          <td class="lbl">${c.label}</td>
          <td class="from">${fromVal}</td>
          <td class="to">${toVal}</td>
        </tr>`;
      }).join('');

      return `<div class="diff-record">
        <div class="dr-header">
          ${name} <span class="dr-meta">${email} &nbsp;·&nbsp; check-in: ${checkIn} &nbsp;·&nbsp; ${changes.length} field${changes.length !== 1 ? 's' : ''} changing</span>
        </div>
        ${overwriteWarn}
        <table><tbody>${fieldRows}</tbody></table>
      </div>`;
    }).join('');

    const moreNote = more > 0
      ? `<p style="color:#9ca3af;font-size:12px;font-style:italic">… and ${more} more records not shown</p>`
      : '';

    return cards + moreNote;
  }

  // ── Review card helpers (for needsReview sections) ─────────────────────────
  const REVIEW_CARD_FIELDS = [
    { api: 'Email__c',           label: 'Email',          get: e => e.customer.email },
    { api: 'Guest_First_Name__c', label: 'First Name',    get: e => e.customer.firstName },
    { api: 'Guest_Last_Name__c',  label: 'Last Name',     get: e => e.customer.lastName },
    { api: 'Telephone__c',       label: 'Phone',          get: e => e.customer.phone },
    { api: 'City__c',            label: 'City',           get: e => e.customer.billingCity },
    { api: 'State_Province__c',  label: 'State/Province', get: e => e.customer.billingState },
    { api: 'Country__c',         label: 'Country',        get: e => e.customer.billingCountry },
    { api: 'Language__c',        label: 'Language',        get: e => mapLanguageToSalesforce(e.customer.language) },
    { api: 'Check_In_Date__c',   label: 'Check-in',       get: e => e.invoice?.checkIn },
    { api: 'Check_Out_Date__c',  label: 'Check-out',      get: e => e.invoice?.checkOut },
  ];

  function reviewCard(entry) {
    const name  = `${entry.customer.firstName || ''} ${entry.customer.lastName || ''}`.trim();
    const email = entry.customer.email || '';
    const rows  = REVIEW_CARD_FIELDS.map(f => {
      const val = f.get(entry);
      const display = val != null && val !== '' ? String(val) : '<em style="color:#9ca3af">(empty)</em>';
      return `<tr>
        <td style="padding:5px 14px;border-top:1px solid #f1f5f9;color:#6b7280;width:36%;font-family:monospace;font-size:11px">${f.api}</td>
        <td style="padding:5px 14px;border-top:1px solid #f1f5f9;color:#6b7280;width:28%">${f.label}</td>
        <td style="padding:5px 14px;border-top:1px solid #f1f5f9;width:36%">${display}</td>
      </tr>`;
    }).join('');
    return `<div class="diff-record">
      <div class="dr-header">${name} <span class="dr-meta">${email}</span></div>
      <table><thead><tr>
        <th style="padding:5px 14px;text-align:left;font-size:11px;color:#6b7280;background:#f8fafc">API Field</th>
        <th style="padding:5px 14px;text-align:left;font-size:11px;color:#6b7280;background:#f8fafc">Label</th>
        <th style="padding:5px 14px;text-align:left;font-size:11px;color:#6b7280;background:#f8fafc">Value</th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  }

  function conflictCardSection(conflictEmails, emailGroups) {
    if (!conflictEmails.size) return '<p style="color:#9ca3af;font-size:13px;">None.</p>';
    const html = [...conflictEmails].slice(0, MAX_LIST).map(email => {
      const entries = emailGroups.get(email) || [];
      const cards   = entries.map(e => reviewCard(e)).join('');
      return `<div style="border-left:4px solid #f59e0b;padding-left:12px;margin-bottom:20px">
        <p style="font-size:13px;font-weight:600;margin:0 0 8px;color:#92400e">${email} — ${entries.length} conflicting entries</p>
        ${cards}
      </div>`;
    }).join('');
    const more = conflictEmails.size > MAX_LIST
      ? `<p style="color:#9ca3af;font-size:12px;font-style:italic">… and ${conflictEmails.size - MAX_LIST} more emails not shown</p>` : '';
    return html + more;
  }

  function ambiguousCardSection(entries) {
    if (!entries.length) return '<p style="color:#9ca3af;font-size:13px;">None.</p>';
    const shown = entries.slice(0, MAX_LIST);
    const more  = entries.length - shown.length;
    const cards = shown.map(e => reviewCard(e)).join('');
    const moreNote = more > 0
      ? `<p style="color:#9ca3af;font-size:12px;font-style:italic">… and ${more} more not shown</p>` : '';
    return cards + moreNote;
  }

  const flagOverwrites   = r.flagOverwrites || [];
  const hasIssues        = r.batchConflictEmails.size > 0 || r.ambiguousEmailSet.size > 0
    || r.invalid > 0 || r.filtered > 0 || flagOverwrites.length > 0;
  const totalNeedsReview = r.batchConflictEntries.length + r.ambiguousContactEntries.length;

  const subject = `[Dry Run] Opera → Salesforce Preview — ${r.guestsCreate} create, ${r.guestsUpdate} update, ${totalNeedsReview} review`;

  const htmlBody = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
<div class="wrap">
  <div class="header">
    <div class="badge">Dry Run</div>
    <h1>Opera DB → Salesforce Preview</h1>
    <p class="sub">Run at ${runAt} (ART) &nbsp;·&nbsp; Nothing was written to Oracle or Salesforce</p>
  </div>
  <div class="body">

    ${hasIssues ? `<div class="notice">⚠ Some records require manual review — see details below.</div>` : ''}

    <div class="section">
      <h2>Summary</h2>
      <div class="stat-grid">
        <div class="stat blue">  <div class="num">${r.eligible}</div><div class="lbl">Eligible guests from Oracle</div></div>
        <div class="stat green"> <div class="num">${r.guestsCreate}</div><div class="lbl">${r.guestObject} would be created</div></div>
        <div class="stat ${r.guestsUpdate > 0 ? 'blue' : 'gray'}">
          <div class="num">${r.guestsUpdate}</div><div class="lbl">${r.guestObject} would be updated</div></div>
        <div class="stat ${totalNeedsReview > 0 ? 'amber' : 'gray'}">
          <div class="num">${totalNeedsReview}</div><div class="lbl">Records → needsReview</div></div>
        <div class="stat ${r.newContacts > 0 ? 'green' : 'gray'}">
          <div class="num">${r.newContacts}</div><div class="lbl">Contacts would be created</div></div>
        <div class="stat gray"><div class="num">${r.existingContacts}</div><div class="lbl">Contacts already in Salesforce</div></div>
        ${r.guestsAlreadyInSync > 0 ? `
        <div class="stat gray">
          <div class="num">${r.guestsAlreadyInSync}</div><div class="lbl">${r.guestObject} already in sync</div></div>
        ` : ''}
        ${flagOverwrites.length > 0 ? `
        <div class="stat amber">
          <div class="num">${flagOverwrites.length}</div><div class="lbl">⚠ Boolean flags would be reset</div></div>
        ` : ''}
      </div>
    </div>

    <div class="section">
      <h2>Sync State</h2>
      <div class="kv"><span class="k">Since timestamp</span><span class="v">${since}</span></div>
      ${r.lastSyncStatus ? `<div class="kv"><span class="k">Last sync status</span><span class="v">${r.lastSyncStatus}</span></div>` : ''}
      ${r.lastSyncRecordCount != null ? `<div class="kv"><span class="k">Last sync record count</span><span class="v">${r.lastSyncRecordCount}</span></div>` : ''}
    </div>

    <div class="section">
      <h2>Oracle Query Results</h2>
      <div class="kv"><span class="k">Raw guests found</span><span class="v">${r.totalRaw}</span></div>
      <div class="kv"><span class="k">Filtered — agent / proxy</span>
        <span class="v">${r.filtered > 0 ? `<span class="pill warn">${r.filtered}</span>` : '0'}</span></div>
      <div class="kv"><span class="k">Invalid email</span>
        <span class="v">${r.invalid > 0 ? `<span class="pill warn">${r.invalid}</span>` : '0'}</span></div>
      <div class="kv"><span class="k">Eligible for sync</span>
        <span class="v"><span class="pill exists">${r.eligible}</span></span></div>
      ${r.guestsAlreadyInSync > 0 ? `<div class="kv"><span class="k">${r.guestObject} already in sync (no update sent)</span><span class="v">${r.guestsAlreadyInSync}</span></div>` : ''}
    </div>

    <div class="section">
      <h2>Contact Classification</h2>
      <div class="kv"><span class="k">NEW — would be created</span>
        <span class="v"><span class="pill new">${r.newContacts}</span></span></div>
      <div class="kv"><span class="k">EXISTS — already in Salesforce</span>
        <span class="v"><span class="pill exists">${r.existingContacts}</span></span></div>
      <div class="kv"><span class="k">AMBIGUOUS — 2+ matches → needsReview</span>
        <span class="v">${r.ambiguousEmailSet.size > 0 ? `<span class="pill warn">${r.ambiguousEmailSet.size}</span>` : '0'}</span></div>
      <div class="kv"><span class="k">Shared-email name conflict → needsReview</span>
        <span class="v">${r.batchConflictEmails.size > 0 ? `<span class="pill warn">${r.batchConflictEmails.size} emails, ${r.batchConflictEntries.length} entries</span>` : '0'}</span></div>
    </div>

    ${r.batchConflictEmails.size > 0 ? `
    <div class="section">
      <h2>⚠ Shared-email Name Conflicts (→ needsReview)</h2>
      <p style="font-size:12px;color:#6b7280;margin:0 0 12px">Each card shows the Salesforce field API name, label, and value for manual entry.</p>
      ${conflictCardSection(r.batchConflictEmails, r.emailGroups)}
    </div>` : ''}

    ${r.ambiguousContactEntries.length > 0 ? `
    <div class="section">
      <h2>⚠ Ambiguous Contacts — 2+ SF Matches (→ needsReview)</h2>
      <p style="font-size:12px;color:#6b7280;margin:0 0 12px">Each card shows the Salesforce field API name, label, and value for manual entry.</p>
      ${ambiguousCardSection(r.ambiguousContactEntries)}
    </div>` : ''}

    ${r.newContactEntries.length > 0 ? `
    <div class="section">
      <h2>Contacts That Would Be Created (${r.newContactEntries.length})</h2>
      ${guestTable(r.newContactEntries)}
    </div>` : ''}

    ${r.guestsToCreate.length > 0 ? `
    <div class="section">
      <h2>${r.guestObject} Records That Would Be Created (${r.guestsToCreate.length})</h2>
      ${guestTable(r.guestsToCreate)}
    </div>` : ''}

    ${r.guestsToUpdate.length > 0 ? `
    <div class="section">
      <h2>${r.guestObject} Records That Would Be Updated (${r.guestsToUpdate.length})</h2>
      ${flagOverwrites.length > 0 ? `<div class="notice" style="margin-bottom:16px">⚠ ${flagOverwrites.length} record${flagOverwrites.length !== 1 ? 's' : ''} have boolean flags currently set to <strong>true</strong> that the sync would reset to <strong>false</strong>. Review before running the live sync.</div>` : ''}
      <p style="font-size:12px;color:#6b7280;margin:0 0 12px">
        Contacts are <strong>never updated</strong> by the sync — only created. The changes below are to ${r.guestObject} fields only.
        <span style="display:inline-block;margin-left:8px"><span style="color:#dc2626;font-weight:600">Red</span> = current value &nbsp; <span style="color:#059669;font-weight:600">Green</span> = incoming value</span>
      </p>
      ${updateDiffSection(r.guestsToUpdate)}
    </div>` : ''}

  </div>
  <div class="footer">
    Opera DB → Salesforce Dry Run &nbsp;·&nbsp; No data was modified &nbsp;·&nbsp; ${runAt} (ART)
  </div>
</div>
</body></html>`;

  const textBody = [
    'DRY RUN — Opera DB → Salesforce Preview',
    `Run at: ${runAt} (ART)`,
    '',
    'SUMMARY',
    `  Since:              ${since}`,
    `  Guests from Oracle: ${r.totalRaw} raw, ${r.eligible} eligible`,
    `  Filtered/invalid:   ${r.filtered} agent/proxy, ${r.invalid} bad email`,
    `  Contacts CREATE:    ${r.newContacts}`,
    `  Contacts EXIST:     ${r.existingContacts}`,
    `  ${r.guestObject} CREATE: ${r.guestsCreate}`,
    `  ${r.guestObject} UPDATE: ${r.guestsUpdate}`,
    `  needsReview:        ${totalNeedsReview}`,
    '',
    'Nothing was written to Oracle or Salesforce.',
  ].join('\n');

  return { subject, textBody, htmlBody };
}

// ── SF connection (read-only — only query() is called) ────────────────────────

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

async function queryAll(conn, soql) {
  let res = await conn.query(soql);
  const records = [...res.records];
  while (!res.done) {
    res = await conn.queryMore(res.nextRecordsUrl);
    records.push(...res.records);
  }
  return records;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();

  console.log('\n' + hr('═'));
  console.log('  DRY RUN — Opera DB → Salesforce Preview');
  console.log(`  Run at: ${now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })} (ART)`);
  console.log(hr('═'));

  // ── 1. Determine the "since" timestamp ───────────────────────────────────

  section('Sync State');

  let lastSyncTimestamp = null;
  let lastSyncStatus    = null;
  let lastSyncRecordCount = null;

  if (SINCE_ARG) {
    lastSyncTimestamp = new Date(SINCE_ARG).toISOString();
    console.log(`  Using --since override: ${lastSyncTimestamp}`);
  } else {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      lastSyncTimestamp   = state.lastSyncTimestamp || null;
      lastSyncStatus      = state.lastSyncStatus || null;
      lastSyncRecordCount = state.lastSyncRecordCount ?? null;
      console.log(`  State file  : ${STATE_FILE}`);
      console.log(`  Last sync   : ${lastSyncTimestamp || 'never (initial sync)'}`);
      console.log(`  Last status : ${lastSyncStatus || '—'}`);
      console.log(`  Last count  : ${lastSyncRecordCount ?? '—'} records`);
    } catch (err) {
      console.warn(`  WARNING: Could not read ${STATE_FILE}: ${err.message}`);
      console.warn('  Proceeding as if no previous sync (will query last 24 months).');
    }
  }

  console.log(`\n  Oracle will be queried for changes since: ${lastSyncTimestamp || '(none — initial sync)'}`);

  // ── 2. Query Opera Oracle ─────────────────────────────────────────────────

  section('Opera Database Query');

  const oracleClient = new OracleClient({
    host    : process.env.ORACLE_HOST,
    port    : process.env.ORACLE_PORT || '1521',
    sid     : process.env.ORACLE_SID,
    service : process.env.ORACLE_SERVICE,
    user    : process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
  });

  console.log('  Connecting to Oracle...');
  await oracleClient.connect();
  console.log('  Connected.\n');

  const { records: allRecords, filtered: allFiltered, invalid: allInvalid } =
    await queryGuestsSince(oracleClient, lastSyncTimestamp);

  await oracleClient.close();

  const totalRaw = allRecords.length + allFiltered.length + allInvalid.length;
  row('Guests found in Oracle:',     String(totalRaw));
  row('  Filtered — agent/proxy:',   String(allFiltered.length));
  row('  Invalid email:',            String(allInvalid.length));
  row('Eligible for Salesforce sync:', String(allRecords.length));

  if (VERBOSE && allFiltered.length) {
    console.log('\n    Filtered (agent/proxy):');
    allFiltered.slice(0, 20).forEach(e => {
      console.log(`      · ${e.firstName} ${e.lastName} <${e.email}> [${e.category}]`);
    });
    if (allFiltered.length > 20) console.log(`      … and ${allFiltered.length - 20} more`);
  }

  if (VERBOSE && allInvalid.length) {
    console.log('\n    Invalid email:');
    allInvalid.slice(0, 20).forEach(e => {
      console.log(`      · ${e.firstName} ${e.lastName} <${e.email}>`);
    });
    if (allInvalid.length > 20) console.log(`      … and ${allInvalid.length - 20} more`);
  }

  if (allRecords.length === 0) {
    console.log('\n  No eligible records. Nothing would be synced.');
    if (SEND_EMAIL) {
      const report = {
        runAt: now, lastSyncTimestamp, lastSyncStatus, lastSyncRecordCount,
        totalRaw, filtered: allFiltered.length, invalid: allInvalid.length, eligible: 0,
        emailGroups: new Map(), batchConflictEmails: new Set(), batchConflictEntries: [],
        newContacts: 0, existingContacts: 0, ambiguousEmailSet: new Set(),
        newContactEntries: [], ambiguousContactEntries: [],
        guestsCreate: 0, guestsUpdate: 0, guestsAlreadyInSync: 0,
        flagOverwrites: [],
        guestsToCreate: [], guestsToUpdate: [],
        guestObject: GUEST_OBJECT,
      };
      await sendReport(report);
    }
    process.exit(0);
  }

  // ── 3. Pre-flight: within-batch conflict detection ────────────────────────

  section('Pre-flight: Shared Email Conflicts');

  const emailGroups = new Map();
  for (const entry of allRecords) {
    const email = (entry.customer.email || '').toLowerCase();
    if (!email) continue;
    if (!emailGroups.has(email)) emailGroups.set(email, []);
    emailGroups.get(email).push(entry);
  }

  const batchConflictEmails  = new Set();
  const batchConflictEntries = [];

  for (const [email, entries] of emailGroups) {
    if (entries.length < 2) continue;
    const names = new Set(
      entries.map(e =>
        `${(e.customer.firstName || '').toLowerCase()}|${(e.customer.lastName || '').toLowerCase()}`
      )
    );
    if (names.size > 1) {
      batchConflictEmails.add(email);
      batchConflictEntries.push(...entries);
    }
  }

  if (batchConflictEmails.size === 0) {
    console.log('  None.');
  } else {
    row('Emails with conflicting names:', String(batchConflictEmails.size));
    row('Entries → needsReview:',         String(batchConflictEntries.length));
    for (const email of batchConflictEmails) {
      const entries = emailGroups.get(email);
      const names = entries.map(e => `${e.customer.firstName} ${e.customer.lastName}`).join(' / ');
      console.log(`\n    ${email}`);
      console.log(`      Names: ${names}`);
    }
  }

  const eligibleEntries = allRecords.filter(entry => {
    const email = (entry.customer.email || '').toLowerCase();
    return email && !batchConflictEmails.has(email);
  });

  const uniqueEmails = [
    ...new Set(eligibleEntries.map(e => (e.customer.email || '').toLowerCase()))
  ];

  // ── 4. Salesforce: Contact lookup ─────────────────────────────────────────

  section('Salesforce — Contact Lookup (read-only)');

  console.log('  Connecting to Salesforce...');
  const sfConn = connectSF();
  await sfConn.identity();
  console.log(`  Connected.\n  Querying ${uniqueEmails.length} unique email${uniqueEmails.length !== 1 ? 's' : ''}...`);

  const emailStatus = new Map();
  for (const email of uniqueEmails) emailStatus.set(email, { status: 'new' });

  for (let i = 0; i < uniqueEmails.length; i += BATCH_SIZE) {
    const batch   = uniqueEmails.slice(i, i + BATCH_SIZE);
    const escaped = batch.map(e => `'${e.replace(/'/g, "\\'")}'`).join(',');
    const result  = await sfConn.query(`SELECT Id, Email FROM Contact WHERE Email IN (${escaped})`);

    const sfByEmail = new Map();
    for (const rec of result.records) {
      const email = rec.Email.toLowerCase();
      if (!sfByEmail.has(email)) sfByEmail.set(email, []);
      sfByEmail.get(email).push(rec.Id);
    }
    for (const [email, ids] of sfByEmail) {
      emailStatus.set(email, ids.length === 1
        ? { status: 'exists', contactId: ids[0] }
        : { status: 'ambiguous' }
      );
    }
  }

  const newEmailSet       = new Set([...emailStatus.entries()].filter(([, s]) => s.status === 'new').map(([e]) => e));
  const existsEmailSet    = new Set([...emailStatus.entries()].filter(([, s]) => s.status === 'exists').map(([e]) => e));
  const ambiguousEmailSet = new Set([...emailStatus.entries()].filter(([, s]) => s.status === 'ambiguous').map(([e]) => e));

  const newContactEntries       = eligibleEntries.filter(e => newEmailSet.has((e.customer.email||'').toLowerCase()));
  const existingContactEntries  = eligibleEntries.filter(e => existsEmailSet.has((e.customer.email||'').toLowerCase()));
  const ambiguousContactEntries = eligibleEntries.filter(e => ambiguousEmailSet.has((e.customer.email||'').toLowerCase()));

  row('NEW   — Contact would be created:',    `${newEmailSet.size} unique email${newEmailSet.size !== 1 ? 's' : ''}`);
  row('EXISTS — Contact already in SF:',      `${existsEmailSet.size} unique email${existsEmailSet.size !== 1 ? 's' : ''}`);
  row('AMBIGUOUS — 2+ SF Contacts for email:', `${ambiguousEmailSet.size} → needsReview`);

  if (VERBOSE) {
    verboseList('Contacts that WOULD BE CREATED', newContactEntries);
    verboseList('Ambiguous — needsReview', ambiguousContactEntries);
  } else {
    if (newEmailSet.size)       console.log(`\n  (pass --verbose to list the ${newEmailSet.size} new-contact guest${newEmailSet.size !== 1 ? 's' : ''})`);
    if (ambiguousEmailSet.size) console.log(`  (pass --verbose to list the ${ambiguousEmailSet.size} ambiguous guest${ambiguousEmailSet.size !== 1 ? 's' : ''})`);
  }

  // Assign placeholder IDs for new emails so Phase 3 can classify them
  for (const email of newEmailSet) {
    emailStatus.set(email, { status: 'exists', contactId: `__NEW__:${email}` });
  }

  // ── 5. Salesforce: TVRS_Guest__c lookup ───────────────────────────────────

  section(`Salesforce — ${GUEST_OBJECT} Lookup (read-only)`);

  const realContactIds = [...emailStatus.values()]
    .filter(s => s.status === 'exists' && s.contactId && !s.contactId.startsWith('__NEW__'))
    .map(s => s.contactId);

  const existingGuestMap = new Map(); // "contactId|checkInDate" → full SF record

  if (realContactIds.length > 0) {
    console.log(`  Querying ${GUEST_OBJECT} for ${realContactIds.length} existing Contact${realContactIds.length !== 1 ? 's' : ''}...`);
    for (let i = 0; i < realContactIds.length; i += BATCH_SIZE) {
      const idBatch = realContactIds.slice(i, i + BATCH_SIZE);
      const escaped = idBatch.map(id => `'${id}'`).join(',');
      try {
        let result = await sfConn.query(
          `SELECT Id, ${CONTACT_LOOKUP}, Check_In_Date__c, ${GUEST_DIFF_SOQL_FIELDS} ` +
          `FROM ${GUEST_OBJECT} WHERE ${CONTACT_LOOKUP} IN (${escaped})`
        );
        let allRecs = result.records;
        while (!result.done) {
          result = await sfConn.queryMore(result.nextRecordsUrl);
          allRecs = allRecs.concat(result.records);
        }
        for (const rec of allRecs) {
          if (rec[CONTACT_LOOKUP] && rec.Check_In_Date__c) {
            existingGuestMap.set(`${rec[CONTACT_LOOKUP]}|${rec.Check_In_Date__c}`, rec);
          }
        }
      } catch (err) {
        console.warn(`  WARNING: could not query ${GUEST_OBJECT}: ${err.message}`);
      }
    }
    console.log(`  Found ${existingGuestMap.size} existing check-in record${existingGuestMap.size !== 1 ? 's' : ''}.`);
  } else {
    console.log('  No existing Contacts to check — all guest records would be new.');
  }

  const guestsToCreate      = [];
  const guestsToUpdate      = []; // { entry, changes } — actual field changes only
  const guestsAlreadyInSync = []; // no field changes; no update will be sent
  const seenGuestKeys       = new Set();

  for (const entry of allRecords) {
    const email = (entry.customer.email || '').toLowerCase();
    if (!email) continue;
    const status = emailStatus.get(email);
    if (!status || status.status !== 'exists' || !status.contactId) continue;

    const proposed    = transformToTVRSGuest(entry.customer, entry.invoice, status.contactId);
    const checkInDate = proposed.Check_In_Date__c || null;
    const matchKey    = checkInDate ? `${status.contactId}|${checkInDate}` : null;

    if (matchKey && seenGuestKeys.has(matchKey)) continue;
    if (matchKey) seenGuestKeys.add(matchKey);

    const currentRecord = matchKey ? existingGuestMap.get(matchKey) : null;
    if (currentRecord) {
      const changes = diffGuestRecord(currentRecord, proposed);
      if (changes.length > 0) {
        guestsToUpdate.push({ entry, changes });
      } else {
        guestsAlreadyInSync.push(entry);
      }
    } else {
      guestsToCreate.push(entry);
    }
  }

  const flagOverwrites = guestsToUpdate.filter(g =>
    g.changes.some(c => c.boolean && c.from === true && c.to === false)
  );

  row(`${GUEST_OBJECT} would be CREATED:`,    String(guestsToCreate.length));
  row(`${GUEST_OBJECT} would be UPDATED:`,    String(guestsToUpdate.length));
  row(`${GUEST_OBJECT} already in sync:`,     String(guestsAlreadyInSync.length));
  if (flagOverwrites.length > 0)
    row('  — ⚠ boolean flag reset:',          String(flagOverwrites.length));

  if (VERBOSE) {
    verboseList('Guest records that WOULD BE CREATED', guestsToCreate);
    if (guestsToUpdate.length) {
      const MAX_V = 30;
      console.log(`\n    Guest records that WOULD BE UPDATED (${guestsToUpdate.length}):`);
      guestsToUpdate.slice(0, MAX_V).forEach(({ entry, changes }) => {
        console.log(`      · ${guestLabel(entry)}`);
        changes.forEach(c => {
          const fromStr = c.from === null || c.from === undefined ? '(empty)' : String(c.from);
          const toStr   = c.to   === null || c.to   === undefined ? '(empty)' : String(c.to);
          const warn    = c.boolean && c.from === true && c.to === false ? ' ⚠' : '';
          console.log(`        ${c.label}: ${fromStr} → ${toStr}${warn}`);
        });
      });
      if (guestsToUpdate.length > MAX_V) console.log(`      … and ${guestsToUpdate.length - MAX_V} more`);
    }
    verboseList('Guest records already in sync (no update sent)', guestsAlreadyInSync);
  }

  // ── 6. Summary ────────────────────────────────────────────────────────────

  section('Summary');

  const totalNeedsReview = batchConflictEntries.length + ambiguousContactEntries.length;

  row('Since timestamp:',              lastSyncTimestamp || '(initial sync)');
  row('Guests found in Oracle:',        String(totalRaw));
  console.log('');
  row('  Filtered (agent/proxy):',      String(allFiltered.length));
  row('  Invalid email:',               String(allInvalid.length));
  row('  Shared-email conflict:',       `${batchConflictEntries.length} entries → needsReview`);
  row('  Ambiguous SF Contacts:',       `${ambiguousContactEntries.length} entries → needsReview`);
  console.log('');
  row('Contacts would be CREATED:',     String(newEmailSet.size));
  row('Contacts left unchanged:',       String(existsEmailSet.size));
  console.log('');
  row(`${GUEST_OBJECT} would be CREATED:`, String(guestsToCreate.length));
  row(`${GUEST_OBJECT} would be UPDATED:`, String(guestsToUpdate.length));
  row(`${GUEST_OBJECT} already in sync:`,  String(guestsAlreadyInSync.length));
  if (flagOverwrites.length > 0)
    row('  — ⚠ boolean flag reset:',       String(flagOverwrites.length));
  console.log('');
  row('Total needsReview:',               String(totalNeedsReview));

  console.log('\n' + hr());
  console.log('  Nothing was written to Oracle or Salesforce.');
  if (!VERBOSE && (newEmailSet.size + guestsToCreate.length + guestsToUpdate.length + totalNeedsReview) > 0) {
    console.log('  Re-run with --verbose to see individual guest rows per category.');
  }
  console.log(hr() + '\n');

  // ── 7. Email report (optional) ────────────────────────────────────────────

  if (SEND_EMAIL) {
    const report = {
      runAt: now, lastSyncTimestamp, lastSyncStatus, lastSyncRecordCount,
      totalRaw, filtered: allFiltered.length, invalid: allInvalid.length,
      eligible: allRecords.length,
      emailGroups, batchConflictEmails, batchConflictEntries,
      newContacts: newEmailSet.size,
      existingContacts: existsEmailSet.size,
      ambiguousEmailSet,
      newContactEntries,
      ambiguousContactEntries,
      guestsCreate: guestsToCreate.length,
      guestsUpdate: guestsToUpdate.length,
      guestsAlreadyInSync: guestsAlreadyInSync.length,
      flagOverwrites,
      guestsToCreate, guestsToUpdate,
      guestObject: GUEST_OBJECT,
    };
    await sendReport(report);
  }
}

async function sendReport(report) {
  console.log('\n  Sending email report...');
  const notifier = new Notifier();
  if (!notifier.emailEnabled) {
    console.warn('  WARNING: EMAIL_ENABLED is not set — skipping email. Set EMAIL_ENABLED=true and configure email credentials.');
    return;
  }
  const { subject, textBody, htmlBody } = buildDryRunEmail(report);
  const sent = await notifier.sendEmail(subject, textBody, htmlBody);
  if (sent) {
    console.log(`  Report sent to ${process.env.EMAIL_TO}`);
  } else {
    console.warn('  WARNING: Email failed to send — check logs for details.');
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
