#!/usr/bin/env node
'use strict';
require('dotenv').config();

const jsforce      = require('jsforce');
const OracleClient = require('../src/oracle-client');

const EMAIL = process.argv[2];
if (!EMAIL) { console.error('Usage: node scripts/lookup-email.js <email>'); process.exit(1); }

async function main() {
  // ── Salesforce ─────────────────────────────────────────────────────────
  console.log('\n=== SALESFORCE ===');
  const conn = new jsforce.Connection({
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
  await conn.identity();

  const contacts = await conn.query(
    `SELECT Id, FirstName, LastName, Email, CreatedDate, LastModifiedDate FROM Contact WHERE Email = '${EMAIL}'`
  );
  console.log(`Contacts (${contacts.totalSize}):`);
  contacts.records.forEach(c =>
    console.log(`  [${c.Id}] ${c.FirstName} ${c.LastName} | created ${c.CreatedDate?.slice(0,10)} | modified ${c.LastModifiedDate?.slice(0,10)}`)
  );

  const guestObj = process.env.SF_OBJECT || 'TVRS_Guest__c';
  const guests = await conn.query(
    `SELECT Id, Guest_First_Name__c, Guest_Last_Name__c, Email__c, Check_In_Date__c, Check_Out_Date__c, LastModifiedDate ` +
    `FROM ${guestObj} WHERE Email__c = '${EMAIL}' ORDER BY Check_In_Date__c DESC`
  );
  console.log(`\n${guestObj} records (${guests.totalSize}):`);
  guests.records.forEach(g =>
    console.log(`  [${g.Id}] ${g.Guest_First_Name__c} ${g.Guest_Last_Name__c} | check-in ${g.Check_In_Date__c} | check-out ${g.Check_Out_Date__c} | modified ${g.LastModifiedDate?.slice(0,10)}`)
  );

  // ── Oracle ──────────────────────────────────────────────────────────────
  console.log('\n=== OPERA (ORACLE) ===');
  const oracle = new OracleClient({
    host: process.env.ORACLE_HOST, port: process.env.ORACLE_PORT || '1521',
    sid: process.env.ORACLE_SID, service: process.env.ORACLE_SERVICE,
    user: process.env.ORACLE_USER, password: process.env.ORACLE_PASSWORD,
  });
  await oracle.connect();

  const nameRows = await oracle.query(`
    SELECT n.NAME_ID, n.FIRST, n.LAST, n.LANGUAGE,
           n.INSERT_DATE AS NAME_CREATED, n.UPDATE_DATE AS NAME_UPDATED,
           p.PHONE_NUMBER AS EMAIL,
           p.INSERT_DATE AS EMAIL_CREATED, p.UPDATE_DATE AS EMAIL_UPDATED
    FROM OPERA.NAME n
    JOIN OPERA.NAME_PHONE p ON n.NAME_ID = p.NAME_ID AND p.PHONE_ROLE = 'EMAIL'
    WHERE LOWER(p.PHONE_NUMBER) = LOWER(:email)
    ORDER BY n.INSERT_DATE
  `, { email: EMAIL });

  console.log(`NAME records with this email (${nameRows.length}):`);
  nameRows.forEach(r => {
    console.log(`  NAME_ID ${r.NAME_ID}: "${r.FIRST} ${r.LAST}"  language=${r.LANGUAGE || '—'}`);
    console.log(`    name:  created ${r.NAME_CREATED?.toISOString().slice(0,10) ?? '—'}  updated ${r.NAME_UPDATED?.toISOString().slice(0,10) ?? '—'}`);
    console.log(`    email: created ${r.EMAIL_CREATED?.toISOString().slice(0,10) ?? '—'}  updated ${r.EMAIL_UPDATED?.toISOString().slice(0,10) ?? '—'}`);
  });

  if (nameRows.length > 0) {
    const nameIds  = nameRows.map(r => r.NAME_ID);
    const binds    = Object.fromEntries(nameIds.map((id, i) => [`id${i}`, id]));
    const holders  = nameIds.map((_, i) => `:id${i}`).join(',');

    const resvRows = await oracle.query(`
      SELECT NAME_ID, RESV_NAME_ID, RESV_STATUS, BEGIN_DATE, END_DATE,
             INSERT_DATE, UPDATE_DATE
      FROM OPERA.RESERVATION_NAME
      WHERE RESORT = 'VINES' AND NAME_ID IN (${holders})
      ORDER BY BEGIN_DATE DESC
    `, binds);

    console.log(`\n  Reservations at VINES (${resvRows.length}):`);
    resvRows.forEach(r =>
      console.log(
        `    NAME_ID ${r.NAME_ID} | ${String(r.RESV_STATUS).padEnd(12)} | ` +
        `check-in ${r.BEGIN_DATE?.toISOString().slice(0,10) ?? '—'} | ` +
        `check-out ${r.END_DATE?.toISOString().slice(0,10) ?? '—'} | ` +
        `updated ${r.UPDATE_DATE?.toISOString().slice(0,10) ?? '—'}`
      )
    );
  }

  await oracle.close();
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
